# 票 M3-04 · 路径 A 落地说明：12 件跳跃平台

> 状态：**已落地** · 2026-11-08
> 父票：`docs/tickets/M3-04-arena-props.md`（布局与数值）
> 子票：`docs/tickets/M3-04b-arena-props-visual.md`（细节规格）
> 回归记录：`.tmp/gate-report.md`

---

## 一句话结论

**本次只做「碰撞盒 + 静态平台几何」**：落地了 12 件跳跃平台（L1..L12，4 条链 × 3 级，台面 0.8 / 1.6 / 2.4 m）的碰撞箱与程序化渲染——玩家真的能站上去，12 件几何合并成 2 个 draw call，位置与碰撞箱同读一份 config。**不做 LOS 判定、不做遮挡物（12 件）/ 防御物（5 件）、不加任何每帧逻辑**（渲染层纯静态，接口无 `update()`），也没有平台破坏（票面要求就是不可破坏）。

---

## 已落地清单

| 文件 | 状态 | 职责 |
|---|---|---|
| `src/game/ArenaProps.ts` | 新增 | **纯逻辑层，不 import three**。极坐标→世界坐标（`x = r·cos(a)`、`z = r·sin(a)`）；footprint（圆 / 正矩形 / 有向矩形）→ 轴对齐 AABB；导出 `placements` / `platformColliders` / `collidersFromProps` / `maxPlatformTopY`。 |
| `src/core/config/arena-props.json` | 新增 | **数值唯一真源**。29 个实例（12 cover / 5 defense / 12 platform）+ kinds 定义 + 渲染参数 + damageModel。代码里不写死任何尺寸。 |
| `src/render/ArenaProps.ts` | 新增 | 表现层，**纯静态**。正八边形平板 + 侧面 + 顶面倒角，**按材质合并**：12 件平台 → `rock` 1 个 mesh + `rim` 1 个 mesh；顶面 `RingGeometry` 0.85→0.95 发光描边；碰撞箱线框调试组（默认隐藏）。接口仅 `{ stats, setCollisionBoxesVisible, dispose }`，**无 `update()`、无每帧逻辑**。 |
| `src/game/GameLoop.ts` | 改动 | `buildPlayerWorld()` 的 `colliders` 追加 `...platformColliders(arenaPropsCfg)`。**只追加 platform 类**，见「明确未做」。 |
| `src/render/App.ts` | 改动 | 新增 `mountArenaProps(config, showCollisionBoxes)`，挂到场景并缓存视图；重复挂载先 `dispose()` 旧的。 |
| `src/main.ts` | 改动 | 调用 `app.mountArenaProps(arenaPropsCfg, params.get('boxes') === '1')`；暴露 `window.__game.props`（`stats()` / `setBoxes()` / `config()`）。 |
| `tests/unit/game/arenaProps.test.ts` | 新增 | 8 条：12 箱全部贴地、顶面 0.8/1.6/2.4、逐级 +0.8、坐标精度、链内间隙 ≤3.0 m、不压塔位 ≥2.2 m、跑帧不弹起、走向 L1 被挡且起跳能站上 0.8 m。 |
| `tests/unit/game/arenaPropsReach.test.ts` | 新增 | 5 条：12 件都能落地到自身台面高度、三级链高度、0.8 m 走不上去（必须跳）且不卡进内部、不压塔位、整局能跑完。 |

> 平台相关的 13 条用例全绿（8 + 5）。

---

## 关键数值

### 12 件平台的 id / 高度 / 世界坐标

坐标由 `src/core/config/arena-props.json` 的 `instances` 用 node 算出（`x = r·cos(a)`，`z = r·sin(a)`，角度 0° = +X 轴、逆时针为正，单位 m，保留 3 位小数）：

