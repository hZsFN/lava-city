# 票 M5-02 · 音频接入（素材已全量入库，缺的是把它接进游戏）

> **前提：67 个音频文件已经在 `public/audio/`（提交 `08036c1`），共 3.42 MB，全部由 `tools/gen-audio.py` 程序化合成。**
> **但 `src/audio/` 目录不存在，代码里零引用——现在这游戏是完全静音的。本票就是把它接上。**
> 不需要再合成任何音效，素材已经齐了。只允许新建 `src/audio/`，改 `src/core/config/ui.json` 的 audio 段。

## 【第一步：加载器】

新建 `src/audio/AudioPlayer.ts`，用 **Web Audio API + AudioBuffer**，不要 `<audio>` 标签：

```ts
const ctx = new AudioContext();                       // 必须在用户手势后创建
const buf = await fetch('audio/sfx-hit.ogg')          // 相对路径，别写 /audio/
  .then(r => r.arrayBuffer())
  .then(a => ctx.decodeAudioData(a));
```

**关键约束**：

- 首次点击/按键才 `new AudioContext()`。页面加载时创建会被 Chrome 挂起并报警告。
- 67 个文件不能一次性全解码（内存吃不消）。**分批**：BGM 9 个 + 环境 2 个先加载齐，56 个音效按"当前阶段可能用到"的组按需加载（进战斗才解 Boss 那 11 个）。
- 同时播放上限 16，超出按优先级丢弃最旧的非关键音效。
- 每次 `play(name)` 时 `new AudioBufferSourceNode`（轻量，播完自动回收）。

## 【第二步：BGM 按阶段切换】

用 `AudioBufferSourceNode` + `loop = true`，切歌时**交叉淡化 0.8 s**（旧轨 `gain` 线性降到 0 再 `stop()`）：

| 阶段 | BGM | 增益 |
|---|---|---|
| `wake` / `tutorial` | `bgm-preparation` | 0.30 |
| `prep` | `bgm-preparation` | 0.35 |
| `boss1` | `bgm-boss-phase1` | 0.42 |
| `transition` | `bgm-phase-transition` | 0.45（不循环，播完切下一首） |
| `boss2` | `bgm-boss-phase2` | 0.45 |
| `rage` | `bgm-rage` | 0.50 |
| `victory` | `bgm-victory` | 0.55 |
| `escape` | `bgm-victory` 继续 | 渐弱到 0 |
| `MatchEnded{result:'lose'}` | `bgm-defeat` | 0.55 |

**环境铺底**（独立于 BGM，全程循环）：`amb-lava` 增益 0.12、`amb-tower` 增益 0.08。熔岩上涨时 `amb-lava` 增益线性提到 0.22（跟 `LavaLevelChanged` 的 y 走）。

**`bgm-tactical` 只有做了战术视图才播**，没做就跳过。

## 【第三步：事件 → 音效映射】

### P0（不做就等于没声音）

| 事件 | 文件 | 增益 |
|---|---|---|
| `WeaknessExposed` | `sfx-weakness-open` | 0.80 |
| `WeaknessClosed` | `sfx-weakness-close` | 0.60 |
| `ExecutionStarted` | `sfx-execution` | 0.90 |
| `ExecutionReady`（破绽环满） | `sfx-execution-ready` | 0.70 |
| `DamageDealt{target:'player'}` | `sfx-hit` | 0.60 |
| `PlayerDied` | `sfx-player-death` | 0.85 |
| `player.hp <= 1`（首次进入） | `sfx-player-low-health` | 循环，0.25 |
| `MatchPhaseChanged → boss1/boss2/rage` | 对应 BGM | — |

### P1（战斗手感）

| 事件 | 文件 | 增益 |
|---|---|---|
| 物理普攻 | `sfx-physical-shot-a` / `-b`（交替） | 0.55 |
| 法术普攻 | `sfx-arcane-shot-a` / `-b`（交替） | 0.50 |
| `PlayerDashed` | `sfx-dash` | 0.55 |
| `formSwitch` | `sfx-form-switch` | 0.60 |
| 玩家落地/移动 | `sfx-footstep-stone-01..04` 轮播 | 0.35 |
| `BossSpawned` | `sfx-boss-windup` | 0.80 |

