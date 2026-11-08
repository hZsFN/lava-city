// src/flow/MatchTimeline.ts
// ============================================================================
// 4:30 时间轴状态机（T-M2-03）· B3 实现
// ----------------------------------------------------------------------------
// 职责：阶段推进 + 熔岩液面 + 塔心 HP + 一局结算。**只发事件，不碰塔/Boss/玩家**。
// 归属事件：MatchPhaseChanged / LavaLevelChanged / CoreHpChanged / MatchEnded
// 数值来源：config/flow.json（阶段、时长、塔心 HP）+ config/arena.json（熔岩、塔高）
// 硬规则：时间点全部从 flow.json 读，不硬编码；逻辑层不 import three。
// ============================================================================

import type { Bus, MatchPhase } from '../core/events';
import type { EndReason, FlowConfig, MatchResult, MatchTimeline, PhaseConfig } from './types';
import arenaJson from '../core/config/arena.json';

/** 一帧最多推进 0.1 s：票要求「每帧只允许跨越一个阶段边界」 */
const MAX_DT_SEC = 0.1;

/** 熔岩液面变化量阈值：>= 0.01 才广播，避免每帧刷屏 */
const LAVA_EMIT_EPS = 0.01;

/** arena.json 里与本模块相关的字段（宽松结构，缺失时回落到仓库内 arena.json） */
interface LavaOverrides {
  startY?: number;
  phase2RiseTo?: number;
  rageRisePerSec?: number;
  /** 熔岩吞没塔心的液面高度；arena.json 目前未定义，见 handoff 的配置申请 */
  swallowY?: number;
}

interface ArenaLike {
  tower?: { height?: number };
  lava?: LavaOverrides;
}

interface LavaCfg {
  startY: number;
  phase2RiseTo: number;
  rageRisePerSec: number;
  swallowY: number;
}

/**
 * 解析熔岩数值。全部来自 arena.json；`swallowY` 缺失时按设计口径回落为
 * 「4:30 整的液面高度」= phase2RiseTo + rageRisePerSec × rage 时长。
 * 这样默认配置下熔岩恰在 270 s 淹没塔心，与超时同帧 → 超时优先（见 handoff 说明）。
 */
function resolveLava(arenaCfg: unknown, flowCfg: FlowConfig): LavaCfg {
  const base = (arenaJson as unknown as ArenaLike).lava ?? {};
  const over = ((arenaCfg ?? {}) as ArenaLike).lava ?? {};

  const pick = (key: keyof LavaOverrides, fallback: number): number => {
    const v = over[key] ?? base[key];
    return typeof v === 'number' ? v : fallback;
  };

  const startY = pick('startY', 0);
  const phase2RiseTo = pick('phase2RiseTo', 0);
  const rageRisePerSec = pick('rageRisePerSec', 0);

  let swallowY = pick('swallowY', Number.NaN);
  if (!Number.isFinite(swallowY)) {
    const rage = flowCfg.phases.find((p) => p.phase === 'rage');
    swallowY = rage
      ? phase2RiseTo +
        rageRisePerSec * Math.max(0, Math.min(rage.endSec, flowCfg.matchLengthSec) - rage.startSec)
      : phase2RiseTo;
  }

  return { startY, phase2RiseTo, rageRisePerSec, swallowY };
}

