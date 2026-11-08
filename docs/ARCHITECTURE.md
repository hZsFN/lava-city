# 熔心孤塔 · 项目底层架构

> 版本：v1.0 · 2026-11-08
> 基线提交：`0b72efb`
> 适用对象：接手本项目的任何人（含 AI Agent）
> 本文只讲**架构事实**，不讲进度与派工。进度见 `docs/PLAN.md`，协作规则见 `docs/plan/00-作战协议.md`。

---

## 一、项目是什么

《熔心孤塔》—— 第一人称塔防 × Boss 战的单人关卡。玩家站在熔岩海中的孤塔塔顶，建塔防守，最终击破 Boss 核心。

技术形态：**浏览器 WebGPU 3D 游戏**，Vite + TypeScript + three.js，打包为可嵌入官方大厅 iframe 的静态站点。

---

## 二、分层架构（最重要的一张图）

```
┌─────────────────────────────────────────────────────────────┐
│  平台层（官方大厅，非本项目代码）                              │
│  window.__WL__ : save / respawn / completeLevel / failLevel  │
│  shared/save-protocol.js（非模块脚本，挂 window.WL）           │
└──────────────────────────┬──────────────────────────────────┘
                           │ 交接协议
┌──────────────────────────▼──────────────────────────────────┐
│  入口层  src/main.ts                                         │
│  启动顺序：App.init → createGame → createGameView → 接线      │
│  职责：组装、WL 协议对接、调试快捷键、暴露 window.__game       │
└──────────────────────────┬──────────────────────────────────┘
                           │
        ┌──────────────────┴──────────────────┐
        │                                     │
┌───────▼────────────────┐      ┌─────────────▼──────────────┐
│  表现层（可替换）        │      │  逻辑层（纯 TS，禁 three）   │
│  src/render/**         │      │  src/towers/**  src/flow/** │
│  src/ui/**             │      │  src/player/**  src/combat/**│
│  three.js / WebGPU     │      │  src/boss/**  src/game/**   │
│                        │      │  src/telemetry/**           │
│  只订阅 bus.on          │      │  发布 bus.emit              │
│  只读 bus.snapshot()    │      │  拥有状态，写 snapshot      │
└────────────────────────┘      └─────────────┬──────────────┘
                                              │
                              ┌───────────────▼──────────────┐
                              │  契约层  src/core/**          │
                              │  events.ts  —— 事件 + 快照定义 │
                              │  config/*.json —— 全部数值    │
                              │  rng.ts —— 确定性随机         │
                              └──────────────────────────────┘
```

**核心不变式：逻辑层永远不知道渲染层存在。** 逻辑层只发事件、写快照；渲染层只订阅、只读快照。这条线一破，项目就不可维护。

---

## 三、契约层（`src/core/`）

### 3.1 `events.ts` —— 唯一耦合点

**契约版本 v1.1**，296 行，包含三个核心类型：

| 类型 | 作用 |
|---|---|
| `Events` | 全部事件名到载荷类型的映射（约 45 个事件） |
| `Snapshot` | 单帧只读状态快照（供渲染/UI 拉取） |
| `Bus` | 事件总线接口：`on` / `emit` / `snapshot` / `__setSnapshot` |

**事件分组**（按领域）：

| 组 | 事件举例 | 唯一发布方 |
|---|---|---|
| 玩家 | `PlayerMoved` `PlayerDamaged` `FormSwitched` `OverheatChanged` | player |
| 战斗 | `DamageDealt` `ExecutionStarted` `WeaknessProgress` | combat |
| Boss | `BossHpChanged` `BossSkillStart` `WeaknessExposed` `KneeBroken` | boss |
| 塔 | `TowerPlaced` `TowerHpChanged` `TowerSlotStateChanged` `TowerInterruptRequested` | towers |
| 流程 | `MatchPhaseChanged` `MatchEnded` `LavaLevelChanged` `CoreHpChanged` | flow |

**`Snapshot` 结构**：

```ts
{
  tSec, phase, phaseEndsAtSec,
  boss:   { hp, maxHp, phase, skill, weakness },
  towers: [{ id, kind, level, hp, pos }],
  towerSlots: [{ slotId, state }],
  player: { pos, yaw, hp, maxHp, form, overheat },
  lavaY, motes, coreHp, score
}
```

