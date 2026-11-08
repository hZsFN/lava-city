# P2-B 三路分工协议（塔系统 + 流程）

> 版本 v2.0 · 2026-11-08 11:40
> **三个对话共同完成 P2-B。** 本文件定义三路的边界、接口与交接。
> 技术事实源：`docs/熔心孤塔_设计与AI开发规划.md`
> 契约事实源：`src/core/events.ts`（只读）+ `src/towers/types.ts` + `src/flow/types.ts`

---

## 0. 三十秒版

| 路 | 目录 | 分支 | 写什么 |
|---|---|---|---|
| **B1** | `E:\demo\p2b-1` | `feat/p2b-towers` | 塔位、塔实体、建/升/拆、耐久、TowerSystem 门面 |
| **B2** | `E:\demo\p2b-2` | `feat/p2b-kinds` | 五种塔的具体行为（kinds/*.ts） |
| **B3** | `E:\demo\p2b-3` | `feat/p2b-flow` | 4:30 时间轴、熔岩、塔心、评分、遥测 |

**三条铁律**
1. `src/core/**` 一个字不能改（events.ts + 所有 config）
2. 逻辑层禁止 `import three`
3. 提交前 `npm run gate` 必须全绿

---

## 1. 为什么这样切

```
┌──────────────────────────────────────────────────────────┐
│  src/towers/types.ts  +  src/flow/types.ts               │
│  （S0 已建好，三路都 import，谁都不改）                     │
└──────────────────────────────────────────────────────────┘
        ↓                    ↓                    ↓
   ┌─────────┐         ┌──────────┐         ┌──────────┐
   │   B1    │         │    B2    │         │    B3    │
   │ 塔位/塔 │◄────────│ 五种塔行为│         │ 时间轴   │
   │ 建升拆  │  B1 调用 │ kinds/*  │         │ 熔岩/评分│
   │ 耐久    │  B2 实现 │ 填注册表 │         │ 遥测     │
   └─────────┘         └──────────┘         └──────────┘
        │                    │                    │
        └────────────┬───────┘                    │
                     ↓                            ↓
              TowerSystem 门面            MatchTimeline
                     └────────────┬───────────────┘
                                  ↓
                        S0 集成期接线 src/main.ts
```

**关键设计**：B1 定义 `TowerRuntime` 和 `TowerBehavior` 接口，B2 只实现接口，**B1 不需要知道 B2 写了什么**。B2 写完一个塔就在 `kinds/index.ts` 里登记一个，B1 自动就能用。

**B3 与 B1 完全解耦**：B3 只发 `MatchPhaseChanged` / `LavaLevelChanged` 事件，B1 订阅这些事件调 `setPhase()` / `setLavaY()`。两者不互相 import。

---

## 2. 写作用域矩阵（硬边界）

| 路 | ✅ 可以写 | ❌ 绝对不许碰 |
|---|---|---|
| **B1** | `src/towers/TowerSocket.ts`<br>`src/towers/TowerBase.ts`<br>`src/towers/TowerSystem.ts`<br>`src/towers/BuildMenu.ts`<br>`tests/unit/towers/**`（不含 kinds 测试）<br>`handoff/B1.md` | `src/towers/types.ts`（S0 的）<br>`src/towers/kinds/**`（B2 的）<br>`src/flow/**`（B3 的）<br>`src/core/**`、`src/render/**`、`src/player/**`、`src/combat/**`、`src/boss/**`、`src/main.ts`、`package.json`、`scripts/**` |
| **B2** | `src/towers/kinds/ballista.ts`<br>`src/towers/kinds/rune.ts`<br>`src/towers/kinds/frost.ts`<br>`src/towers/kinds/quake.ts`<br>`src/towers/kinds/totem.ts`<br>`src/towers/kinds/index.ts`（只改注册表那几行）<br>`tests/unit/towers/kinds/**`<br>`handoff/B2.md` | `src/towers/types.ts`<br>`src/towers/TowerSocket.ts` / `TowerBase.ts` / `TowerSystem.ts` / `BuildMenu.ts`（B1 的）<br>`src/flow/**`、`src/core/**`、其余同上 |
| **B3** | `src/flow/MatchTimeline.ts`<br>`src/flow/Scoring.ts`<br>`src/flow/MatchRunner.ts`<br>`src/telemetry/Telemetry.ts`<br>`tests/unit/flow/**`<br>`handoff/B3.md` | `src/flow/types.ts`（S0 的）<br>`src/towers/**`（B1+B2 的）<br>`src/core/**`、其余同上 |

**唯一交叠处**：`src/towers/kinds/index.ts` 的注册表。B2 每完成一个塔，加两行（import + 表项）。B1 不碰它。

### 越权判定（命中即整次提交回退）

1. commit 里出现别人作用域的文件
2. 修改 `src/core/events.ts` 或 `src/core/config/*.json`
3. 修改 `src/towers/types.ts` 或 `src/flow/types.ts`（S0 的）
4. 逻辑层 `import three`

---

## 3. 共享类型层（已建好，只读）

### `src/towers/types.ts`（B1 和 B2 都依赖）

```ts
export type TowerKind = 'ballista' | 'rune' | 'frost' | 'quake' | 'totem';

/** B1 创建并持有，B2 的行为读它、写 cooldownSec 和 state */
export interface TowerRuntime {
  readonly id: string;
  readonly kind: TowerKind;
  readonly slotId: string;
  readonly pos: Vec3;
  level: number;
  hp: number;
  maxHp: number;
  investedCost: number;
  cooldownSec: number;
  readonly state: Record<string, number>;   // 行为私有状态
  readonly bus: Bus;
  readonly rng: Rng;
  readonly cfg: TowerKindConfig;
}

