import { describe, expect, it } from 'vitest';
import { createBus } from '../../../src/core/events';
import type { Events } from '../../../src/core/events';
import { createMatchTimeline } from '../../../src/flow/MatchTimeline';
import type { FlowConfig } from '../../../src/flow/types';
import flowJson from '../../../src/core/config/flow.json';
import arenaJson from '../../../src/core/config/arena.json';

const flowCfg = flowJson as unknown as FlowConfig;
const arenaCfg = arenaJson as unknown as unknown;

interface Harness {
  bus: ReturnType<typeof createBus>;
  timeline: ReturnType<typeof createMatchTimeline>;
  phases: Array<Events['MatchPhaseChanged']>;
  lava: Array<Events['LavaLevelChanged']>;
  ended: Array<Events['MatchEnded']>;
  core: Array<Events['CoreHpChanged']>;
  advanceTo(targetSec: number): void;
  advance(sec: number): void;
  stepFrames(n: number): void;
}

function harness(): Harness {
  const bus = createBus();
  const timeline = createMatchTimeline();

  const phases: Array<Events['MatchPhaseChanged']> = [];
  const lava: Array<Events['LavaLevelChanged']> = [];
  const ended: Array<Events['MatchEnded']> = [];
  const core: Array<Events['CoreHpChanged']> = [];

  bus.on('MatchPhaseChanged', (p) => phases.push({ ...p }));
  bus.on('LavaLevelChanged', (p) => lava.push({ ...p }));
  bus.on('MatchEnded', (p) => ended.push({ ...p }));
  bus.on('CoreHpChanged', (p) => core.push({ ...p }));

  timeline.init({ bus, flowCfg, arenaCfg });

  const stepFrames = (n: number): void => {
    for (let i = 0; i < n && !timeline.result(); i += 1) {
      timeline.update(1 / 60);
    }
  };

  const advanceTo = (targetSec: number): void => {
    let guard = 0;
    while (timeline.tSec() < targetSec && !timeline.result()) {
      timeline.update(1 / 60);
      if (++guard > 1_000_000) throw new Error('advanceTo 未收敛');
    }
  };

  const advance = (sec: number): void => {
    advanceTo(timeline.tSec() + sec);
  };

  return { bus, timeline, phases, lava, ended, core, advance, advanceTo, stepFrames };
}

