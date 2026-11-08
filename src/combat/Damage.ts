// src/combat/Damage.ts
// 纯函数伤害模型。依据设计文档 §8。禁止 import three；所有数值来自 config。

import type { Attr, BodyPart } from '../core/events';

export type DamageTarget = 'boss' | 'tower' | 'player';

export interface ResistState {
  resistArcane: number;    // 0..0.7，法术抗性
  resistPhysical: number;  // 0..0.7，物理抗性
}

export interface DebuffState {
  /** 灼烙：法术减抗，-0.08/层，上限 5 */
  scorch: number;
  /** 碎甲：物理减抗，-0.08/层，上限 5 */
  sunder: number;
}

/** 弱点倍率：匹配属性命中 = 2.5；不匹配命中弱点 = 1.2；其他 = 1.0 */
export interface WeaknessInfo {
  part: BodyPart;
  attr: Attr;
}

export interface DamageArgs {
  base: number;
  attr: Attr;
  resist: ResistState;
  debuffs: DebuffState;
  /** 若命中弱点则提供其信息，否则 undefined */
  weakness: WeaknessInfo | null;
}

export interface DamageResult {
  amount: number;
  isCrit: boolean;
  /* 真伤（弱点击破），倍率为 2.5 时视为暴击 */
}

const WEAKNESS_MATCH = 2.5;
const WEAKNESS_MISMATCH = 1.2;
const RESIST_FLOOR = -0.3; // 最低减抗 -30%（最高 1.3 倍）
const SCORCH_PER_STACK = -0.08;
const SUNDER_PER_STACK = -0.08;

export function clampResist(resist: number): number {
  return Math.max(resist, RESIST_FLOOR);
}

/**
 * 最终伤害 = 基础 × (1 − 抗性 + Σdebuff减抗) × 弱点倍率。
 * 抗性下限 −30%；命中弱点且属性匹配 ×2.5，不匹配 ×1.2，其他 ×1.0。
 */
export function computeDamage(args: DamageArgs): DamageResult {
  const { base, attr, resist, debuffs, weakness } = args;

  const baseResist =
    attr === 'arcane' ? resist.resistArcane : resist.resistPhysical;

  const debuffBonus =
    attr === 'arcane'
      ? (debuffs?.scorch ?? 0) * SCORCH_PER_STACK
      : (debuffs?.sunder ?? 0) * SUNDER_PER_STACK;

  const resistAfter = clampResist(baseResist + debuffBonus);

  let mult = 1.0;
  let isCrit = false;
  if (weakness) {
    if (weakness.attr === attr) {
      mult = WEAKNESS_MATCH;
      isCrit = true;
    } else {
      mult = WEAKNESS_MISMATCH;
    }
  }

  const amount = base * (1 - resistAfter) * mult;
  return { amount, isCrit };
}

/**
 * 击破真实伤害 = 阶段最大 HP × 12%，无视抗性、无视弱点倍率。
 */
export function executionDamage(maxHp: number): number {
  return maxHp * 0.12;
}

/**
 * 破绽值累积：
 * 匹配属性命中 +1/伤害点；不匹配 +0.25；塔来源 ×0.5。
 * return 本次伤害贡献的破绽值。
 */
export function weaknessContribution(opts: {
  damageDealt: number;
  attr: Attr;
  // 当前弱点属性；null 表示无弱点暴露
  weaknessAttr: Attr | null;
  fromTower: boolean;
}): number {
  const { damageDealt, attr, weaknessAttr, fromTower } = opts;
  if (weaknessAttr === null) return 0;
  const perPoint = attr === weaknessAttr ? 1.0 : 0.25;
  const contribution = damageDealt * perPoint;
  return fromTower ? contribution * 0.5 : contribution;
}