import { describe, expect, it } from 'vitest';
import {
  clampResist,
  computeDamage,
  executionDamage,
  weaknessContribution,
} from '../../../src/combat/Damage';
import type { DebuffState, DamageArgs, ResistState } from '../../../src/combat/Damage';

const noResist: ResistState = { resistArcane: 0, resistPhysical: 0 };
const noDebuff: DebuffState = { scorch: 0, sunder: 0 };

const args = (over: Partial<DamageArgs> = {}): DamageArgs => ({
  base: 100,
  attr: 'physical',
  resist: noResist,
  debuffs: noDebuff,
  weakness: null,
  ...over,
});

describe('clampResist', () => {
  it('保留正常抗性', () => {
    expect(clampResist(0.7)).toBe(0.7);
    expect(clampResist(0)).toBe(0);
  });

  it('抗性下限封顶 -30%', () => {
    expect(clampResist(-0.5)).toBe(-0.3);
    expect(clampResist(-0.3)).toBe(-0.3);
  });
});

describe('computeDamage', () => {
  it('无弱点且无抗性：×1.0，非暴击', () => {
    const r = computeDamage(args());
    expect(r.amount).toBeCloseTo(100);
    expect(r.isCrit).toBe(false);
  });

  it('命中弱点且属性匹配：×2.5，暴击', () => {
    const r = computeDamage(
      args({ attr: 'arcane', weakness: { part: 'core', attr: 'arcane' } }),
    );
    expect(r.amount).toBeCloseTo(250);
    expect(r.isCrit).toBe(true);
  });

  it('命中弱点但属性不匹配：×1.2，非暴击', () => {
    const r = computeDamage(
      args({ attr: 'physical', weakness: { part: 'core', attr: 'arcane' } }),
    );
    expect(r.amount).toBeCloseTo(120);
    expect(r.isCrit).toBe(false);
  });

  it('法术抗性生效，且只吃灼烙减抗', () => {
    const r = computeDamage(
      args({
        attr: 'arcane',
        resist: { resistArcane: 0.5, resistPhysical: 0.7 },
        debuffs: { scorch: 2, sunder: 5 },
      }),
    );
    // 0.5 + 2 × (-0.08) = 0.34
    expect(r.amount).toBeCloseTo(100 * (1 - 0.34));
  });

  it('物理抗性生效，且只吃碎甲减抗', () => {
    const r = computeDamage(
      args({
        attr: 'physical',
        resist: { resistArcane: 0.7, resistPhysical: 0.4 },
        debuffs: { scorch: 5, sunder: 1 },
      }),
    );
    // 0.4 + 1 × (-0.08) = 0.32
    expect(r.amount).toBeCloseTo(100 * (1 - 0.32));
  });

  it('减抗超过 30% 时封顶 1.3×', () => {
    const r = computeDamage(
      args({
        attr: 'physical',
        resist: { resistArcane: 0, resistPhysical: 0.1 },
        debuffs: { scorch: 0, sunder: 5 },
      }),
    );
    // 0.1 - 0.4 = -0.3，正好卡在下限
    expect(r.amount).toBeCloseTo(130);
  });

  it('debuffs 缺省时按 0 层处理（物理）', () => {
    const r = computeDamage({
      base: 100,
      attr: 'physical',
      resist: noResist,
      weakness: null,
      debuffs: undefined as unknown as DebuffState,
    });
    expect(r.amount).toBeCloseTo(100);
  });

  it('debuffs 缺省时按 0 层处理（法术）', () => {
    const r = computeDamage({
      base: 100,
      attr: 'arcane',
      resist: noResist,
      weakness: null,
      debuffs: undefined as unknown as DebuffState,
    });
    expect(r.amount).toBeCloseTo(100);
  });
});

describe('executionDamage', () => {
  it('阶段最大 HP 的 12%', () => {
    expect(executionDamage(1000)).toBeCloseTo(120);
    expect(executionDamage(0)).toBe(0);
  });

  it('无视抗性：结果只与 maxHp 相关', () => {
    expect(executionDamage(833.33)).toBeCloseTo(99.9996);
  });
});

describe('weaknessContribution', () => {
  it('无弱点暴露时为 0', () => {
    expect(
      weaknessContribution({
        damageDealt: 100,
        attr: 'physical',
        weaknessAttr: null,
        fromTower: false,
      }),
    ).toBe(0);
  });

  it('匹配属性：+1/伤害点', () => {
    expect(
      weaknessContribution({
        damageDealt: 40,
        attr: 'arcane',
        weaknessAttr: 'arcane',
        fromTower: false,
      }),
    ).toBe(40);
  });

  it('不匹配属性：+0.25/伤害点', () => {
    expect(
      weaknessContribution({
        damageDealt: 40,
        attr: 'physical',
        weaknessAttr: 'arcane',
        fromTower: false,
      }),
    ).toBe(10);
  });

  it('塔来源 ×0.5', () => {
    expect(
      weaknessContribution({
        damageDealt: 40,
        attr: 'arcane',
        weaknessAttr: 'arcane',
        fromTower: true,
      }),
    ).toBe(20);
  });
});
