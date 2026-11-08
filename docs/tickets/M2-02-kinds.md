# 票 T-M2-02 · 五种塔行为

> 归属：**B2** ｜ 写作用域：`src/towers/kinds/**`、`tests/unit/towers/kinds/**`
> 设计依据：`docs/熔心孤塔_设计与AI开发规划.md` 第 6 节（塔系统）
> 契约依据：`src/core/events.ts`（只读）· `src/towers/types.ts`（S0 的，只读）
> 数值来源：`src/core/config/towers.json`
> **本票只写塔的行为，不写塔位/建拆/耐久**（那是 B1 的 T-M2-01）。

---

## 【目标】

五种塔的"对 Boss 特效"全部实现。每种塔一个文件，实现 `TowerBehavior` 接口，在 `kinds/index.ts` 注册。

**这是"塔防"的灵魂**：塔不是单纯输出，而是制造破绽、上 debuff、拉位置。

---

## 【范围】

允许新建/修改：

```
src/towers/kinds/frost.ts       寒晶塔
src/towers/kinds/quake.ts       震地锚塔
src/towers/kinds/ballista.ts    弩炮塔
src/towers/kinds/rune.ts        符文聚能塔
src/towers/kinds/totem.ts       嘲讽图腾
src/towers/kinds/index.ts       注册表（只加 import 和表项，不改已有结构）
tests/unit/towers/kinds/*.test.ts
```

**禁止修改**：
- `src/towers/types.ts`（S0 的共享类型）
- `src/towers/TowerSocket.ts` / `TowerBase.ts` / `TowerSystem.ts` / `BuildMenu.ts`（B1 的）
- `src/flow/**`（B3 的）
- `src/core/**`（含 events.ts 和所有 config）
- `src/render/**`、`src/player/**`、`src/combat/**`、`src/boss/**`、`src/main.ts`
- `package.json`、`tsconfig.json`、`vite.config.ts`、`scripts/**`

**禁止 import three。**

---

## 【实现模板】

每个塔文件长这样：

```ts
// src/towers/kinds/frost.ts
import type { TowerBehavior, TowerKindConfig, TowerRuntime, TowerUpdateCtx } from '../types';

const KIND = 'frost' as const;

export const frostBehavior: TowerBehavior = {
  kind: KIND,
  attr: 'arcane',
  cost: 3,
  range: 18,
  maxHp: 600,

  onPlaced(self) {
    self.state.freezeValue = 0;
    self.state.decayTimer = 0;
  },

  update(self, ctx) {
    // 1. 射程判定
    const dist = distance(self.pos, ctx.boss.pos);
    if (dist > self.range) return;

    // 2. 冷却
    self.cooldownSec -= ctx.dtSec;
    if (self.cooldownSec > 0) return;
    self.cooldownSec = self.cfg.intervalSec;

    // 3. 冻结值累积
    const max = 100;
    self.state.freezeValue = Math.min(max, (self.state.freezeValue ?? 0) + 8);
    self.bus.emit('FreezeProgressChanged', { value: self.state.freezeValue, max });

    // 4. 满了就广播
    if (self.state.freezeValue >= max) {
      self.bus.emit('FreezeFull', { durationMs: 2500 });
      self.state.freezeValue = 0;
    }
  },
};
```

`kinds/index.ts` 里登记：

```ts
import { frostBehavior } from './frost';

export const TOWER_BEHAVIORS: Partial<Record<TowerKind, TowerBehavior>> = {
  frost: frostBehavior,
};
```

---

## 【五种塔的行为规格】

### 1. 寒晶塔 `frost.ts`（**优先做，破绽机核心**）

| 项 | 值 | 来源 |
|---|---|---|
| 属性 | `arcane` | config |
| 射程 | 18 m | config |
| 造价 | 3 | config |
| 耐久 | 600 | config |
| 攻击间隔 | 1.0 s | config |
| 基础效果 | 范围内 Boss 减速 30% | config `slowRatio` |

**对 Boss 特效**：累积冻结值，满 100 → Boss 僵直 2.5 s 并**强制暴露弱点**

```
每 1.0 s（射程内）：
  freezeValue += cfg.freeze.perHit (8)
  emit FreezeProgressChanged { value, max: 100 }
  若 freezeValue >= 100：
    emit FreezeFull { durationMs: 2500 }
    freezeValue = 0

每帧衰减：freezeValue -= cfg.freeze.decayPerSec (6) * dt
         不低于 0

Boss 被冻结后（Boss 模块会响应 FreezeFull 发 WeaknessExposed），
冻结值清零
```

**单测（≥4 条）**
1. 射程外不累积
2. 射程内每次 +8，发 `FreezeProgressChanged`
3. 累积到 100 发 `FreezeFull`，且 value 归零
4. 衰减：累积 24 后停 1 s → 剩 18

---

### 2. 震地锚塔 `quake.ts`（**优先做，破绽机另一半**）

| 项 | 值 |
|---|---|
| 属性 | `physical` |
| 射程 | 12 m（最短，必须放中环） |
| 造价 | 3 |
| 耐久 | 600 |
| 攻击间隔 | 2.5 s |
| 打断概率 | 50% | config `interruptChance` |

**对 Boss 特效**：Boss 在范围内**施法时**，50% 概率打断，打断即暴露弱点

```
每 2.5 s（射程内 且 ctx.boss.castingSkill !== null）：
  若 rng() < cfg.interruptChance (0.5)：
    emit TowerInterruptRequested {
      towerId: self.id,
      skill: ctx.boss.castingSkill,
      chance: cfg.interruptChance,
    }
  // 注意：不直接发 BossSkillInterrupted，那是 Boss 的活
```

