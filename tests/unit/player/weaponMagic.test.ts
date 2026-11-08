import { describe, expect, it } from 'vitest';
import { createBus } from '../../../src/core/events';
import type { Events } from '../../../src/core/events';
import { WeaponMagic } from '../../../src/player/WeaponMagic';
import type { AttackOutcome, MagicWeaponConfig, WeaponHit } from '../../../src/player/weaponTypes';

const DT = 1 / 60;

const cfg: MagicWeaponConfig = {
  spark: { damage: 12, ratePerSec: 5 },
  pierce: { chargeSec: 1.2, damage: 90, passThroughArmor: true },
  overheat: { fillSec: 4, cooldownSec: 2 },
};

const miss: WeaponHit = {
  target: 'boss',
  weakness: null,
  resist: { resistArcane: 0, resistPhysical: 0 },
  debuffs: { scorch: 0, sunder: 0 },
};

const hit = (over: Partial<WeaponHit> = {}): WeaponHit => ({ ...miss, ...over });

function make(resolve: () => WeaponHit | null = () => hit()) {
  const bus = createBus();
  const overheats: Array<Events['OverheatChanged']> = [];
  bus.on('OverheatChanged', (p) => overheats.push(p));
  const weapon = new WeaponMagic({ bus, config: cfg, resolveHit: resolve });
  return { weapon, overheats };
}

const idle = (over: Partial<Parameters<WeaponMagic['update']>[1]> = {}) => ({
  lightPressed: false,
  lightHeld: false,
  heavyPressed: false,
  heavyHeld: false,
  ...over,
});

function run(weapon: WeaponMagic, frames: number, over = {}): AttackOutcome[] {
  const out: AttackOutcome[] = [];
  for (let i = 0; i < frames; i += 1) {
    const attack = weapon.update(DT, idle(over));
    if (attack) out.push(attack);
  }
  return out;
}

describe('WeaponMagic · 火花', () => {
  it('按住左键 5 发/秒，每发 12 基础法术伤害', () => {
    const { weapon } = make();
    const shots = run(weapon, 60, { lightHeld: true });
    expect(shots).toHaveLength(5);
    expect(shots.every((s) => s.baseDamage === 12 && s.attr === 'arcane')).toBe(true);
  });

  it('命中信息透传给整合层', () => {
    const { weapon } = make(() =>
      hit({ weakness: { part: 'core', attr: 'arcane' }, part: 'core', point: [0, 5, 2] }),
    );
    const shots = run(weapon, 12, { lightHeld: true });
    expect(shots[0].target).toBe('boss');
    expect(shots[0].part).toBe('core');
    expect(shots[0].point).toEqual([0, 5, 2]);
    expect(shots[0].baseDamage).toBe(12);
  });
});

describe('WeaponMagic · 过热', () => {
  it('连续射击 4 s 进入过热，期间无法开火', () => {
    const { weapon, overheats } = make();
    const shots = run(weapon, 240, { lightHeld: true });
    expect(weapon.isOverheated).toBe(true);
    expect(weapon.heatRatio).toBe(1);
    expect(shots).toHaveLength(20);
    expect(overheats.at(-1)).toMatchObject({ overheated: true });

    expect(run(weapon, 60, { lightHeld: true })).toHaveLength(0);
  });

  it('停火 2 s 后过热解除，可以继续开火', () => {
    const { weapon } = make();
    run(weapon, 240, { lightHeld: true });
    expect(weapon.isOverheated).toBe(true);

    run(weapon, 120); // 冷却 2 s
    expect(weapon.isOverheated).toBe(false);
    expect(weapon.heatRatio).toBe(0);

    expect(run(weapon, 12, { lightHeld: true })).toHaveLength(1);
  });

  it('停火时自然散热', () => {
    const { weapon } = make();
    run(weapon, 60, { lightHeld: true });
    const heat = weapon.heatRatio;
    run(weapon, 60);
    expect(weapon.heatRatio).toBeLessThan(heat);
    expect(weapon.heatRatio).toBeGreaterThanOrEqual(0);
  });
});

describe('WeaponMagic · 地脉穿刺', () => {
  it('引导满 1.2 s 释放，90 基础法术伤害', () => {
    const { weapon } = make();
    weapon.update(DT, idle({ heavyPressed: true }));
    run(weapon, 72, { heavyHeld: true });
    expect(weapon.chargeRatio).toBe(1);
    const out = weapon.update(DT, idle({ heavyHeld: false }));
    expect(out?.kind).toBe('pierce');
    expect(out?.baseDamage).toBe(90);
    expect(out?.attr).toBe('arcane');
  });

  it('引导未满释放则取消', () => {
    const { weapon } = make();
    weapon.update(DT, idle({ heavyPressed: true }));
    run(weapon, 30, { heavyHeld: true });
    expect(weapon.update(DT, idle({ heavyHeld: false }))).toBeNull();
  });

  it('穿刺命中信息透传', () => {
    const { weapon } = make(() =>
      hit({ weakness: { part: 'core', attr: 'arcane' }, part: 'core' }),
    );
    weapon.update(DT, idle({ heavyPressed: true }));
    run(weapon, 72, { heavyHeld: true });
    const out = weapon.update(DT, idle({ heavyHeld: false }));
    expect(out?.target).toBe('boss');
    expect(out?.part).toBe('core');
  });
});
