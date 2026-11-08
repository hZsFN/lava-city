// src/player/weaponTypes.ts
// 武器模块共享类型。纯逻辑：禁止 import three；命中判定由整合层注入。

import type { BodyPart, Vec3 } from '../core/events';
import type { DebuffState, ResistState, WeaknessInfo } from '../combat/Damage';

/** 一次攻击查询。几何/距离判定由整合层负责，武器只关心结果 */
export interface WeaponHitQuery {
  kind: 'melee' | 'projectile' | 'channel';
  rangeM: number;
}

/** 命中结果：包含算伤害所需的全部战斗状态 */
export interface WeaponHit {
  target: 'boss' | 'tower' | 'player';
  /** 实际命中的部位（无部位概念时缺省） */
  part?: BodyPart;
  /** 该部位当前是否暴露弱点；null = 无弱点 */
  weakness: WeaknessInfo | null;
  resist: ResistState;
  debuffs: DebuffState;
  /** 目标世界坐标，供岩锚拉拽使用 */
  pos?: Vec3;
}

export type ResolveWeaponHit = (query: WeaponHitQuery) => WeaponHit | null;

/** 每逻辑帧的武器输入 */
export interface WeaponInput {
  /** 左键按下边沿 */
  lightPressed: boolean;
  /** 左键持续按住（法术连发） */
  lightHeld: boolean;
  /** 右键按下边沿（开始蓄力/引导） */
  heavyPressed: boolean;
  /** 右键持续按住；由 true→false 视为释放 */
  heavyHeld: boolean;
}

/** 一次成功攻击的结果，交给整合层做表现/位移 */
export interface AttackOutcome {
  kind: 'melee' | 'anchor' | 'spark' | 'pierce';
  damage: number;
  isCrit: boolean;
  target: 'boss' | 'tower' | 'player' | null;
  part?: BodyPart;
  /** 岩锚命中弱点时的拉拽目标 */
  pullTo?: Vec3;
  /** 第三段近战的击退强度 */
  knockback?: number;
}

export interface PhysicalWeaponConfig {
  melee: {
    combo: number[];
    range: number;
    thirdKnockback: number;
    swingIntervalSec: number;
    comboWindowSec: number;
  };
  anchor: {
    chargeSec: number;
    damage: number;
    pullToWeakness: boolean;
  };
}

export interface MagicWeaponConfig {
  spark: {
    damage: number;
    ratePerSec: number;
  };
  pierce: {
    chargeSec: number;
    damage: number;
    passThroughArmor: boolean;
  };
  overheat: {
    fillSec: number;
    cooldownSec: number;
  };
}
