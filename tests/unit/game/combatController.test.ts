import { describe, expect, it } from 'vitest';
import { createBus } from '../../../src/core/events';
import { CombatController } from '../../../src/game/CombatController';
import type { CombatConfig } from '../../../src/game/CombatController';
import type { AttackOutcome, WeaponHit } from '../../../src/player/weaponTypes';

const DT = 1 / 60;

const config: CombatConfig = {
  formSwitch: { durationSec: 0.5, initial: 'physical' },
  physical: {
    melee: {
      combo: [30, 30, 60],
      range: 3,
      thirdKnockback: 6,
      swingIntervalSec: 0.45,
      comboWindowSec: 0.9,
    },
    anchor: { chargeSec: 1, damage: 80, pullToWeakness: true },
  },
  magic: {
    spark: { damage: 12, ratePerSec: 5 },
    pierce: { chargeSec: 1.2, damage: 90, passThroughArmor: true },
    overheat: { fillSec: 4, cooldownSec: 2 },
  },
};

const bossHit: WeaponHit = {
  target: 'boss',
  weakness: null,
  resist: { resistArcane: 0, resistPhysical: 0 },
  debuffs: { scorch: 0, sunder: 0 },
  point: [0, 5, 2],
};

function make(hit: WeaponHit | null = bossHit) {
  const applied: AttackOutcome[] = [];
  const combat = new CombatController({
    bus: createBus(),
    config,
    resolveHit: () => hit,
    applyBoss: (o) => applied.push(o),
  });
  return { combat, applied };
}

const noWeapon = { lightPressed: false, lightHeld: false, heavyPressed: false, heavyHeld: false };

describe('CombatController · 形态路由', () => {
  it('物理形态左键走重锤，基础伤害交给 Boss', () => {
    const { combat, applied } = make();
    const out = combat.update(DT, { weapon: { ...noWeapon, lightPressed: true }, toggleForm: false });
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('melee');
    expect(out[0].baseDamage).toBe(30);
    expect(out[0].attr).toBe('physical');
    expect(applied).toHaveLength(1);
    expect(applied[0].baseDamage).toBe(30);
  });

  it('Q 切换期间禁止攻击，完成后走法杖', () => {
    const { combat, applied } = make();
    // 切换开始的同时按左键：应被忽略
    expect(
      combat.update(DT, { weapon: { ...noWeapon, lightPressed: true }, toggleForm: true }),
    ).toHaveLength(0);
    expect(applied).toHaveLength(0);

    // 0.5 s 完成切换
    for (let i = 0; i < 30; i += 1) {
      combat.update(DT, { weapon: noWeapon, toggleForm: false });
    }
    expect(combat.form.form).toBe('arcane');

    // 法术形态按住左键 → 火花，12 基础法术伤害
    for (let i = 0; i < 12; i += 1) {
      combat.update(DT, { weapon: { ...noWeapon, lightHeld: true }, toggleForm: false });
    }
    expect(applied.at(-1)?.kind).toBe('spark');
    expect(applied.at(-1)?.baseDamage).toBe(12);
    expect(applied.at(-1)?.attr).toBe('arcane');
  });

  it('非 Boss 目标不交给 Boss 结算', () => {
    const { combat, applied } = make({ ...bossHit, target: 'tower' });
    const out = combat.update(DT, {
      weapon: { ...noWeapon, lightPressed: true },
      toggleForm: false,
    });
    expect(out[0].target).toBe('tower');
    expect(applied).toHaveLength(0);
  });

  it('没命中时不调用 Boss 结算', () => {
    const { combat, applied } = make(null);
    const out = combat.update(DT, {
      weapon: { ...noWeapon, lightPressed: true },
      toggleForm: false,
    });
    expect(out[0].target).toBeNull();
    expect(applied).toHaveLength(0);
  });

  it('命中点透传给表现层', () => {
    const { combat, applied } = make();
    combat.update(DT, { weapon: { ...noWeapon, lightPressed: true }, toggleForm: false });
    expect(applied[0].point).toEqual([0, 5, 2]);
  });
});
