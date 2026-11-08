# 票 T-M2-01 · 塔位与建 / 升 / 拆 / 耐久

> 归属：**S1（P2-B）** ｜ 写作用域：`src/towers/**`、`tests/unit/towers/**`
> 设计依据：`docs/熔心孤塔_设计与AI开发规划.md` 第 4.1、6.1、6.2、6.3 节
> 契约依据：`src/core/events.ts`（v1.1）· 数值来源：`src/core/config/towers.json`、`src/core/config/arena.json`
> **本票不实现 5 种塔的具体攻击逻辑**（那是 T-M2-02）。本票只做"塔能建、能升、能拆、会掉血、塔位有状态"。

---

## 【目标】

把 `arena.json` 里 11 个塔位变成可交互的实体：玩家能在开放塔位上建塔、升级、拆除，塔有耐久会掉血，塔位有 `locked → open → occupied → submerged` 状态机，外环在阶段 II 解锁，熔岩上涨会淹掉塔。

---

## 【范围】

允许新建/修改：

```
src/towers/TowerSocket.ts      塔位状态机
src/towers/TowerBase.ts        塔实例（等级/耐久/位置）
src/towers/TowerSystem.ts      对外门面（place/upgrade/sell/update/setPhase/list）
src/towers/BuildMenu.ts        建塔径向菜单的**逻辑层**（不是 DOM）
tests/unit/towers/*.test.ts
```

**禁止修改**：`src/core/**`（含 events.ts 和所有 config）、`src/flow/**`、`src/render/**`、`src/main.ts`、`package.json`。

**禁止 import three。** 位置用 `Vec3 = readonly [number, number, number]`，不要 `THREE.Vector3`。

---

## 【对外接口（必须逐字实现，其他会话依赖它）】

```ts
// src/towers/TowerSystem.ts
import type { Bus, MatchPhase, Vec3, BodyPart } from '../core/events';
import type { Rng } from '../core/rng';

export interface TowerView {
  id: string;
  kind: string;
  level: number;
  hp: number;
  maxHp: number;
  slotId: string;
  pos: Vec3;
}

export interface TowerUpdateCtx {
  bossPos: Vec3;
  bossPart?: BodyPart;
  playerPos: Vec3;
  /** 当前可用熔核数；place/upgrade 会扣它，通过 MoteCountChanged 广播 */
  motes: number;
  /** 本帧是否允许开火（阶段未开始/已结束时为 false） */
  canFire: boolean;
}

export interface TowerSystem {
  init(deps: { bus: Bus; rng: Rng; towersCfg: unknown; arenaCfg: unknown }): void;
  update(dtSec: number, ctx: TowerUpdateCtx): void;
  place(slotId: string, kind: string): boolean;
  upgrade(towerId: string): boolean;
  sell(towerId: string): boolean;
  /** 阶段切换时调用：处理外环解锁与熔岩淹没 */
  setPhase(phase: MatchPhase): void;
  /** 熔岩高度变化时调用：y 超过 drownSlotY 的塔位被淹没 */
  setLavaY(y: number): void;
  list(): TowerView[];
  /** 建塔/升级所需熔核，供 UI 显示；不可建时返回 null */
  costOf(kind: string): number | null;
}

export function createTowerSystem(): TowerSystem;
```

---

## 【行为规格（每条都要有单测）】

### 1. 塔位状态机

```
初始：unlockPhase=1 的 7 个塔位（M1-M4, T1-T3）→ 'open'
      unlockPhase=2 的 4 个塔位（E1-E4）     → 'locked'

place 成功 → 'occupied'
sell / 塔被摧毁 → 回到 'open'（若该位未被淹没）
setPhase('boss2' 或 'transition' 之后) → 所有 E 位 'locked' → 'open'
setLavaY(y) 且 y >= arena.lava.drownSlotY → 该位 'submerged'，其上塔发 TowerDestroyed{reason:'drowned'}
```

每次状态变化发 `TowerSlotStateChanged { slotId, state }`。

### 2. 建塔

```
place(slotId, kind)
  条件：塔位存在 且 state === 'open' 且 熔核 >= cost 且 kind 合法
  成功：
    - 立即扣熔核 → 发 MoteCountChanged
    - 建塔动画 buildSec = 0.5 s（本票用内部计时器表示，不涉及渲染）
    - 发 TowerPlaced { towerId, kind, slotId, pos }
    - **立即**发 TowerHpChanged { towerId, hp: maxHp, maxHp }（契约要求：TowerPlaced 不带 hp）
    - 发 TowerSlotStateChanged { slotId, state:'occupied' }
    - 返回 true
  失败：不发任何事件，返回 false
```

