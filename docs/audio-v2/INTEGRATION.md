# 熔心孤塔 · 音频接入说明 V2

本包是独立素材交付，**尚未接入或修改原游戏**。`web/` 为游戏用 OGG，`masters/` 为 WAV 母带，`manifest.json` 为最终清单（实际文件、时长、循环标记、实测响度以它为准），`index.html` 为试听入口。下面的映射和参数是待接入建议，不代表已在游戏内运行验证。

V1 原版说明保留在 [INTEGRATION-v1-reference.md](INTEGRATION-v1-reference.md)；本文件在其基础上按 [PROJECT_PROGRESS.md](PROJECT_PROGRESS.md) 的最新进度核查更新。

## 1. 已确认的 demo 内容与限制

- `src` 未检出音频管理器、`AudioContext`、`new Audio` 或 OGG 播放接线；原有五个 OGG 资产不能视为已在游戏播放。
- 主循环 `src/game/GameLoop.ts` 仍以原点作为 Boss 占位目标；Boss 技能、弱点、击破相关声音是**预备素材**，需 Boss 主循环接入后才有触发源。
- 血量接力规则（PR #2）已合并：入口血量来自大厅存档，HP 归零直接 `failLevel`，无常规复活/回血。因此 V2 新增低血警告，不制作复活音；`PlayerRespawned` 仅是契约残留。
- 设计稿中的 `TowerBuilt`、`LavaRise` 等不是当前契约；应使用 `TowerPlaced`、`LavaLevelChanged`。有事件声明也不等于当前主循环已发布该事件。
- `src/core/config/audio.json` 当前值为 master 0.8、music 0.55、sfx 0.9、ui 0.7、ambience 0.6，未证实已用于运行时混音。
- 最终游戏 ZIP ≤12 MB。只选用所需 `web/*.ogg`（全部 67 项约 3.1 MiB）；母带、raw、报告和制作脚本不随游戏打包。

原项目 `tools/gen-audio.py` 会写入原项目 `public/audio`；本包不需要执行该脚本。

## 2. 音乐与时间轴

表内文件位于 `web/`，扩展名均为 `.ogg`。按事件切换，不要硬编码墙钟倒计时。

| 事件条件 | 素材 ID | BPM / 时长 | 播放方式 |
|---|---|---|---|
| `MatchPhaseChanged.phase = wake` | `bgm-molten-heart` | 96 / 40 s | 循环 |
| `phase = prep` | `bgm-preparation` | 120 / 32 s | 循环；与苏醒曲 BPM 不同，用 0.8–1.2 s 交叉淡化 |
| `phase = boss1` | `bgm-boss-phase1` | 150 / 51.2 s | 循环；前 4 小节为 braam 开场，循环回到开头时作为段落重启 |
| `phase = transition` | `bgm-phase-transition` | 144 / 10 s | 单次；阶段提前结束时淡出，不叠加 |
| `phase = boss2` | `bgm-boss-phase2` | 150 / 51.2 s | 循环；与 boss1 同 BPM，可按小节边界（1.6 s）切换 |
| `phase = rage` | `bgm-rage` | 160 / 24 s | 循环；BPM 不同，用交叉淡化 |
| `MatchEnded.result = win` | `bgm-victory` | 12 s | 单次；先淡出循环与预警 |
| `MatchEnded.result = lose` 或 `PlayerDied` | `bgm-defeat` | 8 s | 单次；见下方去重 |
| 预备：`TacticalViewChanged.open = true` | `bgm-tactical` | 96 / 20 s | 循环；当前主循环未发布该事件 |

- 若不想拆分 wake/prep，可让 `bgm-molten-heart` 覆盖两阶段（V1 做法），但不要两首同时播放。
- **失败乐句去重**：最新 `main.ts` 在 `PlayerDied` 中直接 `failLevel`，不一定先发 `MatchEnded`。音频调度应在死亡路径立即停止战斗循环并播放一次 `bgm-defeat`，随后到来的 `MatchEnded(lose)` 不再重播。不要为声音修改事件契约。
- `phase=ended` 只负责停止玩法音轨，胜负乐句由 `MatchEnded` / 死亡路径决定。
- 订阅时机晚于初始化可能错过首个阶段事件。音频首次解锁后读取 `bus.snapshot().phase` 建立当前音乐状态。
- 战术曲：未来接入时替换主音乐并降低节奏层，转场/危险提示优先；关闭时淡回当前阶段曲。

## 3. V1 沿用音效映射与过滤

“待补调用点”表示当前契约不足以准确触发。`*-a/b` 是同一动作的两个变体。

