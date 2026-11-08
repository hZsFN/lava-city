// src/game/ArenaProps.ts
// ============================================================================
// 票 M3-04 · 场地道具的**纯逻辑层**（禁止 import three）
// ----------------------------------------------------------------------------
// 只做三件事：
//   1. 把 config 里的极坐标实例（angleDeg / radiusM / rotDeg）算成世界坐标；
//   2. 把 footprint（圆 / 正矩形 / 有向矩形）算成轴对齐碰撞箱 Aabb；
//   3. 把「可站立平台」的碰撞箱交给 GameLoop 塞进 PlayerWorld.colliders。
//
// 为什么碰撞箱用轴对齐 AABB：PlayerController 目前是手写 AABB 物理
// （M0-01 约定，Rapier 推迟）。本模块只产数据，不改任何物理规则——
// 平台能站上去，靠的是 PlayerController 已有的落地/吸附逻辑。
//
// 坐标系：0° = +X 轴，逆时针为正；x = r·cos(a)，z = r·sin(a)（与 Spire 一致）。
// ============================================================================

import type { Aabb } from '../player/PlayerController';

/** 圆形底面（棱柱、镇石） */
export interface FootprintCircle {
  shape: 'circle';
  radiusM: number;
}

/** 与轴向对齐的正矩形底面（跳跃平台、矮墙） */
export interface FootprintRect {
  shape: 'rect';
  widthM: number;
  depthM: number;
}

/** 带朝向的矩形底面（壁垒、护壁，绕 Y 旋转 rotDeg） */
export interface FootprintOrientedRect {
  shape: 'orientedRect';
  widthM: number;
  depthM: number;
}

export type PropFootprint = FootprintCircle | FootprintRect | FootprintOrientedRect;

export type PropCategory = 'cover' | 'defense' | 'platform';

/** 一件道具的静态属性（config 的 kinds 段） */
export interface PropKindConfig {
  category: PropCategory;
  footprint: PropFootprint;
  heightM: number;
  /** solid = 加碰撞箱；walkable = 只做贴地装饰（不加碰撞箱） */
  collider: 'solid' | 'walkable';
  blocksLos: boolean;
  losBottomY: number;
  losTopY: number;
  hp: number;
  destructible: boolean;
}

/** 场上一个实例（config 的 instances 段） */
export interface PropInstance {
  id: string;
  kind: string;
  angleDeg: number;
  radiusM: number;
  /** 绕 Y 的朝向角（度） */
  rotDeg: number;
}

export interface ArenaPropsRenderConfig {
  platform: {
    sides: number;
    sizeM: number;
    topThicknessM: number;
    rimInnerM: number;
    rimOuterM: number;
    rimEmissiveIntensity: number;
  };
  materials: { rock: string; rim: string; rimEmissive: string };
  collisionBoxes: { color: string; opacity: number };
}

export interface ArenaPropsConfig {
  version: string;
  ticket: string;
  kinds: Record<string, PropKindConfig>;
  instances: PropInstance[];
  damageModel: {
    sweepGroundBandY: [number, number];
    sweepImmuneFeetYAbove: number;
    chargeImmuneFeetYAbove: number;
    losRayHeightY: number;
    note: string;
  };
  render: ArenaPropsRenderConfig;
}

/** 一个实例算完世界坐标后的只读投影（渲染层与调试层共用） */
export interface PropPlacement {
  id: string;
  kind: string;
  category: PropCategory;
  /** 底面中心的世界坐标（底面 y 恒为 0，地形只加高度） */
  x: number;
  z: number;
  /** 台面高度（顶面 y） */
  heightM: number;
  /** 绕 Y 的朝向（弧度） */
  rotRad: number;
  /** solid 才有碰撞箱；walkable 为 null */
  aabb: Aabb | null;
}

const DEG = Math.PI / 180;

/** 极坐标 → 世界坐标（x = r·cos(a)，z = r·sin(a)） */
export function propPosition(inst: PropInstance): { x: number; z: number } {
  const a = inst.angleDeg * DEG;
  return { x: Math.cos(a) * inst.radiusM, z: Math.sin(a) * inst.radiusM };
}

/**
 * footprint → 轴对齐碰撞箱。
 *
 * 有向矩形按「旋转后外接 AABB」处理：宁可略大，也不让玩家卡进看不见的缝隙。
 * 这是本票明确的取舍——AABB 的保守外扩最多 (w·|cos|+d·|sin| - w)/2，
 * 对 3.6×0.8 的壁垒最坏 +1.4 m，仍在塔位净空 2.2 m 预算内。
 */
export function aabbFromFootprint(
  footprint: PropFootprint,
  cx: number,
  cz: number,
  heightM: number,
  rotRad: number,
): Aabb {
  let halfX: number;
  let halfZ: number;

  if (footprint.shape === 'circle') {
    halfX = footprint.radiusM;
    halfZ = footprint.radiusM;
  } else if (footprint.shape === 'rect') {
    halfX = footprint.widthM / 2;
    halfZ = footprint.depthM / 2;
  } else {
    const c = Math.abs(Math.cos(rotRad));
    const s = Math.abs(Math.sin(rotRad));
    halfX = (footprint.widthM * c + footprint.depthM * s) / 2;
    halfZ = (footprint.widthM * s + footprint.depthM * c) / 2;
  }

  return {
    minX: cx - halfX,
    maxX: cx + halfX,
    minY: 0,
    maxY: heightM,
    minZ: cz - halfZ,
    maxZ: cz + halfZ,
  };
}

/** 单个实例 → 渲染/碰撞共用的投影 */
export function placementOf(cfg: ArenaPropsConfig, inst: PropInstance): PropPlacement {
  const kind = cfg.kinds[inst.kind];
  if (!kind) throw new Error(`[arena-props] 未定义的 kind: ${inst.kind}（实例 ${inst.id}）`);
  const { x, z } = propPosition(inst);
  const rotRad = inst.rotDeg * DEG;
  return {
    id: inst.id,
    kind: inst.kind,
    category: kind.category,
    x,
    z,
    heightM: kind.heightM,
    rotRad,
    aabb: kind.collider === 'solid' ? aabbFromFootprint(kind.footprint, x, z, kind.heightM, rotRad) : null,
  };
}

/** 全部实例的投影（顺序与 config 一致，便于测试逐条对齐） */
export function placements(cfg: ArenaPropsConfig): PropPlacement[] {
  return cfg.instances.map((inst) => placementOf(cfg, inst));
}

/** 全部 solid 碰撞箱（平台 / 遮挡物 / 防御物都算） */
export function collidersFromProps(cfg: ArenaPropsConfig): Aabb[] {
  const out: Aabb[] = [];
  for (const p of placements(cfg)) if (p.aabb) out.push(p.aabb);
  return out;
}

/**
 * 只取「可站立平台」的碰撞箱——本票路径 A 的落地点。
 *
 * 与 collidersFromProps 的区别：遮挡物/防御物还没有渲染件，
 * 现在就把它们塞进世界会让玩家撞到看不见的墙，所以先只上平台。
 */
export function platformColliders(cfg: ArenaPropsConfig): Aabb[] {
  const out: Aabb[] = [];
  for (const p of placements(cfg)) {
    if (p.category === 'platform' && p.aabb) out.push(p.aabb);
  }
  return out;
}

/** 平台台面高度的最大值（调试/验收用：玩家能站到多高） */
export function maxPlatformTopY(cfg: ArenaPropsConfig): number {
  let max = 0;
  for (const p of placements(cfg)) if (p.category === 'platform') max = Math.max(max, p.heightM);
  return max;
}