### P1（Boss 技能，按 `BossSkillCast` 的 skill 名映射）

| skill | 文件 |
|---|---|
| `rockSweep` | `sfx-boss-rock-sweep` |
| `leapSlam` | `sfx-boss-slam`（起跳用 `sfx-boss-windup`） |
| `magmaBreath` | `sfx-boss-breath` |
| `stonePillars` | `sfx-boss-stone-pillar` |
| `lavaCharge` | `sfx-boss-lava-charge` |
| `coreDrain` | `sfx-boss-core-drain` |
| 自我点燃 / 狂暴 | `sfx-boss-self-ignite` |
| 被打断 | `sfx-boss-interrupted` |
| 火雨落点 | `sfx-boss-fire-rain-impact` |
| 火焰持续 | `sfx-boss-fire`（循环，结束停） |

### P1（塔）

| 事件 | 文件 |
|---|---|
| `TowerPlaced` | `sfx-tower-build` |
| `TowerUpgraded` | `sfx-tower-upgrade` |
| `TowerSold` | `sfx-tower-sell` |
| `TowerDestroyed` | `sfx-tower-destroy` |
| 弩炮塔开火 | `sfx-tower-ballista` |
| 符文塔开火 | `sfx-tower-rune` |
| 寒晶塔 | `sfx-tower-frost` |
| 震地锚塔 | `sfx-tower-quake` |
| 嘲讽图腾 | `sfx-tower-totem` |
| `TowerSlotStateChanged → open` | `sfx-slot-unlock` |
| `TowerSlotStateChanged → submerged` | `sfx-slot-submerged` |

### P1（界面与节奏）

| 事件 | 文件 |
|---|---|
| 按钮确认 / 取消 / 出错 | `sfx-ui-confirm` / `sfx-ui-cancel` / `sfx-ui-error` |
| 最后 30 s | `sfx-countdown-tick`（每秒） |
| 最后 10 s | `sfx-countdown-final`（每秒，更高） |
| 塔心血量 < 30% | `sfx-core-warning`（每 3 s 一次，低音量） |

**同一音效 50 ms 内不重复播放**（防止塔群齐射时爆音）。

## 【第四步：控制】

- `M` 键静音 / 恢复，状态存 `localStorage`。
- `document.hidden` → `ctx.suspend()`；恢复可见 → `ctx.resume()`。
- 主音量 × BGM 音量 × 音效音量，三个值进 `ui.json` 的 `audio` 段，默认 0.8 / 0.5 / 0.8。

## 【第五步：空间定位（P2，可跳）】

`sfx-weakness-open`、`sfx-boss-*` 用 `PannerNode` 按 Boss 相对玩家方位做左右声道，40 m 外衰减到 0。做不完跳过后两条，但**弱点暴露必须做定位**——玩家要靠声音判断它在哪。

## 【验收】

1. `npm run typecheck` + `npm run build` + `node kit/tools/check.mjs out/` 全过。
2. `out/audio/` 里 67 个 ogg 全部在（打包没漏）。
3. `npm run dev`，点一下页面 → BGM 响起，能听出低频 drone 与心跳。
4. 手动触发 `WeaknessExposed` → 上扬金属共鸣；`ExecutionStarted` → 低频冲击加金属炸裂。
5. 进 boss2 → BGM 换轨，**交叉淡化不出现断续**。
6. 切标签页 10 秒再回来 → 无音效堆积播放。
7. `M` 键静音有效，刷新后保持。
8. 交付说明贴：加载策略（分批方案）、同时播放上限的实际观测值、`out/audio` 文件清单与总大小。

## 【不许做的事】

- 不许再合成新音效（素材已齐）。
- 不许找任何外部音频。
- 不许在页面加载时 `new AudioContext()`。
- 不许改成 `<audio>` 标签（延迟高、不能叠加、无法精确控制增益曲线）。
