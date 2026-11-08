#!/usr/bin/env node
/**
 * 交付包一键自检（零依赖，Node 标准库）。
 *   node tools/check.mjs              # 体检包内示例
 *   node tools/check.mjs <关卡目录>    # 体检你自己的关卡
 *   node tools/check.mjs <提交.zip>    # 检查 ZIP 路径、扩展名、入口和包体限制
 *   node tools/check.mjs <外链URL>     # 外链预检：HTTPS/XFO/CSP/SDK/CORS
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import {parseItemManifest} from '../shared/item-manifest.mjs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, posix } from 'node:path';

const SKIP = new Set(['node_modules', '.git']);
const ZIP_LIMIT = 12 * 1024 * 1024;
const UNPACKED_LIMIT = 40 * 1024 * 1024;
const FILE_COUNT_LIMIT = 250;
const FILE_SIZE_LIMIT = 35 * 1024 * 1024;
const ALLOWED_EXT = new Set('html htm js mjs css json png jpg jpeg gif webp svg ico avif mp3 ogg wav m4a mp4 webm woff woff2 ttf otf wasm data pck pak mem txt md map'.split(' '));
const normalizeZipPath = name => name.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').normalize('NFC');
const VOCAB = { hp: [1, 2], sanity: [1, 1], max_hp: [1, 1], attack: [1, 1] };
const FORBIDDEN = [
  [/alert\s*\(/, 'alert()'],
  [/confirm\s*\(/, 'confirm()'],
  [/\btop\.location/, 'top.location'],
  [/parent\.location/, 'parent.location'],
];
const IP_WORDS = [
  '任天堂', 'Nintendo', '迪士尼', 'Disney', '原神', 'Genshin', '米哈游',
  '宝可梦', 'Pokémon', 'Pokemon', '马里奥', 'Mario', '漫威', 'Marvel',
  'Minecraft', '我的世界',
];
const WORLD_ORIGIN = 'https://world.dayquay.com';
const SDK_URL = WORLD_ORIGIN + '/sdk/v1/worldline.js';

const results = [];
const warnings = [];
const ok = (name, detail = '') => results.push({ ok: true, name, detail });
const bad = (name, detail = '') => results.push({ ok: false, name, detail });
const warn = (name, detail = '') => warnings.push({ name, detail });

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) && dir === process.cwd()) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push({ full, size: st.size });
  }
  return out;
}

function refsOf(html) {
  const list = [];
  const re = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) list.push(m[1]);
  return list;
}

function checkCss(file) {
  const css = readFileSync(file, 'utf8');
  const shown = relative(process.cwd(), file).replace(/\\/g, '/');
  const re = /url\(\s*(["']?)([^)"']+)\1\s*\)/gi;
  let refs = 0, missing = 0, m;
  while ((m = re.exec(css))) {
    const ref = m[2].trim();
    if (!ref || /^(?:https?:|data:|blob:|#)/i.test(ref)) continue;
    refs++;
    const target = ref.split(/[?#]/)[0];
    if (!existsSync(resolve(dirname(file), target))) {
      missing++;
      bad(`CSS 相对引用存在（${shown}）`, `引用「${ref}」找不到；保留 CSS 所在目录结构`);
    }
  }
  if (refs && !missing) ok(`CSS 相对引用存在（${shown}）`, `${refs} 个引用全部命中`);
}

function checkUnityStructure(file, html) {
  if (!/createUnityInstance|unity-canvas|UnityLoader|Build\/[^"']+\.loader\.js/i.test(html)) return;
  const root = dirname(file);
  const names = walk(root).map(item => relative(root, item.full).replace(/\\/g, '/'));
  const has = re => names.some(name => re.test(name));
  const required = [
    [/^Build\/[^/]+\.loader\.js$/i, 'Build/* .loader.js'],
    [/^Build\/[^/]+\.framework\.js$/i, 'Build/* .framework.js'],
    [/^Build\/[^/]+\.wasm$/i, 'Build/* .wasm'],
    [/^Build\/[^/]+\.data$/i, 'Build/* .data'],
  ];
  const missing = required.filter(([re]) => !has(re));
  if (missing.length) bad(`Unity WebGL 资源结构（${relative(process.cwd(), file).replace(/\\/g, '/') }）`, `缺少 ${missing.map(([, label]) => label).join('、')}；请完整导出 Build/ 目录`);
  else ok(`Unity WebGL 资源结构（${relative(process.cwd(), file).replace(/\\/g, '/') }）`, 'Build/ 目录包含 loader、framework、wasm 和 data');
  const compressed = names.filter(name => /\.unityweb$/i.test(name));
  if (compressed.length) bad('Unity WebGL 压缩格式', `发现 ${compressed[0]}；请在 Unity 中关闭 Compression，导出 .data/.wasm`);
  else ok('Unity WebGL 压缩格式', '未发现 .unityweb，适合平台隔离运行');
}

function checkEffects(file, html) {
  let issues = 0;
  const re = /effect\s*:\s*\{([^}]*)\}/gi;
  let m;
  while ((m = re.exec(html))) {
    const body = m[1];
    const stat = (body.match(/stat\s*:\s*["']([^"']+)["']/) || [])[1];
    const valueRaw = (body.match(/value\s*:\s*([^,}\s]+)/) || [])[1];
    const trigger = (body.match(/trigger\s*:\s*["']([^"']+)["']/) || [])[1];
    const line = html.slice(0, m.index).split('\n').length;
    if (!stat || !(stat === 'cleanse' || VOCAB[stat])) {
      bad(`effect 词条合法（${basename(file)}:${line}）`, `stat「${stat || '缺失'}」不在 hp/sanity/max_hp/cleanse/attack`);
      issues++;
      continue;
    }
    if (!['on_enter', 'passive'].includes(trigger)) {
      bad(`effect 触发时机（${basename(file)}:${line}）`, `trigger 只能是 on_enter 或 passive（当前「${trigger || '缺失'}」）`);
      issues++;
      continue;
    }
    if (stat === 'cleanse') {
      if (valueRaw !== 'true') {
        bad(`cleanse 取值（${basename(file)}:${line}）`, 'cleanse 的 value 必须是布尔 true，不能用数字 1');
        issues++;
      }
    } else {
      const n = Number(valueRaw);
      const [min, max] = VOCAB[stat];
      if (!Number.isFinite(n) || n < min || n > max) {
        bad(`effect 取值（${basename(file)}:${line}）`, `${stat} 的 value 必须在 ${min}~${max}`);
        issues++;
      }
    }
  }
  if (!issues) ok(`effect 词条合法（${basename(dirname(file))}/${basename(file)}）`, '所有 effect 都在词表与取值范围内');
}

function checkHtml(file) {
  const html = readFileSync(file, 'utf8');
  const shown = relative(process.cwd(), file).replace(/\\/g, '/');

  // base 必须是相对路径：站内绝对路径（/assets/、src="/）在子目录部署/外链时全部 404。
  const absoluteRef = html.match(/(?:src|href)\s*=\s*["']\/(?!\/)/i) || html.match(/["'](\/assets\/|\/static\/|\/js\/)/i);
  if (absoluteRef) bad(`相对路径 base（${shown}）`, `出现站内绝对引用「${absoluteRef[0]}」；Vite/Phaser 请把 base 设为 './'`);
  else ok(`相对路径 base（${shown}）`, '未发现 /assets/ 或 src="/ 形式的站内绝对引用');

  let refs = 0, missing = 0;
  for (const ref of refsOf(html)) {
    if (/^(https?:|data:|blob:|mailto:|#|javascript:)/i.test(ref)) continue;
    const target = ref.split(/[?#]/)[0];
    if (!target) continue;
    refs++;
    if (isAbsolute(target) || !existsSync(resolve(dirname(file), target))) {
      missing++;
      bad(`相对引用存在（${shown}）`, `引用「${ref}」找不到；改成包内相对路径`);
    }
  }
  if (refs && !missing) ok(`相对引用存在（${shown}）`, `${refs} 个引用全部命中`);

  for (const [re, label] of FORBIDDEN) {
    if (re.test(html)) bad(`禁用 API：${label}（${shown}）`, '改成页面内提示；沙箱会拒绝系统弹窗与顶层跳转');
  }
  const hit = IP_WORDS.find(w => html.includes(w));
  if (hit) bad(`版权关键词（${shown}）`, `出现「${hit}」；确认无未授权 IP 素材`);

  if (!/\bWL\s*\.\s*(?:readSave|ready)\s*\(/.test(html)) bad(`读档接口（${shown}）`, '缺少 WL.ready() 或 WL.readSave()');
  if (!/\bWL\s*\.\s*(?:completeLevel|complete)\s*\(/.test(html)) bad(`交接接口（${shown}）`, '缺少 WL.complete() 或 WL.completeLevel()');
  checkEffects(file, html);
  checkUnityStructure(file, html);
}

function checkSizes(files) {
  const total = files.reduce((n, f) => n + f.size, 0);
  const tooBig = files.filter(f => f.size > FILE_SIZE_LIMIT);
  if (files.length > FILE_COUNT_LIMIT) bad('文件数', `${files.length} 个文件，超过 ${FILE_COUNT_LIMIT} 个上限`);
  else ok('文件数', `${files.length} 个文件，未超过 ${FILE_COUNT_LIMIT}`);
  if (total > UNPACKED_LIMIT) bad('解压后体积', `${(total / 1048576).toFixed(1)}MB，超过 ${UNPACKED_LIMIT / 1048576}MB`);
  else ok('解压后体积', `${(total / 1048576).toFixed(1)}MB，未超过 ${UNPACKED_LIMIT / 1048576}MB`);
  if (tooBig.length) bad('单文件体积', `${tooBig[0].full} 超过 35MB`);
  else ok('单文件体积', '均不超过 35MB');
}

function checkExt(files) {
  const banned = files.filter(f => !ALLOWED_EXT.has(f.full.split('.').pop().toLowerCase()));
  for (const file of banned) bad('文件扩展名', `${JSON.stringify(file.full)} 不在平台白名单内`);
  if (!banned.length) ok('文件扩展名', '全部符合平台白名单');
}

function checkZipPaths(entries) {
  const seen = new Set();
  let invalid = 0;
  for (const entry of entries) {
    const name = entry.name;
    const unsafe = !name || name.length > 250 || /[\\\x00-\x1f%?#:]/.test(name) || name.startsWith('/') || name.split('/').some(p => p === '..' || p === '.' || !p || p.startsWith('.'));
    if (unsafe) { bad('ZIP 文件路径', `${JSON.stringify(entry.rawName)} 含不安全或不支持的路径`); invalid++; }
    if (seen.has(name)) { bad('ZIP 文件路径', `${JSON.stringify(entry.rawName)} 规范化后与其他文件重名`); invalid++; }
    seen.add(name);
  }
  if (!invalid) ok('ZIP 文件路径', '已规范化 Windows 分隔符和相对前缀，无危险路径或重名');
}

// 只读 ZIP 中央目录；文件名、扩展名与体积规则与大厅导入一致。
function zipInfo(file) {
  const buf = readFileSync(file);
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) return null;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) if (buf.readUInt32LE(i) === 0x06054b50 && i + 22 + buf.readUInt16LE(i + 20) === buf.length) { eocd = i; break; }
  if (eocd < 0) return null;
  if (buf.readUInt16LE(eocd + 4) || buf.readUInt16LE(eocd + 6) || buf.readUInt16LE(eocd + 8) !== buf.readUInt16LE(eocd + 10)) return null;
  const count = buf.readUInt16LE(eocd + 10);
  const entries = [];
  let offset = buf.readUInt32LE(eocd + 16);
  if (count === 65535 || offset === 0xffffffff || offset + buf.readUInt32LE(eocd + 12) > eocd) return null;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > eocd || buf.readUInt32LE(offset) !== 0x02014b50) return null;
    if ((buf.readUInt16LE(offset + 8) & 1) || ![0, 8].includes(buf.readUInt16LE(offset + 10))) return null;
    const raw = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28), extra = buf.readUInt16LE(offset + 30), comment = buf.readUInt16LE(offset + 32);
    if (offset + 46 + nameLen + extra + comment > eocd || raw === 0xffffffff) return null;
    const rawName = buf.toString('utf8', offset + 46, offset + 46 + nameLen), name = normalizeZipPath(rawName);
    if (!name.endsWith('/') && !name.startsWith('__MACOSX/') && !name.endsWith('/.DS_Store') && name !== '.DS_Store') entries.push({ name, rawName, full: name, size: raw, method:buf.readUInt16LE(offset+10), compressed:buf.readUInt32LE(offset+20), local:buf.readUInt32LE(offset+42) });
    offset += 46 + nameLen + extra + comment;
  }
  return { zip: buf.length, entries, buf };
}

function checkZip(file) {
  let info;
  try { info = zipInfo(file); } catch { info = null; }
  if (!info) {
    bad('ZIP 结构', '读不到中央目录，请用系统压缩或 tools/pack.ps1 重新打包');
    return;
  }
  if (info.zip > ZIP_LIMIT) bad('ZIP 体积', `${(info.zip / 1048576).toFixed(1)}MB，超过 12MB`);
  else ok('ZIP 体积', `${(info.zip / 1048576).toFixed(1)}MB，未超过 12MB`);
  checkZipPaths(info.entries);
  checkExt(info.entries);
  checkSizes(info.entries);
  const names = info.entries.map(entry => entry.name);
  let paths=names.slice();const first=paths[0]?.split('/')[0];
  const wrapped=paths.length&&paths.every(name=>name.startsWith(first+'/'));
  if(wrapped)paths=paths.map(name=>name.slice(first.length+1));
  let entry=process.argv[4]||'index.html';
  if(!paths.includes(entry)){const candidates=paths.filter(name=>/(^|\/)index\.html?$/i.test(name));if(entry==='index.html'&&candidates.length===1)entry=candidates[0];else {bad('ZIP 入口','找不到 '+entry+'；非 index.html 时用第四个参数指定，并在大厅填写同一路径');entry=null;}}
  const read=record=>{const at=record.local,b=info.buf;if(at+30>b.length||b.readUInt32LE(at)!==0x04034b50)throw Error('ZIP 本地文件头损坏');const dataAt=at+30+b.readUInt16LE(at+26)+b.readUInt16LE(at+28);if(dataAt+record.compressed>b.length)throw Error('ZIP 文件数据不完整');const data=b.subarray(dataAt,dataAt+record.compressed);const result=record.method===8?inflateRawSync(data,{maxOutputLength:FILE_SIZE_LIMIT}):data;if(result.length!==record.size)throw Error('ZIP 文件大小不匹配');return result.toString('utf8');};
  if(entry){try{const record=info.entries.find(row=>row.name===(wrapped?first+'/':'')+entry);if(!/\.html?$/i.test(entry)||!/<(?:!doctype|html|head|body|canvas|div|script)\b/i.test(read(record)))throw Error('入口内容不是有效的 HTML');ok('ZIP 入口',entry);}catch(error){bad('ZIP 入口',error.message);}}
  for(const record of info.entries.filter(row=>/\.(?:html?|css)$/i.test(row.name))){
   try{
    const text=read(record),refs=/\.css$/i.test(record.name)?[...text.matchAll(/url\(\s*["']?([^)'"\s]+)["']?\s*\)/gi)].map(m=>m[1]):refsOf(text);
    for(const ref of refs){if(/^(?:https?:|data:|blob:|mailto:|#|javascript:)/i.test(ref))continue;const bare=ref.split(/[?#]/)[0];if(!bare)continue;
     const target=posix.normalize(posix.join(posix.dirname(record.name),bare));
     if(ref.startsWith('/')||!names.includes(target))bad('ZIP 相对资源',record.name+' 引用 '+ref+'，最终 ZIP 内找不到；不要依赖电脑上的包外文件');
    }
   }catch(error){bad('ZIP 资源检查',record.name+'：'+error.message);}
  }
  const embedded=info.entries.find(row=>/(^|\/)global-items\.json$/.test(row.name));
  checkManifest(process.argv[3]|| (embedded?null:join(dirname(file),'global-items.json')),embedded?()=>read(embedded):null);
  const unityRoots = new Set(names.filter(name => /\/Build\/[^/]+\.loader\.js$/i.test(name) || /^Build\/[^/]+\.loader\.js$/i.test(name)).map(name => name.replace(/\/Build\/[^/]+\.loader\.js$/i, '').replace(/^Build\/[^/]+\.loader\.js$/i, '')));
  for (const root of unityRoots) {
    const prefix = root ? root + '/' : '';
    const has = suffix => names.some(name => new RegExp(`^${prefix}Build/[^/]+${suffix}$`, 'i').test(name));
    const missing = [['.loader.js', 'loader'], ['.framework.js', 'framework'], ['.wasm', 'wasm'], ['.data', 'data']].filter(([suffix]) => !has(suffix));
    if (missing.length) bad(`ZIP Unity WebGL 资源结构（${root || '.'}）`, `缺少 ${missing.map(([, label]) => label).join('、')}；请完整导出 Build/ 目录`);
    else ok(`ZIP Unity WebGL 资源结构（${root || '.'}）`, 'Build/ 目录包含 loader、framework、wasm 和 data');
    if (names.some(name => new RegExp(`^${prefix}Build/.*\\.unityweb$`, 'i').test(name))) bad(`ZIP Unity WebGL 压缩格式（${root || '.'}）`, '发现 .unityweb；请在 Unity 中关闭 Compression');
    else ok(`ZIP Unity WebGL 压缩格式（${root || '.'}）`, '未发现 .unityweb');
  }
}

function checkManifest(path,readEmbedded=null){
 try{const manifest=parseItemManifest(path?readFileSync(path,'utf8'):readEmbedded());ok('全局道具声明',manifest.items.length+' 件；cleanse 只接受布尔 true');}
 catch(error){bad('全局道具声明','请提供实际提交的 global-items.json（第三个参数），没有道具也需空声明。'+error.message);}
}

function cspAllows(value, directive, origin) {
  if (!value) return true;
  const host = new URL(origin).host;
  return String(value).split(',').map(part => part.trim()).filter(Boolean).every(policy => {
    const entry = policy.split(';').map(part => part.trim()).find(part => part.toLowerCase().startsWith(directive.toLowerCase() + ' '));
    if (!entry) return true;
    return entry.split(/\s+/).slice(1).some(token => {
      const t = token.toLowerCase();
      if (t === '*' || t === 'https:') return true;
      if (t === "'none'" || t === "'self'") return false;
      if (t.startsWith('*.')) return host.endsWith(t.slice(1));
      return t === origin.toLowerCase() || t === host || t === host.replace(/^www\./, '');
    });
  });
}

async function checkExternal(url) {
  let parsed;
  try { parsed = new URL(url); } catch { bad('外链 URL', '不是有效 URL'); return; }
  if (parsed.protocol !== 'https:') bad('外链 HTTPS', '必须是 HTTPS');
  else ok('外链 HTTPS', parsed.origin);

  let res;
  try {
    res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'infinite-world-kit-check/3.3.2' } });
  } catch (error) {
    bad('外链可达', error.message + '；若被 WAF 拦截，请用浏览器 Network 复核');
    return;
  }
  const final = new URL(res.url);
  if (final.protocol !== 'https:') bad('外链重定向 HTTPS', '重定向到 ' + final.href);
  else ok('外链重定向 HTTPS', final.href);
  if (!res.ok) bad('外链状态', res.status + ' ' + res.statusText);
  else ok('外链状态', res.status + ' ' + res.statusText);

  const xfo = res.headers.get('x-frame-options');
  if (!xfo) ok('可嵌入 X-Frame-Options', '未设置');
  else if (/deny|sameorigin/i.test(xfo)) bad('可嵌入 X-Frame-Options', xfo + ' 会阻止大厅 iframe');
  else if (/allow-from/i.test(xfo) && !/world\.dayquay\.com/i.test(xfo)) bad('可嵌入 X-Frame-Options', xfo + ' 未允许 world.dayquay.com');
  else ok('可嵌入 X-Frame-Options', xfo);

  const csp = res.headers.get('content-security-policy');
  if (!csp) ok('可嵌入 CSP', '未设置 Content-Security-Policy');
  else {
    if (cspAllows(csp, 'frame-ancestors', WORLD_ORIGIN)) ok('可嵌入 CSP frame-ancestors', '允许 ' + WORLD_ORIGIN);
    else bad('可嵌入 CSP frame-ancestors', '未允许 ' + WORLD_ORIGIN + '；外站会被大厅 iframe 拒绝');
    if (cspAllows(csp, 'script-src', WORLD_ORIGIN) && cspAllows(csp, 'script-src-elem', WORLD_ORIGIN)) ok('SDK CSP script-src', '允许 ' + WORLD_ORIGIN);
    else bad('SDK CSP script-src', '未允许 ' + WORLD_ORIGIN + ' 的 SDK（检查 script-src / script-src-elem）');
  }

  let html = '';
  try { html = await res.text(); } catch (error) { bad('外链 HTML', error.message); }
  if (html) {
    if (/worldline\.js|sdk\/v1|WL\s*\.\s*ready/.test(html)) ok('官方 SDK 引用', '入口发现 SDK 线索');
    else warn('官方 SDK 引用', '入口 HTML 未发现 worldline.js / WL.ready()；若为打包后动态加载，请在 Network 确认');
    const modules = [...html.matchAll(/<script\b[^>]*>/gi)]
      .map(tag => tag[0])
      .filter(tag => /\btype=["']module["']/i.test(tag))
      .map(tag => (tag.match(/\bsrc=["']([^"']+)["']/i) || [])[1])
      .filter(Boolean);
    if (modules.length) {
      const first = new URL(modules[0], final).href;
      try {
        const mod = await fetch(first, { headers: { 'user-agent': 'infinite-world-kit-check/3.3.2' } });
        const acao = mod.headers.get('access-control-allow-origin');
        if (mod.ok && (acao === '*' || acao === 'null')) ok('模块脚本 CORS', first + ' → ' + acao);
        else bad('模块脚本 CORS', first + ' → ' + (acao || '无 ACAO') + '；沙箱 opaque origin 下会加载失败（需 * 或 null）');
      } catch (error) { bad('模块脚本可达', first + '：' + error.message); }
    } else {
      ok('模块脚本 CORS', '入口未发现 type=module；运行时有 fetch/XHR/WASM 仍需静态资源返回 ACAO');
    }
  }

  let sdkRes;
  try { sdkRes = await fetch(SDK_URL, { headers: { 'user-agent': 'infinite-world-kit-check/3.3.2' } }); }
  catch (error) { bad('官方 SDK 可达', SDK_URL + '：' + error.message); }
  if (sdkRes) {
    if (!sdkRes.ok) bad('官方 SDK 可达', SDK_URL + ' → ' + sdkRes.status);
    else ok('官方 SDK 可达', SDK_URL + ' → ' + sdkRes.status);
    const acao = sdkRes.headers.get('access-control-allow-origin');
    const corp = sdkRes.headers.get('cross-origin-resource-policy');
    if (acao === '*' || acao === 'null') ok('官方 SDK CORS', 'Access-Control-Allow-Origin: ' + acao);
    else bad('官方 SDK CORS', 'Access-Control-Allow-Origin 为 ' + (acao || '空') + '；应允许 *');
    if (corp && corp.toLowerCase() !== 'cross-origin') bad('官方 SDK CORP', corp + '；应为 cross-origin');
    else ok('官方 SDK CORP', corp || '未设置');
  }

  console.log('\n外链人工验收清单（自动工具不能代替）：');
  console.log('  □ 大厅 iframe 内能加载，不白屏；Console 无 CORS/CSP 错误');
  console.log('  □ 开局 await WL.ready()，读到非满血/旧道具存档');
  console.log('  □ 通关 await WL.complete() 收到 persisted:true；失败 WL.fail() 收到回执');
  console.log('  □ 不依赖 localStorage/IndexedDB/cookie/线程/弹窗；Unity/Godot 已关闭线程');
  console.log('  □ 4 分 30 秒内到达明确结局；300 秒看门狗未触发');
}

function checkGameDir(dir) {
  const files = walk(dir);
  checkZipPaths(files.map(f=>({name:normalizeZipPath(relative(dir,f.full)),rawName:relative(dir,f.full)})));
  checkManifest(process.argv[3]||join(dir,'global-items.json'));
  const entry = join(dir, 'index.html');
  if (!existsSync(entry)) {
    bad('入口 index.html 在根目录', '把 index.html 放到关卡目录最外层；不要多套一层文件夹');
  } else {
    ok('入口 index.html 在根目录');
    checkHtml(entry);
    for (const f of files) if (/\.html?$/i.test(f.full) && f.full !== entry) checkHtml(f.full);
  }
  checkSizes(files);
  checkExt(files);
  for (const file of files.filter(item => /\.css$/i.test(item.full))) checkCss(file.full);
}

function checkKit(dir) {
  checkManifest(join(dir,'global-items.json'));
  const examples = join(dir, 'examples');
  if (!existsSync(examples)) {
    bad('交付包结构', '缺少 examples/ 目录');
    return;
  }
  const dirs = readdirSync(examples).filter(n => statSync(join(examples, n)).isDirectory());
  for (const name of dirs) {
    const entry = join(examples, name, 'index.html');
    if (!existsSync(entry)) {
      bad(`示例入口（${name}）`, '缺少 index.html');
      continue;
    }
    ok(`示例入口（${name}）`, 'index.html 存在');
    checkHtml(entry);
    checkExt(walk(join(examples, name)));
  }
  const versionPath = join(dir, 'VERSION.json');
  const protocolPath = join(dir, 'shared', 'save-protocol.js');
  if (existsSync(versionPath) && existsSync(protocolPath)) {
    const version = JSON.parse(readFileSync(versionPath, 'utf8'));
    const schema = (readFileSync(protocolPath, 'utf8').match(/var SCHEMA = '([^']+)'/) || [])[1];
    if (version.schema === schema) ok('版本标识一致', `VERSION.json ${version.version} / schema ${schema}`);
    else bad('版本标识一致', `VERSION.json schema=${version.schema}，协议文件 schema=${schema}`);
    const hash = createHash('sha256').update(readFileSync(protocolPath)).digest('hex');
    if (version.protocol && version.protocol.sha256 === hash) ok('协议文件哈希一致', hash.slice(0, 12) + '…');
    else bad('协议文件哈希一致', '协议文件已变，请更新 VERSION.json 的 protocol.sha256');
  } else {
    bad('版本标识', '缺少 VERSION.json 或 shared/save-protocol.js');
  }
  checkSizes(walk(dir));
}

const target = process.argv[2];
const isKit = !target && existsSync(join(process.cwd(), 'VERSION.json'));
const dir = target ? resolve(target) : process.cwd();
const isZip = !!target && /\.zip$/i.test(target);
const isUrl = !!target && /^https?:\/\//i.test(target);

console.log(`\n📦 自检目标：${isUrl ? target : dir}\n`);
if (isUrl) await checkExternal(target);
else if (isZip) checkZip(dir);
else if (target) checkGameDir(dir);
else if (isKit) checkKit(dir);
else checkGameDir(dir);

for (const r of results) {
  console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
}
for (const w of warnings) console.log(`⚠️ ${w.name}${w.detail ? ' — ' + w.detail : ''}`);
const fails = results.filter(r => !r.ok).length;
console.log(`\n${fails ? `❌ ${fails} 项需要修` : '✅ 全部通过'}（共 ${results.length} 项）\n`);
process.exit(fails ? 1 : 0);