export function createMatchTimeline(): MatchTimeline {
  let bus: Bus | null = null;
  let flowCfg: FlowConfig | null = null;
  let phases: PhaseConfig[] = [];
  let phaseIdx = 0;

  let t = 0;
  let coreHp = 0;
  let coreMaxHp = 0;

  let lava: LavaCfg = { startY: 0, phase2RiseTo: 0, rageRisePerSec: 0, swallowY: Number.POSITIVE_INFINITY };
  let lavaY = 0;
  let lastEmitY = Number.NaN;
  let lastEmitRate = Number.NaN;

  let ended: MatchResult | null = null;

  function emitPhase(phase: MatchPhase, atSec: number): void {
    bus?.emit('MatchPhaseChanged', { phase, tSec: atSec });
  }

  function emitCoreHp(): void {
    bus?.emit('CoreHpChanged', { hp: coreHp, maxHp: coreMaxHp });
  }

  /** 结算：一局只发一次 MatchEnded；之后所有 notify / apply 全部忽略 */
  function finish(result: 'win' | 'lose', reason: EndReason): void {
    if (ended || !bus) return;
    ended = { result, reason, tSec: t };

    // 提前结束（Boss 死/塔心爆/玩家耗尽）时补发一次 ended 阶段事件
    const endedIdx = phases.findIndex((p) => p.phase === 'ended');
    if (endedIdx >= 0 && phases[phaseIdx]?.phase !== 'ended') {
      phaseIdx = endedIdx;
      emitPhase('ended', t);
    }

    bus.emit('MatchEnded', { result, reason, tSec: t });
  }

  /** 按「当前阶段 + 阶段内进度」推进熔岩液面；变化够大才广播 */
  function updateLava(): void {
    const p = phases[phaseIdx];
    if (!p) return;

    const dur = Math.max(1e-9, p.endSec - p.startSec);
    let y = lavaY;
    let rate = 0;

    switch (p.phase) {
      case 'wake':
      case 'prep':
      case 'boss1':
        y = lava.startY;
        rate = 0;
        break;
      case 'transition': {
        const prog = Math.min(1, Math.max(0, (t - p.startSec) / dur));
        y = lava.startY + (lava.phase2RiseTo - lava.startY) * prog;
        rate = (lava.phase2RiseTo - lava.startY) / dur;
        break;
      }
      case 'boss2':
        y = lava.phase2RiseTo;
        rate = 0;
        break;
      case 'rage':
        y = lava.phase2RiseTo + lava.rageRisePerSec * Math.max(0, t - p.startSec);
        rate = lava.rageRisePerSec;
        break;
      default:
        break;
    }

    lavaY = y;

    const rateChanged = rate !== lastEmitRate;
    const movedEnough =
      !Number.isFinite(lastEmitY) || Math.abs(y - lastEmitY) >= LAVA_EMIT_EPS;
    if (rateChanged || movedEnough) {
      lastEmitY = y;
      lastEmitRate = rate;
      bus?.emit('LavaLevelChanged', { y, risePerSec: rate });
    }

    // 熔岩吞没塔心 → 判负。硬上限之前才判：270 s 同帧时超时优先（见 handoff）。
    const hardEnd = flowCfg?.matchLengthSec ?? Number.POSITIVE_INFINITY;
    if (y >= lava.swallowY && t < hardEnd) finish('lose', 'lava_swallowed');
  }

  function init(deps: { bus: Bus; flowCfg: FlowConfig; arenaCfg: unknown }): void {
    bus = deps.bus;
    flowCfg = deps.flowCfg;

    phases = [...flowCfg.phases].sort((a, b) => a.startSec - b.startSec);
    phaseIdx = 0;
    t = 0;
    ended = null;

    coreMaxHp = flowCfg.core.maxHp;
    coreHp = coreMaxHp;

    lava = resolveLava(deps.arenaCfg, flowCfg);
    lavaY = lava.startY;
    lastEmitY = Number.NaN;
    lastEmitRate = Number.NaN;

    emitCoreHp();
    if (phases.length > 0) emitPhase(phases[0].phase, 0);
    updateLava();
  }

  function update(dtSec: number): boolean {
    if (!bus || !flowCfg || ended) return false;

    const dt = Math.min(Math.max(dtSec, 0), MAX_DT_SEC);
    if (!(dt > 0)) return false;

    const cur = phases[phaseIdx];
    if (!cur) return false;

    const nextT = t + dt;
    const isLast = phaseIdx >= phases.length - 1;

    // 跨过当前阶段结束点 → 切下一阶段（一帧最多切一次，时间钳在边界上）
    if (!isLast && nextT >= cur.endSec) {
      t = cur.endSec;
      phaseIdx += 1;
      const np = phases[phaseIdx];

      emitPhase(np.phase, t);
      updateLava();
      if (ended) return true;

      if (np.phase === 'ended' || t >= flowCfg.matchLengthSec) {
        finish('lose', 'timeout');
      }
      return true;
    }

    t = nextT;
    updateLava();
    if (ended) return true;

    if (t >= flowCfg.matchLengthSec) {
      finish('lose', 'timeout');
      return true;
    }
    return false;
  }

  function phase(): MatchPhase {
    return phases[phaseIdx]?.phase ?? 'wake';
  }

  function tSec(): number {
    return t;
  }

  function endsAtSec(): number {
    if (ended || phase() === 'ended') return 0;
    return phases[phaseIdx]?.endSec ?? 0;
  }

  function result(): MatchResult | null {
    return ended ? { ...ended } : null;
  }

  function lavaHeight(): number {
    return lavaY;
  }

  function notifyBossDefeated(): void {
    finish('win', 'boss_defeated');
  }

  function notifyCoreDestroyed(): void {
    finish('lose', 'core_destroyed');
  }

  function notifyPlayerOutOfLives(): void {
    finish('lose', 'player_out_of_lives');
  }

  function applyCoreDamage(amount: number): void {
    if (ended || !bus) return;
    if (!(amount > 0)) return;

    coreHp = Math.max(0, coreHp - amount);
    emitCoreHp();
    if (coreHp <= 0) finish('lose', 'core_destroyed');
  }

  return {
    init,
    update,
    phase,
    tSec,
    endsAtSec,
    result,
    lavaY: lavaHeight,
    notifyBossDefeated,
    notifyCoreDestroyed,
    notifyPlayerOutOfLives,
    applyCoreDamage,
  };
}
