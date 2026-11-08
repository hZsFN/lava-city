import { describe, expect, it } from 'vitest';
import { createBus } from '../../../src/core/events';
import type { Events } from '../../../src/core/events';
import { WeaponPhysical } from '../../../src/player/WeaponPhysical';
import type { PhysicalWeaponConfig, WeaponHit } from '../../../src/player/weaponTypes';

const DT = 1 / 60;

const cfg: PhysicalWeaponConfig = {
  melee: {
    combo: [30, 30, 60],
    range: 3,
    thirdKnockback: 6,
    swingIntervalSec: 0.45,
    comboWindowSec: 0.9,
  },
  anchor: { chargeSec: 1, damage: 80, pullToWeakness: true },
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
  bus.on('DamageDealt', (p) => damages.push(p));
  const weapon = new WeaponPhysical({ bus, config: cfg, resolveHit: resolve });
  return { weapon, damages };
}

const idle = (over: Partial<Parameters<WeaponPhysical['update']>[1]> = {}) => ({
  lightPressed: false,
  lightHeld: false,
  heavyPressed: false,
  heavyHeld: false,
  ...over,
});

function run(weapon: WeaponPhysical, frames: number, over = {}): void {
  for (let i = 0; i < frames; i += 1) weapon.update(DT, idle(over));
}

describe('WeaponPhysical · 三段近战', () => {
  it('三段伤害依次为 30/30/60，第三段带击退', () => {
    const { weapon, damages } = make();
    expect(weapon.update(DT, idle({ lightPressed: true }))?.damage).toBeCloseTo(30);
    run(weapon, 28);
    expect(weapon.update(DT, idle({ lightPressed: true }))?.damage).toBeCloseTo(30);
    run(weapon, 28);
    const third = weapon.update(DT, idle({ lightPressed: true }));
    expect(third?.damage).toBeCloseTo(60);
    expect(third?.kind).toBe('melee');
    expect(third?.knockback).toBe(6);
    expect(damages).toHaveLength(3);
    expect(damages.map((d) => d.attr)).toEqual(['physical', 'physical', 'physical']);
  });

  it('挥击冷却内连点无效', () => {
    const { weapon, damages } = make();
    weapon.update(DT, idle({ lightPressed: true }));
    run(weapon, 10, { lightHeld: true });
    expect(weapon.update(DT, idle({ lightPressed: true }))).toBeNull();
    expect(damages).toHaveLength(1);
  });

  it('超过连击窗口后从第一段重新开始', () => {
    const { weapon } = make();
    weapon.update(DT, idle({ lightPressed: true }));
    run(weapon, 58); // 0.966 s > comboWindowSec 0.9
    expect(weapon.comboIndex).toBe(0);
    expect(weapon.update(DT, idle({ lightPressed: true }))?.damage).toBeCloseTo(30);
  });

  it('命中匹配弱点时 ×2.5 并标记暴击', () => {
    const { weapon, damages } = make(() =>
      hit({ weakness: { part: 'core', attr: 'physical' }, part: 'core' }),
    );
    const out = weapon.update(DT, idle({ lightPressed: true }));
    expect(out?.damage).toBeCloseTo(75);
    expect(out?.isCrit).toBe(true);
    expect(damages[0]).toMatchObject({ part: 'core', isCrit: true, amount: 75 });
  });

  it('抗性参与计算', () => {
    const { weapon } = make(() => hit({ resist: { resistArcane: 0, resistPhysical: 0.2 } }));
    expect(weapon.update(DT, idle({ lightPressed: true }))?.damage).toBeCloseTo(24);
  });

  it('没有目标时不产生伤害事件', () => {
    const { weapon, damages } = make(() => null);
    const out = weapon.update(DT, idle({ lightPressed: true }));
    expect(out?.damage).toBe(0);
    expect(out?.target).toBeNull();
    expect(damages).toHaveLength(0);
  });
});

describe('WeaponPhysical · 岩锚', () => {
  it('蓄力未满释放则取消', () => {
    const { weapon, damages } = make();
    weapon.update(DT, idle({ heavyPressed: true }));
    run(weapon, 30, { heavyHeld: true }); // 0.5 s < 1.0 s
    expect(weapon.update(DT, idle({ heavyHeld: false }))).toBeNull();
    expect(damages).toHaveLength(0);
  });

  it('蓄满释放造成 80 物理伤害', () => {
    const { weapon } = make();
    weapon.update(DT, idle({ heavyPressed: true }));
    run(weapon, 61, { heavyHeld: true });
    expect(weapon.chargeRatio).toBe(1);
    const out = weapon.update(DT, idle({ heavyHeld: false }));
    expect(out?.kind).toBe('anchor');
    expect(out?.damage).toBeCloseTo(80);
  });

  it('命中弱点时返回拉拽目标', () => {
    const { weapon } = make(() =>
      hit({ weakness: { part: 'back', attr: 'physical' }, part: 'back', pos: [1, 2, 3] }),
    );
    weapon.update(DT, idle({ heavyPressed: true }));
    run(weapon, 61, { heavyHeld: true });
    const out = weapon.update(DT, idle({ heavyHeld: false }));
    expect(out?.pullTo).toEqual([1, 2, 3]);
    expect(out?.damage).toBeCloseTo(200);
  });

  it('未命中不拉拽', () => {
    const { weapon } = make(() => hit({ pos: [1, 2, 3] }));
    weapon.update(DT, idle({ heavyPressed: true }));
    run(weapon, 61, { heavyHeld: true });
    const out = weapon.update(DT, idle({ heavyHeld: false }));
    expect(out?.pullTo).toBeUndefined();
  });
});