**两条铁律：**

1. **只有 S0 能改 `events.ts`。** 其他人需要新事件 → 提「契约申请」，S0 合并后广播。多路各造一套事件是这类项目的头号死因。
2. **渲染层与 UI 禁止 `emit`。** 只允许 `bus.on()` 订阅和 `bus.snapshot()` 拉取。要改状态必须走逻辑层。

**`__setSnapshot` 特殊说明**：这是内部 API，供拥有高频状态（如玩家精确 pos/yaw）的 owner 模块直接写快照，避免每帧 emit 造成事件洪水。渲染层严禁调用。

### 3.2 `config/*.json` —— 全部数值外置

| 文件 | 内容 |
|---|---|
| `arena.json` | 场地尺寸、塔位布局 |
| `player.json` | 玩家血量、移速、武器参数 |
| `towers.json` | 五种塔的属性表 |
| `boss.json` | Boss 血量、技能时序 |
| `flow.json` | 关卡时间轴、阶段划分 |
| `visual.json` | 渲染参数（雾、色调、后处理） |
| `audio.json` | 音效配置 |
| `ui.json` | 界面参数 |

**结构变更归 S0**（因为会影响契约）；**纯数值调整归各模块 owner**。

### 3.3 `rng.ts` —— 确定性随机

带种子的 PRNG。**所有影响玩法的随机必须走它**，否则无法复现 bug、无法写稳定单测。

---

## 四、逻辑层（禁 `import three`）

### 4.1 模块划分

| 目录 | 职责 | 对外接口 |
|---|---|---|
| `src/towers/` | 塔位状态机、建拆、五种塔实现、debuff | `TowerSystem` |
| `src/flow/` | 关卡时间轴、阶段推进、评分 | `MatchRunner` `MatchTimeline` `Scoring` |
| `src/player/` | 第一人称移动、双形态武器 | `PlayerController` |
| `src/combat/` | 伤害模型、击破判定 | `Damage` |
| `src/boss/` | Boss 实体、阶段、技能、破绽 | `BossEntity` |
| `src/game/` | 整合层：循环、视图同步、输入 | `GameLoop` `GameView` `Input` |
| `src/telemetry/` | 埋点统计 | `Telemetry` |

### 4.2 为什么禁 `import three`

1. **单测必须在纯 Node 下跑。** `vitest.config.ts` 设 `environment: 'node'`，import three 会直接崩。
2. **渲染层要能整体替换。** 今天 WebGPU，出问题要能切 WebGL2 回退，而不动一行玩法代码。
3. **向量运算不需要 three。** 用 `Vec3 = readonly [number, number, number]` 加纯函数就够。

**需要的向量运算**写在 `src/core/math.ts`（纯函数），或模块内局部函数。

### 4.3 已知遗留

`src/boss/BossEntity.ts` 和 `src/boss/preview.ts` 仍在逻辑层 import three。契约检查脚本当前**只告警不阻塞**，且 `tsconfig.json` 把 `src/boss` 排除在类型检查外。这是技术债，不是设计意图。

---

## 五、表现层

### 5.1 渲染（`src/render/`）

| 文件 | 职责 |
|---|---|
| `App.ts` | 渲染器初始化、主循环、场景/相机持有者。**归 S0**，别人只读 |
| `Lava.ts` | 熔岩海材质与动画 |
| `Spire.ts` | 孤塔几何 |
| `Atmosphere.ts` | 氛围（雾、粒子、光照） |
| `PostFX.ts` | 后处理链 |
| `palette.ts` | 配色常量 |
| `config.ts` | 渲染配置读取 |

**渲染器**：three.js `WebGPURenderer`。WebGPU 不可用时降级 `forceWebGL: true`。

**`App.ts` 的对外接口**（`main.ts` 依赖）：

```ts
app.init(): Promise<void>
app.start(): void
app.canvas: HTMLCanvasElement
app.scene: THREE.Scene
app.camera: THREE.Camera
app.backendName: string
app.onTick: (dt: number) => void    // 每帧逻辑推进回调
app.onSync: () => void              // 每帧表现同步回调
app.onFrame: (fps: number) => void  // 每帧统计回调
app.dispose(): void
```

