# 票 T-M2-07 · Boss「伊格纳斯」实体 + 行为树 + 破绽控制器 + Director

> 归属：**S3** ｜ 写作用域：`src/boss/**`、`src/ui/BossDebugPanel.ts`、`tests/unit/boss/**`
> 设计依据：`docs/熔心孤塔_设计与AI开发规划.md` 第 7 节全文 · `docs/tickets/M3-01-boss.md`（原票，造型与数值以它为准）
> 契约依据：`src/core/events.ts`（v1.1）· 数值来源：`src/core/config/boss.json`
> **与 M3-01 原票的差异**：本票**只做逻辑层**（`src/boss/**` 全是纯 TS，不 import three）。几何与动画由 S0 在集成期接 `src/render/`。

---

## 【目标】

一个**能自己动、自己决策、自己开弱点**的 Boss 逻辑核心：效用行为树每 0.5 s 选技能、技能三段时序（前摇/生效/收招）、破绽控制器监听事件开合弱点、Director 保证 30 s 内必有破绽。

**本票不接玩家伤害输入，不做几何造型，不做动画。** 验收方式是 `window.__boss` 状态 + 单测。

---

## 【范围】

```
src/boss/BossEntity.ts         HP / 抗性 / 阶段 / 部位状态（纯数据 + 状态机）
src/boss/BossBrain.ts          效用行为树（0.5 s 评估）
src/boss/skills/               每个技能一个类，三段时序
    RockSweep.ts               岩拳横扫（阶段 I）
    LeapSlam.ts                跃击（阶段 I）
    CoreDrain.ts               地脉汲取（阶段 I）
    StonePillars.ts            岩柱升腾（阶段 I）
    MagmaBreath.ts             熔岩吐息（阶段 II）
    LavaCharge.ts              熔岩冲撞（阶段 II）
    FireRain.ts                火雨（阶段 II）
    SelfIgnite.ts              自燃爆发（阶段 II）
src/boss/WeaknessController.ts 破绽控制器（只监听事件）
src/boss/Director.ts           节奏兜底 / 惩罚贪心 / 狂暴
src/boss/parts.ts              四个部位定义（core/back/kneeL/kneeR）
src/ui/BossDebugPanel.ts       临时调试面板（DOM，可后删）
tests/unit/boss/*.test.ts
```

**禁止修改**：`src/core/**`、`src/render/**`、`src/towers/**`、`src/flow/**`、`src/player/**`、`src/combat/**`、`package.json`。

**`src/boss/**` 禁止 import three。** `BossDebugPanel.ts` 可以用 DOM（它在 `src/ui/`，不在逻辑层扫描范围内）。

---

## 【对外接口（必须逐字实现）】

```ts
// src/boss/BossEntity.ts
import type { Bus, BodyPart, Vec3 } from '../core/events';

export interface BossEntity {
  init(deps: { bus: Bus; bossCfg: unknown; arenaCfg: unknown; rng: Rng }): void;
  update(dtSec: number, ctx: { playerPos: Vec3; corePos: Vec3; tauntTargetId: string | null }): void;
  hp(): number;
  phase(): 1 | 2;
  currentSkill(): string | null;
  weakness(): BodyPart | null;
  /** 阶段 II 转阶段 */
  enterPhase2(): void;
  /** 进入狂暴（flow 在 245 s 调） */
  enterRage(): void;
  /** 玩家/塔造成伤害 */
  takeDamage(amount: number, attr: 'arcane' | 'physical', part?: BodyPart): void;
  /** 调试用：强制下一个技能 */
  forceSkill(name: string): void;
}
export function createBossEntity(): BossEntity;
```

```ts
// src/boss/WeaknessController.ts
export interface WeaknessController {
  init(deps: { bus: Bus; bossCfg: unknown }): void;
  /** 当前打开的弱点（同一时刻只允许一个） */
  current(): BodyPart | null;
  update(dtSec: number): void;
}
export function createWeaknessController(): WeaknessController;
```

```ts
// src/boss/Director.ts
export interface Director {
  init(deps: { bus: Bus; bossCfg: unknown }): void;
  /** 行为树选技能前问它：返回强制技能名或 null */
  pick(skillScores: Record<string, number>): string | null;
  update(dtSec: number): void;
}
export function createDirector(): Director;
```

---

## 【行为规格（每条都要有单测）】

### 1. 阶段与抗性

```
阶段 I：maxHp 1400，resistPhysical 0.70，resistArcane 0.00，弱点 core（法术）
阶段 II：maxHp 1400（重置），resistPhysical 0.00，resistArcane 0.70，弱点 back + 双膝（物理）
转阶段：hp 归零 → 发 BossPhaseChanged{from:1,to:2} + BossHpChanged（满血）+ 暴露 back 6 s
```

### 2. 行为树（0.5 s 评估，`bossCfg.brain.evalIntervalMs`）

