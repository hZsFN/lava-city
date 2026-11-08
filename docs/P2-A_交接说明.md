# P2-A 交接说明 · 玩法 Agent A（player + combat）

> 交接人：P2 玩法 Agent A（当前会话）· 交接对象：主人（P2 玩法负责人，另开新对话接手）
> 时间：2026-11-08（本地）
> 关联文档：`docs/熔心孤塔_设计与AI开发规划.md`（唯一事实来源）· `docs/tickets/M0-01-skeleton.md`（契约附录）· `docs/04-三人×多Agent分工与提示词方案.md`

---

## 一、交接背景与当前进度

- 远端 `master` 已含 3 张 TRAE/P1 的票：`M0-01`（骨架）、`M1-01`（渲染）、`M3-01`（Boss），**M0 工程代码尚未落地**（root 无 `src/`、无 `package.json`）。
- 主人指示：**P2 现在就能开工，不用等 M0**。因为 P2 只需要 `events.ts` 接口定义和 `config/*.json` 字段名（都是文本约定）；`events.ts` 已由 M0-01 附录逐字写定，P2 自行复制一份，M0 落地后 git 自动合并成同一份。
- P2-A 已按此原则落地了一批**不依赖 three、可独立编译**的逻辑代码。

---

## 二、已落地的文件

### 2.1 源码（`src/`）

| 文件 | 内容 | 状态 |
|---|---|---|
| `src/core/events.ts` | 逐字照抄 M0-01 附录契约（`Events` / `Snapshot` / `createBus`）。**补了最小 bus 实现体**（`on/emit/snapshot/__setSnapshot`），接口形状逐字对齐，未改任何事件名/字段/签名 | ✅ 已写 |
| `src/core/config/player.json` | 手感参数初值：移速 6.5 / 冲刺 11 / 跳高 1.2 / 眼高 1.7 / HP100 / 脱战回血 / 双武器（重锤三段 30/30/60、岩锚 80、法杖火花 12@5/s、地脉穿刺 90、过热 4s/2s）/ 熔核开局 6 | ✅ 已写 |
| `src/combat/Damage.ts` | 纯函数伤害模型：`computeDamage`（最终=基础×(1−抗性+Σdebuff减抗, 下限−30%)×弱点倍率 2.5/1.2/1.0）、`executionDamage`（maxHp×12% 真伤）、`weaknessContribution`（匹配+1/不匹配+0.25/塔×0.5）、`clampResist`。全部数值非硬编码 | ✅ 已写 |

> ⚠️ 注意：`Damage.ts` 遵守「逻辑层禁止 import three」，只依赖 `events.ts` 类型。

### 2.2 独立验证环境（`tools/p2a/`，不碰 M0 root 构建链）

| 文件 | 说明 |
|---|---|
| `package.json` | scripts：`typecheck`（tsc --noEmit）、`test`、`test:cov`（vitest + v8 coverage） |
| `tsconfig.json` | strict、ES2022、resolveJsonModule、include `../../src/**` + 本地 tests |
| `vitest.config.ts` | coverage 含源码(combat/player)、门禁 branches≥80 / functions≥80 / lines≥85 / statements≥85 |

> `tools/p2a/pnpm-lock.yaml` 已生成；`node_modules` 与 `.pnpm-store`（60M 缓存）**未提交**（本地已删 .pnpm-store）。

### 2.3 文档

| 文件 | 说明 |
|---|---|
| `docs/P2-A技术预研备忘与契约申请清单.md` | Rapier KCC 官方结论、时间缩放、Damage 公式要点、契约申请清单 |

---

## 三、待接手完成的事项（按优先级）

### 3.1 【立即】跑通验证环境
在 `tools/p2a/` 执行（我在本会话用 pnpm 装着，但 **esbuild 的 build script 被 pnpm 默认忽略**，报 `ERR_PNPM_IGNORED_BUILDS`，vitest/tsc 链路不完整）：

```bash
cd tools/p2a
pnpm approve-builds   # 允许 esbuild@0.21.5 运行 postinstall
pnpm install          # 重装，让 esbuild 真正编译
pnpm typecheck
```

