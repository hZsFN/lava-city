// src/boss/SurtrAdapter.ts
// ============================================================================
// 把 SurtrRig（100% 程序化 three 模型，契约见 SurtrRig.ts）适配成 IgnisBuild。
//
// 为什么需要适配层：
//   - 两个包出自同一套 rig 契约（14 个关节同名、4 个弱点同名），但字段命名不同
//     （solidMeshes vs stoneMeshes、rock/char/lava vs stone/iron/ember）。
//   - IgnisBoss 只认 IgnisBuild，改模型不应该改 Boss 逻辑，所以在这里做一次性映射。
//   - Surtr 原始身高 14.76 m，现有 Boss 约 9.1 m；默认整体缩到 0.62 倍，
//     让相机、塔位（y=12）、技能距离、弱点标记都不用重调。
//
// 坐标：脚底 y=0、面朝 +Z、+X 为右手边——与 IgnisRig 一致，无需额外旋转。
// ============================================================================

import * as THREE from 'three/webgpu';
import { createSurtrRig } from './SurtrRig';
import type { SurtrMeta, SurtrBuild } from './SurtrRig';
import type { IgnisBuild, IgnisMaterials, IgnisRig } from './IgnisRig';

/** 默认缩放：14.762 m * 0.62 ≈ 9.15 m，贴合现有 Boss 的 9.1 m 体量 */
export const SURTR_MODEL_SCALE = 0.62;

export interface SurtrAsIgnisBuild extends IgnisBuild {
  /** 原始模型元数据（弱点位置是未缩放坐标，调用方按 modelScale 换算） */
  meta: SurtrMeta;
  /** 实际应用的整体缩放 */
  modelScale: number;
  /** 原始 Surtr 构建产物（火山灰浮岩、熔岩瀑布、火冠等扩展件在这里） */
  surtr: SurtrBuild;
}

/**
 * 构建一个 IgnisBuild 兼容的苏尔特。
 *
 * 外层 group（rig.root）由 IgnisBoss 负责缩放（登场/转场动画）；
 * 内层（Surtr 自己的 root）固定按 scale 缩小，两者相乘得到最终体量。
 */
export function createSurtrBuild(scale: number = SURTR_MODEL_SCALE): SurtrAsIgnisBuild {
  const surtr = createSurtrRig();
  const inner = surtr.rig.root;
  inner.scale.setScalar(scale);

  const outer = new THREE.Group();
  outer.name = 'surtr';
  outer.add(inner);

  const rig: IgnisRig = { ...surtr.rig, root: outer };

  // Ignis 的 7 种材质 ←→ Surtr 的 8 种材质
  // stone=玄武岩, iron=焦壳/骨白, ember=熔岩橙, emberHot=炽白, core/vent 同名, slag=火山灰
  const materials: IgnisMaterials = {
    stone: surtr.materials.rock,
    iron: surtr.materials.char,
    ember: surtr.materials.lava,
    emberHot: surtr.materials.lavaHot,
    core: surtr.materials.core,
    vent: surtr.materials.vent,
    slag: surtr.materials.ash,
  };

  return {
    rig,
    stoneMeshes: surtr.solidMeshes,
    glowMeshes: surtr.glowMeshes,
    phase1Meshes: surtr.phase1Meshes,
    phase2Meshes: surtr.phase2Meshes,
    materials,
    meta: surtr.meta,
    modelScale: scale,
    surtr,
  };
}
