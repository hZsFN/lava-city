# 票 M1-01 · 渲染管线与熔岩世界

> 依赖：M0-01 已完成（`npm run build` 与 `node kit/tools/check.mjs out/` 已通过）。
> 设计依据：`docs/熔心孤塔_设计与AI开发规划.md` 第 2.2、4、11 节。
> **本票只做"好看"，不做玩法。** 目标是在没有 Boss、没有敌人的情况下，单看画面就能让人"哇"一声。

## 【目标】

把 M0 的灰盒场景升级成一座真正站在里面的地心塔顶：脚下是被熔岩海包围的石制高塔平台，远方是熔岩穹顶，空气里有热浪和火星。1080p 独显 60 fps。

## 【范围】

```
src/render/App.ts            （重写）
src/render/Lava.ts           （新建）
src/render/Spire.ts          （新建）
src/render/Atmosphere.ts     （新建）
src/render/PostFX.ts         （新建）
src/render/palette.ts        （新建）
src/core/config/visual.json  （新建/填充）
```

禁止修改 `src/core/events.ts`、`kit/**`、`docs/**`。

## 【技术要求】

### 1. 渲染器

用 `THREE.WebGLRenderer`（**本票不切 WebGPU**，先保证零兼容风险），参数：
```ts
new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.05
```

### 2. 熔岩海（Lava.ts）—— 本票第一优先级

一个 400×400 的平面，`planeGeometry` 分段 128×128，自定义 `ShaderMaterial`：

- **顶点着色器**：三层正弦叠加做缓慢起伏（振幅 0.35 m，周期 6–14 s），越远振幅越大。
- **片元着色器**：`fbm` 噪声（4 个 octave，`hash` 用 `fract(sin(dot()))`）驱动颜色插值：
  - 冷区 `#2a0705`（近黑的红）
  - 温区 `#8c1d08`
  - 热区 `#ff5a12`
  - 白热区 `#ffd27a`
  - 阈值让约 60% 面积偏暗、5% 面积白热，形成"结壳-裂隙"的观感
- **裂隙**：用 `abs(fbm - 0.5)` 取脊线（`1.0 - smoothstep(0, 0.04, ridge)`），在脊线上叠加强发光，让裂纹像血管。
- **自发光**：把最终色乘以 `2.2` 输出（配合 Bloom 会炸出光）。
- **视差**：`roughness` 不做，用两套 UV 以不同速度流动（`t*0.008` 与 `t*0.013`，方向相反）。
- **远处压暗**：按到原点的距离把亮度衰减到 0.35，避免地平线刺眼。

熔岩面 `y = -18`（塔基在 0 以下很深，制造高度差），并暴露 `setLevel(y)` 方法供后续 M2 票做上涨。

### 3. 塔（Spire.ts）

玩家站的主平台：
- 八角形石台，外接圆半径 22 m，厚 3 m，`y ∈ [-1.5, 1.5]`
- 石材质：`MeshStandardMaterial`，`color:#3a3230`、`roughness:0.86`、`metalness:0.04`，
  用 `CanvasTexture` 程序化生成 512×512 的岩石噪声图作为 `map` 和 `bumpMap`（bumpScale 0.35）
- 台面边缘一圈发光的符文槽：`RingGeometry` + `MeshBasicMaterial({color:#ff6a1e, transparent, opacity:0.85})`，宽 0.4 m
- 台面中央有一口竖井（塔心），直径 6 m 的黑洞，内部 `y=-30` 处放一个巨大的橙色 `PointLight`（强度 800，距离 120）向上打光，制造"从下方涌上来的光"
- 平台下方用 `CylinderGeometry`（8 段）做一根粗壮的塔柱一直延伸到熔岩面，让平台看起来是"长"在岩体上，而不是浮着

### 4. 光照（Atmosphere.ts）

**关键设计：主光是熔岩，不是太阳。所以光从下往上打，所有物体底部亮、顶部暗。**

- 环境光：`HemisphereLight(sky:#1a0d08, ground:#ff4a0a, 0.9)` —— 注意 ground 比 sky 亮，这是本票"地心感"的核心
- 一盏主方向光从下方斜上：`DirectionalLight(#ff7a2a, 1.6)`，位置 `(0, -30, -20)` 指向原点
- 塔心竖井的 `PointLight`（见上）
- 平台边缘 8 个 `PointLight(#ff5a12, 120, 40)` 均布，制造边缘火光
- **雾**：`FogExp2(#1a0a06, 0.0032)`，让远景融进黑暗

### 5. 空气感（Atmosphere.ts）

- **火星粒子**：`Points`，2000 个，`BufferGeometry` 随机分布在半径 120 / 高度 60 的柱体空间内，每个粒子上浮（速度 0.4–1.2 m/s，带正弦横摆），越界回到底部重开。`PointsMaterial({size:0.35, color:#ffb060, transparent, opacity:0.75, sizeAttenuation:true, blending:AdditiveBlending, depthWrite:false})`
- **热浪**：`PostFX` 里做屏幕空间扰动，用 `sin(uv.y*40 + t*2)` 的极轻量 UV 偏移（幅度 0.0015），越靠下越强

### 6. 后处理（PostFX.ts）

**不引外部后处理库**，手写一个两 pass 的 `EffectComposer` 替代品（`WebGLRenderTarget` + 全屏 quad）：

1. **Bloom**：亮部提取（阈值 0.72）→ 水平高斯（9 tap）→ 垂直高斯（9 tap）→ 叠加回主图，强度 0.85
2. **合成 pass**：加暗角（`1 - smoothstep(0.35, 0.95, dist)`）、色差（RGB 各偏移 0.0008 × 边缘权重）、胶片颗粒（`hash(uv+t)*0.035`）、暖橙/冷青分级（暗部偏 `#0a1a22`、亮部偏 `#ffb070`）

所有 pass 的半分辨率可开关。

### 7. 画质档位

`visual.json` 中定义 `quality: "ultra" | "high" | "medium" | "low"`，按首 3 秒平均帧时间自动选：
- `> 22ms` → low（关 Bloom，只留色调，熔岩降到 2 octave）
- `> 17ms` → medium（Bloom 半分辨率，粒子 800）
- 其余 → high（全开）

Ultra 档留给人工切换，不自动选。

## 【验收】

```bash
npm run typecheck
npm run build
npm run pack
node kit/tools/check.mjs out/
```

全部通过。另外必须提供**三张截图**（1080p，放在 `docs/shots/`）：
1. 出生点平视，能看到塔面、符文环、远景熔岩海
2. 走到台边俯视，能看到塔柱扎进熔岩、热浪和火星
3. 抬头，能看到穹顶和雾

截图用 Playwright 或 Chrome 无头都行，命令写进交付说明。

性能：在 `src/ui/DebugOverlay.ts` 里加一行显示 `renderer.info.render.calls` 与三角数，交付时贴出这两个数字。Draw call 必须 < 120。

## 【本票明确不做】

SSR、GTAO、TRAA、DoF、运动模糊、CSM、GPU 计算粒子、3D LUT 文件、WebGPU。
理由：这些在今天的时间预算里是加分项，而"熔岩好看"是必答题。留给 M5 打磨票。
