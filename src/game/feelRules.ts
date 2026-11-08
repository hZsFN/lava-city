import type { MatchPhase } from '../core/events';

/** 结算/通关演出期间不允许暂停：平台交接已经在走，停住只会卡在半截。 */
const UNPAUSABLE: ReadonlySet<MatchPhase> = new Set<MatchPhase>(['victory', 'escape', 'ended']);

export function canPause(phase: MatchPhase, over: boolean, failing: boolean): boolean {
  return !over && !failing && !UNPAUSABLE.has(phase);
}

/**
 * 指针锁丢失时是否自动暂停：只在「刚才确实锁着、现在不是俯视建塔、且可暂停」时触发。
 * 俯视建塔会主动 exitPointerLock，那是玩家意图，不能当成"离开"。
 */
export function shouldAutoPause(input: {
  hadLock: boolean;
  tactical: boolean;
  phase: MatchPhase;
  over: boolean;
  failing: boolean;
}): boolean {
  return input.hadLock && !input.tactical && canPause(input.phase, input.over, input.failing);
}

/** 飘字数值：≥10 取整，小数值保留一位（去掉多余的 .0），非正数不显示。 */
export function formatDamage(amount: number): string | null {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (amount >= 10) return String(Math.round(amount));
  const v = Math.round(amount * 10) / 10;
  return v <= 0 ? '0.1' : String(v);
}

/** 受击红闪强度：掉血越多越亮，钳在 [0.35, 1]。 */
export function hurtFlashStrength(amount: number, maxHp: number): number {
  if (!(maxHp > 0) || !(amount > 0)) return 0.35;
  return Math.min(1, Math.max(0.35, (amount / maxHp) * 4));
}
