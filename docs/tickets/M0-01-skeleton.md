# 票 M0-01 · 项目骨架与构建链

> 交给 TRAE 执行。这是所有后续票的地基，必须先跑通再开其他票。
> 设计依据：`docs/熔心孤塔_设计与AI开发规划.md` 第 2、12 节。

## 【目标】

在仓库根建立一个 TypeScript + Vite + Three.js 的工程骨架，做到：`npm run dev` 能起、`npm run build` 能出产物、`npm run pack` 能打出符合官方规则的交付包、`node kit/tools/check.mjs out/` 全部通过。

**本票不实现任何游戏玩法**，只交付一条能跑通端到端的空壳链路：加载 Three.js 场景 → 显示一个灰盒地面和一块熔岩平面 → 按 R 键能调用 `WL.respawn()` → 按回车能调用 `WL.completeLevel()`。

## 【范围】

允许新建/修改：
```
package.json
package-lock.json
tsconfig.json
vite.config.ts
index.html
.npmrc
src/core/events.ts
src/core/rng.ts
src/core/config/player.json
src/core/config/boss.json
src/core/config/towers.json
src/core/config/arena.json
src/core/config/visual.json
src/core/config/ui.json
src/core/config/audio.json
src/main.ts
src/render/App.ts
src/ui/DebugOverlay.ts
tools/pack-level.ps1
.gitignore
```

禁止修改：`kit/**`（官方交付包，只读）、`docs/**`（设计文档）、`AGENTS.md`。

## 【关键技术约束（违反即验收失败）】

1. **交付包扩展名白名单**（`kit/tools/check.mjs` 的 `ALLOWED_EXT`，v3.3.3 起）：
   `html htm js mjs css json png jpg jpeg gif webp svg ico avif mp3 ogg wav m4a mp4 webm woff woff2 ttf otf wasm data pck pak mem txt md map glb gltf bin hdr ktx2 drc`
   v3.3.3 放开了 `glb / gltf / bin / hdr / ktx2 / drc`，但**本票仍然只用代码程序化生成的几何体与 `CanvasTexture`**，不引入任何外部模型文件——理由是加载器和解码器要随包提交、还要处理 CORS 与 iframe 隔离，这些时间今天花不起。等骨架跑通、时间有余再看要不要上 GLB。
   若后续某票确实要用 GLB：必须同时打包 `decoders/draco/*` 与 `decoders/basis/*` 的 js+wasm，用 `new URL('./assets/x.glb', location.href)` 相对定位，`KTX2Loader.detectSupport(renderer)` 必须在加载前执行。
2. `vite.config.ts` 必须设 `base: './'`，否则 iframe 内相对路径会 404。
3. 交付包内所有路径必须是相对路径，禁止 `http://` / `https://` 引本地资源。
4. 入口 `index.html` 必须在包根，且必须先 `<script src="shared/save-protocol.js"></script>` 再加载 `src/main.ts`。
5. 禁止 `alert()` / `confirm()` / `window.top.location` / `parent.location`（`check.mjs` 会静态扫描，命中即失败）。
6. 禁止出现任何 IP 词汇：任天堂、Nintendo、迪士尼、Disney、原神、Genshin、米哈游、宝可梦、Pokémon、Mario、马里奥、漫威、Marvel、Minecraft、我的世界。
7. TypeScript 必须 `strict: true`，`npm run typecheck` 零错误。

## 【渲染器（直接上 WebGPU，不做 WebGL 验证）】

骨架就用 `THREE.WebGPURenderer` + TSL，不要先做一版 `WebGLRenderer` 再升级：

```ts
import * as THREE from 'three/webgpu';
const renderer = new THREE.WebGPURenderer({ antialias: true, powerPreference: 'high-performance' });
await renderer.init();          // WebGPU 异步初始化，必须 await
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
```

`three` 的 npm 包从 r167 起就带 `three/webgpu` 入口，不需要装额外的包。

`await renderer.init()` 外面套 `try/catch`：**只在 init 抛错且浏览器不支持 WebGPU 时**才回落到 `WebGLRenderer`，正常情况一律走 WebGPU。这个 fallback 是保险丝，不是并行开发的一条支线 —— 不要把时间花在把两条路都调到一样上。

TSL 节点 API 不确定时用 `mcp__context7__query-docs` 查 `three` 文档，不要凭记忆写。

## 【依赖】

```
dependencies:    three
devDependencies: typescript, vite, @types/three
```

本票**不装 Rapier**。物理推迟到 M2 票再决定（先用手写 AABB 碰撞验证玩法是否成立）。除 `three` 外不得引入任何运行时依赖。

`.npmrc` 内容：
```
registry=https://registry.npmmirror.com
```

## 【验收】

在仓库根依次执行，全部通过才算完成：

```bash
npm ci
npm run typecheck
npm run build
npm run pack
node kit/tools/check.mjs out/
```

`check.mjs` 必须输出 0 项失败；出现任何 ✗ 都要修到通过为止。

