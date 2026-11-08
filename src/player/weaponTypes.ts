// src/player/weaponTypes.ts
// 武器模块共享类型。纯逻辑：禁止 import three；命中判定由整合层注入。

import type { Attr, BodyPart, Vec3 } from '../core/events';
import type { DebuffState, ResistState, WeaknessInfo } from '../combat/Damage';

/** 一次攻击查询。几何/距离判定由整合层负责，武器只关心结果 */
export interface WeaponHitQuery {
  kind: 'melee' | 'projectile' | 'channel';
  rangeM: number;
}

/** 命中结果：几何信息 + 目标坐标 */
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
  /** 射线命中点（世界坐标），交给 Boss 判定弱点 */
  point?: Vec3;
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

/** 一次成功攻击的结果。按方案一：武器只给基础伤害，倍率/抗性由目标（Boss）计算 */
export interface AttackOutcome {
  kind: 'melee' | 'anchor' | 'spark' | 'pierce';
  /** 基础伤害（未乘弱点倍率/抗性） */
  baseDamage: number;
  attr: Attr;
  target: 'boss' | 'tower' | 'player' | null;
  part?: BodyPart;
  /** 射线命中点（世界坐标） */
  point?: Vec3;
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
