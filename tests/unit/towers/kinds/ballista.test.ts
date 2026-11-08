import { describe, expect, it } from 'vitest';
import { ballistaBehavior } from '../../../../src/towers/kinds/ballista';
import { makeSelf, tick, towersCfg } from './helpers';

const CFG = towersCfg.kinds.ballista;
/** dt = intervalSec，一帧一次命中 */
const STEP = { dtSec: CFG.intervalSec };

describe('ballista 弩炮塔', () => {
  it('射程内按间隔发 TowerTargetHit，amount 来自 config', () => {
    const h = makeSelf('ballista');
    tick(ballistaBehavior, h, 3, STEP);

    const hits = h.of('TowerTargetHit');
    expect(hits).toHaveLength(3);
    expect(hits[0]).toEqual({
      towerId: h.self.id,
      kind: 'ballista',
      attr: 'physical',
      amount: CFG.damage,
    });
    expect(CFG.damage).toBe(25);
  });

  it('射程外不发', () => {
    const h = makeSelf('ballista');
    tick(ballistaBehavior, h, 10, { ...STEP, bossPos: [999, 0, 0] });
    expect(h.count('TowerTargetHit')).toBe(0);
  });

  it('间隔内只发一次', () => {
    const h = makeSelf('ballista');
    // 1.2s 间隔，推进 1.0s（10 × 0.1s）
    tick(ballistaBehavior, h, 10, { dtSec: 0.1 });
    expect(h.count('TowerTargetHit')).toBe(1);
  });

  it('4 次命中后 sunderHits 归零（叠 1 层碎甲）', () => {
    const h = makeSelf('ballista');
    tick(ballistaBehavior, h, 3, STEP);
    expect(h.self.state.sunderHits).toBe(3);

    tick(ballistaBehavior, h, 1, STEP);
    expect(h.self.state.sunderHits).toBe(0);
    expect(h.count('TowerTargetHit')).toBe(4);
  });

  it('碎甲阈值来自 config（sunderHitsPerStack）', () => {
    expect(CFG.sunderHitsPerStack).toBe(4);
    const h = makeSelf('ballista');
    tick(ballistaBehavior, h, CFG.sunderHitsPerStack! * 2, STEP);
    // 两轮刚好都归零
    expect(h.self.state.sunderHits).toBe(0);
  });

  it('canFire=false 时不开火', () => {
    const h = makeSelf('ballista');
    tick(ballistaBehavior, h, 10, { ...STEP, canFire: false });
    expect(h.count('TowerTargetHit')).toBe(0);
  });

  it('不越权发 DebuffStackChanged（那是 Boss 的活）', () => {
    const h = makeSelf('ballista');
    tick(ballistaBehavior, h, 20, STEP);
    expect(h.count('TowerTargetHit')).toBeGreaterThan(0);
    expect(h.count('DebuffStackChanged')).toBe(0);
  });

  it('数值全部来自 config', () => {
    expect(ballistaBehavior.attr).toBe(CFG.attr);
    expect(ballistaBehavior.cost).toBe(CFG.cost);
    expect(ballistaBehavior.range).toBe(CFG.range);
    expect(ballistaBehavior.maxHp).toBe(CFG.hp);
  });
});
