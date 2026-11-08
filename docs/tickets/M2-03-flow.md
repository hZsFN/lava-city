# 票 T-M2-03 · 4:30 时间轴状态机 + 熔岩上涨 + 塔心 HP + 评分

> 归属：**S1（P2-B）** ｜ 写作用域：`src/flow/**`、`src/telemetry/**`、`tests/unit/flow/**`
> 设计依据：`docs/熔心孤塔_设计与AI开发规划.md` 第 3 节（4:30 时间轴）、第 15.3 节（遥测目标）
> 契约依据：`src/core/events.ts`（v1.1）· 数值来源：`src/core/config/flow.json`、`src/core/config/arena.json`
> **依赖 T-M2-01 的 TowerSystem 接口**（只需接口签名，可以并行开工）。

---

## 【目标】

一局 4:30 的骨架：7 段时间轴自动推进、每段切换广播事件、熔岩按规则上涨、塔心掉血就失败、4:05 后进狂暴、结束时发 `MatchEnded`、算 S/A/B/C 评分并落遥测 JSON。

**这是"一局能跑起来"的地基。** 没有它，其他模块写的都是零件。

---

## 【范围】

```
src/flow/MatchTimeline.ts     时间轴状态机（本票核心）
src/flow/Scoring.ts           评分（纯函数）
src/flow/MatchRunner.ts       把 Timeline + TowerSystem + Boss/Player 桩串成一局（无头可跑）
src/telemetry/Telemetry.ts    每局 JSON 收集与导出
tests/unit/flow/*.test.ts
```

**禁止修改**：`src/core/**`、`src/towers/**`（S1 自己的另一票，但不要在同一提交里混改）、`src/render/**`、`src/main.ts`、`package.json`。

**禁止 import three。**

---

## 【对外接口（必须逐字实现）】

```ts
// src/flow/MatchTimeline.ts
import type { Bus, MatchPhase } from '../core/events';

export interface TimelineDeps {
  bus: Bus;
  flowCfg: unknown;
  arenaCfg: unknown;
}

export interface MatchTimeline {
  init(deps: TimelineDeps): void;
  /** 固定步长推进；返回本帧是否发生阶段切换 */
  update(dtSec: number): boolean;
  phase(): MatchPhase;
  tSec(): number;
  /** 当前阶段结束时刻（倒计时 UI 用）；ended 时为 0 */
  endsAtSec(): number;
  /** 一局结束后才有值 */
  result(): { result: 'win' | 'lose'; reason: string; tSec: number } | null;
  /** 外部通知：Boss 死了 / 塔心被打爆 / 玩家死亡数到上限 */
  notifyBossDefeated(): void;
  notifyCoreDestroyed(): void;
  notifyPlayerOutOfLives(): void;
  /** 熔岩当前高度 */
  lavaY(): number;
}

export function createMatchTimeline(): MatchTimeline;
```

```ts
// src/flow/Scoring.ts
export interface ScoreInput {
  tSec: number;
  executions: number;      // 击破次数
  coreHpPct: number;       // 塔心剩余百分比 0..100
  deaths: number;          // 玩家死亡次数
  won: boolean;
}
export interface ScoreResult {
  grade: 'S' | 'A' | 'B' | 'C';
  breakdown: Record<string, number>;
}
export function computeScore(input: ScoreInput, flowCfg: unknown): ScoreResult;
```

```ts
// src/flow/MatchRunner.ts —— 无头跑一局（给 QA / 平衡用，也给本票验收用）
export interface RunnerDeps {
  bus: Bus;
  timeline: MatchTimeline;
  /** 可选：每帧被调用，用来驱动塔/Boss/玩家的桩 */
  onTick?: (dtSec: number, snapshot: unknown) => void;
}
export function createMatchRunner(deps: RunnerDeps): {
  /** 以固定 1/60 步长跑完一局，返回遥测 */
  runToEnd(maxSec?: number): unknown;
};
```

---

## 【行为规格（每条都要有单测）】

### 1. 阶段推进（时间全部来自 `flow.json`，不许硬编码）

| 阶段 | 起止（秒） | 进入时必须发的事件 |
|---|---|---|
| `wake` | 0–20 | `MatchPhaseChanged{phase:'wake', tSec:0}` |
| `prep` | 20–40 | `MatchPhaseChanged` + 塔位高亮（由 towers 侧响应，本票只发事件） |
| `boss1` | 40–130 | `MatchPhaseChanged` |
| `transition` | 130–145 | `MatchPhaseChanged` + 熔岩开始上涨 |
| `boss2` | 145–245 | `MatchPhaseChanged` + E 位解锁（towers 响应） |
| `rage` | 245–270 | `MatchPhaseChanged` + `LavaLevelChanged` 速率提高 |
| `ended` | 270 | `MatchPhaseChanged` + `MatchEnded` |

**规则**：
- 每帧只允许跨越一个阶段边界（`dtSec` 被 clamp 到 ≤ 0.1 s，一帧最多跨 1 个）。
- 阶段切换发一次事件，**不重复发**。
- `tSec` 累积从 0 开始，`update(1/60)` 调用 60 次后 `tSec()` 应 ≈ 1.0（误差 < 1e-6）。

### 2. 熔岩

```
wake/prep/boss1:  lavaY = arena.lava.startY (-1.8)
transition 起:    lavaY 线性上升到 arena.lava.phase2RiseTo (-0.8)，用 15 s
boss2:            lavaY 保持 -0.8
rage:             lavaY 每秒涨 arena.lava.rageRisePerSec (1.2)
```

