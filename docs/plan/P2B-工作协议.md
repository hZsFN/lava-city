# P2-B 工作协议（塔系统 + 流程）

> 版本 v1.0 · 2026-11-08 11:35
> **本文件只约束 P2-B 这一路。** 不涉及 Boss、渲染、玩家、UI —— 那些是别人的活。
> 技术事实源：`docs/熔心孤塔_设计与AI开发规划.md`
> 契约事实源：`src/core/events.ts`（只读）+ `docs/plan/CONTRACT.lock`

---

## 0. 三十秒版

1. 你只写 `src/towers/`、`src/flow/`、`src/telemetry/` 和它们的单测。
2. `src/core/**` 一个字都不能改（events.ts 和所有 config 都是契约）。
3. 逻辑层禁止 `import three`。
4. 提交前 `npm run gate` 必须全绿。
5. 只 commit，不 push。S0 合并。
6. 每 30 分钟更新 `handoff/S1-p2b.md`。

---

## 1. 目录与分支

| 项 | 值 |
|---|---|
| 工作目录 | `E:\demo\wt-p2b` |
| 分支 | `feat/towers-flow` |
| 仓库 | `https://github.com/hZsFN/lava-city.git` |
| 账号 | `fireworkPx`（已配好，直接 git） |
| 交接文件 | `handoff/S1-p2b.md`（只写这个） |

### 开工第一条命令

```powershell
cd E:\demo\wt-p2b
git fetch origin
git rebase origin/master
npm install --no-fund --no-audit
npm run gate
```

`npm run gate` 必须输出 `[gate] ===== 全部通过 =====` 才能开始写代码。

---

## 2. 写作用域（硬边界）

### ✅ 可以写

```
src/towers/**
src/flow/**
src/telemetry/**
tests/unit/towers/**
tests/unit/flow/**
handoff/S1-p2b.md
```

### ❌ 绝对不许碰

```
src/core/**              含 events.ts 和所有 config/*.json
src/render/**            渲染
src/player/**            玩家
src/combat/**            战斗
src/boss/**              Boss
src/ui/**                UI
src/main.ts              集成入口
package.json / tsconfig.json / vite.config.ts / vitest.config.ts
scripts/**
docs/tickets/**          票是 S0 写的，你只读
```

### 三条越权判定（命中即整次提交回退）

1. commit 里出现上面 ❌ 清单中的任何文件
2. 修改了 `src/core/events.ts`（哈希校验会直接失败）
3. 逻辑层出现 `import three`

---

## 3. 契约规则（最重要）

### 3.1 什么是契约

`src/core/events.ts`（事件 + 快照）+ `src/core/config/*.json`（全部数值）。
这是四路之间**唯一的耦合点**，只有 S0 能改。

### 3.2 P2-B 需要新事件怎么办

写进 `handoff/S1-p2b.md`：

```markdown
### 契约申请 #1（11:42 提出）
- 事件名：`TowerAmmoChanged`
- 字段：`{ towerId: string; ammo: number }`
- 触发时机：塔每次开火后
- 为什么已有事件不够：`TowerTargetHit` 不带剩余弹药，HUD 显示不了
- 提出人：S1
- 状态：待 S0 裁决
```

commit 后告诉 S0 一句「契约申请 #1 已提」。S0 合并后你 `git rebase origin/master` 就能用。

**不许自己复制一份 events.ts。不许在别的文件另起一套事件类型。**

### 3.3 归属规则（避免两边重复发同一事件）

| 事件 | 唯一发布方 | 说明 |
|---|---|---|
| `DebuffStackChanged` | **Boss** | 塔只发 `TowerTargetHit`，不许自己发层数 |
| `BossSkillInterrupted` | **Boss** | 塔发 `TowerInterruptRequested`，Boss 掷骰成功后才发 |
| `MatchEnded` | **flow（你）** | 一局只发一次 |
| `MatchPhaseChanged` | **flow（你）** | 每个时间点切换时发 |
| `LavaLevelChanged` | **flow（你）** | 熔岩高度变化时发 |
| `TowerHpChanged` | **towers（你）** | `place()` 后必须立刻发一次初始化 hp |
| `TowerSlotStateChanged` | **towers（你）** | 塔位状态机变化时发 |
| `TowerPlaced / TowerUpgraded / TowerDestroyed / TowerTargetHit` | **towers（你）** | |
| `FreezeProgressChanged` | **towers（你）** | 寒晶冻结值进度 |
| `TowerInterruptRequested` | **towers（你）** | 震地锚请求打断 |

---

## 4. 禁止 import three（第二红线）

**允许**
```ts
import type { Bus, Vec3, MatchPhase } from '../core/events';
import towersCfg from '../core/config/towers.json';
import { createRng } from '../core/rng';
```

**禁止**
```ts
import * as THREE from 'three';          // ❌
import { Vector3 } from 'three';         // ❌
import anything from 'three/...';        // ❌
```

**为什么**
1. 你的单测要在纯 Node 跑（`vitest.config.ts` 里 `environment: 'node'`），import three 直接崩。
2. 渲染层要能整个换掉而不动玩法。
3. 位置用 `Vec3 = readonly [number, number, number]` 就够了。

**需要向量运算**：在自己模块里写局部纯函数。不要为了 `Vector3` 引 three。

`npm run contract` 会自动扫 `src/towers` 和 `src/flow`，命中即失败。

---

## 5. 你的两张票

### 票 1：`docs/tickets/M2-01-towers.md`

**塔位 + 建/升/拆 + 耐久**

| 项 | 内容 |
|---|---|
| 写 | `src/towers/TowerSocket.ts`、`TowerBase.ts`、`TowerSystem.ts`、`BuildMenu.ts` |
| 测 | `tests/unit/towers/*.test.ts` |
| 单测 | 13 条 |
| 交付 | 12:00 前 |

