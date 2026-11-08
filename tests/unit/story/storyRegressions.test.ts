// tests/unit/story/storyRegressions.test.ts
// ============================================================================
// 剧情层 · 回归测试
// ----------------------------------------------------------------------------
// 这些用例对应**独立代码审查发现的真实缺陷**。每条都先失败、修复后通过，
// 留在这里防止回归。审查由第三方代理完成，用探针脚本实测引擎行为后发现。
// ============================================================================

import { describe, it, expect } from 'vitest';

import { createBus } from '../../../src/core/events';
import { createStoryDirector } from '../../../src/story/StoryDirector';
import type { StoryConfig, StoryCue } from '../../../src/story/types';
import storyJson from '../../../src/core/config/story.json';
import flowJson from '../../../src/core/config/flow.json';

function cue(id: string, over: Partial<StoryCue> = {}): StoryCue {
  return {
    id,
    trigger: { kind: 'tSec', atSec: 999 },
    priority: 10,
    durationMs: 500,
    world: 'surface',
    text: id,
    ...over,
  };
}

function mk(cues: StoryCue[]): StoryConfig {
  return {
    minShowMs: 100,
    inner: { enterFadeMs: 480, exitFadeMs: 620, crystalPerVisit: 0.16, crystalMax: 0.72 },
    cues,
  };
}

const realCfg = storyJson as unknown as StoryConfig;
const flow = flowJson as unknown as {
  phases: Array<{ phase: string; startSec: number; endSec: number }>;
};
const realPhaseDurations = flow.phases.map((p) => ({
  phase: p.phase as never,
  startSec: p.startSec,
  endSec: p.endSec,
}));

/** 用真实配置跑完整局（按 flow.json 的阶段时刻驱动）。 */
function runRealMatch(runIndex: number): string[] {
  const bus = createBus();
  const d = createStoryDirector();
  d.init({ bus, cfg: realCfg, runIndex, phaseDurations: realPhaseDurations });
  let now = 0;
  for (const phase of flow.phases) {
    while (now < phase.startSec) {
      d.update(1 / 60);
      now += 1 / 60;
    }
    bus.emit('MatchPhaseChanged', { phase: phase.phase as never, tSec: phase.startSec });
  }
  while (now < 270) {
    d.update(1 / 60);
    now += 1 / 60;
  }
  return d.state().played;
}

describe('回归 · 多周目 afterCue 链不能断', () => {
  // 缺陷：armAfterCues(finished.id) 传的是实际播出的变体 id（a3_letgo_r2），
  // 而子 cue 的 trigger.id 指向原 id（a3_letgo），永远匹配不到 →
  // 第二周目起 a3_prevlevel / a5_win_after 全部丢失。
  it('首周目：第三幕三连完整', () => {
    const played = runRealMatch(0);
    expect(played).toContain('a3_transition');
    expect(played).toContain('a3_letgo');
    expect(played).toContain('a3_prevlevel');
  });

  it('第二周目：变体代播后，子 cue 仍然要能播（这是修复点）', () => {
    const played = runRealMatch(1);
    // 父 cue 换成了变体
    expect(played).toContain('a3_letgo_r2');
    expect(played).not.toContain('a3_letgo');
    // 子 cue 必须仍然被武装并播出
    expect(played).toContain('a3_prevlevel');
  });

  it('第二周目：a1 变体代播后，后续 cue 不受影响', () => {
    const played = runRealMatch(1);
    expect(played).toContain('a1_keeper_intro_r2');
    expect(played).toContain('a1_build_teach');
    expect(played).toContain('a1_prep');
  });
});

describe('回归 · 血量阈值被挡后要能重试', () => {
  // 缺陷：firedThresholds.add(key) 在 tryPlay() 之前执行。
  // 若此刻被高优先级 cue 占位，阈值已被标记「已触发」，之后不再重试。
  it('被高优先级挡住时不标记，血量再降时重试成功', () => {
    const bus = createBus();
    const d = createStoryDirector();
    d.init({
      bus,
      cfg: mk([
        cue('blocker', {
          trigger: { kind: 'phase', phase: 'boss1' },
          priority: 30,
          durationMs: 3000,
        }),
        cue('hp75', { trigger: { kind: 'bossHpBelow', pct: 75 }, priority: 20, durationMs: 800 }),
      ]),
    });

    bus.emit('MatchPhaseChanged', { phase: 'boss1', tSec: 50 });
    expect(d.state().cue?.id).toBe('blocker');

    // blocker 占位期间血量跌破 75% → 被挡
    bus.emit('BossSpawned', { hp: 1400, maxHp: 1400, phase: 1 });
    bus.emit('BossHpChanged', { hp: 1000, maxHp: 1400, phase: 1 });
    expect(d.state().played).not.toContain('hp75');

    // blocker 播完后，血量再降 → 重试成功
    for (let i = 0; i < 60 * 4; i++) d.update(1 / 60);
    bus.emit('BossHpChanged', { hp: 900, maxHp: 1400, phase: 1 });
    for (let i = 0; i < 30; i++) d.update(1 / 60);
    expect(d.state().played).toContain('hp75');
  });

  it('正常播出的阈值仍然只触发一次（不因重试逻辑而重复）', () => {
    const bus = createBus();
    const d = createStoryDirector();
    d.init({
      bus,
      cfg: mk([cue('hp75', { trigger: { kind: 'bossHpBelow', pct: 75 }, durationMs: 300 })]),
    });
    bus.emit('BossSpawned', { hp: 1400, maxHp: 1400, phase: 1 });
    bus.emit('BossHpChanged', { hp: 1000, maxHp: 1400, phase: 1 });
    expect(d.state().played).toContain('hp75');
    for (let i = 0; i < 60; i++) d.update(1 / 60);
    // 血量继续下降，不应重播
    bus.emit('BossHpChanged', { hp: 800, maxHp: 1400, phase: 1 });
    expect(d.state().played.filter((x) => x === 'hp75')).toHaveLength(1);
  });
});

