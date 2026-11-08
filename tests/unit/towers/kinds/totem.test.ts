import { describe, expect, it } from 'vitest';
import { totemBehavior } from '../../../../src/towers/kinds/totem';
import { makeSelf, tick, towersCfg } from './helpers';

const CFG = towersCfg.kinds.totem;
const DT = 0.1;

describe('totem 嘲讽图腾', () => {
  it('Boss 在射程内且冷却好了 → 发 TauntStarted，durationMs 来自 config', () => {
    const h = makeSelf('totem');
    tick(totemBehavior, h, 1, { dtSec: DT });

    const started = h.of('TauntStarted');
    expect(started).toHaveLength(1);
    expect(started[0]).toEqual({
      towerId: h.self.id,
      durationMs: CFG.tauntSec! * 1000,
    });
    expect(started[0].durationMs).toBe(6000);
  });

  it('射程外不发', () => {
    const h = makeSelf('totem');
    tick(totemBehavior, h, 10, { dtSec: DT, bossPos: [999, 0, 0] });
    expect(h.count('TauntStarted')).toBe(0);
  });

  it('Boss 已被嘲讽（taunted=true）时不抢', () => {
    const h = makeSelf('totem');
    tick(totemBehavior, h, 10, { dtSec: DT, taunted: true });
    expect(h.count('TauntStarted')).toBe(0);
  });

  it('嘲讽期间不重复发', () => {
    const h = makeSelf('totem');
    tick(totemBehavior, h, 1, { dtSec: DT }); // 起手
    tick(totemBehavior, h, 20, { dtSec: DT }); // 2s 内
    expect(h.count('TauntStarted')).toBe(1);
    expect(h.count('TauntEnded')).toBe(0);
  });

  it('嘲讽计时结束 → 发 TauntEnded', () => {
    const h = makeSelf('totem');
    tick(totemBehavior, h, 1, { dtSec: DT }); // 起手
    // 6s / 0.1s = 60 帧
    tick(totemBehavior, h, 60, { dtSec: DT });
    expect(h.count('TauntEnded')).toBe(1);
  });

  it('塔被拆 → 嘲讽中的塔发 TauntEnded', () => {
    const h = makeSelf('totem');
    tick(totemBehavior, h, 1, { dtSec: DT });
    expect(h.count('TauntStarted')).toBe(1);

    totemBehavior.onRemoved!(h.self);
    expect(h.count('TauntEnded')).toBe(1);

    // 再调一次不会重复发
    totemBehavior.onRemoved!(h.self);
    expect(h.count('TauntEnded')).toBe(1);
  });

  it('没有在嘲讽时被拆 → 不发 TauntEnded', () => {
    const h = makeSelf('totem');
    totemBehavior.onRemoved!(h.self);
    expect(h.count('TauntEnded')).toBe(0);
  });

  it('冷却 20s 内不会二次嘲讽', () => {
    const h = makeSelf('totem');
    tick(totemBehavior, h, 1, { dtSec: DT }); // 起手
    tick(totemBehavior, h, 61, { dtSec: DT }); // 6.1s：嘲讽结束，冷却剩 ~13.9s
    expect(h.count('TauntEnded')).toBe(1);
    tick(totemBehavior, h, 100, { dtSec: DT }); // 再 10s：冷却还剩 ~3.9s
    expect(h.count('TauntStarted')).toBe(1);
  });

  it('冷却走完后可再次嘲讽', () => {
    const h = makeSelf('totem');
    tick(totemBehavior, h, 1, { dtSec: DT }); // 起手，cooldown=20
    // 20.1s / 0.1s = 201 帧
    tick(totemBehavior, h, 201, { dtSec: DT });
    expect(h.count('TauntStarted')).toBe(2);
  });

  it('数值全部来自 config', () => {
    expect(totemBehavior.attr).toBe(CFG.attr);
    expect(totemBehavior.attr).toBe('none');
    expect(totemBehavior.cost).toBe(CFG.cost);
    expect(totemBehavior.range).toBe(CFG.range);
    expect(totemBehavior.maxHp).toBe(CFG.hp);
    expect(CFG.cooldownSec).toBe(20);
  });
});
