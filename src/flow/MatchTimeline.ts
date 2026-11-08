// src/flow/MatchTimeline.ts
// ============================================================================
// 一局 4:30 时间轴状态机（M4-01 演出版）
// ----------------------------------------------------------------------------
// 9 段：wake(dark) → wake(blur) → tutorial → prep → boss1 → transition
//       → boss2 →（Boss 死亡）victory → escape → 结算
// 兜底：4:30 仍未击杀 → rage（熔岩每秒 +1 m，5 s 内吞没塔心）→ 失败。
//
// 职责：阶段推进 + 熔岩液面 + 塔心 HP + 一局结算。**只发事件，不碰塔/Boss/玩家**。
// 数值来源：config/flow.json（阶段/时长/演出节拍）+ config/arena.json（熔岩/塔高）
// 硬规则：时间点全部从 flow.json 读，不硬编码；逻辑层不 import three。
// ============================================================================

import type { Bus, MatchPhase } from '../core/events';
import type { EndReason, FlowConfig, MatchResult, MatchTimeline, PhaseConfig } from './types';
import arenaJson from '../core/config/arena.json';

/** 一帧最多推进 0.1 s：票要求「每帧只允许跨越一个阶段边界」 */
const MAX_DT_SEC = 0.1;

/** 熔岩液面变化量阈值：>= 0.01 才广播，避免每帧刷屏 */
const LAVA_EMIT_EPS = 0.01;

interface LavaOverrides {
  startY?: number;
  phase2RiseTo?: number;
}

interface ArenaLike {
  lava?: LavaOverrides;
}

interface LavaCfg {
  startY: number;
  phase2RiseTo: number;
}

function resolveLava(arenaCfg: unknown): LavaCfg {
  const base = (arenaJson as unknown as ArenaLike).lava ?? {};
  const over = ((arenaCfg ?? {}) as ArenaLike).lava ?? {};
  const pick = (key: keyof LavaOverrides, fallback: number): number => {
    const v = over[key] ?? base[key];
    return typeof v === 'number' ? v : fallback;
  };
  return {
    startY: pick('startY', 0),
    phase2RiseTo: pick('phase2RiseTo', 0),
  };
}

type TimelineMode = 'script' | 'victory' | 'escape' | 'rage';