```
score = 冷却可用(0/1) × 距离条件(0/1) × 情境效用(0..1)，取最高分，同分按固定顺序

阶段 I 效用：
  贴近塔心(<8m)   → CoreDrain 0.9，其他 ×0.4
  玩家距离 > 14m  → LeapSlam 0.8
  玩家距离 3–12m  → RockSweep 0.75
  StonePillars    → 基础 0.3（兜底）

阶段 II 效用：
  嘲讽图腾激活   → MagmaBreath 0.95（为了背对玩家）
  玩家距离 > 12m → LavaCharge 0.8
  冷却都不可用   → FireRain 0.5
  debuff 层数 ≥ 3 → SelfIgnite 0.85
```

**必须单测**：给定一个快照（玩家距离、塔心距离、冷却、debuff 层数、嘲讽状态）→ 断言选中的技能名。

### 3. 技能三段时序

每个技能读 `boss.json` 的 `windupMs / activeMs / recoveryMs`，每段开始发 `BossSkillStart{skill, stage, durationMs}`，技能结束发 `BossSkillEnd{skill}`。

| 技能 | 破绽产生方式 |
|---|---|
| RockSweep | 收招硬直 1.0 s = 小破绽（发 `WeaknessExposed{part:'core', durationMs:1000}`，不开放岩甲） |
| LeapSlam | 落地后暴露 core 3 s |
| CoreDrain | 被 `BossSkillInterrupted{by:'interrupt'\|'freeze'}` 打断 → 暴露 core 5 s |
| StonePillars | 无破绽 |
| MagmaBreath | 施放中仇恨目标非玩家 → 暴露 back 6 s |
| LavaCharge | 撞到塔/边界 → 发两条 `KneeBroken{side:'L'\|'R'}` + 眩晕 3 s |
| FireRain | 无破绽 |
| SelfIgnite | 清空 debuff（发 `DebuffStackChanged{stacks:0}` 两次，sunder 与 scorch 各一次）；冻结满时被取消 → 暴露 core 2.5 s |

### 4. 破绽控制器（独立于行为树，**只监听事件**）

```
监听 BossSkillInterrupted → by 为 interrupt/freeze 时暴露 core 5 s
监听 KneeBroken          → 暴露对应膝 4 s
监听 FreezeFull          → 暴露 core 2.5 s
监听 BossPhaseChanged    → 暴露 back 6 s
监听 TowerInterruptRequested → 掷骰（用注入的 Rng）成功则发 BossSkillInterrupted{by:'interrupt'}
暴露时发 WeaknessExposed{part, attr, durationMs}；结束发 WeaknessClosed{part}
**同一时刻只允许一个部位打开**：新开时先发旧的 WeaknessClosed
```

**必须单测**：
- 连续两次不同来源的暴露 → 第二次先关第一个
- 暴露到期自动关闭并发 `WeaknessClosed`
- `TowerInterruptRequested` 用固定种子掷骰：seed=42 时第一次一定命中（写死断言）

### 5. Director（三条硬保证）

```
1. 节奏兜底：距上次 WeaknessExposed 超过 director.noWeaknessWindowMs(25000) → pick() 返回 'leapSlam' 或 'coreDrain'
2. 惩罚贪心：连续两次 ExecutionEnded 后，下三个技能 pick() 优先 'stonePillars'（阶段 I）/ 'fireRain'（阶段 II）
3. 狂暴：MatchPhaseChanged{phase:'rage'} 后所有技能冷却 ×rageCooldownScale(0.6)
```

**必须单测**（三条各一个）：
- 模拟 26 s 无暴露 → `pick()` 返回非 null 且是带破绽的技能
- 模拟两次 `ExecutionEnded` → 下一个 `pick()` 返回惩罚技能
- 狂暴后技能实际冷却 = 原冷却 × 0.6（用假时钟推进验证）

### 6. 调试面板

`window.__boss = { hp, maxHp, phase, skill, weakness, lastExposeAgoMs }`，实时可读。
面板提供按钮：`阶段I` `阶段II` `狂暴` + 8 个技能 + `打断` `冻结满` `击碎膝盖L` `击碎膝盖R`。

---

## 【验收】

在 `E:\demo\wt-boss` 下：

```powershell
npm run gate
```

必须全绿。**本票专属单测**必须覆盖上面 §1–§5 每一条，至少 20 个测试用例。

另外**无头跑一局**（不依赖渲染）：写一个测试用固定种子驱动 Boss 30 秒，断言：
- `WeaknessExposed` 间隔 < 30 s（Director 起作用）
- 技能序列里 4 个阶段 I 技能都至少出现一次

---

## 【禁止事项】

1. ❌ 不要改 `events.ts` / config
2. ❌ `src/boss/**` 不要 `import three`（`npm run contract` 会拦）
3. ❌ 不要做几何造型/动画/特效（S0 集成期接）
4. ❌ 不要直接操作塔对象（只发事件）
5. ❌ 不要 `git push`

---

## 【交付格式】

同 T-M2-01。