- 预期：`typecheck` 零错误。若 `tsc`/`esbuild` 链仍异常，改用 `node_modules/typescript/...` 真实入口，或切回 npm（注意 npm 全局 cache 有 root-owned 文件，需 `sudo chown -R 501:20 ~/.npm` 修复）。

### 3.2 补首个单测并跑覆盖率
尚未写任何 `.test.ts`。建议先生成 `tools/p2a/tests/unit/combat/damage.test.ts`，覆盖：
1. `computeDamage`：无弱点 ×1.0；命中弱点匹配 ×2.5（isCrit=true）；命中弱点不匹配 ×1.2；抗性下限 −30%（高减抗时封顶 1.3×）。
2. `executionDamage`：maxHp×0.12 真伤，无视抗性。
3. `weaknessContribution`：匹配 +1/伤害点；不匹配 +0.25；塔来源 ×0.5；无弱点 0。

跑 `pnpm test:cov`，目标 **`Damage.ts` 100% 分支覆盖**（设计文档 §8 与分工方案硬要求）。

### 3.3 建议调整：契约申请
- M0-01 契约已含 P2-A 需要的主要事件：`PlayerDashed / FormSwitched / OverheatChanged / DamageDealt / ExecutionStarted / ExecutionEnded / WeaknessProgress / PlayerDied / PlayerSpawned / PlayerRespawned / TacticalViewChanged`。
- 我预研清单里提的 `WeaponChanged / AttackSwing / TacticalPointUsed` **未被 M0 采用**。**建议沿用 M0 现有事件名（如 `FormSwitched` 替代 `WeaponChanged`，`DamageDealt` 承载挥击信息，`MoteCountChanged` 管熔核、`TacticalViewChanged` 管战术视图），不做新契约申请**，避免与 P1 冲突、保证 15 点联调无缝。

### 3.4 后续实现顺序（等 M0 落地后）
1. Damage.ts（已完成）→ 单测 100% 覆盖
2. `src/player/PlayerController.ts`（§5.1 输入 / §5.3 HP / 冲刺 0.25s 无敌帧触发 `PlayerDashed` / 死亡触发 `PlayerDied`）
3. `src/player/WeaponPhysical.ts`（+ 双段 AI 冷却）
4. `src/player/WeaponMagic.ts`（过热 / 引导，发布 `OverheatChanged`）
5. `src/player/Execution.ts`（`ExecutionStarted/Ended`）
6. `src/combat/StatusEffects.ts` / `src/combat/Projectiles.ts`
7. `src/player/TacticalView.ts`（发 `TacticalViewChanged`）

> 物理引擎：M0-01 明确「本票不装 Rapier，物理推迟到 M2 票决定，先用手写 AABB」。我的预研基于 Rapier，但**实现应按 M0 约定先用手写 AABB 验证玩法**，Rapier 留待 M2 再议。此分歧需主人定夺。

---

## 四、硬约束提醒（摘自分工方案 §四，P2 必须遵守）

1. **`events.ts` 绝对不许改**。需要新事件走「契约申请」，由 P1 合并。自己造一套事件 → 15 点联调对不上，是最可能致命的点。
2. **P2 不要 `import three`**。逻辑层只通过事件总线 + 只读快照与渲染层通信；渲染层靠事件驱动特效。
3. 只写 `src/player/` + `src/combat/`；需要别的目录时走「跨目录请求」。
4. 数值只进 `config/*.json`，代码不硬编码；随机走 `core/rng.ts`。
5. 提交前 `typecheck && lint && test` 全绿；combat 票附覆盖率。

---

## 五、需主人/上级定夺的开放问题

| # | 问题 | 选项影响 |
|---|---|---|
| 1 | 物理用 Rapier 还是先手写 AABB？ | M0 约定先 AABB；我的预研假设 Rapier。影响 `PlayerController` 的碰撞/冲刺无敌帧实现 |
| 2 | `tools/p2a/` 进入 M0 工程后如何并入 root？ | 已设计为独立目录，root 落地后可迁回 `tests/` + root `package.json` scripts |
| 3 | `.pnpm-store` 是否应进 root `.gitignore`？ | M0 持有 `.gitignore`，建议补一行 `.pnpm-store/` |
| 4 | 新事件是否完全沿用 M0 现有事件？ | 依 §3.3 建议：是，暂不申请新契约 |