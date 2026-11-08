// tools/story/lint-story.mjs
// ============================================================================
// 剧情台词规范校验 · 确定性脚本（无外部依赖，node 直接跑）
// ----------------------------------------------------------------------------
// 校验 docs/剧情/熔心孤塔_剧情设计.md 第九节「写作规范」的每一条：
//   ① 单行 ≤ 22 汉字（CJK 字符 + 全角标点各计 1）
//   ② 标准 cue ≤ 2 行；durationMs ≥ 4000 的关键 cue ≤ 3 行
//   ③ 全片不出现感叹号（中英文都不行）
//   ④ 不出现设定解说词（这个世界 / 规则是 / 传说中 / 顾名思义）
//   ⑤ 不使用 IP 词汇
//   ⑥ id 唯一；altOnReplay 指向存在的 cue；被指向的 cue 不参与常规触发
//   ⑦ trigger 字段完整；world 只能是 surface / inner
//   ⑧ 每条 cue 必须有 world / priority / durationMs / text
//   ⑨ inner 世界必须有 letterbox 或明确不压边（这里要求 inner 一律压边）
//   ⑩ 单局 cue 总数与各幕数量统计（供人工核对节奏）
//
// 用法： node tools/story/lint-story.mjs
// 退出码：0 = 全通过；1 = 有违规
// ============================================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const CFG_PATH = join(ROOT, 'src', 'core', 'config', 'story.json');

const MAX_LINE_CJK = 22;
const MAX_LINES_STD = 2;
const MAX_LINES_LONG = 3;
const LONG_CUE_MS = 4000;

const IP_WORDS = [
  '任天堂', 'Nintendo', '迪士尼', 'Disney', '原神', 'Genshin', '米哈游',
  '宝可梦', 'Pokemon', 'Pokémon', 'Mario', '马里奥', '漫威', 'Marvel',
  'Minecraft', '我的世界',
];
const BANNED_PHRASES = ['这个世界', '规则是', '传说中', '顾名思义', '众所周知'];

