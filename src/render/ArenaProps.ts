// src/render/ArenaProps.ts
// ============================================================================
// 票 M3-04 / M3-04b · 场地跳跃平台的表现层（Lead 实现）
// ----------------------------------------------------------------------------
// 只做 12 件跳跃平台（jumpLedge 0.8 / jumpHigh 1.6 / bridgePier 2.4）。
// 遮挡物与防御物**不在本票范围**：它们还没有任何逻辑与碰撞，先画出来就是骗人。
//
// 三条硬约束（来自 M3-04b）：
//   1. 平台只有「边」没有「面」——顶部一圈极细发光描边（RingGeometry 0.85→0.95），
//      不给符文面，避免玩家以为有魔法效果；
//   2. 全部静态几何按材质合并：12 件平台只吃 2 个 draw call（rock + rim）；
//   3. 尺寸全部来自 src/core/config/arena-props.json，代码里不写死。
//
// 数据来源与逻辑层同一份 config：`src/game/ArenaProps.ts` 的 placements()，
// 保证「画在哪」与「站得上」永远一致（这是本票的核心不变量）。
// ============================================================================

import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Aabb } from '../player/PlayerController';
import type { ArenaPropsConfig, PropPlacement } from '../game/ArenaProps';
import { placements } from '../game/ArenaProps';

export interface ArenaPropsView {
  /** 诊断：平台件数 / 台面高度分布 / 本模块新增 draw call 估算 */
  stats(): { platforms: number; drawCalls: number; heights: number[] };
  /** 调试：显示/隐藏碰撞箱线框（默认隐藏，?boxes=1 打开） */
  setCollisionBoxesVisible(visible: boolean): void;
  dispose(): void;
}

export interface ArenaPropsViewDeps {
  scene: THREE.Scene;
  config: ArenaPropsConfig;
  /** 调试：一进页面就画碰撞箱线框（验收用，默认 false） */
  showCollisionBoxes?: boolean;
}

/** 正八边形平板 + 侧面（与 Spire 的 sides:8 几何母题一致） */
function buildPlatformGeometry(
  sizeM: number,
  sides: number,
  heightM: number,
  topThicknessM: number,
): { rock: THREE.BufferGeometry; rim: THREE.BufferGeometry; rimRadius: number } {
  const half = sizeM / 2;
  // CylinderGeometry 的 radius 是外接圆半径；正八边形平板的「宽 1.8」按对边距算，
  // 所以外接圆 = (size/2) / cos(π/n)。这样台面外接框正好是 1.8×1.8。
  const circumradius = half / Math.cos(Math.PI / sides);
  const topH = Math.min(topThicknessM, heightM);
  const sideH = Math.max(0.01, heightM - topH);

  const top = new THREE.CylinderGeometry(circumradius, circumradius, topH, sides, 1);
  top.translate(0, heightM - topH / 2, 0);

  const side = new THREE.CylinderGeometry(circumradius * 0.94, circumradius * 0.86, sideH, sides, 1);
  side.translate(0, sideH / 2, 0);

  // 顶面倒角：一圈略小的斜台，接光用（M3-04b「边缘倒角接光」）
  const bevel = new THREE.CylinderGeometry(circumradius * 0.97, circumradius, 0.06, sides, 1);
  bevel.translate(0, heightM - topH - 0.03, 0);

  const rockMerged = mergeGeometries(
    [top.toNonIndexed(), side.toNonIndexed(), bevel.toNonIndexed()],
    false,
  );
  top.dispose();
  side.dispose();
  bevel.dispose();
  if (!rockMerged) throw new Error('[arena-props] 平台岩石几何合并失败');

  // 描边：RingGeometry 内 0.85 → 外 0.95（票面数值），8 段与平台同母题
  const rimRadius = circumradius * 0.95;
  const rim = new THREE.RingGeometry(rimRadius * (0.85 / 0.95), rimRadius, sides, 1);
  rim.rotateX(-Math.PI / 2);
  rim.translate(0, heightM + 0.005, 0);
  const rimGeo = rim.toNonIndexed();
  rim.dispose();

  return { rock: rockMerged, rim: rimGeo, rimRadius };
}

