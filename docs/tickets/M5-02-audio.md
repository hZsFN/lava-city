# 票 M5-02 · 音频接入（素材已有，缺的是把它接进游戏）

> **前提：音频素材已经做好了**，在 `public/audio/`，由 `tools/gen-audio.py` 程序化合成，零版权。共 5 个文件、约 300 KB：
>
> | 文件 | 用途 | 时长 |
> |---|---|---|
> | `bgm-molten-heart.ogg` | 主 BGM《渊底》，93 s 无缝循环 | 93 s |
> | `sfx-execution.ogg` | 击破：低频冲击 + 金属炸裂 | 2.6 s |
> | `sfx-weakness-open.ogg` | 弱点暴露：上扬金属共鸣 | 1.5 s |
> | `sfx-hit.ogg` | 受击：短促钝响 | 0.4 s |
> | `sfx-lava-rise.ogg` | 熔岩上涨：可循环低频涌动 | 7.4 s |
>
> **但代码里零引用，没有 `src/audio/` 目录——这五个文件躺在那儿没人播。本票就是把它接上。**

## 【范围】

```
src/audio/AudioPlayer.ts     （新建，唯一入口）
src/audio/soundMap.ts        （新建，事件 → 音效的映射表）
src/core/config/ui.json      （新增 audio 段：各音量初值）
tools/gen-audio.py           （只允许**追加**新音效，不许改已有五个的合成参数）
```

禁止改：`src/render/`、`src/game/`、`src/boss/`、`src/towers/`。

## 【技术要求】

### 1. 加载与播放

用 **Web Audio API + AudioBuffer**，不要 `<audio>` 标签：

```ts
const ctx = new AudioContext();                       // 必须在用户手势后创建
const buf = await fetch('audio/sfx-hit.ogg')
  .then(r => r.arrayBuffer())
  .then(a => ctx.decodeAudioData(a));
```

- 首次点击/按键时才 `new AudioContext()`（浏览器自动播放策略）。
- 相对路径 `audio/xxx.ogg`，不要写死 `/audio/`（build 后要能相对加载）。
- BGM 用 `AudioBufferSourceNode` + `loop = true`，循环点已经在文件里做过交叉淡化，直接 loop 即可。
- 音效每次播放 `new AudioBufferSourceNode`（轻量），播完自动回收。
- 同时播放上限 16，超出按优先级丢弃最旧的非关键音效。

### 2. 事件映射（`soundMap.ts`）

| 事件 | 音效 | 增益 | 备注 |
|---|---|---|---|
| 页面首次交互 | `bgm-molten-heart` | 0.35 | 开始循环 |
| `MatchPhaseChanged` → `wake`/`tutorial` | （BGM 不变） | 0.22 | 开头压低 |
| `MatchPhaseChanged` → `boss1` | （BGM 不变） | 0.40 | 进战斗抬起来 |
| `MatchPhaseChanged` → `boss2`/`rage` | （BGM 不变） | 0.50 | 再抬 |
| `MatchPhaseChanged` → `victory` | 渐弱 2 s 后停 | — | 让位给音效 |
| `WeaknessExposed` | `sfx-weakness-open` | 0.75 | **最重要，必须有** |
| `ExecutionStarted` | `sfx-execution` | 0.85 | 压过 BGM |
| `DamageDealt{target:'player'}` | `sfx-hit` | 0.6 | |
| `PlayerDied` | `sfx-execution` 降调播放 | 0.7 | 用 `playbackRate = 0.6` |
| `LavaLevelChanged`（`risePerSec > 0`） | `sfx-lava-rise` 循环 | 0.18 | 熔岩一涨就起，停涨渐弱 |
| `MatchEnded{result:'win'}` | 补一个胜利音（见下） | 0.8 | |
| `MatchEnded{result:'lose'}` | 补一个失败音（见下） | 0.7 | |

### 3. 需要补做的音效（用 `tools/gen-audio.py` 追加）

现有 5 个覆盖了"大事件"，**日常操作还是哑的**。按优先级补这四个：

1. **`sfx-swing.ogg`** — 挥砍：带通噪声 300 ms，1800→600 Hz 扫频，配 90 Hz 正弦尾。41 KB 以内。
2. **`sfx-tower-build.ogg`** — 建塔：三音上行（392/523/659 Hz），各 90 ms。20 KB。
3. **`sfx-tower-fire.ogg`** — 塔开火：60 Hz 低频 thump + 噪声，120 ms。20 KB。
4. **`sfx-alert.ogg`** — 阶段 II 警报：两音交替 440/620 Hz，0.8 s。20 KB。

追加时**照抄脚本里现有的写法**（`np.sin` + `np.exp` 包络 + `norm` + `sfx()`），不要引入新依赖。生成后同样 `ffmpeg -c:a libvorbis -q:a 4` 转 ogg，并同步更新 `public/audio/README.md` 的表格。

包体新增预算：**≤ 120 KB**（四个音效 + BGM 已在库里）。

### 4. 控制

- `M` 键静音 / 恢复（存 `localStorage`，下次进来保持）。
- `document.hidden` 时 `ctx.suspend()`，回来 `ctx.resume()`。
- 主音量 = BGM 音量 × 音效音量，两个滑块（可以只在调试面板里给，不一定要 UI）。

### 5. 定位（可选，做不完可跳）

Boss 相关的 `sfx-weakness-open` 与将来的 Boss 吼叫，用 `PannerNode` 按 Boss 相对方位做左右声道。做不完先做纯 2D 播放，但**弱点暴露那个音必须响**。

## 【验收】

1. `npm run typecheck` + `npm run build` + `node kit/tools/check.mjs out/` 全过。
2. 检查 `out/audio/` 里五个原始 ogg 都在（打包没漏）。
3. `npm run dev`，点一下页面 → **BGM 应当响起**（0.35 增益，能听出低频 drone 和心跳）。
4. 手动触发 `WeaknessExposed`（调试面板），能听到上扬的金属共鸣。
5. 触发 `ExecutionStarted`，能听到低频冲击 + 金属炸裂。
6. 切标签页 10 秒再回来，不应有音效堆积。
7. `M` 键静音有效，刷新后保持静音状态。
8. 交付说明里贴出：新增音效的生成命令、`out/audio/` 的文件清单与总大小。

## 【不许做的事】

- 不许找任何外部音频素材（已有的五个和要补的四个都必须出自 `gen-audio.py`）。
- 不许在页面加载时 `new AudioContext()`。
- 不许把 BGM 做成立即播放（必须等用户手势，否则 Chrome 会挂起并报警告）。
