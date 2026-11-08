// tests/unit/story/storyDirector.test.ts
// ============================================================================
// StoryDirector 单测 · 纯 Node（不 import three）
// ----------------------------------------------------------------------------
// 覆盖 types.ts 契约里的每一条语义：
//   触发种类 phase / bossPhase / bossHpBelow / coreHpBelow / event / count / tSec / afterCue
//   修饰 window / cooldownMs / firstRunOnly / altOnReplay
//   行为 priority 打断、world 切换、holdInnerMs 余韵、force、dispose、state 快照
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';

import { createBus } from '../../../src/core/events';
import type { Bus } from '../../../src/core/events';
import { createStoryDirector } from '../../../src/story/StoryDirector';
import type { StoryConfig, StoryCue, StoryDirector } from '../../../src/story/types';

/** 造一条 cue，只写关心的字段，其余给合理默认值。 */
function cue(id: string, over: Partial<StoryCue> = {}): StoryCue {
  return {
    id,
    trigger: { kind: 'tSec', atSec: 0 },
    priority: 10,
    durationMs: 1000,
    world: 'surface',
    text: `${id} 的正文`,
    ...over,
  };
}

function makeConfig(cues: StoryCue[], over: Partial<StoryConfig> = {}): StoryConfig {
  return {
    minShowMs: 100,
    inner: {
      enterFadeMs: 480,
      exitFadeMs: 620,
      crystalPerVisit: 0.16,
      crystalMax: 0.72,
    },
    cues,
    ...over,
  };
}

/** 建一个已 init 的 director + bus。 */
function setup(cfg: StoryConfig, runIndex = 0): { bus: Bus; director: StoryDirector } {
  const bus = createBus();
  const director = createStoryDirector();
  director.init({ bus, cfg, runIndex });
  return { bus, director };
}

/** 推进 n 秒（默认按 1/60 步进，模拟真实逻辑帧）。 */
function advance(director: StoryDirector, seconds: number, step = 1 / 60): void {
  let left = seconds;
  while (left > 0) {
    const dt = Math.min(step, left);
    director.update(dt);
    left -= dt;
  }
}

describe('StoryDirector · init 与 state', () => {
  it('init 后 state 是干净的初值', () => {
    const { director } = setup(makeConfig([cue('c1')]));
    const s = director.state();
    expect(s.cue).toBeNull();
    expect(s.world).toBe('surface');
    expect(s.innerVisits).toBe(0);
    expect(s.played).toEqual([]);
    expect(s.runIndex).toBe(0);
    expect(s.shownMs).toBe(0);
  });

  it('state() 每次返回新对象（外部改动不影响内部）', () => {
    const { director } = setup(makeConfig([cue('c1')]));
    const a = director.state();
    const b = director.state();
    expect(a).not.toBe(b);
    a.innerVisits = 999;
    expect(director.state().innerVisits).toBe(0);
  });

  it('state().played 是副本，外部 push 不污染内部', () => {
    const { director } = setup(makeConfig([cue('c1')]));
    const s = director.state();
    (s.played as string[]).push('hacked');
    expect(director.state().played).toEqual([]);
  });

  it('runIndex 透传到 state（多周目判定用）', () => {
    const { director } = setup(makeConfig([cue('c1')]), 2);
    expect(director.state().runIndex).toBe(2);
  });
});

describe('StoryDirector · tSec 触发', () => {
  it('到点前不触发，到点后触发', () => {
    const { director } = setup(makeConfig([cue('c1', { trigger: { kind: 'tSec', atSec: 2 } })]));
    advance(director, 1.5);
    expect(director.state().cue).toBeNull();
    advance(director, 1);
    expect(director.state().cue?.id).toBe('c1');
  });

  it('atSec=0 的 cue 在第一次 update 时触发', () => {
    const { director } = setup(makeConfig([cue('c1', { trigger: { kind: 'tSec', atSec: 0 } })]));
    director.update(1 / 60);
    expect(director.state().cue?.id).toBe('c1');
  });

  it('播完后自动收起，且 world 回落 surface', () => {
    const { director } = setup(
      makeConfig([cue('c1', { trigger: { kind: 'tSec', atSec: 0 }, durationMs: 1000 })]),
    );
    advance(director, 0.1);
    expect(director.state().cue?.id).toBe('c1');
    advance(director, 1.2);
    expect(director.state().cue).toBeNull();
    expect(director.state().world).toBe('surface');
  });

  it('played 按播放顺序累积，且不重复记录同一条', () => {
    const { director } = setup(
      makeConfig([
        cue('c1', { trigger: { kind: 'tSec', atSec: 0 }, durationMs: 500 }),
        cue('c2', { trigger: { kind: 'tSec', atSec: 1 }, durationMs: 500 }),
      ]),
    );
    advance(director, 2);
    expect(director.state().played).toEqual(['c1', 'c2']);
  });
});