### 5.2 UI（`src/ui/`）

`DebugOverlay.ts` —— 调试浮层，显示 FPS、HP、后端名、状态消息。

---

## 六、启动链路（`src/main.ts`，239 行）

```
1. 取 #app 容器
2. new App(host) → await app.init()       渲染器就绪
3. createInput(app.canvas)                输入
4. createGame({ input })                  逻辑世界
5. createGameView({ scene, camera, bus }) 表现层绑定
6. 接线：app.onTick → game.tick
        app.onSync → view.sync
7. DebugOverlay
8. 订阅 MatchPhaseChanged → 更新浮层
9. 订阅 MatchEnded → WL 协议交接（胜利 completeLevel / 失败 failLevel）
10. 调试快捷键：1-5 建塔、N 熔核补给、R 重生、K 锁血/不死（屏幕左上角标 K；锁血期间时间轴停在 4:30、不进狂暴）、Enter 手动通关；`?debug=1` 另有 B 俯视、G 击杀 Boss、J 自杀、M 查看熔岩巨人建模、U 静音
11. 暴露 window.__game（QA/Playwright 用）
12. app.start()
```

**`window.__game` 调试 API**：

```ts
snapshot(): unknown
placeTower(slotId: string, kind: string): boolean
setMotes(n: number): void
endReason(): string | null
tick(dtSec: number): number     // 无头推进逻辑
steps(): number
```

这个 API 是**无头测试的入口**，改动它会影响自动化验收。

---

## 七、平台交接协议（WL）

游戏运行在官方大厅 iframe 内，通过 `window.__WL__` 与平台通信。

```ts
interface WlBridge {
  save(): WlSave | null
  respawn(): WlSave | null
  completeLevel(config, save, options?): WlSave | null
  failLevel?(reason: string): void
}
```

**存档结构**：

```ts
{ level: number, player: { hp, max_hp, deaths? }, items: unknown[], clues: string[] }
```

**出口钩子**：通关时传 `{ exitHook: '熔心仍在跳动，塔外的潮声已隐约可闻……' }`，是给下一关的一句话。

**硬约束**（官方平台限制，违反会被 check.mjs 拒绝）：

- 禁止 `alert` / `confirm` / `top.location`
- 资产扩展名白名单：`glb` `gltf` `bin` `hdr` `ktx2` `drc`（v3.3.3 起）
- 必须用相对路径（`base: './'`）
- 打包 ZIP ≤ 12 MB

---

## 八、构建与门禁

### 8.1 命令

| 命令 | 作用 | 耗时 |
|---|---|---|
| `npm run dev` | Vite dev server（:5173） | — |
| `npm run typecheck` | `tsc --noEmit` | ~5s |
| `npm run test` | vitest（18 个测试文件，纯 Node） | ~10s |
| `npm run build` | Vite 构建到 `out/` | ~15s |
| `npm run pack` | build + 打包 `release/lava-city.zip` | ~25s |
| `npm run gate` | 全量门禁 | ~40s |
| `npm run gate:fast` | contract + typecheck | ~5s |
| `npm run contract` | 只跑契约红线扫描 | ~1s |

### 8.2 门禁链路（`scripts/gate.ps1`）

```
contract → typecheck → test → build → pack(VerifyOnly)
```

任一步非零退出即失败（fail-fast）。

**关键设计**：pack 阶段用 `-VerifyOnly`，只校验已入库的 zip，**不重新打包**。否则每次跑 gate 都会改写 zip 字节，导致「跑完门禁就变 dirty」的死循环。需要新交付包时单独跑 `npm run pack`。

**沙箱适配**：gate 把 `TEMP`/`TMP` 指向仓库内 `.tmp/`，避免 esbuild 删不掉系统临时文件报 Access denied。

### 8.3 契约红线（`scripts/check-contract.ps1`）

四项扫描，命中即失败：

1. `events.ts` 哈希与 `docs/plan/CONTRACT.lock` 不一致
2. 逻辑层出现 `import three`
3. 出现 `alert` / `confirm` / `top.location`
4. 出现 IP 词汇（任天堂/迪士尼/原神/宝可梦/漫威/Minecraft 等）

