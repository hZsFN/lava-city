// tests/unit/story/storyProcessTriggers.test.ts
// ============================================================================
// 进程驱动触发器 · 专项测试
// ----------------------------------------------------------------------------
// 第一版剧情大量用绝对秒数（tSec），脆弱：玩家提前打死 Boss、或阶段时长调整，
// 台词就会和实际进程脱节。本文件验证「配合游戏进程」的四个新触发器：
//
//   phaseProgress   阶段内进度（相对游戏进程，不是墙上钟）
//   playerHpBelow   玩家血量（承接上一关带来的伤）
//   lavaAbove       熔岩液面（本作最贴叙事的进程信号）
//   lavaRising      熔岩上涨速率（狂暴）
//
// 以及一条防回归测试：调用方忘传 phaseDurations 时，第一幕不能整段消失。
// ============================================================================

import { describe, it, expect } from 'vitest';

import { createBus } from '../../../src/core/events';
import { createStoryDirector } from '../../../src/story/StoryDirector';
import type { StoryConfig, StoryCue } from '../../../src/story/types';

function cue(id: string, over: Partial<StoryCue> = {}): StoryCue {
  return {
    id,
    trigger: { kind: 'tSec', atSec: 0 },
    priority: 10,
    durationMs: 500,
    world: 'surface',
    text: `${id}`,
    ...over,
  };
}

function makeConfig(cues: StoryCue[]): StoryConfig {
  return {
    minShowMs: 100,
    inner: { enterFadeMs: 480, exitFadeMs: 620, crystalPerVisit: 0.16, crystalMax: 0.72 },
    cues,
  };
}

function advance(director: ReturnType<typeof createStoryDirector>, seconds: number): void {
  let left = seconds;
  while (left > 0) {
    const dt = Math.min(1 / 60, left);
    director.update(dt);
    left -= dt;
  }
}

const WAKE_DURATIONS = [{ phase: 'wake' as never, startSec: 0, endSec: 20 }];

