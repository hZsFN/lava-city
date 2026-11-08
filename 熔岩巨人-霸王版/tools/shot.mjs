// 截图脚本：对每个 (阶段, 机位) 组合导航到 SurtrRig.html，等模型就绪后截图。
//
// 用法：
//   node tools/shot.mjs                                  # 7 机位 × 2 阶段 = 14 张
//   node tools/shot.mjs --views=hero,front --phases=1
//   node tools/shot.mjs --out=预览图 --size=1920x1080
//   node tools/shot.mjs --html=some.html                 # 覆盖输入 HTML
//
// 输出：<out>/p<phase>_<view>.png
// 退出码：0 = 全部成功且控制台无异常；1 = 有失败或有控制台 error/exception。

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, stat, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { withPage, fileUrl } from './browser.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const ALL_VIEWS = ['hero', 'front', 'side', 'back', 'close', 'low', 'top'];
const ALL_PHASES = [1, 2];

const READY_TIMEOUT_MS = 20000;
const SETTLE_MS = 500;
const NAV_WAIT_MS = 400;

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq < 0) out[a.slice(2)] = true;
    else out[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return out;
}

function parseList(v, fallback) {
  if (!v || v === true) return fallback;
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const t0 = Date.now();

  const htmlPath = resolve(ROOT, args.html || 'SurtrRig.html');
  const outDir = resolve(ROOT, args.out || '预览图');
  const views = parseList(args.views, ALL_VIEWS);
  const phases = parseList(args.phases, ALL_PHASES.map(String)).map((p) => {
    const n = Number(p);
    return n === 2 ? 2 : 1;
  });

  // —— 尺寸参数 --
  let vw = 1600;
  let vh = 1000;
  if (args.size && args.size !== true) {
    const m = /^(\d+)x(\d+)$/i.exec(String(args.size));
    if (!m) {
      console.error(`[截图] --size 格式错误：${args.size}，应为 WxH，例如 1600x1000`);
      process.exit(1);
    }
    vw = Number(m[1]);
    vh = Number(m[2]);
    if (!(vw >= 320 && vh >= 240 && vw <= 7680 && vh <= 4320)) {
      console.error(`[截图] --size 超出合理范围：${vw}x${vh}（320x240 ~ 7680x4320）`);
      process.exit(1);
    }
  }

  // —— 机位/阶段合法性 ——
  const badViews = views.filter((v) => !ALL_VIEWS.includes(v));
  if (badViews.length) {
    console.error(
      `[截图] 未知机位：${badViews.join(', ')}\n  可用机位：${ALL_VIEWS.join(', ')}`,
    );
    process.exit(1);
  }
  if (views.length === 0) {
    console.error('[截图] 没有要拍的机位');
    process.exit(1);
  }

  if (!existsSync(htmlPath)) {
    console.error(
      `[截图] 找不到 ${htmlPath}\n  先跑 \`node tools/build.mjs\` 生成页面。`,
    );
    process.exit(1);
  }
  const htmlStat = await stat(htmlPath);
  if (htmlStat.size < 1024) {
    console.error(`[截图] ${htmlPath} 只有 ${htmlStat.size} 字节，疑似构建不完整。`);
    process.exit(1);
  }

  await mkdir(outDir, { recursive: true });

  // 额外 URL 参数（--params=exposure=0.8,bloom=0.9），原样拼到查询串后面
  // --params-p1 / --params-p2 可按阶段覆盖（阶段 II 通常更亮，需要单独压）
  const parseParams = (raw, label) => {
    const list = [];
    if (!raw || raw === true) return list;
    for (const kv of String(raw).split(',')) {
      const t = kv.trim();
      if (!t) continue;
      if (!/^[A-Za-z_][\w-]*=/.test(t)) {
        console.error(`[截图] ${label} 格式错误：${t}（应为 key=value,key=value）`);
        process.exit(1);
      }
      list.push(t);
    }
    return list;
  };
  const baseParams = parseParams(args.params, '--params');
  const perPhase = {
    1: parseParams(args['params-p1'] ?? args.params1, '--params-p1'),
    2: parseParams(args['params-p2'] ?? args.params2, '--params-p2'),
  };
  /** 合并出某个阶段的最终查询参数（阶段覆盖优先，同名 key 去重）。 */
  const paramsFor = (phase) => {
    const map = new Map();
    for (const kv of baseParams) map.set(kv.slice(0, kv.indexOf('=')), kv);
    for (const kv of perPhase[phase] || []) map.set(kv.slice(0, kv.indexOf('=')), kv);
    return [...map.values()];
  };

  const combos = [];
  for (const p of phases) for (const v of views) combos.push({ phase: p, view: v });

  const ok = [];
  const failed = [];
  const allConsoleErrors = [];

  const paramNote = [];
  for (const p of phases) {
    const list = paramsFor(p);
    if (list.length) paramNote.push(`阶段 ${p}: ${list.join('&')}`);
  }

  console.log(
    `[截图] 目标页面：${htmlPath}\n` +
      `[截图] 输出目录：${outDir}\n` +
      `[截图] 计划拍摄：${combos.length} 张（阶段 ${phases.join('/')} × 机位 ${views.length} 个），` +
      `视口 ${vw}x${vh}` +
      (paramNote.length ? `\n[截图] 额外参数：${paramNote.join(' | ')}` : ''),
  );

  let page = null;
  try {
    await withPage({ width: vw, height: vh, mirror: true }, async (p) => {
      page = p;

      for (const { phase, view } of combos) {
        const fileName = `p${phase}_${view}.png`;
        const filePath = resolve(outDir, fileName);
        const extra = paramsFor(phase);
        const url =
          `${fileUrl(htmlPath)}?phase=${phase}&view=${view}&hud=0&rot=0&weak=0` +
          (extra.length ? `&${extra.join('&')}` : '');

        let done = false;
        for (let attempt = 1; attempt <= 2 && !done; attempt += 1) {
          const consoleMark = p.console.length;
          try {
            await p.goto(url, NAV_WAIT_MS);
            // 等模型就绪
            await p.waitFor(
              'return !!(window.__SURTR__ && window.__SURTR__.ready === true)',
              READY_TIMEOUT_MS,
            );
            // 额外等动画稳定
            await sleep(SETTLE_MS);
            await p.screenshot(filePath);

            const st = await stat(filePath);
            if (st.size < 1024) throw new Error(`截图文件过小（${st.size} 字节）`);

            ok.push({ fileName, phase, view, bytes: st.size, attempt });
            done = true;
            console.log(
              `  ✓ p${phase}_${view}  ${(st.size / 1024).toFixed(0)} KB` +
                (attempt > 1 ? `（第 ${attempt} 次尝试成功）` : ''),
            );
          } catch (e) {
            const msg = e && e.message ? e.message : String(e);
            // 收集本次尝试新产生的 console 错误，方便定位
            const fresh = p.console.slice(consoleMark).filter(isErrorEntry);
            if (attempt < 2) {
              console.warn(`  ! p${phase}_${view} 第 ${attempt} 次失败，重新导航重试：${msg}`);
              if (fresh.length) {
                console.warn(`    页面报错：${fresh.map((l) => l.text).slice(0, 3).join(' | ')}`);
              }
              await sleep(300);
            } else {
              failed.push({
                fileName,
                phase,
                view,
                error: msg,
                pageErrors: fresh.map((l) => l.text).slice(0, 5),
              });
              console.error(`  ✗ p${phase}_${view} 失败（已重试 1 次）：${msg}`);
              await rm(filePath, { force: true }).catch(() => {});
            }
          }
        }
      }

      allConsoleErrors.push(...p.console.filter(isErrorEntry));
    });
  } catch (e) {
    // 浏览器级失败（起不来 / 连不上）——整体失败
    console.error(`\n[截图] 浏览器执行失败：${e && e.message ? e.message : e}`);
    if (failed.length === 0 && ok.length === 0) {
      process.exit(1);
    }
  }

  const ms = Date.now() - t0;

  // —— 控制台错误去重 ——
  const dedupErrors = dedupeConsole(allConsoleErrors);

  console.log('\n================ 截图汇总 ================');
  console.log(`成功：${ok.length} / ${combos.length} 张`);
  if (ok.length) {
    console.log('  成功清单：');
    for (const r of ok) {
      console.log(`    ✓ ${r.fileName}  (${(r.bytes / 1024).toFixed(0)} KB, ${r.attempt} 次尝试)`);
    }
  }
  if (failed.length) {
    console.log(`失败：${failed.length} 张`);
    for (const f of failed) {
      console.log(`    ✗ ${f.fileName}：${f.error}`);
      if (f.pageErrors && f.pageErrors.length) {
        for (const pe of f.pageErrors) console.log(`        页面报错：${pe}`);
      }
    }
  }
  if (dedupErrors.length) {
    console.log(`控制台 error/exception：${dedupErrors.length} 条（去重后）`);
    for (const e of dedupErrors) console.log(`    [${e.kind}] ${e.text} ×${e.count}`);
  } else {
    console.log('控制台 error/exception：无');
  }
  console.log(`耗时：${(ms / 1000).toFixed(1)} s`);
  console.log('==========================================');

  const badExit = failed.length > 0 || dedupErrors.length > 0 || ok.length !== combos.length;
  if (badExit) {
    console.error(
      '\n[截图] FAIL' +
        (failed.length ? ` —— ${failed.length} 张失败` : '') +
        (dedupErrors.length ? `${failed.length ? '，' : ' —— '}控制台有 ${dedupErrors.length} 条异常` : ''),
    );
    process.exit(1);
  }
  console.log('\n[截图] PASS —— 全部成功，控制台干净');
  process.exit(0);
}

function isErrorEntry(l) {
  return (
    l.kind === 'exception' ||
    l.kind === 'error' ||
    l.kind === 'log-error' ||
    (l.kind === 'warning' && /error|fail/i.test(l.text))
  );
}

function dedupeConsole(list) {
  const map = new Map();
  for (const e of list) {
    // 归并同类：把长数字、URL 中的端口等易变部分抹掉，避免同一条错误算多次
    const norm = e.text
      .replace(/https?:\/\/[^\s'"]+/g, '<url>')
      .replace(/\b\d{4,}\b/g, '<n>')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 400);
    const key = `${e.kind}|${norm}`;
    if (map.has(key)) map.get(key).count += 1;
    else map.set(key, { kind: e.kind, text: norm, count: 1 });
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

main().catch((e) => {
  console.error(`[截图] 未捕获异常：${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
