# 苏尔特（熔岩巨人）· 模块接口契约 v1

> 本文件是三个工作流之间的**唯一接口约定**。任何一方不得单方面改动；
> 需要改先在本文件末尾追加「变更记录」并在群里说明。

根目录：`C:\Users\pxnabof\Desktop\熔岩巨人-史尔特尔\`

## 0. 文件分工（写作用域）

| 文件 | 负责人 | 说明 |
|---|---|---|
| `SurtrRig.ts` | Lead | 模型构建器（唯一模型真源） |
| `tools/template.html` | scene-wright | 预览场景模板，含占位标记 `/*__SURTR_MODEL__*/` |
| `tools/build.mjs` / `shot.mjs` / `verify.mjs` / `browser.mjs` | tool-chain | 构建、截图、指标校验 |
| `SurtrRig.html` | 构建产物（勿手改） | 由 `node tools/build.mjs` 生成 |
| `预览图/*.png` | 截图产物（勿手改） | 由 `node tools/shot.mjs` 生成 |
| `_work/metrics.json` | 校验产物 | 由 `node tools/verify.mjs` 生成 |
| `说明.md` / `预览图/总览.png` | Lead | 交付文档与拼图 |

## 1. 模型导出（`SurtrRig.ts`）

```ts
import * as THREE from 'three';

export interface SurtrRig {
  root: THREE.Group;          // name = 'Surtr'
  rig: THREE.Group;
  hips: THREE.Group;
  torso: THREE.Group;
  chest: THREE.Group;
  head: THREE.Group;
  shoulderL: THREE.Group; elbowL: THREE.Group;
  shoulderR: THREE.Group; elbowR: THREE.Group;
  legL: THREE.Group; kneeL: THREE.Group; footL: THREE.Group;
  legR: THREE.Group; kneeR: THREE.Group; footR: THREE.Group;
}

export interface SurtrMaterials {
  rock: THREE.MeshStandardMaterial;      // 黑曜玄武岩（vertexColors，主体皮肤）
  char: THREE.MeshStandardMaterial;      // 焦壳 / 骨白角爪（vertexColors）
  lava: THREE.MeshStandardMaterial;      // 熔岩橙红（自发光）
  lavaHot: THREE.MeshStandardMaterial;   // 炽白黄（自发光，最高亮）
  core: THREE.MeshStandardMaterial;      // 熔岩心：阶段 I 弱点
  vent: THREE.MeshStandardMaterial;      // 火山口：阶段 II 弱点
  ash: THREE.MeshStandardMaterial;       // 火山灰浮岩（阶段 II 悬浮碎块）
  ember: THREE.MeshStandardMaterial;     // 暗余烬缝（自发光，较弱）
}

export interface SurtrWeakPoint {
  key: 'core' | 'back' | 'kneeL' | 'kneeR';
  label: string;                          // 中文短标签，如 '熔岩心'
  pos: [number, number, number];           // 世界坐标（阶段 I 姿态下）
  r: number;                              // 判定球半径
  css: string;                            // 标签颜色，如 '#ff7a2f'
}

export interface SurtrMeta {
  /** 阶段 I 全高（脚底 y=0 → 最高点，米） */
  height: number;
  /** 阶段 I 包围盒 x 跨度（米） */
  width: number;
  weakPoints: SurtrWeakPoint[];            // 固定 4 个，key 见上
  joints: Record<string, [number, number, number]>;  // 关节世界坐标（阶段 I）
  /** 可动画对象（找不到就是 null，调用方必须容错） */
  eyes: THREE.Object3D | null;
  crater: THREE.Object3D | null;           // 背部火山口（阶段 II 喷焰）
  flameCrest: THREE.Object3D[];            // 头顶火焰王冠/鬃毛
  lavaFalls: THREE.Object3D[];             // 熔岩瀑布
}

export interface SurtrBuild {
  rig: SurtrRig;
  /** 受光实体网格（rock + char） */
  solidMeshes: THREE.Mesh[];
  /** 自发光网格 */
  glowMeshes: THREE.Mesh[];
  /** 阶段 I 可见、阶段 II 隐藏 */
  phase1Meshes: THREE.Mesh[];
  /** 阶段 II 可见、阶段 I 隐藏（构建时 visible=false） */
  phase2Meshes: THREE.Mesh[];
  materials: SurtrMaterials;
  meta: SurtrMeta;
}

export function createSurtrRig(): SurtrBuild;
```

约定：
- 模型**脚底 y = 0**，面朝 **+Z**，+X 为其右手边。
- 命名网格（供预览动画查找）：`eyes`、`crater`、`flueMouth`、`slag`、`lavaFall`、`flameCrest`。
- `phase2Meshes` 内所有网格构建时 `visible = false`。
- 阶段 I 可见网格的**精确包围盒**由 verify 计算，需满足：全高 14.2～15.2 m，x 跨度 ≥ 8.5 m。

## 2. 预览模板（`tools/template.html`）

- 纯静态 HTML，ES module，three 走 importmap：
  `"three": "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js"`、
  `"three/addons/": "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/"`
- 模型注入点：**恰好一处**，形式为单独一行：
  ```js
  /*__SURTR_MODEL__*/
  ```
  构建脚本把转译后的 `SurtrRig.ts`（已去掉 import 行）替换到该行。
- 模板中**只能**通过 `createSurtrRig()` 返回值访问模型；**禁止**出现旧字段名
  `stoneMeshes` / `phase2Meshes` 之外的旧接口（`materials.stone` / `materials.iron` / `materials.emberHot` 均不存在）。
- URL 参数：`?phase=1|2&view=hero|front|side|back|close|low|top&hud=0|1&rot=0&weak=0|1`
- 场景、灯光、后期由 scene-wright 自由发挥，但必须：
  - 页面加载 2.5 s 内完成首帧，控制台无 error；
  - `?hud=0` 时隐藏全部 HUD，只剩 canvas；
  - 提供 `window.__SURTR__` 调试句柄：`{ build, camera, renderer, setPhase(on), applyView(name), ready }`，`ready === true` 表示首帧已渲染。

## 3. 工具链（`tools/`）

- `node tools/build.mjs` → 生成 `SurtrRig.html`；退出码 0 表示成功。
- `node tools/shot.mjs [--out=预览图] [--views=hero,front,...] [--phases=1,2]` → 出 PNG。
- `node tools/verify.mjs` → 生成 `_work/metrics.json`，打印摘要；退出码非 0 表示校验失败。
- `npx tsc -p tsconfig.json --noEmit` → 严格类型检查通过。

## 4. 变更记录

| 日期 | 变更 | 影响 |
|---|---|---|
| 2026-11-08 | 初版 | — |