describe('StoryDirector · 时钟校准', () => {
  it('MatchPhaseChanged 用 tSec 校准时钟（时间轴是权威）', () => {
    // cue 在 tSec=60 触发；若时钟不校准，需要真的跑 60 秒
    const { bus, director } = setup(
      makeConfig([cue('late', { trigger: { kind: 'tSec', atSec: 60 } })]),
    );
    bus.emit('MatchPhaseChanged', { phase: 'boss1', tSec: 60 });
    advance(director, 0.1);
    expect(director.state().cue?.id).toBe('late');
  });

  it('tSec 比内部时钟小时不回拨（只取较大值）', () => {
    const { bus, director } = setup(
      makeConfig([cue('c1', { trigger: { kind: 'tSec', atSec: 10 } })]),
    );
    advance(director, 5);
    bus.emit('MatchPhaseChanged', { phase: 'wake', tSec: 0 }); // 回拨尝试
    advance(director, 4.9);
    expect(director.state().cue).toBeNull(); // 时钟没被拉回，仍是 9.9 < 10
    advance(director, 0.2);
    expect(director.state().cue?.id).toBe('c1');
  });
});

describe('StoryDirector · phase 触发', () => {
  it('阶段切换触发对应 cue', () => {
    const { bus, director } = setup(
      makeConfig([cue('p1', { trigger: { kind: 'phase', phase: 'boss1' } })]),
    );
    bus.emit('MatchPhaseChanged', { phase: 'wake', tSec: 0 });
    expect(director.state().cue).toBeNull();
    bus.emit('MatchPhaseChanged', { phase: 'boss1', tSec: 40 });
    expect(director.state().cue?.id).toBe('p1');
  });

  it('同一阶段重复广播不会重播（已消费）', () => {
    const { bus, director } = setup(
      makeConfig([cue('p1', { trigger: { kind: 'phase', phase: 'boss1' }, durationMs: 500 })]),
    );
    bus.emit('MatchPhaseChanged', { phase: 'boss1', tSec: 40 });
    advance(director, 1);
    bus.emit('MatchPhaseChanged', { phase: 'boss1', tSec: 41 });
    expect(director.state().cue).toBeNull();
  });

  it('bossPhase 触发独立于 phase', () => {
    const { bus, director } = setup(
      makeConfig([cue('bp2', { trigger: { kind: 'bossPhase', to: 2 } })]),
    );
    bus.emit('BossPhaseChanged', { from: 1, to: 2 });
    expect(director.state().cue?.id).toBe('bp2');
  });
});