/** 统计一行的"显示宽度"：CJK/全角算 1，ASCII 算 0.5，向上取整。 */
function displayWidth(line) {
  let w = 0;
  for (const ch of line) {
    const cp = ch.codePointAt(0);
    // CJK 统一表意文字、全角标点、假名、谚文
    const isWide =
      (cp >= 0x3000 && cp <= 0x303f) || // CJK 标点
      (cp >= 0x3040 && cp <= 0x30ff) || // 假名
      (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意
      (cp >= 0xff00 && cp <= 0xffef) || // 全角形式
      (cp >= 0xac00 && cp <= 0xd7af); // 谚文
    w += isWide ? 1 : 0.5;
  }
  return w;
}

const violations = [];
const notes = [];
function fail(cueId, msg) {
  violations.push(`[${cueId}] ${msg}`);
}

let raw;
try {
  raw = readFileSync(CFG_PATH, 'utf8');
} catch (e) {
  console.error(`无法读取 ${CFG_PATH}: ${e.message}`);
  process.exit(1);
}

let cfg;
try {
  cfg = JSON.parse(raw);
} catch (e) {
  console.error(`story.json 不是合法 JSON: ${e.message}`);
  process.exit(1);
}

if (!Array.isArray(cfg.cues)) {
  console.error('story.json 缺少 cues 数组');
  process.exit(1);
}

const cues = cfg.cues;
const byId = new Map();
const variantIds = new Set();

// ── 先收集 id 与变体集合 ──────────────────────────────────────────────────
for (const cue of cues) {
  if (!cue.id || typeof cue.id !== 'string') {
    violations.push('[?] cue 缺少 id');
    continue;
  }
  if (byId.has(cue.id)) fail(cue.id, `id 重复`);
  byId.set(cue.id, cue);
  if (cue.altOnReplay) variantIds.add(cue.altOnReplay);
}

// ── 逐条校验 ──────────────────────────────────────────────────────────────
const VALID_TRIGGER = new Set([
  'phase', 'phaseProgress', 'bossPhase', 'bossHpBelow', 'coreHpBelow', 'playerHpBelow',
  'lavaAbove', 'lavaRising', 'event', 'count', 'tSec', 'afterCue',
]);

for (const cue of cues) {
  const id = cue.id ?? '?';

  // ⑧ 必填字段
  for (const key of ['trigger', 'priority', 'durationMs', 'world', 'text']) {
    if (cue[key] === undefined) fail(id, `缺少必填字段 ${key}`);
  }
  if (typeof cue.durationMs === 'number' && cue.durationMs < (cfg.minShowMs ?? 0)) {
    fail(id, `durationMs ${cue.durationMs} < minShowMs ${cfg.minShowMs}`);
  }
  if (typeof cue.priority !== 'number' || !Number.isFinite(cue.priority)) {
    fail(id, `priority 必须是有限数字`);
  }
  if (cue.world !== 'surface' && cue.world !== 'inner') {
    fail(id, `world 必须是 surface 或 inner，实际 ${JSON.stringify(cue.world)}`);
  }

  // ⑦ trigger 完整性
  const trg = cue.trigger;
  if (trg && typeof trg === 'object') {
    if (!VALID_TRIGGER.has(trg.kind)) {
      fail(id, `未知 trigger.kind: ${JSON.stringify(trg.kind)}`);
    } else {
      const need = {
        phase: 'phase',
        phaseProgress: 'pct',
        bossPhase: 'to',
        bossHpBelow: 'pct',
        coreHpBelow: 'pct',
        playerHpBelow: 'pct',
        lavaAbove: 'y',
        lavaRising: 'risePerSec',
        event: 'event',
        count: 'n',
        tSec: 'atSec',
        afterCue: 'id',
      }[trg.kind];
      if (need && trg[need] === undefined) fail(id, `trigger.kind=${trg.kind} 缺少字段 ${need}`);
      if (trg.kind === 'afterCue' && trg.id && !byId.has(trg.id)) {
        fail(id, `afterCue 指向不存在的 cue: ${trg.id}`);
      }
      if (trg.kind === 'phaseProgress') {
        if (!trg.phase) fail(id, 'phaseProgress 缺少 phase');
        if (typeof trg.pct !== 'number' || trg.pct < 0 || trg.pct > 100) {
          fail(id, `phaseProgress.pct 必须在 [0,100]，实际 ${trg.pct}`);
        }
      }
      if ((trg.kind === 'bossHpBelow' || trg.kind === 'coreHpBelow' ||
           trg.kind === 'playerHpBelow') &&
          (typeof trg.pct !== 'number' || trg.pct <= 0 || trg.pct > 100)) {
        fail(id, `pct 必须在 (0,100]，实际 ${trg.pct}`);
      }
      if (trg.kind === 'lavaAbove' && typeof trg.y !== 'number') {
        fail(id, `lavaAbove.y 必须是数字`);
      }
      if (trg.kind === 'count' && (typeof trg.n !== 'number' || trg.n < 1)) {
        fail(id, `count.n 必须 ≥ 1，实际 ${trg.n}`);
      }
    }
  } else {
    fail(id, 'trigger 必须是对象');
  }

  // ⑥ altOnReplay
  if (cue.altOnReplay && !byId.has(cue.altOnReplay)) {
    fail(id, `altOnReplay 指向不存在的 cue: ${cue.altOnReplay}`);
  }

  // ⑨ inner 必须压边
  if (cue.world === 'inner' && cue.letterbox !== true) {
    fail(id, `world=inner 必须显式 letterbox: true`);
  }

  // ②③④⑤⑩ 文本规则
  if (typeof cue.text !== 'string') {
    fail(id, 'text 必须是字符串');
    continue;
  }
  const text = cue.text;
  if (text.length === 0) fail(id, 'text 为空');

  if (/[!！]/.test(text)) fail(id, `出现感叹号（全片禁用）：${text}`);

  for (const w of IP_WORDS) {
    if (text.includes(w)) fail(id, `出现 IP 词汇「${w}」`);
  }
  for (const p of BANNED_PHRASES) {
    if (text.includes(p)) fail(id, `出现设定解说词「${p}」`);
  }

  const lines = text.split('\n');
  const maxLines = cue.durationMs >= LONG_CUE_MS ? MAX_LINES_LONG : MAX_LINES_STD;
  if (lines.length > maxLines) {
    fail(id, `${lines.length} 行超过上限 ${maxLines}（durationMs=${cue.durationMs}）`);
  }
  lines.forEach((line, i) => {
    if (line.trim().length === 0) fail(id, `第 ${i + 1} 行是空行`);
    const w = displayWidth(line);
    if (w > MAX_LINE_CJK) {
      fail(id, `第 ${i + 1} 行宽 ${w} > ${MAX_LINE_CJK}：「${line}」`);
    }
  });

  // 说话人合法性
  if (cue.speaker !== undefined) {
    const ok = ['引路人', '伊格纳斯'].includes(cue.speaker);
    if (!ok) fail(id, `未知说话人「${cue.speaker}」（只允许 引路人 / 伊格纳斯 / 省略=旁白）`);
  }
}

// ── 统计（不算违规，供人工核对节奏） ─────────────────────────────────────
const surfaceCount = cues.filter((c) => c.world === 'surface').length;
const innerCount = cues.filter((c) => c.world === 'inner').length;
const totalMs = cues.reduce((s, c) => s + (c.durationMs ?? 0), 0);
const speakers = {};
for (const c of cues) {
  const k = c.speaker ?? '（旁白）';
  speakers[k] = (speakers[k] ?? 0) + 1;
}

notes.push(`cue 总数：${cues.length}`);
notes.push(`  表世界 ${surfaceCount} 条 / 里世界 ${innerCount} 条`);
notes.push(`  变体专属（只由 altOnReplay 触发）：${variantIds.size} 条 → ${[...variantIds].join(', ') || '无'}`);
notes.push(`  常规可触发：${cues.length - variantIds.size} 条`);
notes.push(`  台词总时长（串行累加，不代表实际占用）：${(totalMs / 1000).toFixed(1)}s`);
notes.push(`  说话人分布：${Object.entries(speakers).map(([k, v]) => `${k} ${v}`).join(' / ')}`);

// 幕分布（按 id 前缀）
const acts = {};
for (const c of cues) {
  const m = /^a(\d)_/.exec(c.id);
  const k = m ? `第${m[1]}幕` : '其他';
  acts[k] = (acts[k] ?? 0) + 1;
}
notes.push(`  幕分布：${Object.entries(acts).sort().map(([k, v]) => `${k} ${v}`).join(' / ')}`);

// ── 输出 ──────────────────────────────────────────────────────────────────
console.log('===== story.json 规范校验 =====');
console.log('');
console.log('【统计】');
for (const n of notes) console.log(`  ${n}`);
console.log('');

if (violations.length === 0) {
  console.log('【结果】✓ 全部通过（0 项违规）');
  process.exit(0);
}

console.log(`【结果】✗ 发现 ${violations.length} 项违规：`);
for (const v of violations) console.log(`  ${v}`);
process.exit(1);