describe('flow/MatchTimeline · 9 段演出时间轴', () => {
  it('固定阶段严格按 flow.json 推进：wake×2 → tutorial → prep → boss1 → transition → boss2', () => {
    const h = harness();
    h.advanceTo(269);

    expect(h.phases.map((p) => p.phase)).toEqual([
      'wake',
      'wake',
      'tutorial',
      'prep',
      'boss1',
      'transition',
      'boss2',
    ]);
    expect(h.phases).toHaveLength(7);
  });

  it('4:30 未击杀 → 进入 rage，5 s 后熔岩吞没塔心判负', () => {
    const h = harness();
    h.advanceTo(276);

    expect(h.timeline.phase()).toBe('ended');
    expect(h.phases.map((p) => p.phase)).toEqual([
      'wake',
      'wake',
      'tutorial',
      'prep',
      'boss1',
      'transition',
      'boss2',
      'rage',
      'ended',
    ]);
    expect(h.ended).toHaveLength(1);
    expect(h.ended[0]).toMatchObject({ result: 'lose', reason: 'lava_swallowed' });
    expect(h.ended[0].tSec).toBeCloseTo(flowCfg.matchLengthSec + flowCfg.rage.swallowAfterSec, 5);
  });

  it('每个阶段的 tSec 与 flow.json 的 startSec 一致（±1 帧）', () => {
    const h = harness();
    h.advanceTo(276);

    for (let i = 0; i < flowCfg.phases.length; i += 1) {
      const cfg = flowCfg.phases[i];
      const ev = h.phases[i];
      expect(ev.phase).toBe(cfg.phase);
      expect(Math.abs(ev.tSec - cfg.startSec)).toBeLessThanOrEqual(1 / 60 + 1e-9);
    }
  });

  it('endsAtSec() 在各段返回该段结束时刻，ended 时为 0', () => {
    const h = harness();

    expect(h.timeline.phase()).toBe('wake');
    expect(h.timeline.endsAtSec()).toBe(8);

    h.advanceTo(10);
    expect(h.timeline.phase()).toBe('wake');
    expect(h.timeline.endsAtSec()).toBe(16);

    h.advanceTo(20);
    expect(h.timeline.phase()).toBe('tutorial');
    expect(h.timeline.endsAtSec()).toBe(40);

    h.advanceTo(45);
    expect(h.timeline.phase()).toBe('prep');
    expect(h.timeline.endsAtSec()).toBe(50);

    h.advanceTo(60);
    expect(h.timeline.phase()).toBe('boss1');
    expect(h.timeline.endsAtSec()).toBe(140);

    h.advanceTo(145);
    expect(h.timeline.phase()).toBe('transition');
    expect(h.timeline.endsAtSec()).toBe(155);

    h.advanceTo(160);
    expect(h.timeline.phase()).toBe('boss2');
    expect(h.timeline.endsAtSec()).toBe(270);

    h.advanceTo(272);
    expect(h.timeline.phase()).toBe('rage');
    expect(h.timeline.endsAtSec()).toBe(275);

    h.advanceTo(276);
    expect(h.timeline.phase()).toBe('ended');
    expect(h.timeline.endsAtSec()).toBe(0);
  });

  it('update 返回本帧是否发生阶段切换（16 s 进入 tutorial）', () => {
    const h = harness();
    h.advanceTo(15.9);
    expect(h.timeline.phase()).toBe('wake');

    let switched = false;
    let guard = 0;
    while (!switched && guard < 30) {
      switched = h.timeline.update(1 / 60);
      guard += 1;
    }
    expect(switched).toBe(true);
    expect(h.timeline.phase()).toBe('tutorial');
  });

  it('init 时立即广播 wake 阶段与初始塔心 HP', () => {
    const h = harness();
    expect(h.phases[0]).toEqual({ phase: 'wake', tSec: 0 });
    expect(h.core[0]).toEqual({ hp: flowCfg.core.maxHp, maxHp: flowCfg.core.maxHp });
  });
});

describe('flow/MatchTimeline · 胜利 / 传送', () => {
  it('Boss 死亡 → victory 15 s → escape 15 s → win', () => {
    const h = harness();
    h.advanceTo(100);

    h.timeline.notifyBossDefeated();
    expect(h.timeline.phase()).toBe('victory');
    expect(h.timeline.endsAtSec()).toBeCloseTo(100 + flowCfg.victory.durationSec, 1);
    expect(h.ended).toHaveLength(0);

    h.advanceTo(116);
    expect(h.timeline.phase()).toBe('escape');
    expect(h.timeline.endsAtSec()).toBeCloseTo(115 + flowCfg.victory.escapeDurationSec, 1);

    h.advanceTo(131);
    expect(h.timeline.phase()).toBe('ended');
    expect(h.ended).toHaveLength(1);
    expect(h.ended[0]).toMatchObject({ result: 'win', reason: 'boss_defeated' });
    expect(h.ended[0].tSec).toBeCloseTo(130, 1);

    // 结算后重复 notify 被忽略
    h.timeline.notifyBossDefeated();
    expect(h.ended).toHaveLength(1);
  });

  it('Boss 尚未登场时 notifyBossDefeated 被忽略', () => {
    const h = harness();
    h.advanceTo(10);
    h.timeline.notifyBossDefeated();
    expect(h.timeline.result()).toBeNull();
    expect(h.timeline.phase()).toBe('wake');
  });

  it('结束后 update 不再推进时间', () => {
    const h = harness();
    h.advanceTo(100);
    h.timeline.notifyBossDefeated();
    for (let i = 0; i < 60 * 40 && !h.timeline.result(); i += 1) h.timeline.update(1 / 60);
    const frozen = h.timeline.tSec();

    for (let i = 0; i < 60; i += 1) h.timeline.update(1 / 60);
    expect(h.timeline.tSec()).toBe(frozen);
  });
});

