# 票 M3-01 · Boss「伊格纳斯」实体与破绽系统

> 依赖：M0-01 完成。与 M1-01 无冲突（不同目录）。与 M2 系列的玩法票**只通过 `src/core/events.ts` 通信**。
> 设计依据：`docs/熔心孤塔_设计与AI开发规划.md` 第 7 节全文。
> 建议实现顺序：几何体 → 分部位 hitbox → 技能状态机 → 破绽控制器 → Director。

## 【目标】

让场地上站着一个 9 米高、会动、会打人、会暴露弱点的石制巨兽。**本票不接玩家的伤害输入**（那是 M2 的活），只负责 Boss 自己的行为与事件发布。验收方式：写一个临时的调试面板，能手动触发每个技能、能看到弱点开合。

## 【范围】

```
src/boss/BossEntity.ts      （模型 + 关节层级 + 动画）
src/boss/BossBrain.ts       （效用行为树，0.5 s 评估）
src/boss/skills/            （每技能一个文件）
    RockSweep.ts            岩拳横扫
    LeapSlam.ts             跃击
    CoreDrain.ts            地脉汲取
    StonePillars.ts         岩柱升腾
src/boss/WeaknessController.ts （破绽控制器）
src/boss/Director.ts        （节奏兜底）
src/boss/parts.ts           （分部位 hitbox 定义）
src/core/config/boss.json   （数值表）
src/ui/BossDebugPanel.ts    （临时调试面板）
```

禁止修改：`src/core/events.ts`、`kit/**`、`docs/**`、`src/render/**`（渲染由 M1 负责，Boss 只往场景里 add 自己的 Group）。

## 【几何造型（程序化，不许用外部模型）】

**阶段 I「岩甲形态」**：高 9 m，站在熔岩口。整体比例要"头小、肩宽、躯干厚重"，像一尊被熔岩淬过的巨像。

关节层级（全部 `THREE.Group`，用程序化旋转做动画，不用骨骼）：

```
root (y=0 在脚底)
├── hips        y=3.2
│   ├── torso   y=1.6   → 躯干本体
│   │   ├── chest  → 胸甲 + 核心挂点
│   │   ├── head   y=2.3
│   │   ├── shoulderL x=-1.9  → upperArmL → elbowL → foreArmL → fistL
│   │   └── shoulderR x=+1.9  → upperArmR → elbowR → foreArmR → fistR
│   ├── legL    x=-0.95 → thighL → shinL → footL
│   └── legR    x=+0.95 → thighR → shinR → footR
```

各部件几何（全部 `*Geometry` 程序化，材质统一 `MeshStandardMaterial`）：
- 躯干：`IcosahedronGeometry(2.7, 1)`，`scale(1.45, 1.35, 1.05)`
- 肩甲：`DodecahedronGeometry(1.5, 0)`，左右各一，`scale(1, 0.8, 1)`
- 头：`OctahedronGeometry(0.85, 0)` + 两个 `BoxGeometry(0.18)` 做眼缝，眼缝用 `MeshBasicMaterial(#ff7a1e)`
- 上臂 `CylinderGeometry(0.55, 0.62, 2.6, 8)`，前臂 `CylinderGeometry(0.42, 0.55, 2.4, 8)`，拳头 `IcosahedronGeometry(0.8, 0)`
- 大腿 `CylinderGeometry(0.78, 0.9, 2.2, 8)`，小腿 `CylinderGeometry(0.62, 0.75, 2.2, 8)`，脚 `BoxGeometry(1.3, 0.6, 1.8)`
- 材质：`color:#2e2a28`，`roughness:0.92`，`metalness:0.08`，`flatShading:true`（低多边形岩块感是本作风格）

**核心（弱点）**：`SphereGeometry(0.95, 16, 12)`，`MeshBasicMaterial(#4aa8ff)`，外加一层 `PointLight(#4aa8ff, 200, 30)`。外面套一层**岩甲壳**（`SphereGeometry(1.05, 8, 6)` + `flatShading`），默认 `visible:true`；弱点暴露时壳 `visible:false` 并播放 0.25 s 的敞开动画（壳两半向外旋转 70°）。

**背部裂缝（阶段 II 弱点）**：躯干背面一条 `BoxGeometry(0.25, 2.2, 0.1)` 的自发光条，默认 `visible:false`。

**膝盖（阶段 II 弱点）**：小腿上端两个 `SphereGeometry(0.35)` 的自发光球，默认 `visible:false`。

## 【分部位 hitbox（parts.ts）】

四个不可见的判定体，跟着关节走：
```ts
export const HIT_PARTS = {
  core:  { r: 1.1,  attr: 'arcane',   localOffset: [0, 1.2, 1.8] },  // 胸口前方
  back:  { r: 1.3,  attr: 'physical', localOffset: [0, 1.6, -1.9] },
  kneeL: { r: 0.6,  attr: 'physical', localOffset: [-0.95, 4.6, 0.2] },
  kneeR: { r: 0.6,  attr: 'physical', localOffset: [ 0.95, 4.6, 0.2] },
} as const;
```

