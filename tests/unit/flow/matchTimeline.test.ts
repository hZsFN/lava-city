import { describe, expect, it } from 'vitest';
import { createBus } from '../../../src/core/events';
import type { Events, MatchPhase } from '../../../src/core/events';
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
  /** 以固定步长推进到 targetSec */
  advanceTo(targetSec: number): void;
  advance(sec: number): void;
  /** 精确推进 n 帧（边界测试用） */
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

  // 用「帧数」而不是秒数累加来推进：帧号是整数，边界判定完全确定。
  // 时间轴跨边界时会把 t 钳在边界上，所以 advanceTo(130) 后 t 恰好 = 130。
  let frames = 0;

  const stepFrames = (n: number): void => {
    for (let i = 0; i < n && !timeline.result(); i += 1) {
      timeline.update(1 / 60);
      frames += 1;
    }
  };

  /** 推进到 tSec >= targetSec（跨过边界时会被钳在边界上） */
  const advanceTo = (targetSec: number): void => {
    let guard = 0;
    while (timeline.tSec() < targetSec && !timeline.result()) {
      timeline.update(1 / 60);
      frames += 1;
      if (++guard > 1_000_000) throw new Error('advanceTo 未收敛');
    }
  };

  const advance = (sec: number): void => {
    advanceTo(timeline.tSec() + sec);
  };

  return { bus, timeline, phases, lava, ended, core, advance, advanceTo, stepFrames };
}

describe('flow/MatchTimeline · 阶段推进', () => {
  it('7 段阶段严格按 flow.json 推进，顺序与次数正确', () => {
    const h = harness();
    h.advanceTo(flowCfg.matchLengthSec + 1);

    expect(h.phases.map((p) => p.phase)).toEqual([
      'wake',
      'prep',
      'boss1',
      'transition',
      'boss2',
      'rage',
      'ended',
    ]);
    // 每段切换只发一次，不重复
    expect(h.phases).toHaveLength(7);
  });

  it('每个阶段的 tSec 与 flow.json 的 startSec 一致（±1 帧）', () => {
    const h = harness();
    h.advanceTo(flowCfg.matchLengthSec + 1);

    for (let i = 0; i < flowCfg.phases.length; i += 1) {
      const cfg = flowCfg.phases[i];
      const ev = h.phases[i];
      expect(ev.phase).toBe(cfg.phase);
      expect(Math.abs(ev.tSec - cfg.startSec)).toBeLessThanOrEqual(1 / 60 + 1e-9);
    }
  });

  it('update(1/60) 调用 60 次后 tSec ≈ 1.0（误差 < 1e-6）', () => {
    const h = harness();
    for (let i = 0; i < 60; i += 1) h.timeline.update(1 / 60);
    expect(Math.abs(h.timeline.tSec() - 1)).toBeLessThan(1e-6);
  });

  it('endsAtSec() 在各阶段返回该阶段结束时刻，ended 时为 0', () => {
    const h = harness();

    expect(h.timeline.phase()).toBe('wake');
    expect(h.timeline.endsAtSec()).toBe(20);

    h.advanceTo(25);
    expect(h.timeline.phase()).toBe('prep');
    expect(h.timeline.endsAtSec()).toBe(40);

    h.advanceTo(150);
    expect(h.timeline.phase()).toBe('boss2');
    expect(h.timeline.endsAtSec()).toBe(245);

    h.advanceTo(flowCfg.matchLengthSec + 1);
    expect(h.timeline.phase()).toBe('ended');
    expect(h.timeline.endsAtSec()).toBe(0);
  });

  it('update 返回本帧是否发生阶段切换', () => {
    const h = harness();
    // 1199 帧 ≈ 19.983 s：尚未到 20 s，不应切换
    h.stepFrames(1199);
    expect(h.timeline.phase()).toBe('wake');

    // 第 1200 帧跨过 20 s：应切换
    const switched = h.timeline.update(1 / 60);
    expect(switched).toBe(true);
    expect(h.timeline.phase()).toBe('prep');
  });

  it('init 时立即广播 wake 阶段与初始塔心 HP', () => {
    const h = harness();
    expect(h.phases[0]).toEqual({ phase: 'wake', tSec: 0 });
    expect(h.core[0]).toEqual({ hp: flowCfg.core.maxHp, maxHp: flowCfg.core.maxHp });
  });
});