/** B2 为每种塔实现一个 */
export interface TowerBehavior {
  readonly kind: TowerKind;
  readonly attr: Attr | 'none';
  readonly cost: number;
  readonly range: number;
  readonly maxHp: number;
  onPlaced?(self: TowerRuntime): void;
  update(self: TowerRuntime, ctx: TowerUpdateCtx): void;
  onDamaged?(self: TowerRuntime, amount: number): number;
  onRemoved?(self: TowerRuntime): void;
}

/** B1 实现，对外门面 */
export interface TowerSystem {
  init(deps: { bus: Bus; rng: Rng; towersCfg: TowersConfig; arenaCfg: ArenaConfig }): void;
  update(dtSec: number, ctx: TowerUpdateCtx): void;
  place(slotId: string, kind: TowerKind, motes: number): boolean;
  upgrade(towerId: string, motes: number): boolean;
  sell(towerId: string): boolean;
  setPhase(phase: MatchPhase): void;
  setLavaY(y: number): void;
  damageTower(towerId: string, amount: number): void;
  list(): TowerView[];
  slots(): SlotView[];
  menu(slotId: string | null, motes: number): BuildMenuState;
  motes(): number;
}
```

### `src/flow/types.ts`（B3 实现）

```ts
export interface MatchTimeline {
  init(deps: { bus: Bus; flowCfg: FlowConfig; arenaCfg: unknown }): void;
  update(dtSec: number): boolean;
  phase(): MatchPhase;
  tSec(): number;
  endsAtSec(): number;
  result(): MatchResult | null;
  lavaY(): number;
  notifyBossDefeated(): void;
  notifyCoreDestroyed(): void;
  notifyPlayerOutOfLives(): void;
  applyCoreDamage(amount: number): void;
}
```

**要改这些类型** → 写进 handoff 的「契约申请」，S0 改。**不要自己改。**

---

## 4. 契约规则（三路共用）

### 4.1 `src/core/events.ts` 只读

需要新事件 → 写进 handoff：

```markdown
### 契约申请 #1（11:50 提出）
- 事件名：`TowerAmmoChanged`
- 字段：`{ towerId: string; ammo: number }`
- 触发时机：
- 为什么已有事件不够：
- 提出人：B2
- 状态：待 S0 裁决
```

commit 后告诉 S0 一句。S0 合并后你 `git rebase origin/master` 就能用。

### 4.2 事件归属（谁发哪个）

| 事件 | 谁发 | 说明 |
|---|---|---|
| `TowerPlaced` / `TowerUpgraded` / `TowerDestroyed` | **B1** | |
| `TowerHpChanged` / `TowerSlotStateChanged` | **B1** | `place()` 后必须立刻发一次 hp |
| `TowerTargetHit` | **B2** | 塔开火命中 |
| `FreezeProgressChanged` | **B2** | 寒晶冻结值 |
| `TowerInterruptRequested` | **B2** | 震地锚请求打断 |
| `TauntStarted` / `TauntEnded` | **B2** | 嘲讽 |
| `MatchPhaseChanged` / `MatchEnded` / `LavaLevelChanged` / `CoreHpChanged` | **B3** | |
| `MoteCountChanged` | **B1** | 建/拆/升级时扣返熔核 |
| `DebuffStackChanged` | ❌ **Boss 发** | 塔只发 `TowerTargetHit` |
| `BossSkillInterrupted` | ❌ **Boss 发** | 塔只发 `TowerInterruptRequested` |

### 4.3 禁止 import three

```ts
// ✅ 允许
import type { Bus, Vec3 } from '../core/events';
import towersCfg from '../core/config/towers.json';
import { createRng } from '../core/rng';
import type { TowerBehavior } from '../types';

