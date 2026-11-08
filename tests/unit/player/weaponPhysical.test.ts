import { describe, expect, it } from 'vitest';
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
  const weapon = new WeaponPhysical({ config: cfg, resolveHit: resolve });
  return { weapon };
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
  it('三段基础伤害依次为 30/30/60，第三段带击退', () => {
    const { weapon } = make();
    expect(weapon.update(DT, idle({ lightPressed: true }))?.baseDamage).toBe(30);
    run(weapon, 28);
    expect(weapon.update(DT, idle({ lightPressed: true }))?.baseDamage).toBe(30);
    run(weapon, 28);
    const third = weapon.update(DT, idle({ lightPressed: true }));
    expect(third?.baseDamage).toBe(60);
    expect(third?.kind).toBe('melee');
    expect(third?.knockback).toBe(6);
  });

  it('伤害属性始终为物理', () => {
    const { weapon } = make();
    const out = weapon.update(DT, idle({ lightPressed: true }));
    expect(out?.attr).toBe('physical');
  });

  it('挥击冷却内连点无效', () => {
    const { weapon } = make();
    weapon.update(DT, idle({ lightPressed: true }));
    run(weapon, 10, { lightHeld: true });
    expect(weapon.update(DT, idle({ lightPressed: true }))).toBeNull();
  });

  it('超过连击窗口后从第一段重新开始', () => {
    const { weapon } = make();
    weapon.update(DT, idle({ lightPressed: true }));
    run(weapon, 58); // 0.966 s > comboWindowSec 0.9
    expect(weapon.comboIndex).toBe(0);
    expect(weapon.update(DT, idle({ lightPressed: true }))?.baseDamage).toBe(30);
  });

  it('命中信息透传给整合层（不做倍率计算）', () => {
    const { weapon } = make(() =>
      hit({ weakness: { part: 'core', attr: 'physical' }, part: 'core', point: [1, 2, 3] }),
    );
    const out = weapon.update(DT, idle({ lightPressed: true }));
    expect(out?.target).toBe('boss');
    expect(out?.part).toBe('core');
    expect(out?.point).toEqual([1, 2, 3]);
    expect(out?.baseDamage).toBe(30);
  });

  it('没有目标时仍返回基础伤害，target 为 null', () => {
    const { weapon } = make(() => null);
    const out = weapon.update(DT, idle({ lightPressed: true }));
    expect(out?.baseDamage).toBe(30);
    expect(out?.target).toBeNull();
  });
});

describe('WeaponPhysical · 岩锚', () => {
  it('蓄力未满释放则取消', () => {
    const { weapon } = make();
    weapon.update(DT, idle({ heavyPressed: true }));
    run(weapon, 30, { heavyHeld: true }); // 0.5 s < 1.0 s
    expect(weapon.update(DT, idle({ heavyHeld: false }))).toBeNull();
  });

  it('蓄满释放为 80 基础物理伤害', () => {
    const { weapon } = make();
    weapon.update(DT, idle({ heavyPressed: true }));
    run(weapon, 61, { heavyHeld: true });
    expect(weapon.chargeRatio).toBe(1);
    const out = weapon.update(DT, idle({ heavyHeld: false }));
    expect(out?.kind).toBe('anchor');
    expect(out?.baseDamage).toBe(80);
    expect(out?.attr).toBe('physical');
  });

  it('命中弱点时返回拉拽目标', () => {
    const { weapon } = make(() =>
      hit({ weakness: { part: 'back', attr: 'physical' }, part: 'back', pos: [1, 2, 3] }),
    );
    weapon.update(DT, idle({ heavyPressed: true }));
    run(weapon, 61, { heavyHeld: true });
    const out = weapon.update(DT, idle({ heavyHeld: false }));
    expect(out?.pullTo).toEqual([1, 2, 3]);
  });

  it('未命中弱点不拉拽', () => {
    const { weapon } = make(() => hit({ pos: [1, 2, 3] }));
    weapon.update(DT, idle({ heavyPressed: true }));
    run(weapon, 61, { heavyHeld: true });
    const out = weapon.update(DT, idle({ heavyHeld: false }));
    expect(out?.pullTo).toBeUndefined();
  });
});
