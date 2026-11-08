# 熔心孤塔 · 音频接入说明

本包是独立素材交付，**尚未接入或修改原游戏**。`web/` 为游戏用 OGG，`masters/` 为 WAV 母带，`manifest.json` 为最终清单，`index.html` 为试听入口。下面的映射和参数是待接入建议，不代表已在游戏内运行验证；实际文件、时长、循环标记以最终清单为准。

## 1. 已确认的 demo 内容与限制

依据 `E:/demo/lava-city/docs/熔心孤塔_设计与AI开发规划.md`、`src/core/events.ts` 和 `src/core/config/flow.json`：游戏是第一人称塔防 × 两阶段 Boss 战，视觉与声音主题为熔岩、黑曜石、岩甲、符文、物理/法术弱点切换。

检查时的实现状态：

- `src` 未检出音频管理器、`AudioContext`、`new Audio` 或 OGG 播放接线；原有五个 OGG 资产不能视为已在游戏播放。
- `src/game/GameLoop.ts` 使用原点作为 Boss 占位目标，注释明确写着“Boss 未接入前”。`src/boss/` 当时只有 `BossEntity.ts` 与 `preview.ts`，引用的部分逻辑模块尚不在该目录。
- 设计稿中的 `TowerBuilt`、`LavaRise` 等名称不是当前契约；应使用 `TowerPlaced`、`LavaLevelChanged`。有事件声明也不等于当前主循环已发布该事件。
- `src/core/config/audio.json` 当前值为 master 0.8、music 0.55、sfx 0.9、ui 0.7、ambience 0.6。这些仅是原配置，未证实已经用于运行时混音。
- `tools/pack-level.ps1` 与 `kit/tools/check.mjs` 限制最终游戏 ZIP ≤12 MB，允许 OGG/WAV。只选用所需 `web/*.ogg`；母带、生产脚本和试听材料不随游戏打包。

原 `tools/gen-audio.py` 会写入原项目 `public/audio`；本包不需要执行该脚本。

## 2. 音乐与时间轴

表内文件位于 `web/`，扩展名均为 `.ogg`。按照事件切换，不要把真实游戏播放逻辑硬编码为墙钟倒计时。

| 事件条件 | 素材 ID | 播放方式 |
|---|---|---|
| `MatchPhaseChanged.phase = wake / prep` | `bgm-molten-heart` | 循环；wake→prep 保持当前进度，不重启 |
| `phase = boss1` | `bgm-boss-phase1` | 循环 |
| `phase = transition` | `bgm-phase-transition` | 单次；切阶段时停止旧转场，不叠加 |
| `phase = boss2` | `bgm-boss-phase2` | 循环 |
| `phase = rage` | `bgm-rage` | 循环 |
| `MatchEnded.result = win` | `bgm-victory` | 单次；先淡出循环与预警 |
| `MatchEnded.result = lose` | `bgm-defeat` | 单次；先淡出循环与预警 |

当前配置为 wake 0–20 秒、prep 20–40 秒、boss1 40–130 秒、transition 130–145 秒、boss2 145–245 秒、rage 245–270 秒。阶段可以提前结束；`phase=ended` 只负责停止玩法音轨，胜负乐句由 `MatchEnded` 决定，避免播两次。

转场曲 metadata 同时列出 `BossPhaseChanged` 与 `MatchPhaseChanged`，表示候选触发来源。本建议采用后者作为音乐调度依据，不同时无条件订阅两者播放；`events` 列表不是自动绑定规则。

订阅时机晚于初始化可能错过首个阶段事件。音频首次解锁后读取 `bus.snapshot().phase` 建立当前音乐状态；不要回放初始化前积攒的音效。

## 3. 音效映射与过滤

下表中“待补调用点”表示当前契约不足以准确触发，不能冒充已有事件。`*-a/b` 表示同一动作的两个变体。