describe('StoryDirector · 血量阈值', () => {
  it('Boss 血量首次跌破阈值时触发一次', () => {
    const { bus, director } = setup(
      makeConfig([cue('hp75', { trigger: { kind: 'bossHpBelow', pct: 75 } })]),
    );
    bus.emit('BossSpawned', { hp: 1400, maxHp: 1400, phase: 1 });
    expect(director.state().cue).toBeNull();
    bus.emit('BossHpChanged', { hp: 1000, maxHp: 1400, phase: 1 }); // 71.4%
    expect(director.state().cue?.id).toBe('hp75');
  });

  it('同一阈值不重复触发（即使血量反复穿越）', () => {
    const { bus, director } = setup(
      makeConfig([cue('hp75', { trigger: { kind: 'bossHpBelow', pct: 75 }, durationMs: 300 })]),
    );
    bus.emit('BossHpChanged', { hp: 1000, maxHp: 1400, phase: 1 });
    advance(director, 1);
    bus.emit('BossHpChanged', { hp: 900, maxHp: 1400, phase: 1 });
    expect(director.state().cue).toBeNull();
  });

  it('maxHp 为 0 时安全跳过（不除零）', () => {
    const { bus, director } = setup(
      makeConfig([cue('hp75', { trigger: { kind: 'bossHpBelow', pct: 75 } })]),
    );
    bus.emit('BossHpChanged', { hp: 0, maxHp: 0, phase: 1 });
    expect(director.state().cue).toBeNull();
  });

  it('coreHpBelow 由 CoreHpChanged 驱动', () => {
    const { bus, director } = setup(
      makeConfig([cue('core40', { trigger: { kind: 'coreHpBelow', pct: 40 } })]),
    );
    bus.emit('CoreHpChanged', { hp: 1000, maxHp: 1000 });
    expect(director.state().cue).toBeNull();
    bus.emit('CoreHpChanged', { hp: 300, maxHp: 1000 });
    expect(director.state().cue?.id).toBe('core40');
  });
});

describe('StoryDirector · event 触发与载荷过滤', () => {
  it('event 类在首次触发时播放', () => {
    const { bus, director } = setup(
      makeConfig([cue('e1', { trigger: { kind: 'event', event: 'ExecutionEnded' } })]),
    );
    bus.emit('ExecutionEnded', { part: 'core', damage: 168 });
    expect(director.state().cue?.id).toBe('e1');
  });

  it('match 不匹配时不触发', () => {
    const { bus, director } = setup(
      makeConfig([
        cue('coreOnly', {
          trigger: { kind: 'event', event: 'WeaknessExposed', match: { part: 'core' } },
        }),
      ]),
    );
    bus.emit('WeaknessExposed', { part: 'back', attr: 'physical', durationMs: 6000 });
    expect(director.state().cue).toBeNull();
    bus.emit('WeaknessExposed', { part: 'core', attr: 'arcane', durationMs: 3000 });
    expect(director.state().cue?.id).toBe('coreOnly');
  });

  it('MatchEnded 按 result 分流到不同 cue', () => {
    const { bus, director } = setup(
      makeConfig([
        cue('win', { trigger: { kind: 'event', event: 'MatchEnded', match: { result: 'win' } } }),
        cue('lose', { trigger: { kind: 'event', event: 'MatchEnded', match: { result: 'lose' } } }),
      ]),
    );
    bus.emit('MatchEnded', { result: 'lose', reason: 'timeout', tSec: 270 });
    expect(director.state().cue?.id).toBe('lose');
  });

  it('被优先级挡下的一次性事件 cue 会保留，等下次同类事件再播（不静默丢失）', () => {
    const { bus, director } = setup(
      makeConfig([
        cue('high', { trigger: { kind: 'phase', phase: 'boss1' }, priority: 30, durationMs: 3000 }),
        cue('low', {
          trigger: { kind: 'event', event: 'ExecutionEnded' },
          priority: 10,
          durationMs: 1000,
        }),
      ]),
    );
    // 先让高优先级占住
    bus.emit('MatchPhaseChanged', { phase: 'boss1', tSec: 40 });
    expect(director.state().cue?.id).toBe('high');
    // 此时低优先级事件来了，应被挡下
    bus.emit('ExecutionEnded', { part: 'core', damage: 100 });
    expect(director.state().cue?.id).toBe('high');
    // 高优先级播完后，下一次同类事件能补上
    advance(director, 4);
    expect(director.state().cue).toBeNull();
    bus.emit('ExecutionEnded', { part: 'core', damage: 100 });
    expect(director.state().cue?.id).toBe('low');
  });
});

