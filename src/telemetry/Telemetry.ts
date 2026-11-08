// src/telemetry/Telemetry.ts
// ============================================================================
// 遥测收集（T-M2-03）· B3 实现
// ----------------------------------------------------------------------------
// 每局一份 JSON。数据来源分两路：
//   ① 订阅 Bus 事件（阶段/击破/建塔/死亡/伤害/结算）
//   ② 结算时从 MatchTimeline 取 result / tSec
// 字段口径见 src/flow/types.ts 的 TelemetryRecord；评分复用 Scoring.computeScore。
//
// 伤害来源归属（依据 events.ts 文末的归属规则）：
//   tower     ← TowerTargetHit.amount（塔只发这个，不发 DamageDealt）
//   execution ← ExecutionEnded.damage
//   player    ← DamageDealt{target:'boss'}.amount
// ============================================================================

import type { Bus, MatchPhase } from '../core/events';
import type { FlowConfig, MatchTimeline, Telemetry, TelemetryRecord } from '../flow/types';
import { computeScore } from '../flow/Scoring';
import flowJson from '../core/config/flow.json';

export interface TelemetryOptions {
  flowCfg?: FlowConfig;
  bus?: Bus;
  timeline?: MatchTimeline;
}

/** 遥测收集器：Telemetry 接口 + 供 Runner/测试喂数据的采集方法 */
export interface TelemetrySink extends Telemetry {
  /** 绑定总线与时间轴，自动订阅事件。重复绑定会先解绑旧的。 */
  bind(bus: Bus, timeline: MatchTimeline): void;
  /** 手动记一次击破（便于桩/测试在无 ExecutionEnded 时喂数据） */
  noteExecution(tSec?: number, damage?: number): void;
  /** 手动记一次伤害来源 */
  noteDamage(source: 'tower' | 'player' | 'execution', amount: number): void;
  /** 手动记一次死亡 */
  noteDeath(count?: number): void;
  /** 手动记一次建塔 */
  noteBuild(kind: string, slotId: string, tSec?: number): void;
  /** 清空重新开始（换局时用） */
  reset(seed?: number): void;
}

const EMPTY_DAMAGE = (): TelemetryRecord['damageBySource'] => ({ tower: 0, player: 0, execution: 0 });