// ❌ 禁止
import * as THREE from 'three';
import { Vector3 } from 'three';
```

位置用 `Vec3 = readonly [number, number, number]`。需要向量运算在自己模块写局部纯函数。

`npm run contract` 自动扫 `src/towers`、`src/flow`，命中即失败。

---

## 5. 三路各自的任务

### B1 · 塔位与塔实体（`E:\demo\p2b-1`）

**票**：`docs/tickets/M2-01-towers.md`（原票，13 条单测）

**交付文件**
```
src/towers/TowerSocket.ts    塔位状态机（locked/open/occupied/submerged）
src/towers/TowerBase.ts      塔实例（等级/耐久/已投入造价）
src/towers/TowerSystem.ts    TowerSystem 门面实现
src/towers/BuildMenu.ts      建塔菜单纯函数
tests/unit/towers/*.test.ts
```

**必须实现的行为**
1. 初始 7 个塔位 open（M1-M4、T1-T3），4 个 locked（E1-E4）
2. `place()` 成功发 3 个事件：`TowerPlaced` + `TowerHpChanged` + `TowerSlotStateChanged`
3. `place()` 失败（locked / 已占用 / 熔核不足 / kind 无行为）→ 返回 false 且**不发任何事件**
4. 升级花费 = `floor(cost * upgradeCostRatio)`
5. 拆除返还 = `floor(investedCost * sellRefundRatio)`（investedCost 含升级花费）
6. 耐久归零 → `TowerDestroyed{reason:'broken'}` + 槽位回 `open`
7. `setPhase('boss2')` → 4 个 E 位依次变 open
8. `setLavaY(y)` 且 `y >= drownSlotY` → 槽位 `submerged` + 塔 `TowerDestroyed{reason:'drowned'}`
9. 仰角死区：`ring === 'tower'` 的塔，Boss 水平距 < 4 m 时不产生 `TowerTargetHit`
10. `update()` 遍历所有塔调 `behavior.update()`，跳过未实现的塔

**关键**：B2 还没写任何塔时，`place()` 必须返回 false 而不是崩。用 `hasBehavior(kind)` 判断。

**验收**
```powershell
npm run gate     # 全绿
npx vitest run tests/unit/towers   # 13+ passed
```

---

### B2 · 五种塔行为（`E:\demo\p2b-2`）

**票**：`docs/tickets/M2-02-kinds.md`

**交付文件**
```
src/towers/kinds/frost.ts      寒晶塔（优先做，破绽机核心）
src/towers/kinds/quake.ts      震地锚塔（破绽机另一半）
src/towers/kinds/ballista.ts   弩炮塔
src/towers/kinds/rune.ts       符文聚能塔
src/towers/kinds/totem.ts      嘲讽图腾
src/towers/kinds/index.ts      注册表（只加 import 和表项）
tests/unit/towers/kinds/*.test.ts
```

**五种塔的行为规格**

| 塔 | 属性 | 射程 | 基础效果 | 对 Boss 特效 | 事件 |
|---|---|---|---|---|---|
| **寒晶** frost | 法术 | 18 | 范围减速 30% | 冻结值累积满 100 → Boss 僵直 2.5 s | `FreezeProgressChanged{value,max}`；满时 `FreezeProgressChanged{value:100}` |
| **震地锚** quake | 物理 | 12 | 周期震击 | Boss 在范围内施法时 50% 打断 | `TowerInterruptRequested{towerId, skill, chance}` |
| **弩炮** ballista | 物理 | 25 | 单体 25/1.2s | 命中 4 次叠 1 层碎甲，上限 5 | `TowerTargetHit` |
| **符文** rune | 法术 | 20 | 单体 18/0.8s | 叠灼烙，上限 5 | `TowerTargetHit` |
| **嘲讽** totem | 无 | 30 | 无伤害 | 强制 Boss 攻击它 6 s，CD 20 s | `TauntStarted{towerId,durationMs}` / `TauntEnded{towerId}` |

**实现要点**
- 每个塔一个文件，导出一个 `TowerBehavior` 对象
- 冷却用 `self.cooldownSec`，每帧 `-= ctx.dtSec`
- 概率用 `self.rng()`，可播种
- 私有状态放 `self.state`（如 `self.state.sunderHits`、`self.state.freezeValue`）
- **不直接改 Boss 状态**，只 emit 事件
- 射程判定用 `dist3(self.pos, ctx.boss.pos) <= self.range`

**验收**
```powershell
npm run gate
npx vitest run tests/unit/towers/kinds   # 每种塔至少 3 条
```

**建议顺序**：frost → quake → ballista → rune → totem（前两个是破绽机，最关键）

---

### B3 · 流程与遥测（`E:\demo\p2b-3`）

**票**：`docs/tickets/M2-03-flow.md`（原票，12 条单测）

**交付文件**
```
src/flow/MatchTimeline.ts    4:30 时间轴状态机
src/flow/Scoring.ts          评分纯函数
src/flow/MatchRunner.ts      无头跑一局
src/telemetry/Telemetry.ts   遥测收集
tests/unit/flow/*.test.ts
```

**必须实现的行为**
1. 7 段阶段严格按 `flow.json` 推进，每段切换发一次 `MatchPhaseChanged{phase, tSec}`
2. `update(1/60)` 调 60 次后 `tSec() ≈ 1.0`（误差 < 1e-6）
3. 熔岩：boss1 结束 `-1.8` → transition 结束 `-0.8` → rage 每秒 +1.2，变化时发 `LavaLevelChanged`
4. `MatchEnded` 一局只发一次；之后再调 `notifyXxx` 全部忽略
5. 失败条件：塔心归零 / 玩家死亡 2 次 / 270 s 超时 / 熔岩吞没
6. 评分：S/A/B/C 按 `flow.json` 的 `score.grades` 匹配，**输了最高只能 B**
7. `runToEnd()` 纯 Node 跑完一局 < 2 秒

**验收**
```powershell
npm run gate
npx vitest run tests/unit/flow   # 12+ passed
```

---

## 6. 提交规范（三路一致）

### 提交前必做

```powershell
npm run gate     # 必须全绿
```

### 提交命令

```powershell
cd E:\demo\p2b-1        # 或 p2b-2 / p2b-3

# 只 add 自己作用域内的文件，不要 git add -A
git add src/towers/TowerSocket.ts src/towers/TowerBase.ts ... handoff/B1.md

git commit -m "towers: 塔位状态机与建拆（T-M2-01）"
```

### 提交信息格式

```
<模块>: <做了什么>（<票号>）
```

例：
- B1：`towers: 塔位状态机与建拆（T-M2-01）`
- B2：`towers: 寒晶塔冻结值（T-M2-02）`
- B3：`flow: 4:30 时间轴（T-M2-03）`

### 不 push

三路都只 commit 到自己分支，S0 合并。

---

## 7. 交接（每 30 分钟）

| 路 | 文件 |
|---|---|
| B1 | `handoff/B1.md` |
| B2 | `handoff/B2.md` |
| B3 | `handoff/B3.md` |

**文件名不相交 → 三路同时写不冲突。**

模板（照 `handoff/README.md`）：

```markdown
# B1 · 塔位与塔实体 交接

> 最后更新：12:00

## 状态
- 当前分支：feat/p2b-towers
- 最后提交：abc1234
- 本轮进度：进行中

## 已完成
- TowerSocket 状态机
- place/upgrade/sell

## 对外暴露的接口
```ts
export function createTowerSystem(): TowerSystem;
```

## 未完成 / 阻塞
- 仰角死区还没测

## 契约申请
无

## 跨目录请求
无

## 下一步第一件事
- 补仰角死区单测

## 复现方式
npm run gate
```

---

## 8. 三路之间的协作点

### B1 ↔ B2：通过 `TowerBehavior` 接口

- **B1 先做**：`TowerSystem.update()` 里遍历塔，调 `behavior.update(self, ctx)`
- **B2 后做**：实现 `TowerBehavior`，在 `kinds/index.ts` 登记
- **B1 不需要等 B2**：`hasBehavior(kind)` 为 false 时跳过，place 返回 false

### B1 ↔ B3：通过事件总线

- B3 发 `MatchPhaseChanged` → B1 订阅后调 `setPhase()`
- B3 发 `LavaLevelChanged` → B1 订阅后调 `setLavaY()`
- **两者不互相 import**

### B2 ↔ B3：无直接依赖

B2 只发事件（`TowerInterruptRequested`、`FreezeProgressChanged`），B3 只关心自己的阶段事件。

---

## 9. 遇到问题

| 情况 | 做法 |
|---|---|
| 契约不够用 | 写「契约申请」，告诉 S0，**不要自己加** |
| 需要改别人文件 | 写「跨目录请求」，**不要自己改** |
| 共享类型不够用 | 写「契约申请」，S0 改 `types.ts` |
| 门禁报错看不懂 | 贴完整报错 |
| 同一错误失败 3 次 | 停下，报告现象/已试/猜测/需要什么决定 |
| 时间不够 | 先交付能跑的最小版本 + 在 handoff 写清缺什么 |

---

## 10. 时间表

| 时刻 | B1 | B2 | B3 |
|---|---|---|---|
| 11:40 | 开工，跑 gate | 开工，跑 gate | 开工，跑 gate |
| 12:00 | **M1**：塔位/建拆/耐久 交付 | frost + quake 交付 | 时间轴骨架交付 |
| 13:15 | **M2**：仰角死区 + 菜单 | 五塔全交付 | 熔岩 + 塔心 + 评分交付 |
| 14:15 | **M3**：补单测 | 补单测 | 遥测 + runToEnd 交付 |
| 14:45 | **M4**：收口 | 收口 | 收口 |
| 15:00 | 冻结 | 冻结 | 冻结 |

---

## 11. 变更记录

| 版本 | 时间 | 变更 |
|---|---|---|
| v2.0 | 2026-11-08 11:40 | 三路拆分：B1 塔位、B2 五塔行为、B3 流程；建共享类型层 |