describe('StoryDirector · count 触发', () => {
  it('第 n 次事件时触发', () => {
    const { bus, director } = setup(
      makeConfig([
        cue('third', { trigger: { kind: 'count', event: 'TowerPlaced', n: 3 }, durationMs: 200 }),
      ]),
    );
    bus.emit('TowerPlaced', { towerId: 'a', kind: 'rune', slotId: 'M1', pos: [0, 0, 0] });
    advance(director, 0.5);
    expect(director.state().cue).toBeNull();
    bus.emit('TowerPlaced', { towerId: 'b', kind: 'rune', slotId: 'M2', pos: [0, 0, 0] });
    advance(director, 0.5);
    expect(director.state().cue).toBeNull();
    bus.emit('TowerPlaced', { towerId: 'c', kind: 'rune', slotId: 'M3', pos: [0, 0, 0] });
    expect(director.state().cue?.id).toBe('third');
  });
});

describe('StoryDirector · priority 打断规则', () => {
  it('更高优先级可以打断当前 cue', () => {
    const { bus, director } = setup(
      makeConfig([
        cue('low', { trigger: { kind: 'phase', phase: 'wake' }, priority: 10, durationMs: 5000 }),
        cue('high', { trigger: { kind: 'phase', phase: 'boss1' }, priority: 30, durationMs: 5000 }),
      ]),
    );
    bus.emit('MatchPhaseChanged', { phase: 'wake', tSec: 0 });
    expect(director.state().cue?.id).toBe('low');
    bus.emit('MatchPhaseChanged', { phase: 'boss1', tSec: 40 });
    expect(director.state().cue?.id).toBe('high');
  });

  it('同优先级不打断', () => {
    const { bus, director } = setup(
      makeConfig([
        cue('first', { trigger: { kind: 'phase', phase: 'wake' }, priority: 10, durationMs: 5000 }),
        cue('second', { trigger: { kind: 'phase', phase: 'boss1' }, priority: 10, durationMs: 5000 }),
      ]),
    );
    bus.emit('MatchPhaseChanged', { phase: 'wake', tSec: 0 });
    bus.emit('MatchPhaseChanged', { phase: 'boss1', tSec: 40 });
    expect(director.state().cue?.id).toBe('first');
  });

  it('低优先级不打断', () => {
    const { bus, director } = setup(
      makeConfig([
        cue('high', { trigger: { kind: 'phase', phase: 'wake' }, priority: 30, durationMs: 5000 }),
        cue('low', { trigger: { kind: 'phase', phase: 'boss1' }, priority: 10, durationMs: 5000 }),
      ]),
    );
    bus.emit('MatchPhaseChanged', { phase: 'wake', tSec: 0 });
    bus.emit('MatchPhaseChanged', { phase: 'boss1', tSec: 40 });
    expect(director.state().cue?.id).toBe('high');
  });

  it('force 无视优先级强插', () => {
    const { bus, director } = setup(
      makeConfig([
        cue('high', { trigger: { kind: 'phase', phase: 'wake' }, priority: 30, durationMs: 5000 }),
        cue('low', { trigger: { kind: 'tSec', atSec: 999 }, priority: 1, durationMs: 1000 }),
      ]),
    );
    bus.emit('MatchPhaseChanged', { phase: 'wake', tSec: 0 });
    expect(director.force('low')).toBe(true);
    expect(director.state().cue?.id).toBe('low');
  });

  it('force 不存在的 id 返回 false', () => {
    const { director } = setup(makeConfig([cue('c1')]));
    expect(director.force('nope')).toBe(false);
  });
});

