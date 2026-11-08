// tools/story/simulate-story.mjs
// ============================================================================
// 剧情时间轴干跑 · 确定性脚本
// ----------------------------------------------------------------------------
// 目的：在不开浏览器、不接 Boss 的前提下，用 flow.json 的真实阶段时刻
// 把 story.json 的全部 cue 干跑一遍，回答三个问题：
//   ① 主线（phase / tSec 驱动）的 cue 是否都在单局 270s 内触发？
//   ② 有没有两条 cue 抢同一个时刻（会被 priority 吃掉，等于写了没播）？
//   ③ 每一条里世界 cue 落在哪个战斗节点上（人工核对"机制即叙事"是否成立）？
//
// 只模拟主线触发（phase / tSec / afterCue / bossHpBelow / coreHpBelow 用
// 阶段内均匀假设）。event 类依赖 Boss 接线，这里按"人工指定时刻"模拟，
// 并在报告里标明哪些是推测时刻。
//
// 用法： node tools/story/simulate-story.mjs
// ============================================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

const story = JSON.parse(readFileSync(join(ROOT, 'src', 'core', 'config', 'story.json'), 'utf8'));
const flow = JSON.parse(readFileSync(join(ROOT, 'src', 'core', 'config', 'flow.json'), 'utf8'));
const arena = JSON.parse(readFileSync(join(ROOT, 'src', 'core', 'config', 'arena.json'), 'utf8'));

const cues = story.cues;
const byId = new Map(cues.map((c) => [c.id, c]));

// 变体专属：不参与常规扫描
const variantIds = new Set(cues.filter((c) => c.altOnReplay).map((c) => c.altOnReplay));

// ── 阶段时刻表 ────────────────────────────────────────────────────────────
// 注意：flow.json 里同一个 phase 可能被拆成多段（wake 的 dark / blur）。
// 必须合并成「语义阶段」的跨度，否则 phaseProgress 的百分比会算错。
const phases = flow.phases;
const phaseStart = new Map();
const phaseEnd = new Map();
for (const p of phases) {
  if (!phaseStart.has(p.phase)) {
    phaseStart.set(p.phase, p.startSec);
    phaseEnd.set(p.phase, p.endSec);
  } else {
    phaseStart.set(p.phase, Math.min(phaseStart.get(p.phase), p.startSec));
    phaseEnd.set(p.phase, Math.max(phaseEnd.get(p.phase), p.endSec));
  }
}
const MATCH_END = flow.matchLengthSec;

/**
 * Boss 血量阈值的推测触发时刻。
 * 假设：阶段 I 打满 90s 掉 100% → 75% 在 boss1 起 +22.5s；50% 在 +45s。
 * 阶段 II 打满 115s 掉 100% → 30% 在 boss2 起 +80s。
 * 这些是**推测值**，接上 Boss 后由真实 BossHpChanged 驱动。
 */
const HP_ASSUMED = {
  75: phaseStart.get('boss1') + 22.5,
  50: phaseStart.get('boss1') + 45,
  30: phaseStart.get('boss2') + 80,
};

/**
 * 事件类 cue 的推测时刻（用于检查"不会挤在一起"）。
 * 接上 Boss 后这些时刻由真实事件决定。
 */
const EVENT_ASSUMED = {
  TowerPlaced: phaseStart.get('tutorial') + 8,
  'WeaknessExposed:core': phaseStart.get('boss1') + 12,
  ExecutionEnded: phaseStart.get('boss1') + 30,
  KneeBroken: phaseStart.get('boss2') + 25,
  TauntStarted: phaseStart.get('boss2') + 10,
  FreezeFull: phaseStart.get('boss2') + 18,
  PlayerDied: phaseStart.get('boss2') + 55,
};

// ── 解算每条 cue 的触发时刻 ────────────────────────────────────────────────
const scheduled = []; // { id, at, how, guess }
const unscheduled = [];