describe('回归 · afterCue 撞车要能重试', () => {
  // 缺陷：armedAfter.delete(id) 先于 tryPlay，被挡下就直接丢弃，子 cue 永久不播。
  // 场景构造要点：child 的 delay 必须足够长，使它在 blocker 已占位期间才到点。
  it('子 cue 到点被挡，之后仍能补播', () => {
    const bus = createBus();
    const d = createStoryDirector();
    d.init({
      bus,
      cfg: mk([
        cue('parent', { trigger: { kind: 'tSec', atSec: 0 }, priority: 20, durationMs: 300 }),
        // delay 1200ms：parent 在 0.3s 结束 → child 在 1.5s 到点，
        // 而 blocker 在 0.4s 就已占位（持续 2s），child 必然撞车。
        cue('child', {
          trigger: { kind: 'afterCue', id: 'parent', delayMs: 1200 },
          priority: 5,
          durationMs: 400,
        }),
        cue('blocker', {
          trigger: { kind: 'tSec', atSec: 0.4 },
          priority: 30,
          durationMs: 2000,
        }),
      ]),
    });

    d.update(1 / 60);
    expect(d.state().cue?.id).toBe('parent');

    // 推进到 1.6s：blocker 已占位，child 到点但被挡
    for (let i = 0; i < 96; i++) d.update(1 / 60);
    expect(d.state().played).toContain('parent');
    expect(d.state().played).toContain('blocker');
    expect(d.state().played).not.toContain('child');

    // blocker 播完后（2.4s 结束），child 应补播
    for (let i = 0; i < 60 * 3; i++) d.update(1 / 60);
    expect(d.state().played).toContain('child');
  });
});

describe('回归 · 配置层：同父 afterCue 不能并行抢位', () => {
  // 缺陷：a4_endgame 与 a4_last 同父 a4_hp30，延迟只差 100ms，
  // 结果 a4_endgame 只播 0.1 秒就被 a4_last 打断。
  it('story.json 里不存在「同父并行且延迟过近」的 afterCue 对', () => {
    // 变体 cue 不参与常规触发（由 altOnReplay 代播），与首局 cue 互斥，
    // 不算并行抢位，必须先排除。
    const variantIds = new Set(
      realCfg.cues.filter((c) => c.altOnReplay).map((c) => c.altOnReplay as string),
    );
    const byParent = new Map<string, Array<{ id: string; delay: number }>>();
    for (const c of realCfg.cues) {
      if (c.trigger.kind !== 'afterCue') continue;
      if (variantIds.has(c.id)) continue; // 变体互斥，跳过
      const arr = byParent.get(c.trigger.id) ?? [];
      arr.push({ id: c.id, delay: c.trigger.delayMs ?? 0 });
      byParent.set(c.trigger.id, arr);
    }
    for (const [parent, kids] of byParent) {
      if (kids.length < 2) continue;
      // 同父多条时，延迟差必须够大（>1500ms），否则前一条会被立刻打断
      for (let i = 0; i < kids.length; i++) {
        for (let j = i + 1; j < kids.length; j++) {
          const gap = Math.abs(kids[i].delay - kids[j].delay);
          expect(
            gap,
            `父 ${parent} 下的 ${kids[i].id} 与 ${kids[j].id} 延迟只差 ${gap}ms，会互相打断`,
          ).toBeGreaterThan(1500);
        }
      }
    }
  });

  it('a4_endgame → a4_last 是链式而非并行', () => {
    const last = realCfg.cues.find((c) => c.id === 'a4_last');
    expect(last).toBeTruthy();
    expect(last?.trigger.kind).toBe('afterCue');
    if (last?.trigger.kind === 'afterCue') {
      expect(last.trigger.id).toBe('a4_endgame');
    }
  });
});

describe('回归 · 表现层层级必须高于所有演出层', () => {
  // 缺陷：字幕 z-index 13，但 HUD 15 / 主 HUD 35 / FlowOverlay 40，
  // 导致第一幕台词整段落在 wake 黑屏里，玩家一个字都看不见。
  it('StoryPresenter 的 z-index 全部 ≥ 41（高于 FlowOverlay 的 40）', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '..', '..', '..', 'src', 'ui', 'StoryPresenter.ts'), 'utf8');

    const zIndexes = [...src.matchAll(/z-index:(\d+)/g)].map((m) => Number(m[1]));
    expect(zIndexes.length).toBeGreaterThan(0);
    for (const z of zIndexes) {
      expect(z, `StoryPresenter 里有 z-index:${z}，低于 FlowOverlay 的 40，字幕会被盖住`).toBeGreaterThanOrEqual(41);
    }
  });
});