export function createArenaPropsView(deps: ArenaPropsViewDeps): ArenaPropsView {
  const { scene, config } = deps;
  const root = new THREE.Group();
  root.name = 'arena-props';
  scene.add(root);

  const cfg = config.render;
  const list: PropPlacement[] = placements(config).filter((p) => p.category === 'platform');

  // ── 按材质合并：12 件平台 → rock 1 个 mesh + rim 1 个 mesh ────────────────
  const rockParts: THREE.BufferGeometry[] = [];
  const rimParts: THREE.BufferGeometry[] = [];
  const heights: number[] = [];

  for (const p of list) {
    heights.push(p.heightM);
    const { rock, rim } = buildPlatformGeometry(
      cfg.platform.sizeM,
      cfg.platform.sides,
      p.heightM,
      cfg.platform.topThicknessM,
    );
    // 平台不旋转：正八边形绕 Y 转 22.5° 才是「边朝正方向」，
    // 但票面只要求八边形轮廓可读，转向会让相邻两级看起来不同族。统一不转。
    const matrix = new THREE.Matrix4().makeTranslation(p.x, 0, p.z);
    rockParts.push(rock.applyMatrix4(matrix));
    rimParts.push(rim.applyMatrix4(matrix));
  }

  const rockMaterial = new THREE.MeshStandardNodeMaterial({
    color: new THREE.Color(cfg.materials.rock),
    roughness: 0.9,
    metalness: 0.02,
    flatShading: true,
  });
  const rimMaterial = new THREE.MeshStandardNodeMaterial({
    color: new THREE.Color('#0a0706'),
    roughness: 0.78,
    metalness: 0.15,
    emissive: new THREE.Color(cfg.materials.rimEmissive),
    emissiveIntensity: cfg.platform.rimEmissiveIntensity,
    flatShading: true,
    side: THREE.DoubleSide,
  });

  const rockMesh = new THREE.Mesh(mergeOrThrow(rockParts), rockMaterial);
  rockMesh.name = 'arena-props-platforms-rock';
  rockMesh.castShadow = true;
  rockMesh.receiveShadow = true;
  root.add(rockMesh);

  const rimMesh = new THREE.Mesh(mergeOrThrow(rimParts), rimMaterial);
  rimMesh.name = 'arena-props-platforms-rim';
  root.add(rimMesh);

  // ── 调试：碰撞箱线框（与 PlayerWorld.colliders 完全同源）──────────────────
  const boxGroup = new THREE.Group();
  boxGroup.name = 'arena-props-collision-boxes';
  boxGroup.visible = deps.showCollisionBoxes === true;
  root.add(boxGroup);

  const boxMaterial = new THREE.LineBasicNodeMaterial({
    color: new THREE.Color(cfg.collisionBoxes.color),
    transparent: true,
    opacity: cfg.collisionBoxes.opacity,
  });

  const boxGeos: THREE.BufferGeometry[] = [];
  for (const p of list) {
    if (!p.aabb) continue;
    const geo = boxWireframe(p.aabb);
    boxGeos.push(geo);
  }
  if (boxGeos.length > 0) {
    boxGroup.add(new THREE.LineSegments(mergeOrThrow(boxGeos), boxMaterial));
  }

  return {
    stats: () => ({
      platforms: list.length,
      // rock + rim（碰撞箱线框默认不可见，不计入）
      drawCalls: boxGroup.visible ? 3 : 2,
      heights,
    }),

    setCollisionBoxesVisible(visible: boolean): void {
      boxGroup.visible = visible;
    },

    dispose(): void {
      scene.remove(root);
      rockMesh.geometry.dispose();
      rimMesh.geometry.dispose();
      rockMaterial.dispose();
      rimMaterial.dispose();
      boxMaterial.dispose();
      boxGroup.traverse((obj) => {
        if (obj instanceof THREE.LineSegments) obj.geometry.dispose();
      });
    },
  };
}

/** AABB → 12 条棱的线段几何 */
function boxWireframe(b: Aabb): THREE.BufferGeometry {
  const { minX, maxX, minY, maxY, minZ, maxZ } = b;
  const c: Array<[number, number, number]> = [
    [minX, minY, minZ],
    [maxX, minY, minZ],
    [maxX, minY, maxZ],
    [minX, minY, maxZ],
    [minX, maxY, minZ],
    [maxX, maxY, minZ],
    [maxX, maxY, maxZ],
    [minX, maxY, maxZ],
  ];
  const edges: Array<[number, number]> = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  const points: number[] = [];
  for (const [a, z] of edges) {
    points.push(...c[a], ...c[z]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  return geo;
}

function mergeOrThrow(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (list.length === 0) return new THREE.BufferGeometry();
  const merged = mergeGeometries(list, false);
  if (!merged) throw new Error('[arena-props] 几何合并失败：属性不一致');
  merged.computeBoundingSphere();
  for (const geo of list) geo.dispose();
  return merged;
}