function scheduleOf(cue, depth = 0) {
  if (depth > 8) return null;
  const t = cue.trigger;
  if (!t) return null;
  switch (t.kind) {
    case 'phase':
      return phaseStart.has(t.phase) ? { at: phaseStart.get(t.phase), how: `phase=${t.phase}` } : null;
    case 'phaseProgress': {
      const s = phaseStart.get(t.phase);
      const e = phaseEnd.get(t.phase);
      if (s === undefined || e === undefined) return null;
      const at = s + (e - s) * (t.pct / 100);
      return { at, how: `${t.phase}@${t.pct}%` };
    }
    case 'bossPhase':
      return { at: t.to === 2 ? phaseStart.get('transition') : phaseStart.get('boss1'), how: `bossPhase=${t.to}` };
    case 'tSec':
      return { at: t.atSec, how: `tSec=${t.atSec}` };
    case 'bossHpBelow':
      return HP_ASSUMED[t.pct] !== undefined
        ? { at: HP_ASSUMED[t.pct], how: `bossHp<${t.pct}%（推测）`, guess: true }
        : null;
    case 'playerHpBelow': {
      // 玩家血量跌破：假设在 boss2 中段某次受伤
      const at = phaseStart.get('boss2') + (phaseEnd.get('boss2') - phaseStart.get('boss2')) * 0.45;
      return { at, how: `playerHp<${t.pct}%（推测）`, guess: true };
    }
    case 'lavaAbove': {
      // 熔岩在 matchLengthSec（rage.atSec）才开始上涨，反解到达 y 的时刻
      const startY = arena.lava?.phase2RiseTo ?? -0.8;
      const rate = flow.rage?.risePerSec ?? 1;
      const riseStart = flow.rage?.atSec ?? MATCH_END;
      const need = (t.y - startY) / rate;
      if (need < 0) return null; // 该高度在上涨开始前就已达到，不会由上涨触发
      return { at: riseStart + need, how: `lava>${t.y}（推算）` };
    }
    case 'lavaRising':
      return { at: flow.rage?.atSec ?? MATCH_END, how: `lavaRising>=${t.risePerSec}`, guess: true };
    case 'coreHpBelow': {
      const at = phaseStart.get('boss2') + (phaseEnd.get('boss2') - phaseStart.get('boss2')) * 0.6;
      return { at, how: `coreHp<${t.pct}%（推测）`, guess: true };
    }
    case 'event': {
      const key = t.match?.part ? `${t.event}:${t.match.part}` : t.event;
      const at = EVENT_ASSUMED[key];
      return at !== undefined ? { at, how: `${key}（推测）`, guess: true } : null;
    }
    case 'afterCue': {
      const parent = byId.get(t.id);
      if (!parent) return null;
      const p = scheduleOf(parent, depth + 1);
      if (!p) return null;
      const parentEnd = p.at + (parent.durationMs + (parent.holdInnerMs ?? 0)) / 1000;
      return { at: parentEnd + (t.delayMs ?? 0) / 1000, how: `after:${t.id}`, guess: p.guess };
    }
    case 'count':
      return EVENT_ASSUMED[t.event] !== undefined
        ? { at: EVENT_ASSUMED[t.event], how: `${t.event}#${t.n}（推测）`, guess: true }
        : null;
    default:
      return null;
  }
}

for (const cue of cues) {
  if (variantIds.has(cue.id)) continue;
  const s = scheduleOf(cue);
  if (!s) {
    unscheduled.push(cue);
    continue;
  }
  scheduled.push({ cue, at: s.at, how: s.how, guess: !!s.guess });
}

scheduled.sort((a, b) => a.at - b.at || b.cue.priority - a.cue.priority);

// ── 冲突检测：两条 cue 的显示区间重叠且优先级不足以打断 ────────────────────
const overlaps = [];
for (let i = 0; i < scheduled.length; i++) {
  for (let j = i + 1; j < scheduled.length; j++) {
    const A = scheduled[i];
    const B = scheduled[j];
    const aEnd = A.at + (A.cue.durationMs + (A.cue.holdInnerMs ?? 0)) / 1000;
    if (B.at >= aEnd) break;
    // B 在 A 的显示区间内
    const winner = B.cue.priority > A.cue.priority ? 'B' : 'A';
    overlaps.push({
      a: A.cue.id, aAt: A.at, aEnd,
      b: B.cue.id, bAt: B.at,
      winner,
      silent: winner === 'A', // B 被吃掉 → 写了没播
    });
  }
}