另外人工验证：
```bash
npm run dev
```
浏览器打开后：能看到地面与一块橙红色发光的熔岩平面在动；控制台无报错；按 R 键触发 `WL.respawn()`；页面右下角有一个调试浮层显示 FPS 和当前 `save.player.hp`。

在真沙盒里验证（可选但强烈建议）：
```bash
npx serve out -l 5180
```
浏览器打开 `http://localhost:5180`，再用 `kit/mock-runner.html` 加载同一地址。

## 【附录：契约必须逐字实现】

`src/core/events.ts` 是本项目**唯一**的模块间通信契约。P2/P3 的所有 Agent 都按它写代码，因此本票必须一字不差地落地下面的事件定义，不允许改名、合并、增删字段。

```ts
// src/core/events.ts
export type Vec3 = readonly [number, number, number];
export type Attr = 'arcane' | 'physical';   // arcane=法术(蓝) physical=物理(白金)
export type BodyPart = 'core' | 'back' | 'kneeL' | 'kneeR';
export type MatchPhase = 'wake' | 'prep' | 'boss1' | 'transition' | 'boss2' | 'rage' | 'ended';

export interface Events {
  // ── 玩家 ──
  PlayerSpawned:        { pos: Vec3 };
  PlayerMoved:          { pos: Vec3; yaw: number };
  PlayerDamaged:        { amount: number; hp: number; maxHp: number; source: string };
  PlayerDied:           { cause: string; deaths: number };
  PlayerRespawned:      { pos: Vec3 };
  PlayerDashed:         { dir: Vec3 };
  FormSwitched:         { form: Attr };
  OverheatChanged:      { value: number; overheated: boolean };

  // ── 战斗 ──
  DamageDealt:          { target: 'boss' | 'tower' | 'player'; amount: number; attr: Attr; part?: BodyPart; isCrit: boolean };
  ExecutionStarted:     { part: BodyPart };
  ExecutionEnded:       { part: BodyPart; damage: number };
  WeaknessProgress:     { part: BodyPart; value: number; max: number; executable: boolean };

  // ── Boss ──
  BossSpawned:          { hp: number; maxHp: number; phase: 1 | 2 };
  BossHpChanged:        { hp: number; maxHp: number; phase: 1 | 2 };
  BossPhaseChanged:     { from: 1 | 2; to: 1 | 2 };
  BossSkillStart:       { skill: string; stage: 'windup' | 'active' | 'recovery'; durationMs: number };
  BossSkillEnd:         { skill: string };
  BossSkillInterrupted: { skill: string; by: 'interrupt' | 'freeze' | 'stagger' };
  WeaknessExposed:      { part: BodyPart; attr: Attr; durationMs: number };
  WeaknessClosed:       { part: BodyPart };
  KneeBroken:           { side: 'L' | 'R' };

  // ── 塔 ──
  TowerPlaced:          { towerId: string; kind: string; slotId: string; pos: Vec3 };
  TowerUpgraded:        { towerId: string; level: number };
  TowerDestroyed:       { towerId: string; reason: 'sold' | 'broken' | 'drowned' };
  TowerTargetHit:       { towerId: string; kind: string; attr: Attr; amount: number };
  DebuffStackChanged:   { kind: 'sunder' | 'scorch'; stacks: number; attr: Attr };
  FreezeFull:           { durationMs: number };
  TauntStarted:         { towerId: string; durationMs: number };
  TauntEnded:           { towerId: string };

  // ── 流程 ──
  MatchPhaseChanged:    { phase: MatchPhase; tSec: number };
  MatchEnded:           { result: 'win' | 'lose'; reason: string; tSec: number };
  LavaLevelChanged:     { y: number; risePerSec: number };
  CoreHpChanged:        { hp: number; maxHp: number };
  MoteCountChanged:     { motes: number };
  TacticalViewChanged:  { open: boolean };
}

export type EventName = keyof Events;
export interface Snapshot {
  tSec: number; phase: MatchPhase;
  boss: { hp: number; maxHp: number; phase: 1 | 2; skill: string | null; weakness: BodyPart | null };
  towers: Array<{ id: string; kind: string; level: number; hp: number; pos: Vec3 }>;
  player: { pos: Vec3; yaw: number; hp: number; maxHp: number; form: Attr; overheat: number };
  motes: number; coreHp: number;
}
```

同时 `src/core/events.ts` 还要导出一个极简总线：

```ts
export function createBus() {
  return {
    on<K extends EventName>(k: K, fn: (p: Events[K]) => void): () => void,
    emit<K extends EventName>(k: K, p: Events[K]): void,
    // 只读快照，供渲染层与 UI 拉取，避免持有逻辑对象
    snapshot: () => Snapshot,
  };
}
```

`specificity: 渲染层与 UI 只允许 on() 订阅和 snapshot()，禁止 emit()。逻辑层禁止 import three。`

## 【交付格式】

按 `AGENTS.md` 的交付格式输出：
1. 改动文件列表
2. 四条验收命令及其实际输出摘要（贴关键行）
3. 契约申请 / 跨目录请求（如有）
4. 未完成项与原因
5. 复现方式（命令 + 预期现象）