变化时发 `LavaLevelChanged { y, risePerSec }`。**每帧都发太吵**——只在变化量 ≥ 0.01 或阶段切换时发。

### 3. 失败与胜利

| 触发 | 结果 | 事件 |
|---|---|---|
| Boss HP 归零（`notifyBossDefeated`） | `win` | `MatchEnded{result:'win', reason:'boss_defeated', tSec}` |
| 塔心 HP 归零（`notifyCoreDestroyed`） | `lose` | `MatchEnded{result:'lose', reason:'core_destroyed', tSec}` |
| 玩家死亡 2 次（`notifyPlayerOutOfLives`） | `lose` | `MatchEnded{result:'lose', reason:'player_out_of_lives', tSec}` |
| 到 270 s 仍未结束 | `lose` | `MatchEnded{result:'lose', reason:'timeout', tSec:270}` |
| 熔岩 y ≥ 塔心高度 | `lose` | `MatchEnded{result:'lose', reason:'lava_swallowed', tSec}` |

**`MatchEnded` 一局只发一次。** 之后再调 `notifyXxx` 全部忽略。

### 4. 塔心 HP

`flow.core.maxHp = 1000`。`update()` 里不自动掉血——塔心掉血由 Boss/玩家伤害驱动，本票提供：
```ts
// 内部方法，通过 bus 事件 CoreHpChanged 对外广播
applyCoreDamage(amount: number): void;
```
（加到 `MatchTimeline` 接口里）

### 5. 评分（`Scoring.ts`，纯函数）

按 `flow.json` 的 `score.grades`，从高到低匹配第一条满足的：

```
S: tSec <= 210 且 executions >= 3 且 coreHpPct >= 60
A: tSec <= 240 且 executions >= 2 且 coreHpPct >= 30
B: tSec <= 270 且 executions >= 1 且 coreHpPct >= 1
C: 其他
```

**输了最高只能 B**（输的局不该给 S/A）。

`breakdown` 至少包含：`{ timeSec, executions, coreHpPct, deaths, won }`。

### 6. 遥测（`Telemetry.ts`）

每局结束时产出一个 JSON（内存对象 + 可导出字符串）：

```ts
export interface TelemetryRecord {
  version: 1;
  seed: number;
  result: 'win' | 'lose';
  reason: string;
  tSec: number;
  phaseTimes: Record<string, number>;       // 各阶段实际停留秒数
  executions: number;
  executionTimes: number[];                 // 每次击破的时刻
  damageBySource: { tower: number; player: number; execution: number };
  towerBuildOrder: Array<{ tSec: number; kind: string; slotId: string }>;
  deaths: number;
  coreHpPct: number;
  grade: 'S' | 'A' | 'B' | 'C';
}
export function createTelemetry(seed: number): {
  record(): TelemetryRecord;
  toJson(): string;
};
```

### 7. `MatchRunner`（无头跑一局）

`runToEnd(300)` 用 1/60 固定步长推进 `timeline.update()` 直到 `result() !== null` 或超过 `maxSec`，返回 `TelemetryRecord`。

**验收要求：这个函数在纯 Node 下跑完一局 < 2 秒**（无渲染、无 DOM、无 three）。

---

## 【验收】

在 `E:\demo\wt-p2b` 下：

```powershell
npm run gate
```

必须全绿。**本票专属单测**（`tests/unit/flow/`）必须覆盖：

1. ✅ 从 0 跑 270 s，`MatchPhaseChanged` 恰好发 7 次，顺序严格 = `wake→prep→boss1→transition→boss2→rage→ended`
2. ✅ 每个阶段切换的 `tSec` 与 `flow.json` 的 `startSec` 一致（±1 帧误差）
3. ✅ `endsAtSec()` 在各阶段返回正确值
4. ✅ 熔岩：boss1 结束时 `lavaY ≈ -1.8`；transition 结束时 `≈ -0.8`；rage 跑 10 s 后涨了 ≈ 12
5. ✅ `notifyBossDefeated()` → `MatchEnded{result:'win'}`，之后再调不发第二次
6. ✅ `notifyCoreDestroyed()` → `MatchEnded{result:'lose', reason:'core_destroyed'}`
7. ✅ 跑到 270 s 无胜 → `MatchEnded{reason:'timeout'}`
8. ✅ `computeScore`：3 击破 + 200 s + 塔心 70% → `S`
9. ✅ `computeScore`：输了 → 最高 `B`
10. ✅ `computeScore`：1 击破 + 260 s + 塔心 5% → `B`
11. ✅ 遥测 JSON 可 `JSON.parse`，字段齐全，`phaseTimes` 累加 ≈ 总时长
12. ✅ `runToEnd()` 纯 Node 跑完一局 < 2000 ms

**验收证据必须贴**：
- `npm run gate` 末尾 20 行
- `npx vitest run tests/unit/flow` 的 `Tests  12 passed` 那行
- `runToEnd()` 的实测耗时（`console.time` 或断言里的数字）

---

## 【禁止事项】

1. ❌ 不要改 `events.ts` / config
2. ❌ 不要 `import three`
3. ❌ 不要硬编码时间点（全部从 `flow.json` 读）
4. ❌ 不要在 `MatchTimeline` 里直接操作塔或 Boss（只发事件）
5. ❌ 不要 `git push`

---

## 【交付格式】

同 T-M2-01。