export function createMatchTimeline(): MatchTimeline {
  let bus: Bus | null = null;
  let flowCfg: FlowConfig | null = null;
  let phases: PhaseConfig[] = [];
  let phaseIdx = 0;

  let t = 0;
  let mode: TimelineMode = 'script';
  let coreHp = 0;
  let coreMaxHp = 0;

  let lava: LavaCfg = { startY: 0, phase2RiseTo: 0 };
  let lavaY = 0;
  let lastEmitY = Number.NaN;
  let lastEmitRate = Number.NaN;

  /** victory / escape / rage 的起始时刻（真实秒） */
  let victoryAt = -1;
  let escapeAt = -1;
  let rageAt = -1;

  let ended: MatchResult | null = null;

  function emitPhase(phase: MatchPhase, atSec: number): void {
    bus?.emit('MatchPhaseChanged', { phase, tSec: atSec });
  }

  function emitCoreHp(): void {
    bus?.emit('CoreHpChanged', { hp: coreHp, maxHp: coreMaxHp });
  }

  function currentPhase(): MatchPhase {
    if (ended) return 'ended';
    if (mode === 'victory') return 'victory';
    if (mode === 'escape') return 'escape';
    if (mode === 'rage') return 'rage';
    return phases[phaseIdx]?.phase ?? 'wake';
  }

  /** 结算：一局只发一次 MatchEnded；之后所有 notify / update 全部忽略 */
  function finish(result: 'win' | 'lose', reason: EndReason): void {
    if (ended || !bus) return;
    const prevPhase = currentPhase();
    ended = { result, reason, tSec: t };
    if (prevPhase !== 'ended') emitPhase('ended', t);
    bus.emit('MatchEnded', { result, reason, tSec: t });
  }

  /** 按「当前模式 + 当前时刻」推进熔岩液面；变化够大才广播 */
  function updateLava(): void {
    if (!flowCfg) return;

    let y = lavaY;
    let rate = 0;

    if (mode === 'rage') {
      y = lava.phase2RiseTo + flowCfg.rage.risePerSec * Math.max(0, t - rageAt);
      rate = flowCfg.rage.risePerSec;
    } else if (mode === 'victory' || mode === 'escape') {
      y = lava.phase2RiseTo;
    } else {
      const p = phases[phaseIdx];
      switch (p?.phase) {
        case 'transition': {
          const riseStart = p.startSec + flowCfg.transition.lavaRiseStartSec;
          const riseEnd = p.startSec + flowCfg.transition.lavaRiseEndSec;
          const k = Math.min(1, Math.max(0, (t - riseStart) / Math.max(1e-9, riseEnd - riseStart)));
          y = lava.startY + (lava.phase2RiseTo - lava.startY) * k;
          rate = k > 0 && k < 1
            ? (lava.phase2RiseTo - lava.startY) / Math.max(1e-9, riseEnd - riseStart)
            : 0;
          break;
        }
        case 'boss2':
          y = lava.phase2RiseTo;
          break;
        default:
          y = lava.startY;
          break;
      }
    }

    lavaY = y;

    const rateChanged = rate !== lastEmitRate;
    const movedEnough = !Number.isFinite(lastEmitY) || Math.abs(y - lastEmitY) >= LAVA_EMIT_EPS;
    if (rateChanged || movedEnough) {
      lastEmitY = y;
      lastEmitRate = rate;
      bus?.emit('LavaLevelChanged', { y, risePerSec: rate });
    }
  }

  function init(deps: { bus: Bus; flowCfg: FlowConfig; arenaCfg: unknown }): void {
    bus = deps.bus;
    flowCfg = deps.flowCfg;

    phases = [...flowCfg.phases].sort((a, b) => a.startSec - b.startSec);
    phaseIdx = 0;
    t = 0;
    mode = 'script';
    victoryAt = -1;
    escapeAt = -1;
    rageAt = -1;
    ended = null;

    coreMaxHp = flowCfg.core.maxHp;
    coreHp = coreMaxHp;

    lava = resolveLava(deps.arenaCfg);
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

    const nextT = t + dt;

    // ── 胜利演出：victory → escape → 结算 ──────────────────────────────────
    if (mode === 'victory') {
      t = nextT;
      if (t >= victoryAt + flowCfg.victory.durationSec) {
        t = victoryAt + flowCfg.victory.durationSec;
        mode = 'escape';
        escapeAt = t;
        emitPhase('escape', t);
        updateLava();
        return true;
      }
      return false;
    }

    if (mode === 'escape') {
      t = nextT;
      if (t >= escapeAt + flowCfg.victory.escapeDurationSec) {
        t = escapeAt + flowCfg.victory.escapeDurationSec;
        finish('win', 'boss_defeated');
        return true;
      }
      return false;
    }

    // ── 狂暴：熔岩上涨，倒计时结束即失败 ──────────────────────────────────
    if (mode === 'rage') {
      t = nextT;
      updateLava();
      if (t >= rageAt + flowCfg.rage.swallowAfterSec) {
        t = rageAt + flowCfg.rage.swallowAfterSec;
        finish('lose', 'lava_swallowed');
        return true;
      }
      return false;
    }

    // ── 脚本阶段 ──────────────────────────────────────────────────────────
    const cur = phases[phaseIdx];
    if (!cur) return false;

    if (nextT >= cur.endSec) {
      t = cur.endSec;

      if (cur.phase === 'boss2') {
        // 4:30 未击杀 → 狂暴（Boss 进 rage、熔岩上涨由本状态机驱动）
        mode = 'rage';
        rageAt = t;
        emitPhase('rage', t);
        updateLava();
        return true;
      }

      phaseIdx += 1;
      const np = phases[phaseIdx];
      if (np) {
        emitPhase(np.phase, t);
        updateLava();
      }
      return true;
    }

    t = nextT;
    updateLava();
    return false;
  }

  function phase(): MatchPhase {
    return currentPhase();
  }

  function tSec(): number {
    return t;
  }

  function endsAtSec(): number {
    if (ended || mode === 'script' && !phases[phaseIdx]) return 0;
    if (mode === 'victory' && flowCfg) return victoryAt + flowCfg.victory.durationSec;
    if (mode === 'escape' && flowCfg) return escapeAt + flowCfg.victory.escapeDurationSec;
    if (mode === 'rage' && flowCfg) return rageAt + flowCfg.rage.swallowAfterSec;
    return phases[phaseIdx]?.endSec ?? 0;
  }

  function result(): MatchResult | null {
    return ended ? { ...ended } : null;
  }

  function lavaHeight(): number {
    return lavaY;
  }

  /** Boss 死亡 → 进入 victory；演出结束后由 escape 自动结算 */
  /** 阶段 I 血量打空 → 立刻进转阶段演出（按血量触发，不等时间轴到 140 秒） */
  function jumpToTransition(): void {
    if (ended || !flowCfg || mode !== 'script') return;
    const cur = currentPhase();
    if (cur !== 'boss1') return;
    const idx = phases.findIndex((p) => p.phase === 'transition');
    if (idx < 0) return;
    t = phases[idx]!.startSec;
    phaseIdx = idx;
    emitPhase('transition', t);
    updateLava();
  }

  /** 跳过开场：直接把时间推到 boss1 起点，Boss 立刻登场 */
  function jumpToBoss1(): void {
    if (ended || !flowCfg || mode !== 'script') return;
    const cur = currentPhase();
    if (cur === 'boss1' || cur === 'transition' || cur === 'boss2' || cur === 'rage') return;
    const idx = phases.findIndex((p) => p.phase === 'boss1');
    if (idx < 0) return;
    t = phases[idx]!.startSec;
    phaseIdx = idx;
    emitPhase('boss1', t);
    updateLava();
  }

  function notifyBossDefeated(): void {
    if (ended || !flowCfg || mode !== 'script') return;
    const p = currentPhase();
    if (p !== 'boss1' && p !== 'boss2') return;

    mode = 'victory';
    victoryAt = t;
    emitPhase('victory', t);
    updateLava();
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
    jumpToTransition,
    jumpToBoss1,
    notifyCoreDestroyed,
    notifyPlayerOutOfLives,
    applyCoreDamage,
  };
}