| 素材 ID | 事件或调用点 | 必需过滤 / 注意事项 |
|---|---|---|
| `sfx-hit` | `PlayerDamaged` | 仅 `amount > 0`；忽略预览初始化的零伤害事件；冷却 80–120 ms |
| `sfx-player-death` | `PlayerDied` | 同一死亡次数只播一次；死亡优先于同帧受击 |
| `sfx-dash` | `PlayerDashed` | 每次事件一次，不依据持续按键或逐帧位移触发 |
| `sfx-form-switch` | `FormSwitched` | `form` 与前值不同时播放；首次快照初始化静默 |
| `sfx-overheat` | `OverheatChanged` | 仅 `overheated: false→true`；热量数值变化不重播 |
| `sfx-physical-shot-a/b` | 待补：实际物理攻击成功发起点 | 命中事件不能表示挥空/发射；动作冷却通过后才播，随机且避免连续同一变体 |
| `sfx-arcane-shot-a/b` | 待补：实际法术攻击成功发起点 | 不绑定每帧鼠标按住；按真实射击节奏触发，过热拒绝攻击时不播 |
| `sfx-weakness-open` | `WeaknessExposed` | 同一部位持续暴露时不重复播；重开窗口才触发 |
| `sfx-weakness-close` | `WeaknessClosed` | 仅已记录为打开的部位关闭时播；被击破关闭时可省略 |
| `sfx-execution` | `ExecutionEnded` 且 `damage > 0` | 主冲击只播一次；若未来动画另有实际命中回调，可移到该点，但不要同时绑定 Started 与 Ended |
| `sfx-tower-build` | `TowerPlaced` | 按新 `towerId` 去重；不要再从紧随其后的 `TowerHpChanged` 触发 |
| `sfx-tower-upgrade` | `TowerUpgraded` | 按 `towerId + level` 去重 |
| `sfx-tower-sell` | `TowerDestroyed.reason = sold` | 不再叠加摧毁音 |
| `sfx-tower-destroy` | `reason = broken / drowned` | 每个塔 ID 一次；同帧多塔被毁限制为 2 个声部 |
| `sfx-tower-ballista` | `TowerTargetHit.kind = ballista` | 当前事件是命中，可先作为命中反馈；未来发射动作需独立调用点，避免发射/命中双播同一音 |
| `sfx-tower-rune` | `TowerTargetHit.kind = rune` | 同上；要求 `amount > 0`，每塔独立冷却 |
| `sfx-tower-frost` | `FreezeProgressChanged` | 可作聚合冻结脉冲；事件无 towerId，不能定位某座塔。限频约 400 ms；满值时让冻结完成音优先 |
| `sfx-tower-quake` | `TowerInterruptRequested` | 只代表发出打断请求，不代表成功。当前实现并非每次震击都发请求；完整发射声仍需补动作点 |
| `sfx-tower-totem` | `TauntStarted` | 每个 `towerId` 每次新嘲讽一次；不要监听每帧 taunted 状态重播 |
| `sfx-freeze` | `FreezeFull` | 冻结完成一次；同帧 `BossSkillInterrupted.by=freeze` 不再重复触发 |
| `sfx-boss-windup` | `BossSkillStart.stage = windup` | 每次施法仅一次。契约无施法实例 ID，可用活动 skill/stage 状态去重，在 End/Interrupted 时清除 |
| `sfx-boss-slam` | `BossSkillStart.stage = active`，skill 为 `rockSweep / leapSlam / stonePillars / lavaCharge` | 暂作共用岩石冲击；最终动画命中点优先于阶段开始，不应两处同时播 |
| `sfx-boss-fire` | `stage = active`，skill 为 `fireRain / selfIgnite` | 火雨事件只表示技能开始，不表示每颗火球落地；落点音需独立命中回调 |
| `sfx-boss-breath` | `stage = active`，skill 为 `magmaBreath` | 单次持续声；按 `durationMs`、`BossSkillEnd`、`BossSkillInterrupted` 停止/淡出；不得擅自当作无缝循环 |
| `sfx-core-warning` | `CoreHpChanged` | 仅血量从 >25% 跨到 ≤25% 且仍存活时提醒；建议 5 秒冷却；恢复到 >30% 才重新武装 |
| `sfx-ui-confirm / sfx-ui-cancel` | 待补：UI 的成功确认 / 返回取消动作 | 建塔成功已有 build 音，避免同一次操作两声叠加；失败不能播 confirm |
| `sfx-lava-rise` | `LavaLevelChanged.risePerSec` | `0→正数` 启动一个循环，持续事件仅调音量；回到 0 时淡出 |
| `amb-lava / amb-tower` | 场景进入、退出与游戏暂停 | 各一个循环；首次解锁后启动，切阶段不重复创建 |

