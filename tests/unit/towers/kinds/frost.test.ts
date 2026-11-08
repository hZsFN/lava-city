import { describe, expect, it } from 'vitest';
import { frostBehavior } from '../../../../src/towers/kinds/frost';
import { makeCtx, makeSelf, tick, towersCfg } from './helpers';

const FREEZE = towersCfg.freeze;

/** dt 取 1.0 = 寒晶攻击间隔，方便一帧一次累积 */
const STEP = { dtSec: 1.0 };

describe('frost 寒晶塔', () => {
  it('射程外不累积冻结值，也不发进度事件', () => {
    const h = makeSelf('frost');
    tick(frostBehavior, h, 5, { ...STEP, bossPos: [100, 0, 0] });
    expect(h.self.state.freezeValue).toBe(0);
    expect(h.count('FreezeProgressChanged')).toBe(0);
    expect(h.count('FreezeFull')).toBe(0);
  });

  it('射程内每次 +perHit，并逐次发 FreezeProgressChanged{value,max}', () => {
    const h = makeSelf('frost');
    tick(frostBehavior, h, 3, STEP);
    const progress = h.of('FreezeProgressChanged');
    expect(progress.map((p) => p.value)).toEqual([
      FREEZE.perHit,
      FREEZE.perHit * 2,
      FREEZE.perHit * 3,
    ]);
    expect(progress.every((p) => p.max === FREEZE.max)).toBe(true);
    expect(h.self.state.freezeValue).toBe(FREEZE.perHit * 3);
  });

  it('累积到 max 发 FreezeFull，随后冻结值归零', () => {
    const h = makeSelf('frost');
    const ticksNeeded = Math.ceil(FREEZE.max / FREEZE.perHit);
    tick(frostBehavior, h, ticksNeeded, STEP);

    const full = h.of('FreezeFull');
    expect(full).toHaveLength(1);
    expect(full[0].durationMs).toBe(Math.round(FREEZE.stunSec * 1000));
    expect(h.self.state.freezeValue).toBe(0);
    // 满值那一次仍然先发一条 value === max 的进度
    const progress = h.of('FreezeProgressChanged');
    expect(progress[progress.length - 1].value).toBe(FREEZE.max);
  });

  it('停火 1 秒按 decayPerSec 衰减：累积 24 后剩 18', () => {
    const h = makeSelf('frost');
    tick(frostBehavior, h, 3, STEP);
    expect(h.self.state.freezeValue).toBe(24);

    // Boss 离开射程 1 秒
    tick(frostBehavior, h, 1, { ...STEP, bossPos: [100, 0, 0] });
    expect(h.self.state.freezeValue).toBeCloseTo(24 - FREEZE.decayPerSec, 6);
  });

  it('衰减不会低于 0', () => {
    const h = makeSelf('frost');
    tick(frostBehavior, h, 3, { ...STEP, bossPos: [100, 0, 0] });
    expect(h.self.state.freezeValue).toBe(0);
  });

  it('canFire=false 时不开火，只衰减', () => {
    const h = makeSelf('frost');
    tick(frostBehavior, h, 3, { ...STEP, canFire: false });
    expect(h.count('FreezeProgressChanged')).toBe(0);
    expect(h.self.state.freezeValue).toBe(0);
  });

  it('onPlaced 清零冻结值与冷却', () => {
    const h = makeSelf('frost', { state: { freezeValue: 77 } });
    h.self.cooldownSec = 3;
    frostBehavior.onPlaced!(h.self);
    expect(h.self.state.freezeValue).toBe(0);
    expect(h.self.cooldownSec).toBe(0);
  });

  it('不越权发 Boss 的事件', () => {
    const h = makeSelf('frost');
    tick(frostBehavior, h, 20, STEP);
    expect(h.count('DebuffStackChanged')).toBe(0);
    expect(h.count('BossSkillInterrupted')).toBe(0);
  });

  it('数值全部来自 config', () => {
    const cfg = towersCfg.kinds.frost;
    expect(frostBehavior.attr).toBe(cfg.attr);
    expect(frostBehavior.cost).toBe(cfg.cost);
    expect(frostBehavior.range).toBe(cfg.range);
    expect(frostBehavior.maxHp).toBe(cfg.hp);
  });

  it('冷却按 intervalSec 生效：一帧 dt 过小不会连发', () => {
    const h = makeSelf('frost');
    // 0.1s × 10 帧 = 1.0s，正好一个间隔 → 只应累积一次
    tick(frostBehavior, h, 10, { dtSec: 0.1 });
    expect(h.count('FreezeProgressChanged')).toBe(1);
  });

  it('makeCtx 默认可开火（脚手架自检）', () => {
    expect(makeCtx().canFire).toBe(true);
    expect(makeCtx().boss.castingSkill).toBeNull();
  });
});
