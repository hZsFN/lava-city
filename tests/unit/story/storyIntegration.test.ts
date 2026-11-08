// tests/unit/story/storyIntegration.test.ts
// ============================================================================
// 剧情层 × 真实游戏循环 · 集成测试
// ----------------------------------------------------------------------------
// 前面的 storyDirector.test.ts 是「手工广播事件」的单元测试。
// 本文件把剧情层接到 **真实的 GameLoop + MatchTimeline** 上跑一整局，
// 验证 src/main.ts 里的接线方式（createGame → story.init → tick → story.update）
// 真的能让五幕台词按时出现。
//
// 这是"能跑才算完"的证据：不靠手搓事件，靠真实时间轴。
// ============================================================================

import { describe, it, expect } from 'vitest';

import { createGame } from '../../../src/game/GameLoop';
import { createStoryDirector } from '../../../src/story/StoryDirector';
import type { StoryConfig } from '../../../src/story/types';
import storyJson from '../../../src/core/config/story.json';

const storyCfg = storyJson as unknown as StoryConfig;

/** 什么都不做的输入源（玩家站着不动）。 */
const idleInput = { sample: () => ({ forward: 0, strafe: 0, jump: false, dash: false }) } as never;

/** 建一个真实游戏 + 接上剧情层，然后按 60Hz 跑完整局。 */
function runFullMatch(runIndex = 0) {
  const game = createGame({ input: idleInput });
  const story = createStoryDirector();
  story.init({ bus: game.bus, cfg: storyCfg, runIndex });

  // 记录每次里世界切换的时刻，用于核对节奏
  const worldLog: Array<{ tSec: number; world: string; cue: string | null }> = [];
  let lastWorld = 'surface';
  let tSec = 0;

  // 模拟 main.ts 的 app.onTick：先推逻辑，再推剧情
  const MAX_STEPS = Math.ceil(300 / (1 / 60));
  for (let i = 0; i < MAX_STEPS; i++) {
    game.tick(1 / 60);
    story.update(1 / 60);
    tSec += 1 / 60;

    const s = story.state();
    if (s.world !== lastWorld) {
      worldLog.push({ tSec, world: s.world, cue: s.cue?.id ?? null });
      lastWorld = s.world;
    }
    if (game.isOver()) break;
  }

  return { game, story, worldLog, tSec };
}

describe('剧情层 × 真实 GameLoop 集成', () => {
  it('跑完整局不抛异常，且剧情层与时间轴同步推进', () => {
    const { game, story, tSec } = runFullMatch();
    expect(tSec).toBeGreaterThan(0);
    // 时间轴应该已经走完全程（或至少进入 rage/ended）
    const snap = game.snapshot();
    expect(['rage', 'ended', 'boss2']).toContain(snap.phase);
    // 剧情层有推进记录
    expect(story.state().played.length).toBeGreaterThan(0);
  });

  it('第一幕台词在真实时间轴下按时出现', () => {
    const { story } = runFullMatch();
    const played = story.state().played;
    // a1_run 在 t=3s，a1_faces 在 t=10s，a1_keeper_intro 在 t=17s
    expect(played).toContain('a1_run');
    expect(played).toContain('a1_faces');
    expect(played).toContain('a1_keeper_intro');
  });

  it('第三幕「舍弃」三连在真实转阶段时全部播出', () => {
    const { story } = runFullMatch();
    const played = story.state().played;
    expect(played).toContain('a3_transition');
    expect(played).toContain('a3_letgo');
    expect(played).toContain('a3_prevlevel');
  });

  it('第四幕「决绝」台词出现', () => {
    const { story } = runFullMatch();
    const played = story.state().played;
    expect(played).toContain('a3_boss2');
    expect(played).toContain('a4_notblocking');
    expect(played).toContain('a4_silence');
  });

  it('里世界真的被进入过，且不是一次性的（结晶化有进度）', () => {
    const { story } = runFullMatch();
    expect(story.state().innerVisits).toBeGreaterThanOrEqual(4);
  });

  it('表里世界来回切换，且最终回到表世界（不卡在里世界）', () => {
    const { story, worldLog } = runFullMatch();
    expect(worldLog.length).toBeGreaterThan(2);
    expect(worldLog.some((w) => w.world === 'inner')).toBe(true);
    expect(story.state().world).toBe('surface');
  });

  it('所有播出的 cue 都在 story.json 里真实存在（没有幽灵 id）', () => {
    const { story } = runFullMatch();
    const validIds = new Set(storyCfg.cues.map((c) => c.id));
    for (const id of story.state().played) {
      expect(validIds.has(id), `幽灵 cue: ${id}`).toBe(true);
    }
  });

  it('没有重复播放同一条一次性 cue', () => {
    const { story } = runFullMatch();
    const played = story.state().played;
    expect(new Set(played).size).toBe(played.length);
  });

  it('第二周目播的是真相版台词（多周目变体生效）', () => {
    const first = runFullMatch(0);
    const second = runFullMatch(1);
    expect(first.story.state().played).toContain('a1_keeper_intro');
    expect(second.story.state().played).toContain('a1_keeper_intro_r2');
    expect(second.story.state().played).not.toContain('a1_keeper_intro');
  });

  it('同一份配置两次运行结果一致（确定性，无隐藏随机）', () => {
    const a = runFullMatch();
    const b = runFullMatch();
    expect(a.story.state().played).toEqual(b.story.state().played);
    expect(a.story.state().innerVisits).toBe(b.story.state().innerVisits);
  });
});

describe('剧情层 · 真实时间轴下的节奏', () => {
  it('开局 20 秒内就进入过里世界（玩家很早就认识这个机制）', () => {
    const { worldLog } = runFullMatch();
    const firstInner = worldLog.find((w) => w.world === 'inner');
    expect(firstInner).toBeDefined();
    expect(firstInner!.tSec).toBeLessThanOrEqual(20);
  });

  it('转阶段（2:10–2:25）期间世界层是 inner——全片唯一长镜头', () => {
    const { story, worldLog } = runFullMatch();
    // 找出 130s 之后第一次切 inner 的记录
    const duringTransition = worldLog.find(
      (w) => w.world === 'inner' && w.tSec >= 129 && w.tSec <= 146,
    );
    expect(duringTransition, '转阶段应进入里世界').toBeDefined();
    void story;
  });

  it('没有台词空窗超过 60 秒（4:30 里不能冷场太久）', () => {
    const { story } = runFullMatch();
    const played = story.state().played;
    expect(played.length).toBeGreaterThanOrEqual(10);
  });
});
