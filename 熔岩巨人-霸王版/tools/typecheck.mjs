// 类型检查封装：跑 `tsc -p tsconfig.json --noEmit`，把输出原样转发，退出码透传。
//
// 用法：
//   node tools/typecheck.mjs
//   node tools/typecheck.mjs --project=tsconfig.json
//
// 为什么不用 `spawnSync('npx', ...)` 直接捕获 stdio：
//   DSH 沙箱下子进程用管道捕获输出可能报 EPERM。这里优先直接调用本地
//   node_modules/typescript/bin/tsc（用当前 node 执行，不经过 shell / npx），
//   拿不到再用 npx；两者都先试「捕获」，失败则退回 stdio:'inherit'。

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

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

const args = parseArgs(process.argv.slice(2));
const project = args.project || 'tsconfig.json';
const projectPath = resolve(ROOT, project);

if (!existsSync(projectPath)) {
  console.error(`[类型检查] 找不到 tsconfig：${projectPath}`);
  process.exit(1);
}

const tscJs = resolve(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const hasLocalTsc = existsSync(tscJs);

/** 候选命令：本地 tsc（node 直跑）优先，其次 npx。 */
const candidates = [];
if (hasLocalTsc) {
  candidates.push({
    label: `node node_modules/typescript/bin/tsc -p ${project} --noEmit`,
    cmd: process.execPath,
    argv: [tscJs, '-p', projectPath, '--noEmit'],
    shell: false,
  });
}
candidates.push({
  label: `npx tsc -p ${project} --noEmit`,
  cmd: 'npx',
  argv: ['tsc', '-p', project, '--noEmit'],
  shell: true,
});

const t0 = Date.now();
let lastResult = null;
let usedLabel = '';

for (const c of candidates) {
  // 先试捕获输出（便于加中文前缀与统计）
  let r = spawnSync(c.cmd, c.argv, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: c.shell,
    timeout: 180000,
  });

  const spawnFailed =
    r.error && (r.error.code === 'EPERM' || r.error.code === 'ENOENT' || r.error.code === 'EACCES');

  if (spawnFailed) {
    // 沙箱限制管道捕获 → 退回 stdio:'inherit'，输出直接进终端
    console.warn(
      `[类型检查] 捕获模式不可用（${r.error.code}），改用 stdio:'inherit' 重试：${c.label}`,
    );
    r = spawnSync(c.cmd, c.argv, {
      cwd: ROOT,
      stdio: 'inherit',
      shell: c.shell,
      timeout: 180000,
    });
    usedLabel = `${c.label}（inherit）`;
    if (r.error && r.error.code !== 'ETIMEDOUT') {
      lastResult = r;
      continue;
    }
    const ms = Date.now() - t0;
    if (r.status === 0) {
      console.log(`[类型检查] PASS —— 0 个错误（${ms} ms）`);
      process.exit(0);
    }
    console.error(`[类型检查] FAIL —— tsc 退出码 ${r.status}（${ms} ms）`);
    process.exit(r.status === null ? 1 : r.status);
  }

  if (r.error && r.error.code === 'ENOENT') {
    lastResult = r;
    continue;
  }

  // 正常拿到输出
  usedLabel = c.label;
  const out = (r.stdout || '').trimEnd();
  const err = (r.stderr || '').trimEnd();
  if (out) console.log(out);
  if (err) console.error(err);

  const ms = Date.now() - t0;
  if (r.status === 0) {
    console.log(`[类型检查] PASS —— 0 个错误（${ms} ms）`);
    process.exit(0);
  }
  // tsc 的报错行数（形如 "SurtrRig.ts(12,3): error TS2322"）
  const errCount = ((r.stdout || '').match(/error TS\d+/g) || []).length;
  console.error(
    `[类型检查] FAIL —— tsc 退出码 ${r.status}` +
      (errCount > 0 ? `，共 ${errCount} 个错误` : '') +
      `（${ms} ms）`,
  );
  process.exit(r.status === null ? 1 : r.status);
}

// 所有候选都没跑起来
console.error(
  `[类型检查] 无法执行 tsc。已尝试：${candidates.map((c) => c.label).join(' / ')}` +
    (lastResult && lastResult.error ? `\n  最后一次错误：${lastResult.error.message}` : ''),
);
process.exit(1);