### 8.4 配置文件要点

| 文件 | 关键设置 |
|---|---|
| `tsconfig.json` | `strict: true`、`noUnusedLocals`、`verbatimModuleSyntax`、`resolveJsonModule`；**排除 `src/boss`** |
| `vite.config.ts` | `base: './'`、`outDir: 'out'`、自定义插件处理 `shared/save-protocol.js`（非模块脚本，Vite 会尝试打包报错，故 pre 摘除 post 塞回） |
| `vitest.config.ts` | `environment: 'node'`、只跑 `tests/unit/**/*.test.ts` |

---

## 九、测试体系

```
tests/unit/
├── combat/damage.test.ts          伤害模型
├── core/events.test.ts            契约（Bus、snapshot、reduce）
├── flow/                          matchTimeline / scoring / telemetry
├── game/integration.test.ts       整合层
├── player/playerController.test.ts
└── towers/                        TowerSystem / TowerSocket / BuildMenu
    └── kinds/                     ballista / frost / quake / rune / totem
```

**18 个测试文件，全部在纯 Node 下跑。** 这是「逻辑层禁 three」的执行保障——一旦有人 import three，测试立刻崩。

---

## 十、交付包结构

```
release/lava-city.zip
├── index.html
├── assets/          Vite 构建产物
└── shared/
    └── save-protocol.js    平台协议（从 public/ 复制）
```

`kit/` 目录是官方接入包（v3.3.3），含各技术栈适配器与接入文档，**不属于游戏源码**，是参考与对接材料。

---

## 十一、架构红线（违反即回退）

| # | 红线 | 原因 |
|---|---|---|
| 1 | 改 `src/core/events.ts` 或 config 结构 | 契约破坏，多路联调必炸 |
| 2 | 逻辑层 `import three` | 单测崩、渲染层无法替换 |
| 3 | 写自己作用域外的文件 | 多路并行时互相覆盖 |
| 4 | 未跑 `npm run gate` 就 commit | 坏代码进主干 |
| 5 | 直接 push `master` | 已开分支保护，推不上去 |
| 6 | `git add -A` | 会带上别人的改动 |
| 7 | `alert` / `confirm` / `top.location` | 平台硬约束 |
| 8 | 非白名单资产扩展名 | check.mjs 拒绝 |
| 9 | IP 词汇 | 法务风险 |
| 10 | handoff 写「完成」但没跑验收命令 | 虚假交付 |

---

## 十二、快速上手（新接手者）

```powershell
# 1. 进仓库
cd E:\demo\lava-city

# 2. 确认环境（应输出 fireworkPx / openssl / 127.0.0.1:12334）
git config user.name
git config http.sslBackend
git config http.proxy

# 3. 装依赖
npm install --no-fund --no-audit

# 4. 跑门禁基线（应全绿）
npm run gate:fast

# 5. 起开发服务器
npm run dev
# 浏览器开 http://localhost:5173

# 6. 读架构
# 本文 → docs/PLAN.md → docs/plan/00-作战协议.md → src/core/events.ts
```

---

## 十三、文档地图

| 文档 | 内容 | 何时读 |
|---|---|---|
| **本文** | 底层架构事实 | 接手第一份 |
| `docs/PLAN.md` | 今日节奏、五道闸门、风险清单 | 想知道进度 |
| `docs/plan/00-作战协议.md` | 多路协作规则、写作用域、Git 流程 | 要动手写代码前 |
| `docs/plan/01-四路派单表.md` | 逐票任务分配 | 领任务 |
| `docs/熔心孤塔_设计与AI开发规划.md` | 完整游戏设计（513 行） | 想知道「为什么这样做」 |
| `kit/README.md` | 平台硬约束 | 对接官方 |
| `handoff/*.md` | 各路实时进度 | 每天开工前 |
| `docs/DELIVERY.md` | **PR 交付流程（本文件配套）** | **每次提交前** |

---

## 变更记录

| 版本 | 时间 | 变更 |
|---|---|---|
| v1.0 | 2026-11-08 | 初版：分层架构、契约、门禁、测试、红线 |
