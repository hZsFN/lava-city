# P2-A 技术预研备忘 + 契约申请清单

> 作者：P2 玩法 Agent A（player + combat）
> 状态：预研稿，供与 P1 架构 Agent 对齐；M0 骨架落地后据此实现
> 依据：`熔心孤塔_设计与AI开发规划.md`（唯一事实来源）· Rapier 官方 Character Controller 文档（v0.21）

---

## 一、Rapier KinematicCharacterController —— 关键技术结论

> 核实的官方说明（rapier.rs/docs/user_guides/javascript/character_controller）

1. **controller 不持有角色引用**：`world.createCharacterController(offset)` 返回的实例可复用于多个 collider。负责"算一段理想位移被障碍修正后的真实位移"。
2. **三选一的落地方式**（决定 PlayerController 用哪种）：
   - 未挂刚体的 collider：`collider.setTranslation(当前 + corrected)`。
   - **position-based 刚体（本方案推荐）**：`rigidBody.setNextKinematicTranslation(当前 + corrected)` —— 与固定步长 60 Hz 天然契合。
   - velocity-based 刚体：`setLinvel(corrected / dt)`。
3. **重力必须自己加**：KCC 只处理障碍滑动，不内置完整重力；我需在 desiredTranslation 里附加 downward 分量，再让 controller 修正。跳跃：velocity 的垂直分量在 airborne 时自己处理，并配合 `setCharacterAutostep` / `enableSnapToGround` 提升手感。
4. **碰撞事件：**`numComputedCollisions()` + `computedCollision(i)` 取条带化碰撞信息 —— 用于判定落地/共享平台，而非靠穿模。
5. **Filtering（重点，决定所谓"无敌帧"怎么实现）**：`computeColliderMovement(collider, v, filterFlags, filterGroups, filterPredicate)`。**冲刺 0.25s 无敌帧** = 在 move 时对"会命中玩家的碰撞体"设置过滤（例如临时过滤 boss 的 hitbox collider，或 filterGroups 让冲刺帧归到某 group），而不是物理性"取消碰撞"。
6. **应用冲量**：`setApplyImpulsesToDynamicBodies(true)` 让 KCC 把接触力推给动态刚体（若玩家需推动碎石/岩甲碎片）。默认不推。

> 设计文档 §4.2 手感基准：移速 6.5 / 冲刺 11（0.25s 无敌帧）/ 跳高 1.2 / 眼高 1.7。

---

## 二、时间缩放与 fixed-timestep 联动（PlayerController / Execution / TacticalView）

- 逻辑层**不接受渲染帧时间**直接控制移动；移动用固定步长 `dt=1/60`，乘以 `core.time.scale`（1.0 / 0.2 击破慢镜 / 0.15 战术视图）。
- **Club：不要用 `requestAnimationFrame` 累积真实 dt 来算 move**；应由 `core.time` 提供 `advance(dt*scale)` 由主循环驱动。PlayerController 只读 `core.time.scale`。
- 冲刺无敌帧计时按**逻辑时间**（`scale` 也作用其上），而非渲染帧。这样慢镜/战术视图不会让 0.25s 无敌帧变得超长。

---

## 三、Damage 公式（§8）纯函数要点

```
最终 = 基础 × (1 − 抗性 + Σdebuff减抗)   // 抗性下限 −30%（最高 1.3×）
     × 弱点倍率（命中弱点且属性匹配 2.5 / 命中弱点属性不匹配 1.2 / 其他 1.0）
击破 = 阶段最大HP × 12%，真实伤害，无视抗性
破绽累加：匹配属性 +1/伤害点；不匹配 +0.25；塔来源 ×0.5
```

- `Damage.ts` 必须**纯函数、100% 分支覆盖**。所有数字（抗性、倍率、下限）都从 `config/*.json` 读，不硬编码。
- 弱点偏转逻辑分两类：`WeaknessExposed{part, element, duration}` 决定了哪个部位、什么属性、持续多久。击破处决 `Execution.ts` 只发 `ExecutionStarted/Ended`，不直接碰 Boss 对象或渲染。

---

## 四、给 P1 的契约申请清单（P2-A 需要 events.ts / config 提供的东西）

### 4.1 事件（events.ts，P2-A 将发布或订阅）

| 事件 | 方向 | 字段 | 触发 |
|---|---|---|---|
| `PlayerDied` | 发 | — | HP≤0 |
| `PlayerDashed` | 发 | `{iframes:boolean}` | 冲刺开始/结束 |
| `WeaponChanged` | 发 | `{form:'physical'\|'magic'}` | Q 切换完整后 |
| `AttackSwing` | 发 | `{form, index, atk}` | 武器每段挥出 |
| `ExecutionStarted` / `ExecutionEnded` | 发 | `{target, part}` / — | 处决开/合（供渲染慢镜） |
| `TacticalPointUsed` / `FreeRearrangeGranted` | 发/收 | — | 战术点消费 / 免费重布 |
| 订阅 `BossSkillStart/Interrupted`、`BossPhaseChanged`、`MatchPhaseChanged` | 收 | — | 击破时机/慢镜联动、读时间轴 |

### 4.2 config/*.json

- `config/player.json`：`moveSpeed, sprintSpeed, jheight, eyeHeight, dashIFramesMs, hp100, overhearSec, cd, weapon 三段与岩锚/法杖参数`。
- `config/visual.json`：属性色（法术蓝/物理白金）—— P2-A 只**读**，用于准星/破绽环逻辑，渲染色归渲染层。
- `config/arena.json`、`config/towers.json`：仅读（战术视图塔位、击破给战术点）。
- `config/effects.json`：状态效果词条（灼烙/碎甲/冻结/眩晕）。

### 4.3 需要 P1 在 M0 提供的基础设施

- `window.__game.snapshot()` 至少含 `player.position/hp/form/overheating`、`timeline.phase`，供验收断言。
- `core/time.ts` 的 `scale` 与 `advance()`；`core/rng.ts` 可播种随机。
- 固定步长主循环（逻辑 60 Hz + 渲染可变）。
- `tests/` Vitest 骨架 + 覆盖率门禁；`npm run typecheck/lint/test`。

---

## 五、P2-A 实现顺序建议（等 M0）

1. **Damage.ts（纯函数，先打 100% 覆盖率）** —— 是 A2/A3 武器和 A4 击破的公共底座。
2. **PlayerController + Boss 分部位 hitbox 靶** —— 可独立 "走/跳/冲刺/掉熔岩重生"，触发 `PlayerDied`。
3. **WeaponPhysical / WeaponMagic** —— 接 Damage 与 event。
4. **Execution（击破）** —— 接 WeaknessExposed / Break 事件 + 时间缩放。
5. **StatusEffects / Projectiles** —— 独立模块可并行。
6. **TacticalView** —— 依赖时间缩放与 arena。

> 每张票约 2–6 小时、可独立验证；验收命令统一为 `typecheck && lint && test`，combat 票附覆盖率。