| id | kind | 角度 | 半径 r | x | z | 台面高 |
|---|---|---|---|---|---|---|
| L1 | jumpLedge | 22.5° | 13.2 | 12.195 | 5.051 | 0.8 |
| L2 | jumpHigh | 22.5° | 15.4 | 14.228 | 5.893 | 1.6 |
| L3 | bridgePier | 22.5° | 17.6 | 16.260 | 6.735 | 2.4 |
| L4 | jumpLedge | 157.5° | 13.2 | -12.195 | 5.051 | 0.8 |
| L5 | jumpHigh | 157.5° | 15.4 | -14.228 | 5.893 | 1.6 |
| L6 | bridgePier | 157.5° | 17.6 | -16.260 | 6.735 | 2.4 |
| L7 | jumpLedge | 202.5° | 13.2 | -12.195 | -5.051 | 0.8 |
| L8 | jumpHigh | 202.5° | 15.4 | -14.228 | -5.893 | 1.6 |
| L9 | bridgePier | 202.5° | 17.6 | -16.260 | -6.735 | 2.4 |
| L10 | jumpLedge | 337.5° | 13.2 | 12.195 | -5.051 | 0.8 |
| L11 | jumpHigh | 337.5° | 15.4 | 14.228 | -5.893 | 1.6 |
| L12 | bridgePier | 337.5° | 17.6 | 16.260 | -6.735 | 2.4 |

### 结构

- **4 条链**：角度 22.5° / 157.5° / 202.5° / 337.5°，即 ±X 上下各一条，关于原点中心对称。
- **每条链 3 级**：`r = 13.2 → 15.4 → 17.6`（径向每级 +2.2 m），台面 `0.8 → 1.6 → 2.4`（每级 +0.8 m）。
- **间隙**：台面 1.8×1.8，径向间距 2.2 m ⇒ **净间隙 0.4 m**，远在走跳 3.0 m 安全上限内。
- **可达性**：单跳抬升上限 0.9 m，实际每级 0.8 m ✅；但 1.6 / 2.4 都超过 1.2 m 单跳极限，**从地面直上高台做不到**，必须逐级跳。
- **`maxPlatformTopY = 2.4`**，玩家最高可站到 2.4 m。

### 碰撞箱口径

- 平台 footprint 为 `rect` 1.8×1.8 ⇒ 半宽 `0.9`；所有平台 `rotDeg = 0`（不旋转）。
- 每件 AABB：`[x−0.9, x+0.9] × [0, h] × [z−0.9, z+0.9]`，`minY` 恒为 0。
- `collider: solid` 才产 AABB；`platformColliders()` 只取 `category === 'platform'` 的 12 件。

### 渲染

- 几何：`sides: 8`（正八边形），`sizeM: 1.8` 按**对边距**算，故外接圆 `= 0.9 / cos(π/8)`。
- 台面厚度 `topThicknessM: 0.18`，侧面上下收分 0.94 / 0.86，顶面 0.06 倒角接光。
- 描边：`RingGeometry` 内 0.85 → 外 0.95，`emissiveIntensity: 0.5`，颜色 `#ff9a3c`。
- 材质：rock `#2b2523`（roughness 0.9 / metalness 0.02 / flatShading）。
- **纯静态**：几何在挂载时一次构建完成，`ArenaPropsView` 只暴露 `stats` / `setCollisionBoxesVisible` / `dispose`，**没有 `update()`，不引入任何每帧逻辑**。
- **draw call：主 pass +2**（rock + rim 两个 mesh）。**实测全量增量 +6**——`rockMesh` 参与 3 级阴影级联，阴影 pass 也各画一次；`App.init()` 里 `renderer.info.autoReset = false`，统计的是所有 pass 的全量。
  实测口径（`?raw=1`，同一帧内可见/隐藏各采 6 次取中位数）：`calls 406 → 400`（Δ=6），`tris 174583 → 174331`（Δ≈5052，同样含阴影 pass 重复计数）。开 `?boxes=1` 再加 1（碰撞箱线框组）。
- 平台**不旋转**：八边形统一不转，避免相邻两级看起来不同族（票面只要求轮廓可读）。

---

## 验收证据

### 1. `.tmp/shots/arena-props/lead-01.png` —— 后处理全开

