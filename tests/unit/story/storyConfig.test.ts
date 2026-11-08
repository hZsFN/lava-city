// tests/unit/story/storyConfig.test.ts
// ============================================================================
// story.json 内容完整性测试 · 纯 Node（不 import three）
// ----------------------------------------------------------------------------
// 与 tools/story/lint-story.mjs 的分工：
//   lint-story.mjs     → 写作文体规范（行宽、行数、感叹号、禁用词）
//   本文件             → 数据完整性 + 与 flow.json 的一致性 + 可触发性
//
// 为什么两层都要：lint 是给人快速跑的 CLI；本文件进 `npm run test`，
// 任何人改台词时若破坏引用关系或时间轴，CI 立刻红。
// ============================================================================

import { describe, it, expect } from 'vitest';

import storyJson from '../../../src/core/config/story.json';
import flowJson from '../../../src/core/config/flow.json';
import type { StoryConfig, StoryCue } from '../../../src/story/types';

const cfg = storyJson as unknown as StoryConfig;
const flow = flowJson as unknown as {
  matchLengthSec: number;
  phases: Array<{ phase: string; startSec: number; endSec: number }>;
};

const cues = cfg.cues;
const byId = new Map<string, StoryCue>(cues.map((c) => [c.id, c]));

/** 被别的 cue 用 altOnReplay 引用的 id = 变体专属，不参与常规触发。 */
const variantIds = new Set(
  cues.filter((c) => c.altOnReplay).map((c) => c.altOnReplay as string),
);

/** 常规可触发 cue（排除变体专属）。 */
const regularCues = cues.filter((c) => !variantIds.has(c.id));

describe('story.json · 基本结构', () => {
  it('至少 24 条常规 cue（低于这个数说明剧情被削了）', () => {
    expect(regularCues.length).toBeGreaterThanOrEqual(24);
  });

  it('cue id 全局唯一', () => {
    expect(byId.size).toBe(cues.length);
  });

  it('每条 cue 的必填字段齐全且类型正确', () => {
    for (const cue of cues) {
      expect(typeof cue.id, `${cue.id} id`).toBe('string');
      expect(cue.id.length, `${cue.id} id 非空`).toBeGreaterThan(0);
      expect(typeof cue.text, `${cue.id} text`).toBe('string');
      expect(cue.text.length, `${cue.id} text 非空`).toBeGreaterThan(0);
      expect(typeof cue.priority, `${cue.id} priority`).toBe('number');
      expect(typeof cue.durationMs, `${cue.id} durationMs`).toBe('number');
      expect(cue.durationMs, `${cue.id} durationMs ≥ minShowMs`).toBeGreaterThanOrEqual(cfg.minShowMs);
      expect(['surface', 'inner'], `${cue.id} world`).toContain(cue.world);
      expect(cue.trigger, `${cue.id} trigger`).toBeTruthy();
    }
  });

  it('inner 世界的 cue 一律压黑边（表里切换要有仪式感）', () => {
    for (const cue of cues) {
      if (cue.world === 'inner') {
        expect(cue.letterbox, `${cue.id} 应为 letterbox:true`).toBe(true);
      }
    }
  });

  it('inner 配置自洽：crystalPerVisit > 0 且 crystalMax ∈ (0,1]', () => {
    expect(cfg.inner.crystalPerVisit).toBeGreaterThan(0);
    expect(cfg.inner.crystalMax).toBeGreaterThan(0);
    expect(cfg.inner.crystalMax).toBeLessThanOrEqual(1);
    // 至少 4 次进入才能到上限，否则第一幕就结晶满了，进度条失去意义
    expect(cfg.inner.crystalMax / cfg.inner.crystalPerVisit).toBeGreaterThanOrEqual(4);
  });
});