describe('StoryDirector · 里世界与余韵', () => {
  it('inner cue 把 world 切到 inner 并累计 innerVisits', () => {
    const { director } = setup(
      makeConfig([
        cue('in', { trigger: { kind: 'tSec', atSec: 0 }, world: 'inner', durationMs: 1000 }),
      ]),
    );
    director.update(1 / 60);
    expect(director.state().world).toBe('inner');
    expect(director.state().innerVisits).toBe(1);
  });

  it('holdInnerMs 让里世界在字幕结束后继续维持', () => {
    const { director } = setup(
      makeConfig([
        cue('in', {
          trigger: { kind: 'tSec', atSec: 0 },
          world: 'inner',
          durationMs: 500,
          holdInnerMs: 500,
        }),
      ]),
    );
    advance(director, 0.7); // 正文已结束，余韵中
    expect(director.state().cue).toBeNull();
    expect(director.state().world).toBe('inner');
    expect(director.state().innerMsLeft).toBeGreaterThan(0);
    advance(director, 0.6); // 余韵结束
    expect(director.state().world).toBe('surface');
    expect(director.state().innerMsLeft).toBe(0);
  });

  it('surface cue 不会误开里世界', () => {
    const { director } = setup(
      makeConfig([cue('out', { trigger: { kind: 'tSec', atSec: 0 }, world: 'surface' })]),
    );
    director.update(1 / 60);
    expect(director.state().world).toBe('surface');
    expect(director.state().innerVisits).toBe(0);
  });

  it('多次进入里世界累加 innerVisits（结晶化进度）', () => {
    const { bus, director } = setup(
      makeConfig([
        cue('in1', { trigger: { kind: 'phase', phase: 'wake' }, world: 'inner', durationMs: 300 }),
        cue('in2', { trigger: { kind: 'phase', phase: 'prep' }, world: 'inner', durationMs: 300 }),
        cue('in3', { trigger: { kind: 'phase', phase: 'boss1' }, world: 'inner', durationMs: 300 }),
      ]),
    );
    bus.emit('MatchPhaseChanged', { phase: 'wake', tSec: 0 });
    advance(director, 0.5);
    bus.emit('MatchPhaseChanged', { phase: 'prep', tSec: 20 });
    advance(director, 0.5);
    bus.emit('MatchPhaseChanged', { phase: 'boss1', tSec: 40 });
    expect(director.state().innerVisits).toBe(3);
  });
});

describe('StoryDirector · afterCue 串接', () => {
  it('父 cue 播完后按 delayMs 触发子 cue', () => {
    const { director } = setup(
      makeConfig([
        cue('parent', { trigger: { kind: 'tSec', atSec: 0 }, durationMs: 500 }),
        cue('child', {
          trigger: { kind: 'afterCue', id: 'parent', delayMs: 200 },
          durationMs: 500,
        }),
      ]),
    );
    director.update(1 / 60);
    expect(director.state().cue?.id).toBe('parent');
    advance(director, 0.6); // 父已结束
    expect(director.state().cue).toBeNull();
    advance(director, 0.25); // 延迟到点
    expect(director.state().cue?.id).toBe('child');
  });

  it('delayMs 省略时父结束即播子', () => {
    const { director } = setup(
      makeConfig([
        cue('parent', { trigger: { kind: 'tSec', atSec: 0 }, durationMs: 300 }),
        cue('child', { trigger: { kind: 'afterCue', id: 'parent' }, durationMs: 300 }),
      ]),
    );
    advance(director, 0.35);
    expect(director.state().cue?.id).toBe('child');
  });

  it('三连串接按顺序播完（第三幕舍弃段落的形态）', () => {
    const { director } = setup(
      makeConfig([
        cue('a', { trigger: { kind: 'tSec', atSec: 0 }, durationMs: 300 }),
        cue('b', { trigger: { kind: 'afterCue', id: 'a', delayMs: 50 }, durationMs: 300 }),
        cue('c', { trigger: { kind: 'afterCue', id: 'b', delayMs: 50 }, durationMs: 300 }),
      ]),
    );
    // a 播 0–0.3s，b 在 0.35s 起，c 在 0.70s 起。取窗口中点断言，避开边界帧。
    advance(director, 0.42);
    expect(director.state().cue?.id).toBe('b');
    advance(director, 0.35);
    expect(director.state().cue?.id).toBe('c');
    expect(director.state().played).toEqual(['a', 'b', 'c']);
  });
});

