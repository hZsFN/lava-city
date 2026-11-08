// 构建脚本：把 SurtrRig.ts 转译成 JS，注入 tools/template.html 的唯一占位标记，
// 产出 SurtrRig.html（UTF-8 无 BOM）。
//
// 用法：
//   node tools/build.mjs                      # 正常构建
//   node tools/build.mjs --model=a.ts --template=b.html --out=c.html
//   node tools/build.mjs --check              # 只做静态检查，不写文件
//
// 退出码：0 = 成功；1 = 失败（缺文件 / 占位标记数量不对 / 转译报错）。
// 幂等：可重复执行，输出完全一致。

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const PLACEHOLDER = '/*__SURTR_MODEL__*/';

/** 解析 --key=value 形式的命令行参数。 */
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

/** 打印可定位的错误：文件 + 行号 + 上下文。 */
function fail(msg, file, line) {
  const where = file ? `${file}${line ? `:${line}` : ''}` : '';
  console.error(`\n[构建失败] ${where ? `(${where}) ` : ''}${msg}`);
  process.exit(1);
}

/** 把 tsc 诊断信息格式化成人能看的一行。 */
function formatDiagnostic(diag, modelPath, sourceText) {
  const pos =
    diag.file && typeof diag.start === 'number'
      ? diag.file.getLineAndCharacterOfPosition(diag.start)
      : null;
  const line = pos ? pos.line + 1 : 0;
  const col = pos ? pos.character + 1 : 0;
  const text = ts.flattenDiagnosticMessageText(diag.messageText, '\n');
  let snippet = '';
  if (line > 0 && sourceText) {
    const srcLine = sourceText.split(/\r?\n/)[line - 1] || '';
    snippet = `\n    ${String(line).padStart(4)} | ${srcLine}`;
    snippet += `\n         | ${' '.repeat(Math.max(0, col - 1))}^`;
  }
  return `${modelPath}:${line}:${col} TS${diag.code}: ${text}${snippet}`;
}