// ── 报告 ──────────────────────────────────────────────────────────────────
function fmt(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
function pad(s, n) {
  // 中文字符按 2 宽
  let w = 0;
  for (const ch of s) w += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
  return s + ' '.repeat(Math.max(0, n - w));
}

console.log('===== 剧情时间轴干跑 =====');
console.log(`单局时长 ${MATCH_END}s ｜ 常规 cue ${scheduled.length} 条 ｜ 变体专属 ${variantIds.size} 条`);
console.log('');

// 按阶段分组输出（只列 flow.json 里真实存在的阶段）
const groups = ['wake', 'tutorial', 'prep', 'boss1', 'transition', 'boss2', 'victory', 'escape']
  .filter((p) => phaseStart.has(p))
  .map((p) => [p, phaseStart.get(p), phaseEnd.get(p)]);

for (const [name, from, to] of groups) {
  const inGroup = scheduled.filter((s) => s.at >= from && s.at < to);
  if (inGroup.length === 0) continue;
  console.log(`── ${name}  ${fmt(from)}–${fmt(to)}  ${'─'.repeat(28)}`);
  for (const s of inGroup) {
    const world = s.cue.world === 'inner' ? '里' : '表';
    const guess = s.guess ? '*' : ' ';
    const text1 = (s.cue.text ?? '').split('\n')[0];
    console.log(
      `  ${fmt(s.at)} ${world}${guess} ${pad(s.cue.id, 20)} p${String(s.cue.priority).padStart(2)} ` +
      `${String((s.cue.durationMs / 1000).toFixed(1)).padStart(4)}s  ${text1}`,
    );
  }
  console.log('');
}

// 超出单局的
const late = scheduled.filter((s) => s.at >= MATCH_END);
if (late.length) {
  console.log('⚠ 超出单局时长的 cue：');
  for (const s of late) console.log(`  ${fmt(s.at)} ${s.cue.id}`);
  console.log('');
}

// 未排上时刻的
if (unscheduled.length) {
  console.log('○ 无推测时刻（需真实 Boss 事件才能触发，属预期）：');
  for (const c of unscheduled) {
    console.log(`  ${pad(c.id, 20)} ${c.trigger?.kind} ${JSON.stringify(c.trigger)}`);
  }
  console.log('');
}

// 冲突
console.log(`── 冲突检测  ${'─'.repeat(30)}`);
if (overlaps.length === 0) {
  console.log('  ✓ 无重叠');
} else {
  const silent = overlaps.filter((o) => o.silent);
  console.log(`  共 ${overlaps.length} 处区间重叠，其中 ${silent.length} 处会被高优先级吃掉（写了没播）：`);
  for (const o of overlaps) {
    const tag = o.silent ? '✗ 静默丢失' : '· 正常打断';
    console.log(
      `  ${tag}  ${fmt(o.aAt)}–${fmt(o.aEnd)} ${pad(o.a, 20)} ← ${fmt(o.bAt)} ${o.b}`,
    );
  }
}
console.log('');

// 节奏核对：里世界密度
const innerCues = scheduled.filter((s) => s.cue.world === 'inner');
const innerSec = innerCues.reduce((sum, s) => sum + (s.cue.durationMs + (s.cue.holdInnerMs ?? 0)) / 1000, 0);
console.log(`── 节奏核对  ${'─'.repeat(30)}`);
console.log(`  里世界 cue ${innerCues.length} 条，累计 ${innerSec.toFixed(1)}s（占单局 ${(innerSec / MATCH_END * 100).toFixed(1)}%）`);
console.log(`  表世界 cue ${scheduled.length - innerCues.length} 条`);
const firstInner = innerCues[0];
if (firstInner) console.log(`  首次进入里世界：${fmt(firstInner.at)}（${firstInner.cue.id}）`);
const longestGap = (() => {
  let max = 0, at = 0;
  for (let i = 1; i < scheduled.length; i++) {
    const gap = scheduled[i].at - scheduled[i - 1].at;
    if (gap > max) { max = gap; at = scheduled[i - 1].at; }
  }
  return { max, at };
})();
console.log(`  最长无台词空窗：${longestGap.max.toFixed(1)}s（自 ${fmt(longestGap.at)} 起）`);
console.log('');

if (overlaps.some((o) => o.silent)) {
  console.log('【结果】✗ 存在会被静默吃掉的 cue，需要调 priority 或改用 afterCue 串接');
  process.exit(1);
}
console.log('【结果】✓ 主线 cue 全部排上时刻，无静默丢失');
process.exit(0);