证明：**在完整渲染管线（含后处理 / bloom）下，12 件平台在纯黑场地里仍然一眼可数**。
- 四条链各三级呈阶梯抬升，0.8 → 1.6 → 2.4 的高度差靠透视就能读出。
- 顶面八边形轮廓与一圈细描边被 bloom 提亮，远景（L3/L6/L9/L12 一带）也能读出「这里有个台子」。
- 描边是「边」不是「面」——没有符纹面，不会被误认成有魔法效果。

### 2. `.tmp/shots/arena-props/lead-02-raw.png` —— `?raw=1` 关后处理

证明：**可读性不依赖后处理**，这是本票最容易糊弄过去、也最该证明的一点。
- 绕过整条后处理直出，描边回到材质本色（暖橙 `#ff9a3c`），台面八边形轮廓、侧面收分、顶面倒角全部清晰。
- 近景那件大八边形（贴脸视角）说明台面是**实心可站的平板**，不是贴片。
- 与 lead-01 对比可确认：后处理只做提亮与调色，几何与描边本身在 raw 下就成立。

> 补充（非本任务指定）：`.tmp/shots/arena-props/lead-03-boxes.png` 为 `?boxes=1` 的碰撞箱线框图，可直观核对「看得见的台子」与「站得上的台子」同源。

---

## 明确未做

- 遮挡物 12 件 / 防御物 5 件**未落地**：没有渲染件也没有 LOS 判定。现在把它们塞进碰撞会让玩家撞到看不见的墙，所以 `GameLoop` 只追加 platform 类。
- 无 LOS 判定（`magmaBreath` 仍穿墙）
- 平台不可破坏（票面要求 destroyable:false，已满足）

---

## 与设计票的偏差

| # | 设计票（`M3-04-arena-props.md`） | 实际落地 | 原因 / 影响 |
|---|---|---|---|
| 1 | 路径 A 示例代码用 `p.kind.startsWith('jump')` 过滤 | 改为按 `category === 'platform'` 过滤 | 平台 kind 有三个：`jumpLedge` / `jumpHigh` / **`bridgePier`**。按 `startsWith('jump')` 会漏掉 L3/L6/L9/L12 共 4 件 2.4 m 残墩，三级链断在第二级。按 category 过滤才是票面本意。 |
| 2 | 父票写平台用例 7 条 | 实际 `arenaProps.test.ts` 8 条，另有 `arenaPropsReach.test.ts` 5 条 | 拆成「逻辑/几何」与「可达性」两个文件；用例变多不是缩水，覆盖更细。 |
| 3 | 有向矩形按「旋转后外接 AABB」处理，最坏外扩 +1.4 m | 逻辑层已实现该保守策略，但本票只上平台，平台 `rotDeg = 0`，实际外扩为 0 | 该取舍留给遮挡物落地时生效；平台侧无精度损失。 |
| 4 | 路径 A 描述为「零代码改动」 | 实际新增了逻辑层 / 表现层 / config 三个文件，`GameLoop` 与 `App` / `main` 各改一处 | 票面原意是「不改物理规则」——`PlayerController` 一行未动，靠已有落地/吸附逻辑生效。这个判断是准确的。 |
| 5 | 未提及渲染实现细节 | 12 件合并为 2 个 draw call；八边形统一不旋转 | 见 `M3-04b` 的三条硬约束（只有边没有面 / 按材质合并 / 尺寸全来自 config）。 |
| 6 | 未规定描边是否动态 | 描边**纯静态**，不做每帧动画 | 按 Lead 范围收窄：本票只交付「碰撞盒 + 静态平台几何」，不引入任何每帧逻辑。静态描边已足够在纯黑场地里区分台面轮廓（见 lead-02-raw.png），动态化留给后续票。 |

---

## 回归状态

| 命令 | 结果 |
|---|---|
| `npx tsc --noEmit` | **PASS** — 0 error（exit 0，零输出）。首次曾有 2 条 TS6133（`src/render/Towers.ts`），已由 owner 修复 |
| `npx vitest run` | **PASS** — 22 files / 340 tests 全绿，0 失败 |
| `npm run build` | **PASS** — 78 modules，`out/assets/index-Dek9_HCW.js` 1238.91 kB（gzip 375.66 kB），2.62s |

命令原文见 `.tmp/gate-report.md`。
