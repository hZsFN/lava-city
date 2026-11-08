# 票 T-M2-05 · 玩家控制器 + 双形态武器 + 伤害公式

> 归属：**S2（P2-A）** ｜ 写作用域：`src/player/**`、`src/combat/**`、`tests/unit/player/**`、`tests/unit/combat/**`
> 设计依据：`docs/熔心孤塔_设计与AI开发规划.md` 第 5 节（主角系统）、第 8 节（伤害模型）
> 契约依据：`src/core/events.ts`（v1.1）· 数值来源：`src/core/config/player.json`
> **本票不接渲染、不接 Rapier**。物理用最简单的 AABB + 地面高度判定，先验证玩法成立。

---

## 【目标】

玩家能在塔顶平台上走动、冲刺、跳、切形态、开火，伤害公式 100% 分支覆盖。位置与状态通过 `PlayerMoved / PlayerDamaged / FormSwitched / OverheatChanged` 广播出去。

---

## 【范围】

```
src/player/PlayerController.ts   移动/冲刺/跳/重力（自写 AABB，不引 Rapier）
src/player/WeaponPhysical.ts     熔岩重锤三段 + 岩锚蓄力投掷
src/player/WeaponMagic.ts        地脉法杖连发 + 过热 + 地脉穿刺
src/player/Execution.ts          击破逻辑（只发事件，不做镜头）
src/combat/Damage.ts             伤害公式（纯函数，100% 覆盖）
src/combat/StatusEffects.ts      碎甲/灼烙/冻结值/减速
src/combat/Projectiles.ts        投射物对象池（逻辑层，无渲染）
tests/unit/player/*.test.ts
tests/unit/combat/*.test.ts
```

**禁止修改**：`src/core/**`、`src/towers/**`、`src/flow/**`、`src/boss/**`、`src/render/**`、`src/main.ts`、`package.json`。

**禁止 import three。**

---

## 【对外接口（必须逐字实现）】

```ts
// src/player/PlayerController.ts
import type { Bus, Attr, Vec3 } from '../core/events';

export interface PlayerInput {
  moveX: number;      // -1..1
  moveZ: number;      // -1..1
  yaw: number;        // 弧度
  dash: boolean;      // 本帧按下
  jump: boolean;
  attackPrimary: boolean;
  attackSecondary: boolean;
  switchForm: boolean;
  execute: boolean;
}

export interface PlayerController {
  init(deps: { bus: Bus; playerCfg: unknown; arenaCfg: unknown }): void;
  update(dtSec: number, input: PlayerInput): void;
  pos(): Vec3;
  hp(): number;
  form(): Attr;
  overheat(): number;
  isInvulnerable(): boolean;
  /** Boss/塔伤害入口；内部走 Damage.ts */
  takeDamage(raw: number, source: string): void;
  /** 从熔岩里掉下去 / 塔心被打爆时由 flow 调用 */
  respawn(): void;
  /** 死亡次数（flow 判断是否 out of lives） */
  deaths(): number;
}
export function createPlayerController(): PlayerController;
```

```ts
// src/combat/Damage.ts —— 纯函数，100% 分支覆盖
import type { Attr, BodyPart } from '../core/events';

export interface DamageInput {
  base: number;
  /** 目标抗性 0..1，如阶段 I 物理 0.70 */
  resist: number;
  /** 碎甲/灼烙减抗层数累计，如 0.24 表示 3 层 × 8% */
  resistReduction: number;
  /** 命中的部位属性匹配情况 */
  hit: 'none' | 'weaknessMatch' | 'weaknessMismatch';
  /** 来源是否塔（塔的破绽值累积 ×0.5） */
  fromTower: boolean;
}
export interface DamageOutput {
  amount: number;
  /** 贡献的破绽值（0..base 量级） */
  weaknessContribution: number;
}
export function computeDamage(input: DamageInput): DamageOutput;
```

```ts
// src/combat/StatusEffects.ts
export interface StatusEffects {
  addSunder(stacks: number): void;    // 碎甲，上限 5
  addScorch(stacks: number): void;    // 灼烙，上限 5
  addFreeze(value: number): number;   // 返回当前冻结值
  decay(dtSec: number): void;
  resistReduction(attr: Attr): number;
  freezeValue(): number;
  clearAll(): void;
  sunderStacks(): number;
  scorchStacks(): number;
}
export function createStatusEffects(deps: { bus: Bus; towersCfg: unknown }): StatusEffects;
```

---

## 【行为规格（每条都要有单测）】

### 1. 移动（数值全部来自 `player.json`）

```
moveSpeed 6.5 m/s，dashSpeed 11 m/s，jumpHeight 1.2 m，eyeHeight 1.7 m
dash 持续 0.25 s 且期间 dashInvulnerableSec = 0.25 s 无敌
重力 -22 m/s²（写进 player.json 或本地常量，注明）
落地判定：y <= 0 时贴地
掉出平台（水平距 > arena.rings.outerRadius + 2 或 y < arena.lava.startY）→ 发 PlayerDied{cause:'lava'} 并 respawn()
```