`towerId` 格式：`${slotId}-${kind}-${递增序号}`，保证一局内唯一。

### 3. 升级

```
upgrade(towerId)
  条件：塔存在 且 level < build.maxLevel(2) 且 熔核 >= floor(cost * build.upgradeCostRatio)
  成功：扣熔核、level+1、耐久回满、发 TowerUpgraded + TowerHpChanged
```

### 4. 拆除

```
sell(towerId)
  条件：塔存在
  成功：返还 floor(cost * build.sellRefundRatio) 熔核（**按已投入总额算，含升级花费**）
        发 TowerDestroyed { reason:'sold' } + TowerSlotStateChanged{state:'open'} + MoteCountChanged
```

### 5. 耐久

```
塔被 Boss 打到 → applyDamage(towerId, amount)（本票提供这个内部方法，T-M2-02/M3 调用）
  发 TowerHpChanged { towerId, hp, maxHp }
  hp <= 0 → 发 TowerDestroyed { reason:'broken' } + 槽位回 'open'
```

### 6. 仰角死区（塔身塔位）

`arena.elevationDeadzoneDeg = 25`。塔身塔位（`ring === 'tower'`，y=12）对**贴塔基的 Boss**（水平距离 < 4 m）无法命中：
`update()` 时若该塔的目标水平距离 < 4 m 且塔位 y > 6，则不产生 `TowerTargetHit`。

### 7. 建塔菜单逻辑（BuildMenu.ts）

```ts
export interface BuildMenuState {
  slotId: string | null;          // 当前打开的塔位
  options: Array<{ kind: string; name: string; cost: number; affordable: boolean; range: number; special: string }>;
}
export function createBuildMenu(towersCfg: unknown, motes: number, slotId: string | null): BuildMenuState;
```
纯函数，不碰 DOM。UI 会话将来直接消费这个返回值。

---

## 【验收】

在 `E:\demo\wt-p2b` 下依次执行：

```powershell
npm run gate
```

必须全绿。**另外本票专属的单测**（`tests/unit/towers/`）必须覆盖：

1. ✅ 初始 7 个塔位 open、4 个 locked
2. ✅ 在 locked 塔位上 place → 返回 false 且**不发任何事件**
3. ✅ 熔核不足时 place → false，熔核不变
4. ✅ 正常 place → 扣熔核、发 TowerPlaced + TowerHpChanged + TowerSlotStateChanged，hp === maxHp
5. ✅ 同一塔位重复 place → 第二次 false
6. ✅ 升级到 maxLevel 后不再能升
7. ✅ 升级花费 = `floor(cost * 0.7)`
8. ✅ 拆除返还 = `floor((cost + 升级花费) * 0.7)`
9. ✅ 耐久归零 → TowerDestroyed{reason:'broken'} + 槽位回 open
10. ✅ `setPhase('boss2')` → 4 个 E 位依次变 open（4 条 TowerSlotStateChanged）
11. ✅ `setLavaY(drownSlotY)` → 对应塔位 submerged + 塔发 TowerDestroyed{reason:'drowned'}
12. ✅ 仰角死区：Boss 水平距 < 4 m 时塔身塔位不产生 TowerTargetHit
13. ✅ `createBuildMenu` 在熔核不足时 `affordable: false`

**验收证据必须贴 `npm run gate` 的实际输出末尾 20 行**（含 `[gate] ===== 全部通过 =====`）。

---

## 【禁止事项】

1. ❌ 不要改 `events.ts`。缺事件 → 在 `handoff/S1-p2b.md` 提「契约申请」。
2. ❌ 不要 `import three`（`npm run contract` 会拦）。
3. ❌ 不要实现 5 种塔的攻击（T-M2-02 的事）。
4. ❌ 不要写 DOM（BuildMenu 只是纯函数）。
5. ❌ 不要硬编码数值（全部从 config 读）。
6. ❌ 不要 `git push`。

---

## 【交付格式】

按 `AGENTS.md`：

1. 改动文件列表
2. `npm run gate` 输出摘要
3. 13 条单测的通过情况（贴 vitest 的 `Tests  13 passed` 那行）
4. 契约申请 / 跨目录请求（如有）
5. 未完成项与原因
6. 复现方式（`npm run gate` + `npx vitest run tests/unit/towers`）