describe('flow/MatchTimeline · 熔岩', () => {
  it('boss1 结束时 lavaY ≈ -1.8（arena.startY）', () => {
    const h = harness();
    h.advanceTo(130);
    expect(h.timeline.phase()).toBe('transition');
    expect(h.timeline.lavaY()).toBeCloseTo(arenaJson.lava.startY, 5);
  });

  it('transition 结束时 lavaY ≈ -0.8（arena.phase2RiseTo）', () => {
    const h = harness();
    h.advanceTo(145);
    expect(h.timeline.phase()).toBe('boss2');
    expect(h.timeline.lavaY()).toBeCloseTo(arenaJson.lava.phase2RiseTo, 5);
  });

  it('rage 跑 10 s 后涨了 ≈ 12（1.2/s）', () => {
    const h = harness();
    h.advanceTo(245);
    expect(h.timeline.phase()).toBe('rage');
    const before = h.timeline.lavaY();

    h.advanceTo(255);
    const gained = h.timeline.lavaY() - before;
    expect(gained).toBeCloseTo(arenaJson.lava.rageRisePerSec * 10, 1);
  });

  it('LavaLevelChanged 不会每帧都发（变化量 < 0.01 时静默）', () => {
    const h = harness();
    h.advanceTo(120); // 全程 120 s，7200 帧
    // 前 120 s 液面恒定在 startY，只有 init + 进入阶段的少量事件
    expect(h.lava.length).toBeLessThan(10);
    for (const e of h.lava) expect(e.y).toBeCloseTo(arenaJson.lava.startY, 5);
  });

  it('进入 rage 时广播 risePerSec = 1.2', () => {
    const h = harness();
    h.advanceTo(246);
    const last = h.lava[h.lava.length - 1];
    expect(last.risePerSec).toBeCloseTo(arenaJson.lava.rageRisePerSec, 5);
  });
});

describe('flow/MatchTimeline · 结算', () => {
  it('notifyBossDefeated → win/boss_defeated，MatchEnded 只发一次', () => {
    const h = harness();
    h.advanceTo(100);

    h.timeline.notifyBossDefeated();
    expect(h.ended).toHaveLength(1);
    expect(h.ended[0]).toMatchObject({ result: 'win', reason: 'boss_defeated' });
    expect(h.timeline.result()?.result).toBe('win');

    // 之后再调任何 notify 都忽略
    h.timeline.notifyBossDefeated();
    h.timeline.notifyCoreDestroyed();
    h.timeline.notifyPlayerOutOfLives();
    expect(h.ended).toHaveLength(1);
  });

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

  it('跑到 270 s 无胜 → lose/timeout', () => {
    const h = harness();
    h.advanceTo(flowCfg.matchLengthSec + 1);

    expect(h.ended).toHaveLength(1);
    expect(h.ended[0]).toMatchObject({ result: 'lose', reason: 'timeout' });
    expect(h.timeline.result()?.tSec).toBeCloseTo(flowCfg.matchLengthSec, 5);
  });

  it('塔心归零 → lose/core_destroyed，且先广播 CoreHpChanged', () => {
    const h = harness();
    h.advanceTo(50);

    h.timeline.applyCoreDamage(flowCfg.core.maxHp);
    expect(h.ended[0]).toMatchObject({ result: 'lose', reason: 'core_destroyed' });
    expect(h.core[h.core.length - 1].hp).toBe(0);
  });

  it('塔心扣血但没归零 → 不结算，HP 正确下降', () => {
    const h = harness();
    h.advanceTo(50);

    h.timeline.applyCoreDamage(250);
    expect(h.timeline.result()).toBeNull();
    expect(h.core[h.core.length - 1]).toEqual({ hp: 750, maxHp: 1000 });
  });

  it('结束后 update 不再推进时间', () => {
    const h = harness();
    h.advanceTo(50);
    h.timeline.notifyBossDefeated();
    const frozen = h.timeline.tSec();

    for (let i = 0; i < 60; i += 1) h.timeline.update(1 / 60);
    expect(h.timeline.tSec()).toBe(frozen);
  });

  it('结束后 applyCoreDamage 被忽略', () => {
    const h = harness();
    h.advanceTo(50);
    h.timeline.notifyBossDefeated();
    const before = h.core.length;

    h.timeline.applyCoreDamage(500);
    expect(h.core.length).toBe(before);
  });
});

describe('flow/MatchTimeline · 熔岩吞没', () => {
  it('熔岩液面到达吞没线 → lose/lava_swallowed', () => {
    const bus = createBus();
    const timeline = createMatchTimeline();
    const ended: Array<Events['MatchEnded']> = [];
    bus.on('MatchEnded', (p) => ended.push({ ...p }));

    // arena.json 暂无 swallowY 字段，用覆盖值把吞没线压到 rage 中段以验证分支
    timeline.init({
      bus,
      flowCfg,
      arenaCfg: { lava: { ...arenaJson.lava, swallowY: 10 } },
    });

    for (let i = 0; i < 60 * 280 && !timeline.result(); i += 1) timeline.update(1 / 60);

    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ result: 'lose', reason: 'lava_swallowed' });
    // 10 = -0.8 + 1.2 * t → t ≈ 245 + 9
    expect(ended[0].tSec).toBeCloseTo(254, 0);
    expect(ended[0].tSec).toBeLessThan(flowCfg.matchLengthSec);
  });
});

describe('flow/MatchTimeline · 阶段枚举完整性', () => {
  it('7 个阶段全部被覆盖且类型正确', () => {
    const expected: MatchPhase[] = [
      'wake',
      'prep',
      'boss1',
      'transition',
      'boss2',
      'rage',
      'ended',
    ];
    expect(flowCfg.phases.map((p) => p.phase)).toEqual(expected);
  });
});
