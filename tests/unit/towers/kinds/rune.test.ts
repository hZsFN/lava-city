import { describe, expect, it } from 'vitest';
import { runeBehavior } from '../../../../src/towers/kinds/rune';
import { makeSelf, tick, towersCfg } from './helpers';

const CFG = towersCfg.kinds.rune;
const STEP = { dtSec: CFG.intervalSec };

describe('rune 符文聚能塔', () => {
  it('射程内按间隔发 TowerTargetHit，attr=arcane、amount 来自 config', () => {
    const h = makeSelf('rune');
    tick(runeBehavior, h, 2, STEP);

    const hits = h.of('TowerTargetHit');
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({
      towerId: h.self.id,
      kind: 'rune',
      attr: 'arcane',
      amount: CFG.damage,
    });
    expect(CFG.damage).toBe(18);
  });

  it('射程外不发', () => {
    const h = makeSelf('rune');
    tick(runeBehavior, h, 10, { ...STEP, bossPos: [999, 0, 0] });
    expect(h.count('TowerTargetHit')).toBe(0);
  });

  it('0.8 s 内只发一次', () => {
    const h = makeSelf('rune');
    // 冷却初始为 0 = 就绪，第 1 帧即开火
    tick(runeBehavior, h, 1, { dtSec: 0.1 });
    expect(h.count('TowerTargetHit')).toBe(1);

    // 之后 0.7s 内不再开火
    tick(runeBehavior, h, 7, { dtSec: 0.1 });
    expect(h.count('TowerTargetHit')).toBe(1);

    // 满 0.8s 后第二发
    tick(runeBehavior, h, 2, { dtSec: 0.1 });
    expect(h.count('TowerTargetHit')).toBe(2);
  });

  it('canFire=false 时不开火', () => {
    const h = makeSelf('rune');
    tick(runeBehavior, h, 10, { ...STEP, canFire: false });
    expect(h.count('TowerTargetHit')).toBe(0);
  });

  it('不越权发 DebuffStackChanged（灼烙由 Boss 记）', () => {
    const h = makeSelf('rune');
    tick(runeBehavior, h, 20, STEP);
    expect(h.count('TowerTargetHit')).toBeGreaterThan(0);
    expect(h.count('DebuffStackChanged')).toBe(0);
  });

  it('数值全部来自 config', () => {
    expect(runeBehavior.attr).toBe(CFG.attr);
    expect(runeBehavior.cost).toBe(CFG.cost);
    expect(runeBehavior.range).toBe(CFG.range);
    expect(runeBehavior.maxHp).toBe(CFG.hp);
  });
});