暴露状态机由 `WeaknessController` 管：`closed → open(durationMs) → closed`，只有 `open` 且当前形态属性匹配时，玩家攻击才算"打到弱点"。

## 【技能（每个一个类，三段时长读 boss.json）】

| 技能 | 前摇 | 生效 | 收招 | 关键行为 |
|---|---|---|---|---|
| RockSweep 岩拳横扫 | 0.9 s | 0.35 s | 1.0 s | 右臂绕 Y 轴 -120°→+120°，扇形命中；收招硬直 1.0 s = **小破绽**（发布 `WeaknessExposed{part:'core', durationMs:1000}`，不开放岩甲） |
| LeapSlam 跃击 | 1.6 s | 0.25 s | 0.8 s | 仅当玩家距离 > 14 m 时可选；抛物线跳到玩家位置，落地震屏；落地后岩甲张开 3 s → **核心暴露** |
| CoreDrain 地脉汲取 | 2.5 s | 2.5 s | 0.6 s | 仅当 Boss 在塔心 8 m 内可选；每秒回 5%/2.5 的 HP；可被 `BossSkillInterrupted` 打断 → 核心暴露 5 s |
| StonePillars 岩柱升腾 | 1.2 s | 0.4 s | 0.6 s | 在玩家位置 + 前后左右各 3 m 升起 3 根 1.2 m 岩柱，命中伤；**无破绽** |

每个技能必须：①开始/阶段切换/结束都发 `BossSkillStart` / `BossSkillEnd`；②被中断发 `BossSkillInterrupted`；③所有时长从 `boss.json` 读，禁止硬编码。

## 【行为树（BossBrain.ts）】

每 0.5 s 评估一次，`score = 冷却可用(0/1) × 距离条件(0/1) × 情境效用(0..1)`，取最高分；同分按固定顺序。效用规则：

```
贴近塔心(<8m)        → CoreDrain 效用 0.9，其他 ×0.4
玩家距离 > 14 m      → LeapSlam  效用 0.8
玩家距离 3–12 m      → RockSweep 效用 0.75
StonePillars         基础效用 0.3（兜底填充，无其他技能可用时）
```

仇恨目标优先级：`嘲讽图腾(处于 Taunt 中) > 近身玩家(<6m) > 中环塔 > 塔心`。

## 【破绽控制器（WeaknessController.ts）】

独立于行为树，**只监听事件**，不查询 Boss 状态：
- 监听 `BossSkillInterrupted` → 若 `by==='freeze' || by==='interrupt'`，暴露 `core` 5 s
- 监听 `KneeBroken` → 暴露对应膝 4 s
- 监听 `FreezeFull` → 暴露 `core` 2.5 s
- 监听阶段切换 → 暴露 `back` 6 s（阶段 II 开场）
- 暴露时发 `WeaknessExposed{part, attr, durationMs}`；结束时发 `WeaknessClosed{part}`
- **同一时刻只允许一个部位打开**；新开时先关旧的

## 【导演（Director.ts）】

三条硬保证，每条都要能单独测：
1. **节奏兜底**：任意 30 s 窗口内至少一次 `WeaknessExposed`。实现：距上次暴露 25 s 仍未发生，则下一次技能强制选"带破绽收招"的技能（LeapSlam 或 CoreDrain）。
2. **惩罚贪心**：连续两次 `ExecutionEnded` 后，下三个技能优先选 StonePillars / 高伤技能（本票先按"提高 StonePillars 效用到 0.9、冷却临时减半"简单实现）。
3. **狂暴**：`MatchPhaseChanged{phase:'rage'}` 后所有技能冷却 ×0.6。

## 【数值（boss.json 初值）】

```json
{
  "maxHp": 1400,
  "phase1": { "resistPhysical": 0.70, "resistArcane": 0.00, "height": 9 },
  "phase2": { "resistPhysical": 0.00, "resistArcane": 0.70, "height": 11 },
  "brain": { "evalIntervalMs": 500, "leapMinDistance": 14, "closeRange": [3, 12], "coreNear": 8 },
  "skills": {
    "rockSweep":   { "windupMs": 900,  "activeMs": 350,  "recoveryMs": 1000, "cooldownMs": 6000, "damage": 35, "arcDeg": 120 },
    "leapSlam":    { "windupMs": 1600, "activeMs": 250,  "recoveryMs": 800,  "cooldownMs": 9000, "damage": 50, "openMs": 3000 },
    "coreDrain":   { "windupMs": 2500, "activeMs": 2500, "recoveryMs": 600,  "cooldownMs": 20000, "healPct": 5 },
    "stonePillars":{ "windupMs": 1200, "activeMs": 400,  "recoveryMs": 600,  "cooldownMs": 8000, "damage": 20, "count": 3 }
  },
  "rageCooldownScale": 0.6,
  "director": { "noWeaknessWindowMs": 25000, "guaranteeWindowMs": 30000 }
}
```

