import { describe, expect, it } from 'vitest';
import { createBus } from '../../../src/core/events';
import { createMatchTimeline } from '../../../src/flow/MatchTimeline';
import { createMatchRunner, FIXED_DT_SEC } from '../../../src/flow/MatchRunner';
import { createTelemetry } from '../../../src/telemetry/Telemetry';
import type { FlowConfig, TelemetryRecord } from '../../../src/flow/types';
import flowJson from '../../../src/core/config/flow.json';
import arenaJson from '../../../src/core/config/arena.json';

const flowCfg = flowJson as unknown as FlowConfig;

function newTimeline() {
  const bus = createBus();
  const timeline = createMatchTimeline();
  timeline.init({ bus, flowCfg, arenaCfg: arenaJson });
  return { bus, timeline };
}

const REQUIRED_KEYS: Array<keyof TelemetryRecord> = [
  'version',
  'seed',
  'result',
  'reason',
  'tSec',
  'phaseTimes',
  'executions',
  'executionTimes',
  'damageBySource',
  'towerBuildOrder',
  'deaths',
  'coreHpPct',
  'grade',
];

describe('telemetry/Telemetry · 字段完整性', () => {
  it('JSON 可 parse，字段齐全，version=1', () => {
    const { bus, timeline } = newTimeline();
    const t = createTelemetry(12345, { flowCfg, bus, timeline });

    for (let i = 0; i < 60 * 60; i += 1) timeline.update(FIXED_DT_SEC);
    timeline.notifyBossDefeated();
    // victory 15 s + escape 15 s 演出走完才结算
    for (let i = 0; i < 60 * 31; i += 1) timeline.update(FIXED_DT_SEC);

    const raw = t.toJson();
    const parsed = JSON.parse(raw) as TelemetryRecord;

    for (const key of REQUIRED_KEYS) {
      expect(parsed).toHaveProperty(key);
    }
    expect(parsed.version).toBe(1);
    expect(parsed.seed).toBe(12345);
    expect(parsed.result).toBe('win');
    expect(parsed.reason).toBe('boss_defeated');
    expect(typeof parsed.coreHpPct).toBe('number');
    expect(['S', 'A', 'B', 'C']).toContain(parsed.grade);
  });

  it('phaseTimes 累加 ≈ 总时长（270 s + 5 s 狂暴）', () => {
    const { bus, timeline } = newTimeline();
    const t = createTelemetry(1, { flowCfg, bus, timeline });

    for (let i = 0; i < 60 * 280 && !timeline.result(); i += 1) timeline.update(FIXED_DT_SEC);

    const rec = t.record();
    const sum = Object.values(rec.phaseTimes).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(flowCfg.matchLengthSec + flowCfg.rage.swallowAfterSec, 0);
    expect(rec.result).toBe('lose');
    expect(rec.reason).toBe('lava_swallowed');
  });

  it('各阶段时长与 flow.json 一致', () => {
    const { bus, timeline } = newTimeline();
    const t = createTelemetry(1, { flowCfg, bus, timeline });

    for (let i = 0; i < 60 * 280 && !timeline.result(); i += 1) timeline.update(FIXED_DT_SEC);

    const { phaseTimes } = t.record();
    const expected: Record<string, number> = {};
    for (const p of flowCfg.phases) {
      expected[p.phase] = (expected[p.phase] ?? 0) + (p.endSec - p.startSec);
    }
    for (const [phase, duration] of Object.entries(expected)) {
      expect(phaseTimes[phase]).toBeCloseTo(duration, 1);
    }
    expect(phaseTimes.rage).toBeCloseTo(flowCfg.rage.swallowAfterSec, 1);
  });

  it('击破与建塔事件被记录（含时刻）', () => {
    const { bus, timeline } = newTimeline();
    const t = createTelemetry(7, { flowCfg, bus, timeline });

    for (let i = 0; i < 60 * 50; i += 1) timeline.update(FIXED_DT_SEC);

    bus.emit('TowerPlaced', { towerId: 'tw1', kind: 'frost', slotId: 'M1', pos: [20, 0, 0] });
    bus.emit('ExecutionEnded', { part: 'core', damage: 120 });
    bus.emit('TowerTargetHit', { towerId: 'tw1', kind: 'frost', attr: 'arcane', amount: 30 });
    bus.emit('DamageDealt', { target: 'boss', amount: 50, attr: 'physical', isCrit: false });
    bus.emit('PlayerDied', { cause: 'lava', deaths: 1 });
    timeline.notifyBossDefeated();

    const rec = t.record();
    expect(rec.executions).toBe(1);
    expect(rec.executionTimes).toHaveLength(1);
    expect(rec.executionTimes[0]).toBeCloseTo(50, 0);
    expect(rec.towerBuildOrder).toEqual([
      { tSec: expect.closeTo(50, 0), kind: 'frost', slotId: 'M1' },
    ]);
    expect(rec.damageBySource).toEqual({ tower: 30, player: 50, execution: 120 });
    expect(rec.deaths).toBe(1);
  });

  it('coreHpPct 反映塔心剩余百分比', () => {
    const { bus, timeline } = newTimeline();
    const t = createTelemetry(1, { flowCfg, bus, timeline });

    for (let i = 0; i < 60 * 10; i += 1) timeline.update(FIXED_DT_SEC);
    timeline.applyCoreDamage(250);

    expect(t.record().coreHpPct).toBeCloseTo(75, 5);
  });

  it('手动采集方法可用（noteExecution / noteDamage / noteBuild / noteDeath）', () => {
    const t = createTelemetry(3, { flowCfg });
    t.noteBuild('rune', 'T1', 12);
    t.noteExecution(30, 200);
    t.noteDamage('tower', 40);
    t.noteDeath(2);

    const rec = t.record();
    expect(rec.executions).toBe(1);
    expect(rec.executionTimes).toEqual([30]);
    expect(rec.damageBySource).toEqual({ tower: 40, player: 0, execution: 200 });
    expect(rec.towerBuildOrder).toEqual([{ tSec: 12, kind: 'rune', slotId: 'T1' }]);
    expect(rec.deaths).toBe(2);
  });

  it('reset 清空状态', () => {
    const t = createTelemetry(9, { flowCfg });
    t.noteExecution(10, 5);
    t.noteBuild('frost', 'M1', 1);
    t.reset(42);

    const rec = t.record();
    expect(rec.seed).toBe(42);
    expect(rec.executions).toBe(0);
    expect(rec.towerBuildOrder).toEqual([]);
  });
});

