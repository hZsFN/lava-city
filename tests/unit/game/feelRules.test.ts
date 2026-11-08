import { describe, expect, it } from 'vitest';
import { canPause, formatDamage, hurtFlashStrength, shouldAutoPause, skillTell } from '../../../src/game/feelRules';

describe('skillTell', () => {
  it('六个技能都有预警文案', () => {
    for (const s of ['rockSweep', 'leapSlam', 'coreDrain', 'stonePillars', 'magmaBreath', 'lavaCharge']) {
      expect(skillTell(s)?.name).toBeTruthy();
    }
  });
  it('未知技能返回 null', () => expect(skillTell('nope')).toBeNull());
});

describe('canPause', () => {
  it('战斗与开场阶段可暂停', () => {
    for (const p of ['wake', 'tutorial', 'prep', 'boss1', 'transition', 'boss2', 'rage'] as const) {
      expect(canPause(p, false, false)).toBe(true);
    }
  });
  it('结算/演出/失败中不可暂停', () => {
    expect(canPause('victory', false, false)).toBe(false);
    expect(canPause('escape', false, false)).toBe(false);
    expect(canPause('ended', false, false)).toBe(false);
    expect(canPause('boss1', true, false)).toBe(false);
    expect(canPause('boss1', false, true)).toBe(false);
  });
});

describe('shouldAutoPause', () => {
  const base = { hadLock: true, tactical: false, phase: 'boss1' as const, over: false, failing: false };
  it('战斗中丢失指针锁 → 暂停', () => expect(shouldAutoPause(base)).toBe(true));
  it('从没锁过不暂停', () => expect(shouldAutoPause({ ...base, hadLock: false })).toBe(false));
  it('俯视建塔主动解锁不暂停', () => expect(shouldAutoPause({ ...base, tactical: true })).toBe(false));
  it('结算中不暂停', () => expect(shouldAutoPause({ ...base, phase: 'ended' })).toBe(false));
});

describe('formatDamage', () => {
  it('非正数/非法值不显示', () => {
    expect(formatDamage(0)).toBeNull();
    expect(formatDamage(-3)).toBeNull();
    expect(formatDamage(Number.NaN)).toBeNull();
  });
  it('大数取整、小数保留一位', () => {
    expect(formatDamage(123.6)).toBe('124');
    expect(formatDamage(3)).toBe('3');
    expect(formatDamage(2.46)).toBe('2.5');
    expect(formatDamage(0.01)).toBe('0.1');
  });
});

describe('hurtFlashStrength', () => {
  it('钳在 [0.35, 1]', () => {
    expect(hurtFlashStrength(0.1, 10)).toBe(0.35);
    expect(hurtFlashStrength(5, 10)).toBe(1);
    expect(hurtFlashStrength(1, 0)).toBe(0.35);
  });
});