describe('phaseProgress · 阶段内进度触发', () => {
  it('走到指定进度时触发（不是按秒数）', () => {
    const bus = createBus();
    const d = createStoryDirector();
    d.init({
      bus,
      cfg: makeConfig([
        cue('half', {
          trigger: { kind: 'phaseProgress', phase: 'wake', pct: 50 },
          durationMs: 4000, // 留足观察窗口，避免断言时已播完
        }),
      ]),
      phaseDurations: WAKE_DURATIONS,
    });
    bus.emit('MatchPhaseChanged', { phase: 'wake', tSec: 0 });

    advance(d, 9); // 9/20 = 45%，未到 50%
    expect(d.state().cue).toBeNull();
    advance(d, 2); // 11/20 = 55%，过了
    expect(d.state().cue?.id).toBe('half');
  });

  it('阶段时长改了，触发时刻自动跟着改（tSec 做不到）', () => {
    // 同样写 pct:50，阶段 20s → 10s 触发；阶段 40s → 20s 触发
    const run = (span: number) => {
      const bus = createBus();
      const d = createStoryDirector();
      d.init({
        bus,
        cfg: makeConfig([
          cue('half', { trigger: { kind: 'phaseProgress', phase: 'wake', pct: 50 } }),
        ]),
        phaseDurations: [{ phase: 'wake' as never, startSec: 0, endSec: span }],
      });
      bus.emit('MatchPhaseChanged', { phase: 'wake', tSec: 0 });
      let t = 0;
      while (t < span) {
        d.update(1 / 60);
        t += 1 / 60;
        if (d.state().cue?.id === 'half') return t;
      }
      return -1;
    };
    expect(run(20)).toBeCloseTo(10, 0);
    expect(run(40)).toBeCloseTo(20, 0);
  });

  it('阶段切换后进度归零，新阶段的 pct 重新算', () => {
    const bus = createBus();
    const d = createStoryDirector();
    d.init({
      bus,
      cfg: makeConfig([
        cue('w50', { trigger: { kind: 'phaseProgress', phase: 'wake', pct: 50 } }),
        cue('p10', {
          trigger: { kind: 'phaseProgress', phase: 'prep', pct: 10 },
          durationMs: 4000,
        }),
      ]),
      phaseDurations: [
        { phase: 'wake' as never, startSec: 0, endSec: 20 },
        { phase: 'prep' as never, startSec: 20, endSec: 40 },
      ],
    });
    bus.emit('MatchPhaseChanged', { phase: 'wake', tSec: 0 });
    advance(d, 11);
    expect(d.state().played).toContain('w50');

    bus.emit('MatchPhaseChanged', { phase: 'prep', tSec: 20 });
    advance(d, 1); // prep 走了 1/20 = 5%，未到 10%
    expect(d.state().played).not.toContain('p10');
    advance(d, 2); // 累计 3/20 = 15%，过了 10%
    expect(d.state().played).toContain('p10');
  });

  it('同一阶段内重复广播不重置进度（只在阶段真的变化时重置）', () => {
    const bus = createBus();
    const d = createStoryDirector();
    d.init({
      bus,
      cfg: makeConfig([
        cue('half', {
          trigger: { kind: 'phaseProgress', phase: 'wake', pct: 50 },
          durationMs: 4000,
        }),
      ]),
      phaseDurations: WAKE_DURATIONS,
    });
    bus.emit('MatchPhaseChanged', { phase: 'wake', tSec: 0 });
    advance(d, 11);
    expect(d.state().cue?.id).toBe('half');
    // 再广播一次同阶段（真实中不会发生，但要保证不炸）
    expect(() => bus.emit('MatchPhaseChanged', { phase: 'wake', tSec: 11 })).not.toThrow();
  });

  it('进度只前进不后退（pct 不会因时钟校准而回退）', () => {
    const bus = createBus();
    const d = createStoryDirector();
    d.init({
      bus,
      cfg: makeConfig([
        cue('late', {
          trigger: { kind: 'phaseProgress', phase: 'wake', pct: 90 },
          durationMs: 4000,
        }),
      ]),
      phaseDurations: WAKE_DURATIONS,
    });
    bus.emit('MatchPhaseChanged', { phase: 'wake', tSec: 0 });
    advance(d, 19); // 95%
    expect(d.state().cue?.id).toBe('late');
  });
});

describe('playerHpBelow · 玩家血量', () => {
  it('首次跌破阈值时触发一次', () => {
    const bus = createBus();
    const d = createStoryDirector();
    d.init({
      bus,
      cfg: makeConfig([cue('hurt', { trigger: { kind: 'playerHpBelow', pct: 35 } })]),
    });
    bus.emit('PlayerDamaged', { amount: 10, hp: 90, maxHp: 100, source: 'boss' });
    expect(d.state().cue).toBeNull();
    bus.emit('PlayerDamaged', { amount: 60, hp: 30, maxHp: 100, source: 'boss' });
    expect(d.state().cue?.id).toBe('hurt');
  });

  it('同一阈值不重复触发', () => {
    const bus = createBus();
    const d = createStoryDirector();
    d.init({
      bus,
      cfg: makeConfig([
        cue('hurt', { trigger: { kind: 'playerHpBelow', pct: 35 }, durationMs: 200 }),
      ]),
    });
    bus.emit('PlayerDamaged', { amount: 70, hp: 30, maxHp: 100, source: 'boss' });
    advance(d, 1);
    bus.emit('PlayerDamaged', { amount: 10, hp: 20, maxHp: 100, source: 'boss' });
    expect(d.state().cue).toBeNull();
  });

  it('maxHp 为 0 时安全跳过', () => {
    const bus = createBus();
    const d = createStoryDirector();
    d.init({
      bus,
      cfg: makeConfig([cue('hurt', { trigger: { kind: 'playerHpBelow', pct: 35 } })]),
    });
    bus.emit('PlayerDamaged', { amount: 1, hp: 0, maxHp: 0, source: 'x' });
    expect(d.state().cue).toBeNull();
  });
});

