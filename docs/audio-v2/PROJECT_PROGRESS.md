# 项目进度核查与 v2 音频补充依据

核查时间：2026-11-08 12:49–12:55，Asia/Shanghai。此次只读检查原游戏与工作副本，未执行 fetch、构建、测试、安装、提交或游戏接入。仅本音频包的新文件被写入。

## 当前结论

项目已有渲染场景、第一人称移动/碰撞/冲刺、五类塔的逻辑、阶段时间轴和局终接口。**完整 Boss 战尚未接入主循环；音频管理器和音频播放接线也尚未出现。** 本音频包是可供后续接入的资产，不能将“素材已制作”描述为“游戏已具备完整声效”。

本轮最关键的新变化是 **血量接力规则已经合并**：入口血量来自大厅存档，移除玩家自动回血和控制器复活方法，死亡立即交给 `failLevel`。音频设计应增加低血、死亡/失败的可靠反馈，不按旧设计新增正常玩法复活或回血音。

## 实时远端与本地工作区的区别

以下 PR 状态使用 GitHub 连接器实时读取，未通过修改本地 `.git` 来同步：

| 项 | 核查到的状态 | 音频影响 |
|---|---|---|
| [PR #1：玩家控制器与伤害模型](https://github.com/hZsFN/lava-city/pull/1) | 已合并，2026-11-08 12:28:55 | 具备移动/跳跃/冲刺/伤害基础；PR 的旧复活/回血描述已被 #2 覆盖 |
| [PR #2：血量接力](https://github.com/hZsFN/lava-city/pull/2) | 已合并，2026-11-08 12:45:05；合并提交 `d078b62` | 入口血量注入；Boss 命中接口固定扣1；受击1.2秒无敌；HP归零直接死亡/失败；不做正常玩法复活音 |
| [PR #3：架构与 PR 交付流程](https://github.com/hZsFN/lava-city/pull/3) | 已合并，2026-11-08 12:51:59；本机已观察到合并提交 `b36b155` | 新文档可作架构依据；不代表新增 Boss 或音频实现 |

PR #3 作者提供的门禁记录为16个测试文件、223条测试通过、构建与包检查通过。**这是 PR 中的提交方验收记录，本轮没有重跑，也不是完整实机 Boss 战验收。** 架构文档正文仍写18个测试文件，属于不同快照，不应混写为本轮实测。

通过连接器直接读取 `master/src/game/GameLoop.ts` 137–163行，也确认主循环仍使用原点作为 Boss 占位目标。因此这一结论并非只依赖可能过时的远端跟踪引用。

读取时 `E:/demo/lava-city` 工作区位于 `docs/pr-delivery-architecture @ da90795`，其源码仍在 PR #2 之前；本机远端跟踪引用 `origin/master` 在检查期间推进到 `b36b1553cc6bae0f0f702324521d84b8e0ec228b`。本报告的最新规则分析以该已合并版本为准，不修改本地分支。

四个工作副本亦已只读检查：

| 目录 | 分支 / HEAD | 与此次最新规则的关系 |
|---|---|---|
| `wt-p2a` | `feat/p2a-player-combat @ d32afe9` | 较早的玩家分支，不能据其旧复活逻辑覆盖已合并的血量接力规则 |
| `p2b-1` | `feat/p2b-towers @ c696901` | 塔位、建拆、耐久与集成测试交接 |
| `p2b-2` | `feat/p2b-kinds @ fed8869` | 五塔行为交接 |
| `p2b-3` | `feat/p2b-flow @ 34728e3` | 时间轴、评分与遥测交接 |

读取时上述工作副本 `git status --short` 均无输出。它们与新主干存在历史差异，报告不把旧分支的提交数量当成功能完成百分比。

## 已实现与仍待接线的事实

后续代码引用固定在 `b36b155`，避免把本地旧分支和最新主干的行号混用。

| 功能 | 当前证据 | 对声音的结论 |
|---|---|---|
| 玩家移动、跳跃、冲刺和落地 | `PlayerController` 有 `isGrounded`、`handleJump`、`integrateVertical`；`PlayerMoved`、`PlayerDashed` 有实际发布 | 冲刺已有事件；脚步/跳跃/落地值得补，但须增加动作调用点或经逻辑适配器用落地状态与位移判定 |
| 血量接力与死亡 | `main.ts:71` 注入存档血量；`:93` 订阅 `PlayerDied` 并调用 `failLevel`；控制器移除了 `respawn()` | 新增低血提示；死亡音和失败乐句须由统一局终状态去重 |
| 复活 | `PlayerRespawned` 仍留在契约中，但最新控制器没有对应发布；入口还保留 R 调试调用 `WL.respawn()` | 契约残留和调试桥接不等于正常复活玩法；本轮不制作常规复活/回血资产 |
| 五种防御塔 | `TowerSystem` 已接入；各 kind 的行为注册存在；建造/升级/销毁/塔位事件有实际发布 | 已有塔声可继续使用；可以补解锁、淹没、拒绝操作等反馈 |
| Boss | `GameLoop.ts:150` 明确为占位目标；`src/boss` 只有 `BossEntity.ts` 与 `preview.ts`，所需部分依赖未在该提交中 | Boss 配乐和专属动作声属于准备好的未来接入素材，不能称已能在主循环触发 |
| 玩家武器/击破 | `src/combat` 仅有伤害计算纯函数；Q/F 的 consume 方法有定义，但主入口没有调用；相关事件未检出实际发布方 | 物理/法术射击、击破 ready/windup 等先做资产，接入时仍需实际攻击/击破动作点 |
| 战术视图 | `TacticalViewChanged` 只有契约，未检出当前主循环发布 | 战术音乐与开闭音可作为预备，不能无条件绑定“存在这个类型” |
| 流程 | `MatchTimeline` 负责 wake→prep→boss1→transition→boss2→rage→ended，`MatchEnded` 会在其局终路径发出 | 分阶段音乐、准备倒计时和胜负音乐有清晰调度基础 |
| 桥梁 | `Spire.ts:390` 是静态造桥逻辑；未检出实际断桥系统/事件 | 断桥声仅为文档中转阶段设计的预备素材，不直接随所有阶段切换播放 |
| 核心汲取 | Boss 表现文件中有 `coreDrain` 技能分支，但 Boss 主循环未接入 | 可补汲取持续声与打断声，按未来 active / End / Interrupted 控制句柄 |
| 音频播放 | 已核查源码没有 `AudioContext`、`new Audio`、`.ogg` 资源加载或独立 `src/audio` 实现 | 本轮不接入，避免越过原项目只读边界 |

代码证据：[主循环占位](https://github.com/hZsFN/lava-city/blob/b36b1553cc6bae0f0f702324521d84b8e0ec228b/src/game/GameLoop.ts#L150)、[死亡出口](https://github.com/hZsFN/lava-city/blob/b36b1553cc6bae0f0f702324521d84b8e0ec228b/src/main.ts#L91)、[落地状态](https://github.com/hZsFN/lava-city/blob/b36b1553cc6bae0f0f702324521d84b8e0ec228b/src/player/PlayerController.ts#L140)、[输入消费接口](https://github.com/hZsFN/lava-city/blob/b36b1553cc6bae0f0f702324521d84b8e0ec228b/src/game/Input.ts#L120)、[造桥逻辑](https://github.com/hZsFN/lava-city/blob/b36b1553cc6bae0f0f702324521d84b8e0ec228b/src/render/Spire.ts#L390)。

## v2 补充优先级与触发约束

这是制作与接入依据，最终实际交付文件以本目录 `manifest.json` 和 `CATALOG.md` 为准，不将候选清单当成已经生成的素材。

| 优先级 | 补充方向 | 可执行的接入约束 |
|---|---|---|
| P0 | 更有力的两阶段 Boss / 狂暴音乐 | 加强节奏、低音和主题推进；按 `MatchPhaseChanged.phase` 切换，不能仅依据固定墙钟时刻 |
| P0 | 独立布防音乐 | `phase=prep`，与苏醒音乐拉开节奏；Boss 开战时退出，不同时叠两首完整曲目 |
| P0 | 脚步4变体、跳跃、轻/重落地 | 当前没有对应事件；落地状态且实际水平移动后按距离累计步频，空中/冲刺/原地/暂停不播脚步。跳跃成功起跳时触发，落地按空中→落地边沿及下落强度选择 |
| P0 | 玩家低血提示 | `PlayerDamaged.amount>0` 后首次跨入低血区；阈值建议 `max(1, ceil(maxHp*0.25))`。入口初值先读快照，不误当受击；失败后停止重复预警 |
| P0 | 准备倒数和开战提示 | 用 `game.timeline.tSec()` 与 `endsAtSec()` 计算剩余时间，只在最后数秒的整数边沿发声。不能逐帧播tick，也不能重启阶段音乐 |
| P0 | UI错误/建造拒绝 | `towers.place/upgrade` 失败通常返回false且零事件，必须从调用结果触发，不能等待不存在的失败事件 |
| P1 | 塔位解锁、淹没 | `TowerSlotStateChanged` 的实际状态变化；初始化静默；同帧多槽聚合，避免11声同时播放 |
| P1 | 资源增加提示 | `MoteCountChanged` 有初始化/消费/售出退款/调试设值。可只做通用“增加确认”，不要未经区分当成拾取；售出音与资源音去重 |
| P1 | 施法打断、膝甲破碎、火雨落点、汲取持续声、可击破就绪/前摇 | 有契约或设计依据，Boss/攻击链尚需接入。必须区分 windup/active/recovery，持续声按 End/Interrupted 退出 |
| 预备 | 战术音乐、开闭音和断桥声 | 当前无完整玩法发布，元数据须标为预备/待补调用点；不得声称已在当前 demo 自动运行 |

## 两处会直接影响新音乐接线的风险

1. **失败乐句不能只等 `MatchEnded`。** 最新 `main.ts` 在 `PlayerDied` 中直接 `failLevel`，并用 `failed` 防止后续重复提交；当前主循环没有把该死亡路径先转换成时间轴 `MatchEnded`。音频调度应在死亡路径立即停止战斗循环、播放一次失败乐句，并在后续 `MatchEnded` 到来时去重。不要为声音擅自修改事件契约。
2. **不能直接用现有快照做逐秒倒计时。** `events.ts:239` 仅在 `MatchPhaseChanged` 时写入 `snapshot.tSec`，`phaseEndsAtSec` 初始为0，未检出主循环持续写回。可从已实现的 `timeline.tSec()/endsAtSec()` 读取；未来若更换为只读快照，需要先由对应 owner 完成数据同步。

时间轴证据：[实时读时接口](https://github.com/hZsFN/lava-city/blob/b36b1553cc6bae0f0f702324521d84b8e0ec228b/src/flow/MatchTimeline.ts#L227)、[阶段事件快照写回](https://github.com/hZsFN/lava-city/blob/b36b1553cc6bae0f0f702324521d84b8e0ec228b/src/core/events.ts#L236)。

## 旧文档使用说明

`docs/PLAN.md` 状态仍标11:30；`handoff/S1–S4` 多为模板。B1/B2/B3交接更具体，但包括早先 Boss 导致门禁失败的历史记录。最新架构说明将 `src/boss` 排除在类型检查外，最新 PR 的门禁通过也不能证明 Boss 缺失依赖已经补齐。

本轮以“最新已合并代码 + 实时 PR 状态 + 明确时间戳”核对，保留设计稿作为未来音色与素材预备依据。所有游戏内触发、混音与主观听感仍需后续实际接入验收。