**单测（≥4 条）**
1. 射程外不触发
2. Boss 没施法时不触发
3. Boss 施法 + 种子固定 → 第一次命中（`rng` 用 `createRng(42)`）
4. 同一技能不重复请求（冷却内只发一次）

---

### 3. 弩炮塔 `ballista.ts`

| 项 | 值 |
|---|---|
| 属性 | `physical` |
| 射程 | 25 m |
| 造价 | 3 |
| 耐久 | 600 |
| 攻击间隔 | 1.2 s |
| 单次伤害 | 25 |
| 碎甲：命中 4 次叠 1 层，上限 5 层 |

**对 Boss 特效**：物理抗性 −8%/层

```
每 1.2 s（射程内）：
  emit TowerTargetHit {
    towerId: self.id,
    kind: 'ballista',
    attr: 'physical',
    amount: cfg.damage (25),
  }
  self.state.sunderHits = (self.state.sunderHits ?? 0) + 1
  若 self.state.sunderHits >= cfg.sunderHitsPerStack (4)：
    self.state.sunderHits = 0
    // 碎甲层数由 Boss 侧维护（它监听 TowerTargetHit 自己算）
    // 塔不直接发 DebuffStackChanged
```

**注意**：`DebuffStackChanged` 由 **Boss** 发。塔只发 `TowerTargetHit`，Boss 收到后自己累加层数并发 `DebuffStackChanged`。

**单测（≥3 条）**
1. 射程内按间隔发 `TowerTargetHit`，amount = 25
2. 射程外不发
3. 4 次命中后 `state.sunderHits` 归零

---

### 4. 符文聚能塔 `rune.ts`

| 项 | 值 |
|---|---|
| 属性 | `arcane` |
| 射程 | 20 m |
| 造价 | 3 |
| 耐久 | 600 |
| 攻击间隔 | 0.8 s |
| 单次伤害 | 18 |

**对 Boss 特效**：叠灼烙（法术抗性 −8%/层，上限 5）

```
每 0.8 s（射程内）：
  emit TowerTargetHit {
    towerId: self.id,
    kind: 'rune',
    attr: 'arcane',
    amount: cfg.damage (18),
  }
```

和弩炮一样，层数由 Boss 维护。

**单测（≥3 条）**
1. 射程内按间隔发 `TowerTargetHit`，attr = 'arcane'，amount = 18
2. 射程外不发
3. 0.8 s 内只发一次

---

### 5. 嘲讽图腾 `totem.ts`

| 项 | 值 |
|---|---|
| 属性 | `none` |
| 射程 | 30 m |
| 造价 | 2 |
| 耐久 | 300 |
| 伤害 | 0 |
| 嘲讽时长 | 6 s |
| 冷却 | 20 s |

**对 Boss 特效**：强制 Boss 攻击它 6 s，用于拉位置、让 Boss 背对玩家（阶段 II 背部弱点的唯一手段）

```
每帧：
  self.state.tauntCooldown = max(0, (self.state.tauntCooldown ?? 0) - dt)

  若 Boss 未处于嘲讽中（ctx.boss.taunted === false）
     且 cooldown === 0
     且 Boss 在射程内：
    emit TauntStarted { towerId: self.id, durationMs: 6000 }
    self.state.tauntCooldown = cfg.cooldownSec (20)
    self.state.tauntEndsAt = 6.0   // 内部计时

  若 tauntEndsAt 到时间：
    emit TauntEnded { towerId: self.id }
```

**注意**：`onRemoved` 时要发 `TauntEnded`（塔被拆了，嘲讽要结束）。

**单测（≥3 条）**
1. Boss 在射程内 + 冷却好了 → 发 `TauntStarted`，durationMs = 6000
2. 嘲讽期间不重复发
3. 塔被拆 → 发 `TauntEnded`

---

## 【验收】

在 `E:\demo\p2b-2` 下：

```powershell
npm run gate
```

必须全绿。**本票专属单测**（`tests/unit/towers/kinds/`）必须覆盖上面每一条，至少 17 个测试用例（frost 4 + quake 4 + ballista 3 + rune 3 + totem 3）。

**验收证据必须贴**：
- `npm run gate` 末尾 20 行（含 `[gate] ===== 全部通过 =====`）
- `npx vitest run tests/unit/towers/kinds` 的 `Tests  N passed` 那行

---

## 【禁止事项】

1. ❌ 不要改 `src/core/events.ts`（契约）。缺事件 → 写「契约申请」。
2. ❌ 不要改 `src/towers/types.ts`（S0 的共享类型）。不够用 → 写「契约申请」。
3. ❌ 不要改 B1 的 `TowerSystem.ts` / `TowerSocket.ts` / `TowerBase.ts` / `BuildMenu.ts`。
4. ❌ 不要 `import three`。
5. ❌ 不要发 `DebuffStackChanged`（Boss 的活）或 `BossSkillInterrupted`（Boss 的活）。
6. ❌ 不要硬编码数值（全部从 `self.cfg` 读）。
7. ❌ 不要用 `Math.random()`（用 `self.rng()`）。
8. ❌ 不要 `git push`。

---

## 【交付格式】

按 `AGENTS.md`：

1. 改动文件列表
2. `npm run gate` 输出摘要
3. 17+ 条单测的通过情况（贴 vitest 的 `Tests  N passed` 那行）
4. 契约申请 / 跨目录请求（如有）
5. 未完成项与原因
6. 复现方式（`npm run gate` + `npx vitest run tests/unit/towers/kinds`）