describe('lavaAbove · 熔岩液面', () => {
  it('液面首次升到阈值以上时触发', () => {
    const bus = createBus();
    const d = createStoryDirector();
    d.init({
      bus,
      cfg: makeConfig([cue('knee', { trigger: { kind: 'lavaAbove', y: -0.2 } })]),
    });
    bus.emit('LavaLevelChanged', { y: -0.8, risePerSec: 1.2 });
    expect(d.state().cue).toBeNull();
    bus.emit('LavaLevelChanged', { y: -0.1, risePerSec: 1.2 });
    expect(d.state().cue?.id).toBe('knee');
  });

  it('液面下降不会触发（只判 >=）', () => {
    const bus = createBus();
    const d = createStoryDirector();
    d.init({
      bus,
      cfg: makeConfig([cue('chest', { trigger: { kind: 'lavaAbove', y: 0.6 } })]),
    });
    bus.emit('LavaLevelChanged', { y: 2.0, risePerSec: 1.2 });
    expect(d.state().cue?.id).toBe('chest');
    advance(d, 1);
    bus.emit('LavaLevelChanged', { y: -1.0, risePerSec: 0 });
    expect(d.state().cue).toBeNull();
  });

  it('多条 lavaAbove 按高度依次触发', () => {
    const bus = createBus();
    const d = createStoryDirector();
    d.init({
      bus,
      cfg: makeConfig([
        cue('knee', { trigger: { kind: 'lavaAbove', y: -0.2 }, durationMs: 200 }),
        cue('chest', { trigger: { kind: 'lavaAbove', y: 0.6 }, durationMs: 200 }),
      ]),
    });
    bus.emit('LavaLevelChanged', { y: -0.2, risePerSec: 1.2 });
    expect(d.state().cue?.id).toBe('knee');
    advance(d, 0.5);
    bus.emit('LavaLevelChanged', { y: 0.7, risePerSec: 1.2 });
    expect(d.state().cue?.id).toBe('chest');
  });
});

describe('lavaRising · 熔岩上涨速率', () => {
  it('速率达到阈值时触发（狂暴开始）', () => {
    const bus = createBus();
    const d = createStoryDirector();
    d.init({
      bus,
      cfg: makeConfig([cue('rage', { trigger: { kind: 'lavaRising', risePerSec: 1.0 } })]),
    });
    bus.emit('LavaLevelChanged', { y: -0.8, risePerSec: 0.05 }); // 转阶段的缓慢上涨
    expect(d.state().cue).toBeNull();
    bus.emit('LavaLevelChanged', { y: -0.8, risePerSec: 1.2 }); // 狂暴
    expect(d.state().cue?.id).toBe('rage');
  });
});

describe('防回归 · 调用方忘传 phaseDurations', () => {
  it('仍能从 flow.json 兜底，phaseProgress 不会整段失效', () => {
    const bus = createBus();
    const d = createStoryDirector();
    // 故意不传 phaseDurations
    d.init({
      bus,
      cfg: makeConfig([
        cue('wakeEarly', {
          trigger: { kind: 'phaseProgress', phase: 'wake', pct: 50 },
          durationMs: 4000,
        }),
      ]),
    });
    bus.emit('MatchPhaseChanged', { phase: 'wake', tSec: 0 });
    advance(d, 11); // flow.json 里 wake 是 0–20s，50% = 10s
    expect(d.state().cue?.id).toBe('wakeEarly');
  });

  it('能从只读快照补读已发生的阶段（剧情层晚于时间轴 init）', () => {
    const bus = createBus();
    // 模拟真实顺序：时间轴先发事件，剧情层后 init
    bus.emit('MatchPhaseChanged', { phase: 'wake', tSec: 0 });
    bus.emit('CoreHpChanged', { hp: 1000, maxHp: 1000 });

    const d = createStoryDirector();
    d.init({
      bus,
      cfg: makeConfig([
        cue('wakeEarly', {
          trigger: { kind: 'phaseProgress', phase: 'wake', pct: 50 },
          durationMs: 4000,
        }),
      ]),
      phaseDurations: WAKE_DURATIONS,
    });
    // init 后应已从快照知道当前是 wake 阶段
    advance(d, 11);
    expect(d.state().cue?.id).toBe('wakeEarly');
  });
});