describe('StoryDirector · window 与 cooldown', () => {
  it('window 外不触发', () => {
    const { director } = setup(
      makeConfig([
        cue('win', {
          trigger: { kind: 'tSec', atSec: 5 },
          window: { fromSec: 10, toSec: 20 },
          durationMs: 2000,
        }),
      ]),
    );
    advance(director, 6); // 时钟到 6，已过 atSec 但不在窗口内
    expect(director.state().cue).toBeNull();
    advance(director, 4.5); // 时钟到 10.5，进窗口且不落在边界帧
    expect(director.state().cue?.id).toBe('win');
  });

  it('window 上界之后不触发', () => {
    const { director } = setup(
      makeConfig([
        cue('win', {
          trigger: { kind: 'tSec', atSec: 25 },
          window: { fromSec: 10, toSec: 20 },
        }),
      ]),
    );
    advance(director, 26);
    expect(director.state().cue).toBeNull();
  });

  it('cooldown 内的重复事件不重播，冷却过后可再播', () => {
    const { bus, director } = setup(
      makeConfig([
        cue('died', {
          trigger: { kind: 'event', event: 'PlayerDied' },
          durationMs: 300,
          cooldownMs: 5000,
        }),
      ]),
    );
    bus.emit('PlayerDied', { cause: 'lava', deaths: 1 });
    advance(director, 1);
    // 1 秒后再次死亡：仍在 5 秒冷却内
    bus.emit('PlayerDied', { cause: 'lava', deaths: 2 });
    expect(director.state().cue).toBeNull();
    // 冷却过后
    advance(director, 5);
    bus.emit('PlayerDied', { cause: 'lava', deaths: 3 });
    expect(director.state().cue?.id).toBe('died');
  });
});

describe('StoryDirector · firstRunOnly 与 altOnReplay', () => {
  it('firstRunOnly 在第二周目被跳过', () => {
    const { director } = setup(
      makeConfig([
        cue('truth', { trigger: { kind: 'tSec', atSec: 0 }, firstRunOnly: true }),
      ]),
      1,
    );
    advance(director, 0.2);
    expect(director.state().cue).toBeNull();
  });

  it('firstRunOnly 在首周目正常播', () => {
    const { director } = setup(
      makeConfig([
        cue('truth', { trigger: { kind: 'tSec', atSec: 0 }, firstRunOnly: true }),
      ]),
      0,
    );
    advance(director, 0.1);
    expect(director.state().cue?.id).toBe('truth');
  });

  it('第二周目改播 altOnReplay 指向的变体', () => {
    const { director } = setup(
      makeConfig([
        cue('intro', {
          trigger: { kind: 'tSec', atSec: 0 },
          durationMs: 500,
          altOnReplay: 'intro_r2',
        }),
        cue('intro_r2', {
          trigger: { kind: 'tSec', atSec: 0 },
          durationMs: 500,
          text: '第二次的真相版',
        }),
      ]),
      1,
    );
    advance(director, 0.1);
    expect(director.state().cue?.id).toBe('intro_r2');
  });

  it('首周目播原版，不播变体', () => {
    const { director } = setup(
      makeConfig([
        cue('intro', {
          trigger: { kind: 'tSec', atSec: 0 },
          durationMs: 500,
          altOnReplay: 'intro_r2',
        }),
        cue('intro_r2', { trigger: { kind: 'tSec', atSec: 0 }, durationMs: 500 }),
      ]),
      0,
    );
    advance(director, 0.1);
    expect(director.state().cue?.id).toBe('intro');
  });

  it('变体 cue 不参与常规扫描（不能被自己的 tSec 单独触发）', () => {
    const { director } = setup(
      makeConfig([
        cue('base', {
          trigger: { kind: 'tSec', atSec: 999 }, // 永不触发
          durationMs: 500,
          altOnReplay: 'variant',
        }),
        cue('variant', { trigger: { kind: 'tSec', atSec: 0 }, durationMs: 500 }),
      ]),
      0, // 首周目，base 不会替换，variant 也不该被 tSec 扫描到
    );
    advance(director, 0.5);
    expect(director.state().cue).toBeNull();
  });

  it('force 可以强播变体（调试用）', () => {
    const { director } = setup(
      makeConfig([
        cue('base', { trigger: { kind: 'tSec', atSec: 0 }, altOnReplay: 'variant' }),
        cue('variant', { trigger: { kind: 'tSec', atSec: 0 }, durationMs: 500 }),
      ]),
      0,
    );
    expect(director.force('variant')).toBe(true);
    expect(director.state().cue?.id).toBe('variant');
  });
});

