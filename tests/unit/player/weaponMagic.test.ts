import { describe, expect, it } from 'vitest';
import { createBus } from '../../../src/core/events';
import type { Events } from '../../../src/core/events';
import { WeaponMagic } from '../../../src/player/WeaponMagic';
import type { MagicWeaponConfig, WeaponHit } from '../../../src/player/weaponTypes';

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
  const damages: Array<Events['DamageDealt']> = [];
  const overheats: Array<Events['OverheatChanged']> = [];
  bus.on('DamageDealt', (p) => damages.push(p));
  bus.on('OverheatChanged', (p) => overheats.push(p));
  const weapon = new WeaponMagic({ bus, config: cfg, resolveHit: resolve });
  return { weapon, damages, overheats };
}

const idle = (over: Partial<Parameters<WeaponMagic['update']>[1]> = {}) => ({
  lightPressed: false,
  lightHeld: false,
  heavyPressed: false,
  heavyHeld: false,
  ...over,
});

function run(weapon: WeaponMagic, frames: number, over = {}): void {
  for (let i = 0; i < frames; i += 1) weapon.update(DT, idle(over));
}

describe('WeaponMagic · 火花', () => {
  it('按住左键 5 发/秒，每发 12 法术伤害', () => {
    const { weapon, damages } = make();
    run(weapon, 60, { lightHeld: true });
    expect(damages).toHaveLength(5);
    expect(damages.every((d) => d.attr === 'arcane' && Math.abs(d.amount - 12) < 1e-9)).toBe(true);
  });

  it('没有目标时也按射速消耗，但不产生伤害事件', () => {
    const { weapon, damages } = make(() => null);
    run(weapon, 60, { lightHeld: true });
    expect(damages).toHaveLength(0);
  });

  it('命中匹配弱点时 ×2.5', () => {
    const { weapon, damages } = make(() =>
      hit({ weakness: { part: 'core', attr: 'arcane' }, part: 'core' }),
    );
    run(weapon, 12, { lightHeld: true }); // 到首次开火（0.2 s）
    expect(damages[0].amount).toBeCloseTo(30);
    expect(damages[0].isCrit).toBe(true);
  });
});

describe('WeaponMagic · 过热', () => {
  it('连续射击 4 s 进入过热，期间无法开火', () => {
    const { weapon, damages, overheats } = make();
    run(weapon, 240, { lightHeld: true });
    expect(weapon.isOverheated).toBe(true);
    expect(weapon.heatRatio).toBe(1);
    expect(damages).toHaveLength(20);
    expect(overheats.at(-1)).toMatchObject({ overheated: true });

    const before = damages.length;
    run(weapon, 60, { lightHeld: true });
    expect(damages).toHaveLength(before);
  });

  it('停火 2 s 后过热解除，可以继续开火', () => {
    const { weapon, damages } = make();
    run(weapon, 240, { lightHeld: true });
    expect(weapon.isOverheated).toBe(true);

    run(weapon, 120); // 冷却 2 s
    expect(weapon.isOverheated).toBe(false);
    expect(weapon.heatRatio).toBe(0);

    const before = damages.length;
    run(weapon, 12, { lightHeld: true });
    expect(damages.length).toBe(before + 1);
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
  it('引导满 1.2 s 释放，造成 90 法术伤害', () => {
    const { weapon, damages } = make();
    weapon.update(DT, idle({ heavyPressed: true }));
    run(weapon, 72, { heavyHeld: true });
    expect(weapon.chargeRatio).toBe(1);
    const out = weapon.update(DT, idle({ heavyHeld: false }));
    expect(out?.kind).toBe('pierce');
    expect(out?.damage).toBeCloseTo(90);
    expect(damages.at(-1)?.attr).toBe('arcane');
  });

  it('引导未满释放则取消', () => {
    const { weapon, damages } = make();
    weapon.update(DT, idle({ heavyPressed: true }));
    run(weapon, 30, { heavyHeld: true });
    expect(weapon.update(DT, idle({ heavyHeld: false }))).toBeNull();
    expect(damages).toHaveLength(0);
  });

  it('穿刺命中匹配弱点时 ×2.5', () => {
    const { weapon } = make(() => hit({ weakness: { part: 'core', attr: 'arcane' } }));
    weapon.update(DT, idle({ heavyPressed: true }));
    run(weapon, 72, { heavyHeld: true });
    expect(weapon.update(DT, idle({ heavyHeld: false }))?.damage).toBeCloseTo(225);
  });
});