## 【验收】

```bash
npm run typecheck
npm run build
npm run pack
node kit/tools/check.mjs out/
```

加上人工验收（必须截图/录屏）：
1. 调试面板点 RockSweep：能看到右臂横扫动画，结束后胸口蓝光亮起 1 s
2. 点 LeapSlam：能看到 Boss 跳起砸下，落地后岩甲壳敞开 3 s 露出核心
3. 点 CoreDrain：能看到胸口的蓝色光球持续吸能（HP 数字上涨），再点"打断"按钮 → 核心暴露 5 s
4. 连点 30 秒不放：日志里 `WeaknessExposed` 间隔必须 < 30 s（Director 在起作用）
5. `window.__boss` 暴露 `{ hp, phase, skill, weakness }`，控制台能直接读
6. 点 `阶段II`：Boss 体型变大、材质变熔岩裂纹、抗性互换；点 `熔岩吐息` 时若调试面板勾选了"模拟嘲讽中"，背对玩家后必须暴露 `back` 6 s
7. 点 `熔岩冲撞`：Boss 沿直线冲出并撞到场地边界，眩晕 3 s 且双膝同时暴露（日志出现两条 `KneeBroken`）
8. 点 `火雨`：地面出现 10 个预警圈，2 s 后落下，落点不压在玩家当前位置上
9. 点 `冻结满` 再点 `自燃爆发`：爆发被取消，转为眩晕并暴露 `core`

## 【阶段 II「熔火形态」—— 完整实现，不是简化版】

转阶段由 `MatchPhaseChanged{phase:'transition'}` 触发：岩甲崩裂（碎片用 `InstancedMesh` 抛出后落进熔岩）、跃入熔岩（`y` 沉到 -8 再升回）、身体膨胀到 11 m、材质换成熔岩裂纹（复用 M1 的熔岩 TSL 节点材质，把 `scale` 和发光强度调高）、`maxHp` 重置为 1400、`resistPhysical/Arcane` 互换。

四个技能**全部实现**：

| 技能 | 前摇 | 生效 | 收招 | 关键行为 | 破绽 |
|---|---|---|---|---|---|
| **熔岩吐息** MagmaBreath | 1.4 s | 2.5 s | 0.9 s | 正面 20 m、±25° 锥形，每 0.25 s 判定一次伤 8；**施放期间锁定朝向不变** | 施放中若仇恨目标是非玩家（嘲讽图腾/塔）→ 躯干背对玩家 → 暴露 `back` 6 s |
| **熔岩冲撞** LavaCharge | 1.1 s | 1.8 s | 0.7 s | 沿直线以 22 m/s 冲撞，撞到塔即摧毁（发 `TowerDestroyed{reason:'broken'}`），撞到玩家伤 45 | 撞到塔/石柱/场地边界 → 眩晕 3 s 且**双膝同时暴露** 4 s（发 `KneeBroken{side}` 两条） |
| **火雨** FireRain | 2.0 s（全场预警贴花） | 6 s | 0.5 s | 全场 10 个落点，每点半径 3.5 m，落地伤 30、塔 −80 耐久；落点随机但**避开玩家当前位置 2 m**（保证可躲） | 无 |
| **自燃爆发** SelfIgnite | 1.2 s | 0.4 s | 1.5 s | 周身 10 m 爆炸伤 60；**清除自身全部 debuff 层数**（发 `DebuffStackChanged{stacks:0}`）；同时清空冻结值 | 若爆炸瞬间冻结值已满（`FreezeFull` 已触发）→ 爆发被取消，改为眩晕 2.5 s 并暴露 `core` |

阶段 II 的仇恨规则变化：**嘲讽图腾权重提到最高**（这是让 Boss 背对玩家、打开背部弱点的唯一手段），其次才是近身玩家。

阶段 II 的 `Director`：4:05 后 `MatchPhaseChanged{phase:'rage'}`，所有技能冷却 ×0.6，火雨落点从 10 增到 16。

## 【调试面板（BossDebugPanel.ts，临时，下线前删）】

用原生 DOM 做一个右下角面板：
- 一行按钮：`阶段I` `阶段II` `狂暴`
- 每个技能一个按钮（阶段 I 四个、阶段 II 四个），点击后 `forceSkill('leapSlam')`
- 一行按钮：`打断` `冻结满` `击碎膝盖L` `击碎膝盖R`（手动发对应事件，验证破绽控制器）
- 一行实时读数：`hp / phase / skill / weakness / 上次暴露距今秒数`

`window.__boss = { hp, maxHp, phase, skill, weakness, lastExposeAgoMs }`。

## 【本票明确不做】

玩家的伤害输入（打到 Boss 身上不掉血）、塔的实体、UI 血条。这些属于 M2 系列。本票结束时 Boss 能自己动、自己打、自己开弱点，但玩家还打不动它 —— 这是故意的，为了把两张票彻底解耦。