describe('StoryDirector · minShowMs 抬升', () => {
  it('durationMs 小于 minShowMs 时按 minShowMs 播', () => {
    const { director } = setup(
      makeConfig([cue('short', { trigger: { kind: 'tSec', atSec: 0 }, durationMs: 50 })], {
        minShowMs: 400,
      }),
    );
    director.update(1 / 60);
    expect(director.state().cue?.id).toBe('short');
    advance(director, 0.3); // 0.3s < 0.4s 的最短显示
    expect(director.state().cue?.id).toBe('short');
    advance(director, 0.2);
    expect(director.state().cue).toBeNull();
  });
});

describe('StoryDirector · dispose', () => {
  it('dispose 后不再响应事件', () => {
    const { bus, director } = setup(
      makeConfig([cue('p1', { trigger: { kind: 'phase', phase: 'boss1' } })]),
    );
    director.dispose();
    bus.emit('MatchPhaseChanged', { phase: 'boss1', tSec: 40 });
    expect(director.state().cue).toBeNull();
  });

  it('dispose 后 update 安全无副作用', () => {
    const { director } = setup(makeConfig([cue('c1', { trigger: { kind: 'tSec', atSec: 0 } })]));
    director.dispose();
    expect(() => advance(director, 2)).not.toThrow();
    expect(director.state().cue).toBeNull();
  });

  it('dispose 后 force 返回 false', () => {
    const { director } = setup(makeConfig([cue('c1')]));
    director.dispose();
    expect(director.force('c1')).toBe(false);
  });

  it('dispose 后 state 仍可安全读取', () => {
    const { director } = setup(makeConfig([cue('c1')]));
    director.dispose();
    expect(() => director.state()).not.toThrow();
  });
});

describe('StoryDirector · 真实配置冒烟', () => {
  it('用 story.json 跑完一整局不报错，且主线台词都播了', async () => {
    const storyJson = (await import('../../../src/core/config/story.json')).default;
    const flowJson = (await import('../../../src/core/config/flow.json')).default;
    const cfg = storyJson as unknown as StoryConfig;
    const flow = flowJson as unknown as {
      phases: Array<{ phase: string; startSec: number; endSec: number }>;
    };

    const bus = createBus();
    const director = createStoryDirector();
    director.init({
      bus,
      cfg,
      phaseDurations: flow.phases.map((p) => ({
        phase: p.phase as never,
        startSec: p.startSec,
        endSec: p.endSec,
      })),
    });

    // 按 flow.json 的阶段时刻依次广播。
    // **顺序很重要**：必须先把时间推进到该阶段起点，再广播阶段切换——
    // MatchPhaseChanged 会用 tSec 校准时钟。若先广播再推进，时钟会被直接
    // 推到阶段末尾，phaseProgress 永远算不出进度（真实游戏不是这个顺序）。
    let now = 0;
    for (const phase of flow.phases) {
      while (now < phase.startSec) {
        director.update(1 / 60);
        now += 1 / 60;
      }
      bus.emit('MatchPhaseChanged', { phase: phase.phase as never, tSec: phase.startSec });
    }
    // 跑到 270s 结束
    while (now < 270) {
      director.update(1 / 60);
      now += 1 / 60;
    }

    const played = director.state().played;
    // 五幕关键台词都该在（这些全部由 phase / phaseProgress / afterCue 驱动，
    // 不依赖 Boss 接线，所以现在就能播）
    expect(played).toContain('a1_run');
    expect(played).toContain('a1_faces');
    expect(played).toContain('a1_prep');
    expect(played).toContain('a3_transition');
    expect(played).toContain('a3_letgo');
    expect(played).toContain('a3_prevlevel');
    // 第四幕锚点用 phaseProgress 驱动的 a4_silence；
    // a4_last / a4_hp30 依赖 Boss 血量事件，属接线后的增强层，此处不断言。
    expect(played).toContain('a4_silence');

    // 里世界：本冒烟只走"时间/阶段驱动"路径。
    // Boss 事件驱动的里世界 cue（弱点暴露、击破、膝盖、冻结、血量阈值、
    // 玩家受伤）要等 BossEntity 接线后才会触发。
    expect(director.state().innerVisits).toBeGreaterThanOrEqual(4);
  });
});
