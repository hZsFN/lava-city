import { describe, expect, it } from 'vitest';
import { createRng } from '../../../../src/core/rng';
import { quakeBehavior } from '../../../../src/towers/kinds/quake';
import { makeCtx, makeSelf, tick, towersCfg } from './helpers';

const CFG = towersCfg.kinds.quake;
/** createRng(7) 首个抽样 ≈ 0.0117 < 0.5 → 第一次掷骰必中 */
const SEED_HIT = 7;
/** createRng(42) 首个抽样 ≈ 0.6011 > 0.5 → 第一次掷骰必不中 */
const SEED_MISS = 42;
const STEP = { dtSec: 0.5 };

describe('quake 震地锚塔', () => {
  it('Boss 在射程外：不触发打断请求', () => {
    const h = makeSelf('quake', { seed: SEED_HIT });
    tick(quakeBehavior, h, 20, { ...STEP, bossPos: [100, 0, 0], castingSkill: 'slam' });
    expect(h.count('TowerInterruptRequested')).toBe(0);
  });

  it('Boss 没施法：不触发打断请求', () => {
    const h = makeSelf('quake', { seed: SEED_HIT });
    tick(quakeBehavior, h, 20, { ...STEP, castingSkill: null });
    expect(h.count('TowerInterruptRequested')).toBe(0);
  });

  it('Boss 施法 + 固定种子 → 第一次掷骰命中并发出请求', () => {
    const h = makeSelf('quake', { seed: SEED_HIT });
    tick(quakeBehavior, h, 1, { ...STEP, castingSkill: 'slam' });

    const req = h.of('TowerInterruptRequested');
    expect(req).toHaveLength(1);
    expect(req[0]).toEqual({
      towerId: h.self.id,
      skill: 'slam',
      chance: CFG.interruptChance,
    });
  });

  it('掷骰不中（种子 42 首抽 0.6011）→ 不发请求', () => {
    // 先确认种子前提，避免测试随 rng 实现漂移而失去意义
    expect(createRng(SEED_MISS)()).toBeGreaterThan(CFG.interruptChance!);
    const h = makeSelf('quake', { seed: SEED_MISS });
    tick(quakeBehavior, h, 1, { ...STEP, castingSkill: 'slam' });
    expect(h.count('TowerInterruptRequested')).toBe(0);
  });

  it('冷却内只请求一次：连续多帧同一技能不重复发', () => {
    const h = makeSelf('quake', { seed: SEED_HIT });
    // 2.5s 间隔，推进 2.0s（4 × 0.5s）仍在一个装填周期内
    tick(quakeBehavior, h, 4, { ...STEP, castingSkill: 'slam' });
    expect(h.count('TowerInterruptRequested')).toBe(1);
  });

  it('过了 intervalSec 后再次掷骰（同一次施法可再请求一次）', () => {
    const h = makeSelf('quake', { seed: SEED_HIT });
    // 第 1 帧立刻掷骰并进入 2.5s 装填；之后每帧 0.5s，
    // 第 6 帧装填正好归零（只扣减、不再掷），第 7 帧才进入下一个周期
    tick(quakeBehavior, h, 7, { ...STEP, castingSkill: 'slam' });
    expect(h.count('TowerInterruptRequested')).toBe(2);
  });

  it('施法结束后装填重新开始：换技能立刻可掷骰', () => {
    const h = makeSelf('quake', { seed: SEED_HIT });
    tick(quakeBehavior, h, 1, { ...STEP, castingSkill: 'slam' });
    expect(h.count('TowerInterruptRequested')).toBe(1);

    // 施法结束（castingSkill 变 null）
    tick(quakeBehavior, h, 1, { ...STEP, castingSkill: null });

    // 新技能：冷却已经走掉 0.5s，还没到 2.5s，所以仍要等
    tick(quakeBehavior, h, 5, { ...STEP, castingSkill: 'stomp' });
    expect(h.count('TowerInterruptRequested')).toBe(2);
  });

  it('canFire=false 时不请求', () => {
    const h = makeSelf('quake', { seed: SEED_HIT });
    tick(quakeBehavior, h, 10, { ...STEP, canFire: false, castingSkill: 'slam' });
    expect(h.count('TowerInterruptRequested')).toBe(0);
  });

  it('不越权发 BossSkillInterrupted（那是 Boss 的活）', () => {
    const h = makeSelf('quake', { seed: SEED_HIT });
    tick(quakeBehavior, h, 40, { ...STEP, castingSkill: 'slam' });
    expect(h.count('TowerInterruptRequested')).toBeGreaterThan(0);
    expect(h.count('BossSkillInterrupted')).toBe(0);
  });

  it('数值全部来自 config', () => {
    expect(quakeBehavior.attr).toBe(CFG.attr);
    expect(quakeBehavior.cost).toBe(CFG.cost);
    expect(quakeBehavior.range).toBe(CFG.range);
    expect(quakeBehavior.maxHp).toBe(CFG.hp);
    expect(makeCtx({ castingSkill: 'x' }).boss.castingSkill).toBe('x');
  });
});