describe('flow/MatchTimeline · 熔岩', () => {
  it('boss1 结束时 lavaY = arena.startY', () => {
    const h = harness();
    h.advanceTo(139);
    expect(h.timeline.phase()).toBe('boss1');
    expect(h.timeline.lavaY()).toBeCloseTo(arenaJson.lava.startY, 5);
  });

  it('transition 的 10–13 s 内上涨到 phase2RiseTo', () => {
    const h = harness();
    h.advanceTo(151);
    expect(h.timeline.phase()).toBe('transition');
    const mid = h.timeline.lavaY();
    expect(mid).toBeGreaterThan(arenaJson.lava.startY);
    expect(mid).toBeLessThan(arenaJson.lava.phase2RiseTo);

    h.advanceTo(153);
    expect(h.timeline.lavaY()).toBeCloseTo(arenaJson.lava.phase2RiseTo, 5);
  });

  it('boss2 保持 phase2RiseTo；rage 每秒 +1 m', () => {
    const h = harness();
    h.advanceTo(160);
    expect(h.timeline.phase()).toBe('boss2');
    expect(h.timeline.lavaY()).toBeCloseTo(arenaJson.lava.phase2RiseTo, 5);

    h.advanceTo(271);
    expect(h.timeline.phase()).toBe('rage');
    expect(h.timeline.lavaY()).toBeCloseTo(
      arenaJson.lava.phase2RiseTo + flowCfg.rage.risePerSec,
      1,
    );
  });

  it('LavaLevelChanged 不会每帧都发（变化量 < 0.01 时静默）', () => {
    const h = harness();
    h.advanceTo(120);
    expect(h.lava.length).toBeLessThan(10);
    for (const e of h.lava) expect(e.y).toBeCloseTo(arenaJson.lava.startY, 5);
  });
});

describe('flow/MatchTimeline · 结算', () => {
  it('notifyCoreDestroyed → lose/core_destroyed', () => {
    const h = harness();
    h.advanceTo(60);
    h.timeline.notifyCoreDestroyed();

    expect(h.ended).toHaveLength(1);
    expect(h.ended[0]).toMatchObject({ result: 'lose', reason: 'core_destroyed' });
  });

  it('notifyPlayerOutOfLives → lose/player_out_of_lives', () => {
    const h = harness();
    h.advanceTo(60);
    h.timeline.notifyPlayerOutOfLives();

    expect(h.ended[0]).toMatchObject({ result: 'lose', reason: 'player_out_of_lives' });
  });

  it('塔心归零 → lose/core_destroyed，且先广播 CoreHpChanged', () => {
    const h = harness();
    h.advanceTo(60);

    h.timeline.applyCoreDamage(flowCfg.core.maxHp);
    expect(h.ended[0]).toMatchObject({ result: 'lose', reason: 'core_destroyed' });
    expect(h.core[h.core.length - 1].hp).toBe(0);
  });

  it('塔心扣血但没归零 → 不结算，HP 正确下降', () => {
    const h = harness();
    h.advanceTo(60);

    h.timeline.applyCoreDamage(250);
    expect(h.timeline.result()).toBeNull();
    expect(h.core[h.core.length - 1]).toEqual({ hp: 750, maxHp: 1000 });
  });

  it('结束后 applyCoreDamage 被忽略', () => {
    const h = harness();
    h.advanceTo(60);
    h.timeline.notifyCoreDestroyed();
    const before = h.core.length;

    h.timeline.applyCoreDamage(500);
    expect(h.core.length).toBe(before);
  });
});

describe('flow/MatchTimeline · 阶段枚举完整性', () => {
  it('config 里 7 个固定段全部被覆盖（wake 出现两次）', () => {
    expect(flowCfg.phases.map((p) => p.phase)).toEqual([
      'wake',
      'wake',
      'tutorial',
      'prep',
      'boss1',
      'transition',
      'boss2',
    ]);
  });
});