| 素材 ID | 事件或调用点 | 必需过滤 / 注意事项 |
|---|---|---|
| `sfx-hit` | `PlayerDamaged` | 仅 `amount > 0`；冷却 80–120 ms |
| `sfx-player-death` | `PlayerDied` | 同一局只播一次；`cause=lava` 时改用 `sfx-lava-fall`，两者不叠 |
| `sfx-dash` | `PlayerDashed` | 每次事件一次 |
| `sfx-form-switch` | `FormSwitched` | `form` 与前值不同时播放；首次快照静默 |
| `sfx-overheat` | `OverheatChanged` | 仅 `overheated: false→true` |
| `sfx-physical-shot-a/b` | 待补：物理攻击成功发起点 | 冷却通过后才播；随机且避免连续同一变体 |
| `sfx-arcane-shot-a/b` | 待补：法术攻击成功发起点 | 过热拒绝攻击时不播 |
| `sfx-weakness-open` | `WeaknessExposed` | 同一部位持续暴露时不重复播 |
| `sfx-weakness-close` | `WeaknessClosed` | 仅已记录为打开的部位；被击破关闭时可省略 |
| `sfx-execution` | `ExecutionEnded` 且 `damage > 0` | 主冲击只播一次 |
| `sfx-tower-build` | `TowerPlaced` | 按 `towerId` 去重；不从 `TowerHpChanged` 触发 |
| `sfx-tower-upgrade` | `TowerUpgraded` | 按 `towerId + level` 去重 |
| `sfx-tower-sell` | `TowerDestroyed.reason = sold` | 不叠摧毁音；与 `sfx-mote-gain` 去重 |
| `sfx-tower-destroy` | `reason = broken / drowned` | 每塔一次；同帧多塔限 2 声部；`drowned` 同帧有 `sfx-slot-submerged` 时二选一 |
| `sfx-tower-ballista` / `sfx-tower-rune` | `TowerTargetHit.kind` | `amount > 0`；每塔独立冷却 |
| `sfx-tower-frost` | `FreezeProgressChanged` | 限频约 400 ms；满值时让 `sfx-freeze` 优先 |
| `sfx-tower-quake` | `TowerInterruptRequested` | 只代表发出请求，不代表成功 |
| `sfx-tower-totem` | `TauntStarted` | 每 `towerId` 每次新嘲讽一次 |
| `sfx-freeze` | `FreezeFull` | 同帧 `BossSkillInterrupted.by=freeze` 不再触发打断音 |
| `sfx-boss-windup` | `BossSkillStart.stage = windup` | 每次施法一次；End/Interrupted 清除状态 |
| `sfx-boss-slam` | `stage = active`，skill 为 `leapSlam` | V2 已为 `rockSweep / stonePillars / lavaCharge` 提供专属音，优先使用专属音 |
| `sfx-boss-fire` | `stage = active`，skill 为 `fireRain` | 只表示技能开始；落点用 `sfx-boss-fire-rain-impact` |
| `sfx-boss-breath` | `stage = active`，skill 为 `magmaBreath` | 按 `durationMs`/End/Interrupted 淡出 |
| `sfx-core-warning` | `CoreHpChanged` | >25%→≤25% 时提醒；5 秒冷却；>30% 才重新武装 |
| `sfx-ui-confirm / sfx-ui-cancel` | 待补：UI 成功 / 取消 | 失败用 `sfx-ui-error`，不能播 confirm |
| `sfx-lava-rise` | `LavaLevelChanged.risePerSec` | `0→正数` 启动一个循环，回到 0 淡出 |
| `amb-lava / amb-tower` | 场景进入、退出与暂停 | 各一个循环；切阶段不重复创建 |

## 4. V2 新增音效

`implementation_status`（见 metadata/manifest）：`observed_event` = 当前代码已有发布方；`needs_action_hook` / `needs_timeline_scheduler` = 需新增调用点；`contract_only` = 契约存在但未检出发布方；`planned_boss` = Boss 主循环接入后可用。