`coreDrain` 暂无专属持续汲取声，只有通用前摇；脚步、落地、玩家重生、可击破专属提示和岩桥断裂也未单列素材。需要时可另增资产；不要把清单外用途描述为已覆盖。

`DamageDealt` 与 `TowerTargetHit` 不能无区别同时绑定同一命中音：前者含 target/attr，后者由塔发布。资源计数 `MoteCountChanged` 也包含初值、消费和卖塔退款，不能每次变化都当作拾取。

## 4. 混音与并发建议

以下是初始调试值，需要在真实玩法中试听调整，不是已经验证的最终混音。

- 维持 music / sfx / ui / ambience 独立总线，主输出保留余量；母带无削波不代表多音叠加后无削波。
- 音乐切换用 0.6–1.2 秒等功率交叉淡化。同一目标曲目正在播放时不重新开始；正常最多 2 条音乐声部。转场单次音轨须跟随真正的阶段事件退出。
- Boss 预警和弱点打开优先于普通攻击。预警时音乐降低约 3 dB、持续约 0.5 秒；击破时可降低约 6 dB，20–40 ms 进入、600–900 ms 恢复。多次 ducking 取当前最强衰减，不逐次相乘。
- 初始总 SFX 上限可设为 16 个，普通射击/命中 6 个，塔音 5 个，UI 2 个。达到上限时先淘汰最旧普通射击或最远塔声，保留玩家受击、Boss 预警、弱点与击破。
- 使用音频时钟记录冷却。按 `(素材, 来源实体)` 限频；同类多个实体再设总并发上限。不要用全局冷却吞掉不同危险提示。
- 持续声保存一个播放句柄，状态变化只调 gain；循环素材采用清单里的 loop 标记和真实解码时长。切勿给所有 SFX 一律开启 loop。
- 只有具备可靠坐标的声源才做空间化。`TowerPlaced.pos` 可建 towerId→坐标表；`TowerTargetHit` 不直接带坐标，`FreezeProgressChanged` 也不带来源。音乐、UI、全局预警保持非空间声。
- 战术视图和击破慢动作期间建议维持音乐速度，音效/环境适度降音量。不能把游戏 timeScale 直接套给全部音频，尤其要保持提示音清楚。

## 5. 浏览器启动、暂停与销毁

1. 页面加载时可以准备清单与解码；第一次明确的“开始/启用声音”点击或键盘动作中创建/恢复 AudioContext，再启动当前阶段音乐。开始前保持静音，禁止解锁后补播一串旧音效。恢复失败要保留可点击的声音开关。
2. 手动暂停、页面隐藏或失去游戏焦点时，先短淡出，再暂停持续声/挂起 AudioContext；不要在隐藏页面继续累积待播放动作。UI 是否保留由暂停菜单需求决定。
3. 返回页面后等待继续操作，根据当前游戏快照恢复。如果游戏逻辑同时暂停，可恢复原循环位置；若逻辑继续推进，则进入新的当前阶段，丢弃过时音乐与音效。
4. 音频调度使用 AudioContext 的时钟，不用游戏逐帧计时直接推导已预约播放时间。恢复时重新计算尚未开始的调度，避免过期声音瞬间齐发。
5. 重开一局或卸载场景时取消所有事件订阅，停止并断开活动源，清空阶段/部位/塔 ID 去重状态和警告状态；解码后的音频缓存可保留复用。

## 6. 接入后的验收清单

- 用户手势前无自动播放；点击开始后曲目与当前阶段一致，暂停/恢复和重开不会叠出第二套音乐。
- wake→prep 不重启同曲；结算只有一首胜或败乐句；提前结算不等待预定 270 秒。
- 多次 `LavaLevelChanged` 只有一个上涨循环；同次弱点暴露、过热与死亡只播一次。
- 塔建成不会因为初始 HP 事件再播建造音；出售不会播摧毁音；冻结不会因两个相关事件重播。
- Boss 预警和弱点提示在满负载战斗中仍可听清；连续攻击、八塔活动时无明显削波或音量暴涨。
- 在目标浏览器试听至少两个完整循环及阶段交叉淡化；信号接缝检测通过仍需判断循环节奏和空间尾音是否自然。
- 以上游戏内项目本次均未执行，待获得接入原项目的授权后再实现和验证。