describe('story.json · 引用完整性', () => {
  it('altOnReplay 指向存在的 cue', () => {
    for (const cue of cues) {
      if (cue.altOnReplay) {
        expect(byId.has(cue.altOnReplay), `${cue.id} → ${cue.altOnReplay}`).toBe(true);
      }
    }
  });

  it('afterCue 指向存在的 cue', () => {
    for (const cue of cues) {
      if (cue.trigger.kind === 'afterCue') {
        expect(byId.has(cue.trigger.id), `${cue.id} → ${cue.trigger.id}`).toBe(true);
      }
    }
  });

  it('变体 cue 自己不再指向别的变体（禁止套娃）', () => {
    for (const cue of cues) {
      if (variantIds.has(cue.id) && cue.altOnReplay) {
        expect.fail(`变体 cue ${cue.id} 不应再有 altOnReplay`);
      }
    }
  });

  it('phase 触发的阶段名必须在 flow.json 里真实存在', () => {
    const valid = new Set(flow.phases.map((p) => p.phase));
    for (const cue of cues) {
      if (cue.trigger.kind === 'phase') {
        expect(valid.has(cue.trigger.phase), `${cue.id} → ${cue.trigger.phase}`).toBe(true);
      }
    }
  });

  it('tSec 触发必须在单局时长内', () => {
    for (const cue of cues) {
      if (cue.trigger.kind === 'tSec') {
        expect(cue.trigger.atSec, `${cue.id}`).toBeGreaterThanOrEqual(0);
        expect(cue.trigger.atSec, `${cue.id}`).toBeLessThan(flow.matchLengthSec);
      }
    }
  });

  it('window 区间合法且落在单局内', () => {
    for (const cue of cues) {
      if (cue.window) {
        expect(cue.window.fromSec, `${cue.id} from`).toBeGreaterThanOrEqual(0);
        expect(cue.window.toSec, `${cue.id} to > from`).toBeGreaterThan(cue.window.fromSec);
        expect(cue.window.toSec, `${cue.id} to`).toBeLessThanOrEqual(flow.matchLengthSec);
      }
    }
  });

  it('bossHpBelow / coreHpBelow 的阈值在 (0,100]', () => {
    for (const cue of cues) {
      const t = cue.trigger;
      if (t.kind === 'bossHpBelow' || t.kind === 'coreHpBelow') {
        expect(t.pct, `${cue.id}`).toBeGreaterThan(0);
        expect(t.pct, `${cue.id}`).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe('story.json · 五幕结构', () => {
  it('五幕都有台词（迷惘/成长/舍弃/决绝/新生）', () => {
    for (const act of ['a1', 'a2', 'a3', 'a4', 'a5']) {
      const hit = cues.filter((c) => c.id.startsWith(`${act}_`));
      expect(hit.length, `${act} 幕至少 3 条`).toBeGreaterThanOrEqual(3);
    }
  });

  it('第三幕（舍弃）的里世界段落覆盖整个转阶段——这是全片重心', () => {
    const act3 = cues.filter((c) => c.id.startsWith('a3_') && !variantIds.has(c.id));
    expect(act3.length).toBeGreaterThanOrEqual(3);

    // a3_boss2 是第三幕的"出口"：它由 boss2 阶段触发，正是里世界褪去、
    // 玩家回到表世界的第一句。它是幕间缝合点，故意在 surface。
    // 真正的"舍弃"段落 = 转阶段 phase 触发 + 其后 afterCue 串接的整串。
    const letgoChain = act3.filter(
      (c) =>
        (c.trigger.kind === 'phase' && c.trigger.phase === 'transition') ||
        c.trigger.kind === 'afterCue',
    );
    expect(letgoChain.length, '舍弃段落至少 3 条').toBeGreaterThanOrEqual(3);
    for (const cue of letgoChain) {
      expect(cue.world, `${cue.id} 应在里世界`).toBe('inner');
    }
  });

  it('第三幕由转阶段驱动，且用 afterCue 串接而非抢同一时刻', () => {
    const act3 = cues.filter((c) => c.id.startsWith('a3_') && !variantIds.has(c.id));
    const kinds = act3.map((c) => c.trigger.kind);
    expect(kinds).toContain('phase');
    expect(kinds.filter((k) => k === 'afterCue').length).toBeGreaterThanOrEqual(1);
  });

  it('第一幕必须有「首次进入里世界」的 cue（教学玩家这个机制）', () => {
    const act1Inner = cues.filter((c) => c.id.startsWith('a1_') && c.world === 'inner');
    expect(act1Inner.length).toBeGreaterThanOrEqual(1);
    // 且必须很早：用 wake 阶段的进度触发（前 70% 之内），保证开局就让玩家
    // 认识表里世界这个机制，而不是等到打得正激烈才第一次看见。
    const first = act1Inner[0];
    const t = first.trigger;
    if (t.kind === 'phaseProgress') {
      expect(t.phase).toBe('wake');
      expect(t.pct).toBeLessThanOrEqual(70);
    } else if (t.kind === 'tSec') {
      expect(t.atSec).toBeLessThanOrEqual(15);
    } else {
      expect.fail(`第一幕首个里世界 cue 应由 wake 阶段进度驱动，实际 ${t.kind}`);
    }
  });

  it('结局失败原因各有专属台词，且与 flow 的 reason 对得上', () => {
    const reasons = cues
      .filter((c) => c.trigger.kind === 'event' && c.trigger.event === 'MatchEnded')
      .map((c) => {
        const t = c.trigger;
        if (t.kind !== 'event' || !t.match) return null;
        return (t.match as Record<string, unknown>).reason ?? null;
      })
      .filter((r): r is string => typeof r === 'string');
    expect(reasons).toContain('core_destroyed');
    expect(reasons).toContain('player_out_of_lives');
    expect(reasons).toContain('timeout');
    expect(reasons).toContain('lava_swallowed');
  });
});

describe('story.json · 多周目变体', () => {
  it('至少 3 个触发点有第二周目真相版台词', () => {
    const withAlt = cues.filter((c) => c.altOnReplay);
    expect(withAlt.length).toBeGreaterThanOrEqual(3);
  });

  it('每个变体都真的存在且文本不同（不能复制粘贴忘了改）', () => {
    for (const cue of cues) {
      if (!cue.altOnReplay) continue;
      const alt = byId.get(cue.altOnReplay);
      expect(alt, `${cue.id} 的变体`).toBeTruthy();
      expect(alt?.text, `${cue.id} 与变体文本必须不同`).not.toBe(cue.text);
    }
  });

  it('变体比首局更"里世界"（真相要用里世界讲）', () => {
    for (const cue of cues) {
      if (!cue.altOnReplay) continue;
      const alt = byId.get(cue.altOnReplay);
      if (cue.world === 'surface') {
        expect(alt?.world, `${cue.id} 的变体应切到里世界`).toBe('inner');
      }
    }
  });
});

describe('story.json · 说话人与基调', () => {
  it('只有 引路人 / 伊格纳斯 两个具名说话人', () => {
    for (const cue of cues) {
      if (cue.speaker === undefined) continue;
      expect(['引路人', '伊格纳斯'], `${cue.id}`).toContain(cue.speaker);
    }
  });

  it('旁白占比足够（旁白是这部剧情的主声部）', () => {
    const narration = cues.filter((c) => c.speaker === undefined).length;
    expect(narration / cues.length).toBeGreaterThanOrEqual(0.35);
  });

  it('引路人与伊格纳斯都真的说过话（不是只在设定里存在）', () => {
    expect(cues.some((c) => c.speaker === '引路人')).toBe(true);
    expect(cues.some((c) => c.speaker === '伊格纳斯')).toBe(true);
  });

  it('全片不出现感叹号（基调是疲惫，不是热血）', () => {
    for (const cue of cues) {
      expect(/[!！]/.test(cue.text), `${cue.id} 含感叹号`).toBe(false);
    }
  });

  it('全片不出现 IP 词汇（平台红线）', () => {
    const ip = ['任天堂', 'Nintendo', '迪士尼', 'Disney', '原神', 'Genshin', '米哈游',
      '宝可梦', 'Pokemon', 'Pokémon', 'Mario', '马里奥', '漫威', 'Marvel', 'Minecraft', '我的世界'];
    for (const cue of cues) {
      for (const w of ip) {
        expect(cue.text.includes(w), `${cue.id} 含 ${w}`).toBe(false);
      }
    }
  });

  it('台词不解释设定（不出现"这个世界/规则是/传说中"这类解说腔）', () => {
    const banned = ['这个世界', '规则是', '传说中', '顾名思义', '众所周知'];
    for (const cue of cues) {
      for (const p of banned) {
        expect(cue.text.includes(p), `${cue.id} 含解说词 ${p}`).toBe(false);
      }
    }
  });
});

describe('story.json · 节奏', () => {
  it('表里世界都有足量台词（不能一边倒）', () => {
    const surface = cues.filter((c) => c.world === 'surface').length;
    const inner = cues.filter((c) => c.world === 'inner').length;
    expect(surface).toBeGreaterThanOrEqual(10);
    expect(inner).toBeGreaterThanOrEqual(10);
  });

  it('里世界总时长占单局 8%–25%（太多变 MV，太少没存在感）', () => {
    const innerMs = cues
      .filter((c) => c.world === 'inner')
      .reduce((s, c) => s + c.durationMs + (c.holdInnerMs ?? 0), 0);
    const ratio = innerMs / 1000 / flow.matchLengthSec;
    expect(ratio).toBeGreaterThanOrEqual(0.08);
    expect(ratio).toBeLessThanOrEqual(0.25);
  });

  it('没有任何一条 cue 长到把整个阶段占满（单条 ≤ 12s）', () => {
    for (const cue of cues) {
      expect(cue.durationMs, `${cue.id}`).toBeLessThanOrEqual(12000);
    }
  });
});