export function createTelemetry(seed: number, opts: TelemetryOptions = {}): TelemetrySink {
  const flowCfg = (opts.flowCfg ?? (flowJson as unknown as FlowConfig));
  const defaultFlowCfg = flowCfg;

  let currentSeed = seed;
  let bus: Bus | null = null;
  let timeline: MatchTimeline | null = null;
  let unsubs: Array<() => void> = [];

  let phaseTimes: Record<string, number> = {};
  let lastPhase: MatchPhase | null = null;
  let lastPhaseStart = 0;
  let closed = false;

  let executions = 0;
  let executionTimes: number[] = [];
  let damageBySource = EMPTY_DAMAGE();
  let towerBuildOrder: TelemetryRecord['towerBuildOrder'] = [];
  let deaths = 0;
  let coreHp = 0;
  let coreMaxHp = 0;
  let endResult: TelemetryRecord['result'] | null = null;
  let endReason = '';
  let endTSec = 0;

  /** 当前时刻：优先时间轴，退化到阶段事件的 tSec */
  function now(): number {
    return timeline ? timeline.tSec() : lastPhaseStart;
  }

  function closePhase(atSec: number): void {
    if (closed || !lastPhase) return;
    const dur = Math.max(0, atSec - lastPhaseStart);
    phaseTimes[lastPhase] = (phaseTimes[lastPhase] ?? 0) + dur;
    lastPhaseStart = atSec;
  }

  function onPhase(phase: MatchPhase, atSec: number): void {
    closePhase(atSec);
    lastPhase = phase;
    lastPhaseStart = atSec;
    if (phaseTimes[phase] === undefined) phaseTimes[phase] = 0;
  }

  function onEnded(result: 'win' | 'lose', reason: string, tSec: number): void {
    if (endResult !== null) return;
    closePhase(tSec);
    closed = true;
    endResult = result;
    endReason = reason;
    endTSec = tSec;
  }

  function unsubscribe(): void {
    for (const off of unsubs) off();
    unsubs = [];
  }

  function bind(nextBus: Bus, nextTimeline: MatchTimeline): void {
    unsubscribe();
    bus = nextBus;
    timeline = nextTimeline;

    // 时间轴的 init() 会在订阅前就发出首段 MatchPhaseChanged，
    // 所以这里补一次当前阶段作为起点（一局从 0 s 开始计时）。
    if (lastPhase === null) {
      lastPhase = timeline.phase();
      lastPhaseStart = 0;
      if (phaseTimes[lastPhase] === undefined) phaseTimes[lastPhase] = 0;
    }

    unsubs.push(
      bus.on('MatchPhaseChanged', (p) => onPhase(p.phase, p.tSec)),
      bus.on('MatchEnded', (p) => onEnded(p.result, p.reason, p.tSec)),
      bus.on('CoreHpChanged', (p) => {
        coreHp = p.hp;
        coreMaxHp = p.maxHp;
      }),
      bus.on('ExecutionEnded', (p) => {
        executions += 1;
        executionTimes.push(now());
        damageBySource.execution += p.damage;
      }),
      bus.on('TowerTargetHit', (p) => {
        damageBySource.tower += p.amount;
      }),
      bus.on('DamageDealt', (p) => {
        if (p.target === 'boss') damageBySource.player += p.amount;
      }),
      bus.on('PlayerDied', (p) => {
        deaths = Math.max(deaths, p.deaths);
      }),
      bus.on('TowerPlaced', (p) => {
        towerBuildOrder.push({ tSec: now(), kind: p.kind, slotId: p.slotId });
      }),
    );
  }

  function noteExecution(atSec?: number, damage = 0): void {
    executions += 1;
    executionTimes.push(atSec ?? now());
    damageBySource.execution += damage;
  }

  function noteDamage(source: 'tower' | 'player' | 'execution', amount: number): void {
    if (!(amount > 0)) return;
    damageBySource[source] += amount;
  }

  function noteDeath(count?: number): void {
    deaths = Math.max(deaths, count ?? deaths + 1);
  }

  function noteBuild(kind: string, slotId: string, atSec?: number): void {
    towerBuildOrder.push({ tSec: atSec ?? now(), kind, slotId });
  }

  function reset(nextSeed?: number): void {
    unsubscribe();
    bus = null;
    timeline = null;
    if (typeof nextSeed === 'number') currentSeed = nextSeed;
    phaseTimes = {};
    lastPhase = null;
    lastPhaseStart = 0;
    closed = false;
    executions = 0;
    executionTimes = [];
    damageBySource = EMPTY_DAMAGE();
    towerBuildOrder = [];
    deaths = 0;
    coreHp = 0;
    coreMaxHp = 0;
    endResult = null;
    endReason = '';
    endTSec = 0;
  }

  function record(): TelemetryRecord {
    // 结算：优先事件里的结果，退化到时间轴；都没结束则视为未完成
    const r = timeline?.result() ?? null;
    const result: TelemetryRecord['result'] = endResult ?? r?.result ?? 'lose';
    const reason = endReason || r?.reason || 'incomplete';
    const tSec = endResult !== null ? endTSec : (r?.tSec ?? timeline?.tSec() ?? now());

    // 若还没收到 MatchEnded，把当前阶段结算进去（便于中途取快照）
    if (!closed) closePhase(tSec);

    const maxHp = coreMaxHp > 0 ? coreMaxHp : defaultFlowCfg.core.maxHp;
    const coreHpPct = maxHp > 0 ? Math.max(0, Math.min(100, (coreHp / maxHp) * 100)) : 0;

    const { grade } = computeScore(
      { tSec, executions, coreHpPct, deaths, won: result === 'win' },
      defaultFlowCfg,
    );

    return {
      version: 1,
      seed: currentSeed,
      result,
      reason,
      tSec,
      phaseTimes: { ...phaseTimes },
      executions,
      executionTimes: [...executionTimes],
      damageBySource: { ...damageBySource },
      towerBuildOrder: towerBuildOrder.map((b) => ({ ...b })),
      deaths,
      coreHpPct,
      grade,
    };
  }

  function toJson(): string {
    return JSON.stringify(record());
  }

  if (opts.bus && opts.timeline) bind(opts.bus, opts.timeline);

  return { bind, noteExecution, noteDamage, noteDeath, noteBuild, reset, record, toJson };
}
