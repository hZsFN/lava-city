# 契约变更 M4-01 · MatchPhase 从 6 值扩到 9 值

> **这是给 TRAE 的精确补丁说明。`src/core/events.ts` 是三家共用契约，只允许按本文改，不许自行增删其他字段。**
> 改完必须立刻通知 P1 复核，并同步 `docs/plan/CONTRACT.lock` 里的 SHA256。

## 一、改动内容（只有两处）

### 改动 1：`MatchPhase` 类型

**原文**：
```ts
export type MatchPhase = 'wake' | 'prep' | 'boss1' | 'transition' | 'boss2' | 'rage' | 'ended';
```

**改成**：
```ts
export type MatchPhase =
  | 'wake'        // 0:00–0:16  黑屏 → 睁眼，不能动
  | 'tutorial'    // 0:16–0:40  能走，地上有教程书
  | 'prep'        // 0:40–0:50  准备期，能建塔
  | 'boss1'       // 0:50–2:20  阶段 I
  | 'transition'  // 2:20–2:35  转阶段过场，不能动
  | 'boss2'       // 2:35–4:00  阶段 II
  | 'rage'        // 4:00 后未击杀时的狂暴
  | 'victory'     // 4:00–4:15  击杀后的胜利演出
  | 'escape'      // 4:15–4:30  传送与结算
  | 'ended';      // 已结束（win/lose 都归这里）
```

**只是新增 `tutorial`、`victory`、`escape` 三个值**，原有七个一个都没删、没改。

### 改动 2：`Events` 接口里新增一个事件

在 `Events` 里追加：
```ts
  /** 剧情台词：由 flow.json 的 narration 段驱动，UI 层订阅后显示 */
  Narration: { text: string; speaker: 'boss' | 'narrator' | 'player'; holdMs: number };
```

其余事件一个字不动。

## 二、`Snapshot` 要加的两个字段

```ts
export interface Snapshot {
  // ...原有字段保持不动...
  /** 当前阶段已经进行了多少秒，UI 的倒计时用它，不要自己算 */
  phaseElapsedSec: number;
  /** 本阶段剩余秒数；不是限时阶段时给 -1 */
  phaseRemainSec: number;
}
```

## 三、改完之后必须做的三件事

1. `npm run typecheck` 零错误（会有大量 `switch (phase)` 报 `no case` 或 `not assignable`，这是**正常的**，说明改对了——把每处的默认分支补上即可）。
2. 跑 `npm run contract`，把 `docs/plan/CONTRACT.lock` 里的 `events.ts` SHA256 更新成新值。
3. 在 `docs/plan/01-四路派单表.md` 顶部加一行变更记录：`2026-11-08 M4-01：MatchPhase +3 值（tutorial/victory/escape），新增 Narration 事件，Snapshot +2 字段`。

## 四、九阶段的时序常量（同时写进 `src/core/config/flow.json`）

```json
{
  "phases": [
    { "phase": "wake",       "startSec": 0,   "endSec": 16 },
    { "phase": "tutorial",   "startSec": 16,  "endSec": 40 },
    { "phase": "prep",       "startSec": 40,  "endSec": 50 },
    { "phase": "boss1",      "startSec": 50,  "endSec": 140 },
    { "phase": "transition", "startSec": 140, "endSec": 155 },
    { "phase": "boss2",      "startSec": 155, "endSec": 240 },
    { "phase": "rage",       "startSec": 240, "endSec": 268 },
    { "phase": "victory",    "startSec": 240, "endSec": 255, "conditional": "bossDead" },
    { "phase": "escape",     "startSec": 255, "endSec": 270, "conditional": "bossDead" }
  ]
}
```

**注意 `victory`/`escape` 与 `rage` 的起始时间相同（240 s），走哪条取决于 Boss 是否已死**——这是唯一的分叉点，实现时用 `if (bossDead)` 判断，不要做成两条独立时间线。

## 五、不许做的事

- 不许改 `MatchPhase` 里已有七个值的拼写
- 不许删 `Snapshot` 的任何现有字段（UI 和塔系统都在读）
- 不许在这个文件里加业务逻辑
- 不许顺手"整理"格式或重排字段顺序（会让 CONTRACT.lock 的 diff 变成整文件重写，失去意义）