async function main() {
  const t0 = Date.now();
  const args = parseArgs(process.argv.slice(2));

  const modelPath = resolve(ROOT, args.model || 'SurtrRig.ts');
  const templatePath = resolve(ROOT, args.template || 'tools/template.html');
  const outPath = resolve(ROOT, args.out || 'SurtrRig.html');
  const checkOnly = Boolean(args.check);

  // —— 1. 输入文件存在性 ——
  if (!existsSync(modelPath)) {
    fail(
      `模型文件不存在：${modelPath}\n` +
        `  这是 Lead 负责的文件。如果你只想自测工具链，请用 --model=_work/xxx.ts 指定假模型。`,
      modelPath,
    );
  }
  if (!existsSync(templatePath)) {
    fail(
      `模板文件不存在：${templatePath}\n` +
        `  这是 scene-wright 负责的文件，需含恰好一处 ${PLACEHOLDER} 占位行。`,
      templatePath,
    );
  }

  // —— 2. 读入 ——
  let tsSource;
  let template;
  try {
    tsSource = await readFile(modelPath, 'utf8');
  } catch (e) {
    fail(`读取模型文件失败：${e.message}`, modelPath);
  }
  try {
    template = await readFile(templatePath, 'utf8');
  } catch (e) {
    fail(`读取模板失败：${e.message}`, templatePath);
  }

  // 去掉 BOM，避免转译产物里混进 \uFEFF
  if (tsSource.charCodeAt(0) === 0xfeff) tsSource = tsSource.slice(1);
  if (template.charCodeAt(0) === 0xfeff) template = template.slice(1);

  // —— 3. 模板占位标记校验：必须恰好 1 次 ——
  const markerCount = countOccurrences(template, PLACEHOLDER);
  if (markerCount !== 1) {
    const lines = template.split(/\r?\n/);
    const hitLines = [];
    lines.forEach((l, i) => {
      if (l.includes(PLACEHOLDER)) hitLines.push(i + 1);
    });
    fail(
      `模板占位标记 ${PLACEHOLDER} 必须恰好出现 1 次，实际出现 ${markerCount} 次` +
        (hitLines.length ? `（行：${hitLines.join(', ')}）` : '') +
        `\n  模板：${templatePath}` +
        `\n  请让 scene-wright 修正模板，不要在构建脚本里绕过。`,
      templatePath,
      hitLines[0] || 0,
    );
  }
  // 占位标记必须独占一行（契约第 2 节）
  const markerLineIdx = template.split(/\r?\n/).findIndex((l) => l.includes(PLACEHOLDER));
  const markerLine = template.split(/\r?\n/)[markerLineIdx] || '';
  if (markerLine.trim() !== PLACEHOLDER) {
    console.warn(
      `[构建警告] 占位标记未独占一行（第 ${markerLineIdx + 1} 行是 "${markerLine.trim()}"），` +
        `契约要求单独一行。将按内联替换继续。`,
    );
  }

  // —— 4. 语法检查（transpileModule 不做类型检查，但会报语法错）——
  const transpileOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    // 保留 import.meta / 顶层 await 等现代语法
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    isolatedModules: true,
    removeComments: false,
    newLine: ts.NewLineKind.LineFeed,
    sourceMap: false,
    inlineSourceMap: false,
  };

  // 先跑一次 parse 拿语法诊断，便于报出准确行号
  const sf = ts.createSourceFile(
    modelPath,
    tsSource,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const syntactic = sf.parseDiagnostics || [];
  if (syntactic.length > 0) {
    const msgs = syntactic
      .slice(0, 8)
      .map((d) => formatDiagnostic(d, modelPath, tsSource))
      .join('\n  ');
    fail(`SurtrRig.ts 存在 ${syntactic.length} 个语法错误：\n  ${msgs}`, modelPath);
  }

  // —— 5. 转译 ——
  let js;
  try {
    const result = ts.transpileModule(tsSource, {
      compilerOptions: transpileOptions,
      fileName: modelPath,
      reportDiagnostics: true,
    });
    const diags = result.diagnostics || [];
    if (diags.length > 0) {
      const msgs = diags
        .slice(0, 8)
        .map((d) => formatDiagnostic(d, modelPath, tsSource))
        .join('\n  ');
      fail(`转译 SurtrRig.ts 失败（${diags.length} 条诊断）：\n  ${msgs}`, modelPath);
    }
    js = result.outputText;
  } catch (e) {
    fail(`转译异常：${e.message}`, modelPath);
  }

  // —— 6. 去掉 THREE 的 import 行（模板里已有全局 THREE）——
  const importRe = /^\s*import\s+\*\s+as\s+THREE\s+from\s+['"]three['"];?\s*$/gm;
  const removedImportCount = (js.match(importRe) || []).length;
  js = js.replace(importRe, '');

  // 其他 three 具名导入也一并去掉，并提示（契约只允许 `import * as THREE`）
  const otherThreeImportRe = /^\s*import\s+(?!\*)[^;]*?from\s+['"]three(?:\/[^'"]*)?['"];?\s*$/gm;
  const otherImports = js.match(otherThreeImportRe) || [];
  if (otherImports.length > 0) {
    js = js.replace(otherThreeImportRe, '');
    console.warn(
      `[构建警告] SurtrRig.ts 里还有 ${otherImports.length} 条非 \`import * as THREE\` 的 three 导入，已移除：\n  ` +
        otherImports.map((s) => s.trim()).join('\n  ') +
        `\n  契约要求只用 \`import * as THREE from 'three'\`。`,
    );
  }

  // 兜底：转译后仍残留 import 语句 → 说明模型引了其他模块，浏览器里会 404
  const leftoverImportRe = /^\s*import\s.+?from\s+['"][^'"]+['"];?\s*$/gm;
  const leftovers = js.match(leftoverImportRe) || [];
  if (leftovers.length > 0) {
    console.warn(
      `[构建警告] 转译产物仍残留 ${leftovers.length} 条 import，浏览器里可能解析失败：\n  ` +
        leftovers.map((s) => s.trim()).join('\n  '),
    );
  }

  // —— 7. 处理 export：转译产物里 `export function createSurtrRig` 不能放进 IIFE，
  //      把声明前的 `export` 关键字去掉（类型/接口已被转译器擦除，不会有 export interface）。
  //      同时把 `export default X` 记下来，最后挂到 window。
  let defaultExportName = null;
  const defaultRe = /^\s*export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/gm;
  const defaultHits = js.match(defaultRe) || [];
  if (defaultHits.length > 0) {
    defaultExportName = defaultHits[0].replace(/^\s*export\s+default\s+/, '').replace(/[;\s]+$/, '');
    js = js.replace(defaultRe, '');
  }
  js = js.replace(/^[ \t]*export\s+default\s+/gm, '');
  js = js.replace(
    /^([ \t]*)export\s+(?=(?:async\s+)?(?:function|const|let|var|class)\b)/gm,
    '$1',
  );
  // 兜底：`export { a, b };` 形式的再导出（IIFE 里不合法，直接删掉，函数已在作用域内）
  js = js.replace(/^[ \t]*export\s*\{[^}]*\}\s*;?[ \t]*$/gm, '');

  // —— 8. 包进 IIFE，避免顶层 const 与模板脚本撞名 ——
  const modelBlock = [
    '// ===== 以下由 tools/build.mjs 自动生成，请勿手改 =====',
    '// 源文件：SurtrRig.ts',
    '(function () {',
    "'use strict';",
    js.trimEnd(),
    '// 暴露给模板：模板脚本用 createSurtrRig() 访问（模块作用域会回落到全局对象）',
    'if (typeof createSurtrRig === "function") window.createSurtrRig = createSurtrRig;',
    defaultExportName ? `window.__SURTR_DEFAULT__ = ${defaultExportName};` : '',
    '})();',
    '// ===== 自动生成结束 =====',
  ]
    .filter((l) => l !== '')
    .join('\n');

  // —— 9. 注入 ——
  const html = template.replace(PLACEHOLDER, () => modelBlock);

  const modelJsLines = js.trimEnd().split(/\r?\n/).length;
  const totalLines = html.split(/\r?\n/).length;

  if (checkOnly) {
    console.log('[构建检查] 通过（--check 模式，未写文件）');
    console.log(`  模型 JS：${modelJsLines} 行`);
    console.log(`  预计 HTML：${totalLines} 行`);
    console.log(`  去掉了 ${removedImportCount} 条 \`import * as THREE\` 行`);
    return;
  }

  // —— 9. 写出（UTF-8 无 BOM）——
  try {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, html, { encoding: 'utf8' });
  } catch (e) {
    fail(`写输出文件失败：${e.message}`, outPath);
  }

  // —— 10. 自检：产物必须存在且非空，且占位标记已消失 ——
  const st = await stat(outPath);
  if (st.size === 0) fail('输出文件为空', outPath);
  const written = await readFile(outPath, 'utf8');
  if (written.includes(PLACEHOLDER)) {
    fail(`输出文件里仍残留占位标记 ${PLACEHOLDER}（替换逻辑有 bug）`, outPath);
  }
  if (written.charCodeAt(0) === 0xfeff) {
    fail('输出文件带 BOM，必须是 UTF-8 无 BOM', outPath);
  }
  if (!written.includes('createSurtrRig')) {
    console.warn('[构建警告] 输出里没有 "createSurtrRig" 字样，模型可能没导出该函数。');
  }

  const ms = Date.now() - t0;
  console.log('[构建成功]');
  console.log(`  模型 JS   ：${modelJsLines} 行（去掉 ${removedImportCount} 条 THREE import）`);
  console.log(`  HTML 总行数：${totalLines} 行`);
  console.log(`  输出路径  ：${outPath}`);
  console.log(`  文件大小  ：${(st.size / 1024).toFixed(1)} KB`);
  console.log(`  耗时      ：${ms} ms`);
}

/** 统计子串出现次数（不重叠）。 */
function countOccurrences(haystack, needle) {
  let count = 0;
  let idx = 0;
  for (;;) {
    idx = haystack.indexOf(needle, idx);
    if (idx < 0) break;
    count += 1;
    idx += needle.length;
  }
  return count;
}

main().catch((e) => {
  console.error(`[构建失败] 未捕获异常：${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
