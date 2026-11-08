// 离线化：把 SurtrRig.html 里的 ES module（importmap + CDN three.js）打包成一段内联的经典 <script>，
// 产物不依赖网络、也不依赖 file:// 下的模块加载，双击即可打开。
//
// 用法：node tools/build.mjs && node tools/offline.mjs
// esbuild 查找顺序：本项目 node_modules → 环境变量 ESBUILD_DIR 指向的 node_modules

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let esbuild;
try {
  esbuild = await import('esbuild');
} catch {
  const dir = process.env.ESBUILD_DIR;
  if (!dir) throw new Error('找不到 esbuild：npm i -D esbuild，或设置 ESBUILD_DIR');
  esbuild = await import(pathToFileURL(resolve(dir, 'esbuild/lib/main.js')).href);
}

const htmlPath = resolve(ROOT, 'SurtrRig.html');
let html = readFileSync(htmlPath, 'utf8');
const open = '<script type="module">';
const start = html.indexOf(open);
if (start < 0) {
  console.log('[离线化] 已是离线版（没有 module 脚本），跳过');
  process.exit(0);
}
const end = html.indexOf('</script>', start);
const code = html.slice(start + open.length, end);

const out = await esbuild.build({
  stdin: { contents: code, resolveDir: ROOT, loader: 'js' },
  bundle: true,
  format: 'iife',
  minify: true,
  target: 'es2020',
  write: false,
  logLevel: 'error',
});
const bundled = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

html = html.slice(0, start) + '<script>\n' + bundled + '\n' + html.slice(end);
html = html.replace(/<script type="importmap">[\s\S]*?<\/script>\s*/, '');
html = html.replace(/本页需要联网从 jsDelivr 获取 three\.js（r170）；若长时间无画面，请检查网络后刷新。/g, '若长时间无画面，请换用最新版 Chrome / Edge 打开，并确认已开启硬件加速（WebGL）。');
writeFileSync(htmlPath, html, 'utf8');
console.log(`[离线化] 完成：${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MB，无外部依赖`);