**dash 无敌帧必须有单测**：dash 开始后 0.24 s 内 `isInvulnerable()` 为 true，0.26 s 后为 false。

### 2. 双形态

```
switchForm：0.5 s 切换（期间不能攻击），完成后发 FormSwitched{form}
physical 形态：
  - 左键三段：30 / 30 / 60，范围 3 m，第三段击退
  - 右键蓄力 1.0 s 投掷岩锚，物理 80；命中弱点时"把自己拉到弱点处"（本票只发事件，位移由 T-M2-06 或集成期接）
arcane 形态：
  - 左键连发火花 12/发，5 发/s，过热条 4 s 满、冷却 2 s
  - 右键引导 1.2 s 地脉穿刺，法术 90
过热：连续开火累计 4 s → 发 OverheatChanged{overheated:true}，冷却 2 s 后恢复
```

### 3. 伤害公式（第 8 节，**逐字实现**）

```
最终伤害 = 基础
         × (1 − 抗性 + Σdebuff减抗)     // 抗性下限 −30%，即系数上限 1.3
         × 弱点倍率（匹配 2.5 / 不匹配 1.2 / 非弱点 1.0）
击破 = 阶段最大 HP × 12%，真实伤害，无视以上

破绽值累积：匹配属性 +1/伤害点；不匹配 +0.25；塔来源 ×0.5
```

`computeDamage` 必须覆盖的分支：
1. 无 debuff、非弱点、非塔 → 基础 × (1−resist)
2. 有 debuff 减抗 → 系数上升
3. 减抗超过抗性 → 系数被 clamp 到 1.3（**不能超过**）
4. 弱点匹配 → ×2.5
5. 弱点不匹配 → ×1.2
6. 塔来源 → 破绽贡献 ×0.5
7. 抗性 0 → 系数 1.0
8. 抗性 0.7 + 5 层碎甲（0.4）→ 系数 0.7
9. `base = 0` → 输出 0，不除零不 NaN
10. 负数 base → 输出 0（clamp，不产生治疗）

**要求 100% 分支覆盖**：`npx vitest run --coverage tests/unit/combat` 的 `Damage.ts` 分支覆盖率必须是 100%。

### 4. 状态效果

```
碎甲（sunder，物理减抗）：每层 −8%，上限 5 层 → 最多 −40%
灼烙（scorch，法术减抗）：每层 −8%，上限 5 层
冻结值：max 100，每命中 +8，每秒衰减 6；满 → 发 FreezeProgressChanged{value:100} 并由 Boss 侧响应 FreezeFull
减速：寒晶塔范围内 slowRatio 0.3
```

**`DebuffStackChanged` 不许由本模块发**（契约规定由 Boss 统一发）。`StatusEffects` 只维护内部层数 + 发 `FreezeProgressChanged`。

### 5. 击破（`Execution.ts`）

```
条件：当前有 WeaknessExposed 且 part 匹配 且 距离达标 且 破绽值满 100 且 3 s 窗口未过期
执行：发 ExecutionStarted{part} → 1.2 s 后发 ExecutionEnded{part, damage}
damage = 阶段最大 HP × 0.12（真实伤害）
不做镜头、不做时间缩放（那是渲染层订阅事件后自己做）
```

### 6. 投射物对象池

```
池容量 64，复用，不每帧 new
超过池容量时丢最旧的
```

---

## 【验收】

在 `E:\demo\wt-p2a` 下：

```powershell
npm run gate
```

必须全绿。**本票专属单测**必须覆盖上面 §1–§6 每一条，其中：

1. ✅ `Damage.ts` 分支覆盖率 100%（贴 coverage 表格）
2. ✅ dash 无敌帧窗口正确
3. ✅ 掉出平台发 `PlayerDied{cause:'lava'}`
4. ✅ 过热：连续开火 4 s → `overheated:true`；停火 2 s → `overheated:false`
5. ✅ 形态切换期间不能攻击
6. ✅ 碎甲/灼烙上限 5 层（第 6 层不生效）
7. ✅ 冻结值累积到 100 发 `FreezeProgressChanged{value:100}`
8. ✅ 击破伤害 = 阶段最大 HP × 0.12
9. ✅ 击破窗口过期后不能再击破
10. ✅ 对象池不超容量、复用不泄漏

**验收证据必须贴**：
- `npm run gate` 末尾 20 行
- `Damage.ts` 的 coverage 行（`% Branch 100`）

---

## 【禁止事项】

1. ❌ 不要改 `events.ts` / config
2. ❌ 不要 `import three`
3. ❌ 不要引 Rapier（本票用自写 AABB）
4. ❌ 不要做镜头/特效/时间缩放（发事件即可）
5. ❌ 不要发 `DebuffStackChanged`（Boss 的活）
6. ❌ 不要 `git push`

---

## 【交付格式】

同 T-M2-01。