核心行为：
- 初始 7 个塔位 open（M1-M4、T1-T3），4 个 locked（E1-E4）
- `place()` 成功要发 3 个事件：`TowerPlaced` + `TowerHpChanged` + `TowerSlotStateChanged`
- 拆除返还 = `floor((cost + 升级花费) * 0.7)`
- 耐久归零 → `TowerDestroyed{reason:'broken'}`，槽位回 `open`
- `setPhase('boss2')` → 4 个 E 位依次变 open
- `setLavaY()` 超过 `drownSlotY` → 槽位 `submerged`，塔 `TowerDestroyed{reason:'drowned'}`
- 仰角死区：Boss 水平距 < 4 m 时塔身塔位不产生 `TowerTargetHit`

### 票 2：`docs/tickets/M2-03-flow.md`

**4:30 时间轴 + 熔岩 + 塔心 + 评分**

| 项 | 内容 |
|---|---|
| 写 | `src/flow/MatchTimeline.ts`、`Scoring.ts`、`MatchRunner.ts`、`src/telemetry/Telemetry.ts` |
| 测 | `tests/unit/flow/*.test.ts` |
| 单测 | 12 条 |
| 交付 | 13:15 前 |

核心行为：
- 7 段阶段严格按 `flow.json` 推进，每段切换发一次 `MatchPhaseChanged`
- 熔岩：boss1 结束 `-1.8` → transition 结束 `-0.8` → rage 每秒 +1.2
- `MatchEnded` 一局只发一次
- 评分：S/A/B/C 按 `flow.json` 的 `score.grades` 匹配，**输了最高只能 B**
- `runToEnd()` 在纯 Node 下跑完一局 < 2 秒

### 票 3（若还有时间）

5 种塔的具体攻击与特效事件：
- 弩炮：命中 4 次叠 1 层碎甲，上限 5 层
- 符文：叠灼烙，上限 5 层
- 寒晶：冻结值累积，满 100 发 `FreezeFull` 与 `FreezeProgressChanged{value:100}`
- 震地锚：50% 概率发 `TowerInterruptRequested`
- 嘲讽：6 s 时长、20 s CD，发 `TauntStarted` / `TauntEnded`

---

## 6. 提交规范

### 提交前必做

```powershell
npm run gate
```

必须全绿。不绿不许 commit。

### 提交命令

```powershell
cd E:\demo\wt-p2b

# 只 add 自己作用域内的文件，不要 git add -A
git add src/towers src/flow tests/unit/towers tests/unit/flow handoff/S1-p2b.md

git commit -m "towers: 塔位注册与建拆（T-M2-01）"
```

### 提交信息格式

```
<模块>: <做了什么>（<票号>）
```

例：
- `towers: 塔位注册与建拆（T-M2-01）`
- `flow: 4:30 时间轴状态机（T-M2-03）`
- `towers: 五种塔特效事件（T-M2-04）`
- `handoff: S1 进度 12:30`

### 不 push

你的提交留在 `feat/towers-flow` 本地分支，S0 在合并点合并。

---

## 7. 交接（每 30 分钟一次）

更新 `handoff/S1-p2b.md`，照 `handoff/README.md` 的模板：

```markdown
# S1 · P2-B 交接

> 最后更新：12:30

## 状态
- 当前分支：feat/towers-flow
- 最后提交：abc1234
- 本轮进度：进行中

## 已完成
- TowerSocket 状态机
- place/upgrade/sell 主流程

## 对外暴露的接口（别人可以依赖的）
```ts
export function createTowerSystem(): TowerSystem;
export interface TowerSystem {
  place(slotId: string, kind: string): boolean;
  upgrade(towerId: string): boolean;
  sell(towerId: string): boolean;
  setPhase(phase: MatchPhase): void;
  setLavaY(y: number): void;
  list(): TowerView[];
}
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

## 8. 交付格式（每次交付都按这个）

```markdown
【交付】票号
状态：完成 / 部分完成 / 阻塞

1. 改动文件列表
2. npm run gate 输出末尾 20 行（必须含 [gate] ===== 全部通过 =====）
3. 单测通过情况（贴 vitest 的 Tests  N passed 那行）
4. 契约申请 / 跨目录请求（如有）
5. 未完成项与原因
6. 复现方式（命令 + 预期现象）
```

**没有证据不算完成。** "应该能跑"不是证据，`npm run gate` 的输出才是。

---

## 9. 遇到问题

| 情况 | 做法 |
|---|---|
| 契约不够用 | 写「契约申请」，告诉 S0，**不要自己加** |
| 需要改别人文件 | 写「跨目录请求」，**不要自己改** |
| 门禁报错看不懂 | 贴完整报错，不要猜着改 |
| 同一错误失败 3 次 | 停下，报告现象/已试/猜测/需要什么决定 |
| 时间不够 | 先交付能跑的最小版本 + 在 handoff 写清缺什么 |
| rebase 冲突在别人作用域 | 停下找 S0 |

---

## 10. 时间表

| 时刻 | 事件 |
|---|---|
| 11:35 | 开工，跑 gate |
| 12:00 | **合并点 M1**：票 1 交付 |
| 13:15 | **合并点 M2**：票 2 交付 |
| 14:15 | **合并点 M3**：票 3（若做） |
| 14:45 | **合并点 M4**：收口 |
| 15:00 | 冻结，只修 blocker |

---

## 11. 变更记录

| 版本 | 时间 | 变更 |
|---|---|---|
| v1.0 | 2026-11-08 11:35 | 初版：只覆盖 P2-B 一路，不含 Boss/渲染/玩家 |