describe('flow/MatchRunner · runToEnd', () => {
  it('纯 Node 跑完一局 < 2000 ms', () => {
    const { bus, timeline } = newTimeline();
    const runner = createMatchRunner({ bus, timeline, flowCfg, seed: 1 });

    const started = performance.now();
    const rec = runner.runToEnd(300);
    const cost = performance.now() - started;

    expect(rec.result).toBe('lose');
    expect(rec.reason).toBe('lava_swallowed');
    expect(cost).toBeLessThan(2000);
    // 供交付报告引用
    console.log(`[runToEnd] 实测耗时 ${cost.toFixed(1)} ms`);
  });

  it('Boss 在 100 s 被打死 → victory + escape 演出后结算 win', () => {
    const { bus, timeline } = newTimeline();
    let killed = false;
    const runner = createMatchRunner({
      bus,
      timeline,
      flowCfg,
      seed: 2,
      onTick: () => {
        // 用时间轴自己的 tSec：snapshot.tSec 只在阶段切换时回写，会滞后
        if (!killed && timeline.tSec() >= 100) {
          killed = true;
          timeline.notifyBossDefeated();
        }
      },
    });

    const rec = runner.runToEnd(300);
    expect(rec.result).toBe('win');
    expect(rec.reason).toBe('boss_defeated');
    expect(rec.tSec).toBeCloseTo(100 + flowCfg.victory.durationSec + flowCfg.victory.escapeDurationSec, 0);
    expect(rec.tSec).toBeLessThan(flowCfg.matchLengthSec);
  });

  it('maxSec 很小时按上限停下，不会死循环', () => {
    const { bus, timeline } = newTimeline();
    const runner = createMatchRunner({ bus, timeline, flowCfg, seed: 3 });

    const rec = runner.runToEnd(5);
    // 5 s 内不会结束 → 记录为未完成（lose）
    expect(rec.result).toBe('lose');
    expect(rec.tSec).toBeLessThanOrEqual(5);
  });

  it('同一 seed 两次跑出完全相同的结果（可回放）', () => {
    const run = (): TelemetryRecord => {
      const { bus, timeline } = newTimeline();
      return createMatchRunner({ bus, timeline, flowCfg, seed: 77 }).runToEnd(300);
    };
    expect(run()).toEqual(run());
  });
});
