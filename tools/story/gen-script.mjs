// tools/story/gen-script.mjs
// ============================================================================
// 台词脚本生成器 · 确定性脚本
// ----------------------------------------------------------------------------
// 从 src/core/config/story.json 生成 docs/剧情/熔心孤塔_台词脚本.md。
//
// 为什么要有这个脚本：
//   台词是唯一会被人反复改的内容。手写一份"给人看的台词表"必然与 JSON 脱节，
//   最后配音/本地化拿到的是过期版本。所以台词表必须**从配置生成**，不许手写。
//
// 用法： node tools/story/gen-script.mjs
// 退出码：0 = 已写入；1 = 读取失败
// ============================================================================

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

const story = JSON.parse(readFileSync(join(ROOT, 'src', 'core', 'config', 'story.json'), 'utf8'));
const flow = JSON.parse(readFileSync(join(ROOT, 'src', 'core', 'config', 'flow.json'), 'utf8'));

const phaseSpan = new Map(flow.phases.map((p) => [p.phase, { s: p.startSec, e: p.endSec }]));
const variantIds = new Set(story.cues.filter((c) => c.altOnReplay).map((c) => c.altOnReplay));
const byId = new Map(story.cues.map((c) => [c.id, c]));

const ACTS = {
  a1: '第一幕 · 迷惘',
  a2: '第二幕 · 成长',
  a3: '第三幕 · 舍弃',
  a4: '第四幕 · 决绝',
  a5: '第五幕 · 新生',
};

function fmt(sec) {
  const m = Math.floor(sec / 60);
  return `${m}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}

/** 把触发条件翻译成人类可读的"大概什么时候"。 */
function describeTrigger(t) {
  if (!t) return '—';
  switch (t.kind) {
    case 'phase': {
      const p = phaseSpan.get(t.phase);
      return p ? `约 ${fmt(p.s)}（${t.phase} 起）` : `${t.phase} 起`;
    }
    case 'phaseProgress': {
      const p = phaseSpan.get(t.phase);
      if (!p) return `${t.phase} ${t.pct}%`;
      const at = p.s + (p.e - p.s) * (t.pct / 100);
      return `约 ${fmt(at)}（${t.phase} ${t.pct}%）`;
    }
    case 'bossHpBelow':
      return `Boss 血量 <${t.pct}%`;
    case 'coreHpBelow':
      return `塔心 <${t.pct}%`;
    case 'playerHpBelow':
      return `玩家血量 <${t.pct}%`;
    case 'lavaAbove':
      return `熔岩升到 ${t.y}`;
    case 'lavaRising':
      return `熔岩上涨 ≥${t.risePerSec}/s`;
    case 'event':
      return `事件 ${t.event}${t.match ? ` ${JSON.stringify(t.match)}` : ''}`;
    case 'count':
      return `事件 ${t.event} 第 ${t.n} 次`;
    case 'afterCue':
      return `接「${t.id}」（+${t.delayMs ?? 0}ms）`;
    case 'tSec':
      return fmt(t.atSec);
    default:
      return t.kind;
  }
}

const lines = [];
lines.push('# 《熔心孤塔》台词脚本（配音 / 本地化用）');
lines.push('');
lines.push('> **本文件由 `node tools/story/gen-script.mjs` 从 `src/core/config/story.json` 自动生成，请勿手改。**');
lines.push(`> 共 ${story.cues.length} 条 cue（${story.cues.length - variantIds.size} 条常规 + ${variantIds.size} 条多周目变体）。`);
lines.push('> 说话人：引路人 / 伊格纳斯 / 旁白（无 speaker，游戏内以斜体显示）。');
lines.push('> `／` 表示换行（游戏内分两行显示）。');
lines.push('');
lines.push('---');
lines.push('');

for (const act of Object.keys(ACTS)) {
  const list = story.cues.filter((c) => c.id.startsWith(`${act}_`) && !variantIds.has(c.id));
  if (list.length === 0) continue;
  lines.push(`## ${ACTS[act]}`);
  lines.push('');
  for (const cue of list) {
    const speaker = cue.speaker ?? '（旁白）';
    const world = cue.world === 'inner' ? '**里世界**' : '表世界';
    lines.push(`### \`${cue.id}\``);
    lines.push('');
    lines.push(
      `- 说话人：**${speaker}** ｜ 世界：${world} ｜ 触发：${describeTrigger(cue.trigger)} ｜ ` +
        `时长：${(cue.durationMs / 1000).toFixed(1)}s ｜ 优先级：${cue.priority}`,
    );
    if (cue.letterbox) lines.push('- 压黑边：是');
    if (cue.holdInnerMs) lines.push(`- 里世界余韵：${cue.holdInnerMs}ms`);
    lines.push('');
    lines.push(`> ${cue.text.replace(/\n/g, '／')}`);
    lines.push('');
  }
}

// ── 结局 ──
const endings = story.cues.filter(
  (c) => c.trigger.kind === 'event' && c.trigger.event === 'MatchEnded' && !variantIds.has(c.id),
);
if (endings.length > 0) {
  lines.push('## 结局');
  lines.push('');
  for (const cue of endings) {
    const m = cue.trigger.kind === 'event' ? cue.trigger.match : null;
    const cond =
      m && m.result ? '胜利' : m && m.reason ? `失败 · ${m.reason}` : '结局';
    lines.push(`### \`${cue.id}\` · ${cond}`);
    lines.push('');
    lines.push(
      `- 说话人：**${cue.speaker ?? '（旁白）'}** ｜ 世界：${cue.world === 'inner' ? '**里世界**' : '表世界'} ｜ 时长：${(cue.durationMs / 1000).toFixed(1)}s`,
    );
    lines.push('');
    lines.push(`> ${cue.text.replace(/\n/g, '／')}`);
    lines.push('');
  }
}

// ── 多周目变体 ──
const variants = story.cues.filter((c) => c.altOnReplay);
if (variants.length > 0) {
  lines.push('---');
  lines.push('');
  lines.push('## 多周目变体（第二局起替换首局台词）');
  lines.push('');
  lines.push('> 同一个触发点，第二局改播真相版。这是"重复挑战即叙事"的载体。');
  lines.push('');
  for (const first of variants) {
    const alt = byId.get(first.altOnReplay);
    if (!alt) continue;
    lines.push(`### \`${first.id}\` → \`${alt.id}\``);
    lines.push('');
    lines.push(`- 首局（${first.world === 'inner' ? '里世界' : '表世界'}）：`);
    lines.push(`  > ${first.text.replace(/\n/g, '／')}`);
    lines.push('');
    lines.push(`- 第二局起（${alt.world === 'inner' ? '里世界' : '表世界'}）：`);
    lines.push(`  > ${alt.text.replace(/\n/g, '／')}`);
    lines.push('');
  }
}

const out = lines.join('\n');
writeFileSync(join(ROOT, 'docs', '剧情', '熔心孤塔_台词脚本.md'), out, 'utf8');
console.log(`[gen-script] 已生成 docs/剧情/熔心孤塔_台词脚本.md（${story.cues.length} 条 cue，${Buffer.byteLength(out, 'utf8')} 字节）`);