| 素材 ID | 触发 | 状态 | 过滤 / 注意事项 |
|---|---|---|---|
| `sfx-footstep-stone-01…04` | 落地且水平累计距离达到步幅 | needs_action_hook | 四变体轮换不连重复；空中/冲刺/静止/暂停不播；建议 -7 dB |
| `sfx-jump` | 起跳成功调用点 | needs_action_hook | 不绑定空格按下；拒绝跳跃不播 |
| `sfx-land-light` / `sfx-land-heavy` | 空中→落地边沿 | needs_action_hook | 按下落距离/速度二选一；出生落地、台阶吸附静默 |
| `sfx-lava-fall` | `PlayerDied.cause = lava` | observed_event | 替代通用死亡音 |
| `sfx-player-low-health` | `PlayerDamaged.amount > 0` 且 hp 首次跨入 `0 < hp ≤ max(1, ceil(maxHp*0.25))` | observed_event | 冷却 5 秒；死亡优先；入口血量快照不当作受击 |
| `sfx-mote-gain` | `MoteCountChanged` 正增量 | observed_event | 初始化/调试设值静默；售塔退款与出售音去重 |
| `sfx-slot-unlock` | `TowerSlotStateChanged` locked→open | observed_event | 初始化静默；同帧多槽合并为一次；拆塔 occupied→open 不算 |
| `sfx-slot-submerged` | `TowerSlotStateChanged` →submerged | observed_event | 同帧 `TowerDestroyed(drowned)` 只保留一个优先声 |
| `sfx-countdown-tick` | prep 最后 3 秒整数边沿 | needs_timeline_scheduler | 读 `timeline.tSec()/endsAtSec()`，不用 `snapshot.tSec`；后台恢复不补播 |
| `sfx-countdown-final` | `MatchPhaseChanged.phase = boss1` 首次进入 | observed_event | 代替倒数 0；不得同时从倒数调度触发 |
| `sfx-ui-error` | `place/upgrade` 返回 false | needs_action_hook | 当前无失败事件，必须由调用结果触发 |
| `sfx-execution-ready` | `WeaknessProgress.executable` false→true | contract_only | 每个部位每次窗口一次 |
| `sfx-execution-windup` | `ExecutionStarted` | contract_only | 不含最终重击；Ended 再播 `sfx-execution` |
| `sfx-boss-interrupted` | `BossSkillInterrupted.by = interrupt / stagger` | contract_only | `by=freeze` 用 `sfx-freeze`，不双播 |
| `sfx-boss-core-drain` | `BossSkillStart` skill=`coreDrain`, stage=`active` | planned_boss | **循环**；保存单一句柄，End/Interrupted/阶段退出淡出；建议 -6 dB |
| `sfx-boss-rock-sweep` | skill=`rockSweep` active | planned_boss | 命中另用受击反馈 |
| `sfx-boss-stone-pillar` | skill=`stonePillars` active | planned_boss | 多岩柱同帧合并限流 |
| `sfx-boss-lava-charge` | skill=`lavaCharge` active | planned_boss | 技能提前中断则淡出 |
| `sfx-boss-self-ignite` | skill=`selfIgnite` active | planned_boss | 单次，不每帧重播 |
| `sfx-boss-fire-rain-impact` | 每颗火雨落点回调 | needs_action_hook | 契约缺逐落点事件；不可用 BossSkillStart 代替；同帧限 3 声部 |
| `sfx-tactical-open` / `sfx-tactical-close` | `TacticalViewChanged.open` 边沿 | contract_only | 初始化静默；不与普通取消音重复 |

metadata 中的 `suggested_mix_gain_db` 是相对总线的初始建议值，`events` 列表是候选来源，不是自动绑定规则。

## 5. 混音与并发建议

以下是初始调试值，需要在真实玩法中试听调整。

- 维持 music / sfx / ui / ambience 独立总线。V2 Boss 曲目母带约 -16 LUFS，比 V1 (-18) 更响，接入时 music 总线可先下调约 2 dB 再试听。
- 音乐切换用 0.8–1.2 秒等功率交叉淡化；同目标曲目正在播放时不重启；正常最多 2 条音乐声部。
- Boss 预警、弱点、可击破信号和低血警告优先于普通攻击。预警时音乐降约 3 dB、约 0.5 秒；击破降约 6 dB，20–40 ms 进入、600–900 ms 恢复。多次 ducking 取最强衰减。
- 初始 SFX 上限 16：普通射击/命中 6，塔音 5，脚步 2，UI 2。超限先淘汰最旧普通射击或最远塔声，保留受击、低血、Boss 预警、弱点与击破。
- 用音频时钟记录冷却，按 `(素材, 来源实体)` 限频。
- 持续声（`sfx-lava-rise`、`sfx-boss-core-drain`、环境）保存一个句柄，状态变化只调 gain；只对清单 `loop=true` 的素材开启循环。
- 只有具备可靠坐标的声源才做空间化（`TowerPlaced.pos` 可建 towerId→坐标表）；音乐、UI、全局预警保持非空间声。
- 战术视图和击破慢动作期间维持音乐速度，不把 timeScale 直接套给全部音频。

## 6. 浏览器启动、暂停与销毁

1. 第一次明确的用户手势中创建/恢复 AudioContext，再启动当前阶段音乐；禁止解锁后补播旧音效；恢复失败保留声音开关。
2. 暂停、页面隐藏或失焦时短淡出，再暂停持续声/挂起 AudioContext。
3. 返回后按当前游戏快照恢复；逻辑继续推进过则进入新阶段，丢弃过时音乐与音效。
4. 调度使用 AudioContext 时钟；恢复时重新计算未开始的调度，避免过期声音齐发。
5. 重开一局或卸载场景时取消订阅、停止活动源，清空阶段/部位/塔 ID/低血/失败去重状态；解码缓存可复用。

## 7. 接入后的验收清单

- 手势前无自动播放；开始后曲目与当前阶段一致，暂停/恢复/重开不叠出第二套音乐。
- wake→prep→boss1 切换自然；倒计时最后 3 秒各一声，进入 boss1 只有一次开战音。
- 结算只有一首胜或败乐句；HP 归零直接失败时失败乐句立即出现且不因 `MatchEnded` 重播。
- 低血警告只在跨入阈值时出现，入口低血量不误报；坠入熔岩不叠两套死亡音。
- 脚步只在地面移动时出现，冲刺/空中/静止不播；轻重落地互斥。
- 多次 `LavaLevelChanged` 只有一个上涨循环；塔位同帧多槽解锁只有一声。
- 满负载战斗中 Boss 预警、弱点、可击破提示仍清楚，无明显削波。
- 目标浏览器试听至少两个完整循环及阶段交叉淡化。
- 以上游戏内项目本次均未执行，待获得接入原项目的授权后再实现和验证。
