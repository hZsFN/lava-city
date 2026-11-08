// 浏览器实测驱动：用本机 Edge/Chrome 的 headless 模式 + Chrome DevTools Protocol
// 打开页面、收集 console / 未捕获异常、执行注入脚本、截图。
//
// 为什么不用 Playwright：本机没有装，且 DSH 沙箱禁止子进程用管道捕获 stdio（spawn EPERM）。
// 这里用 spawn(stdio:'ignore') + HTTP/WebSocket 直连 CDP，绕开管道限制，零依赖。
//
// 相比「熔心孤塔」demo 版本的增强（withPage / fileUrl / findBrowser 接口保持不变）：
//   1. 端口冲突自动重试（最多 5 次），浏览器启动失败不再直接崩；
//   2. CDN 本地镜像：把页面里 jsdelivr / unpkg 上的 three 资源用本地 node_modules 兜底，
//      断网也能跑（通过 CDP Fetch 域拦截，不修改页面 HTML）；
//   3. 新增 page.goto / page.waitFor / page.setViewport，方便一次浏览器内多次导航；
//   4. 保留 --headless=new。
//
// 用法：
//   import { withPage, fileUrl } from './browser.mjs';
//   await withPage({ url }, async (page) => {
//     const r = await page.evalJs('return 1 + 1');
//     await page.screenshot('a.png');
//   });

import { spawn } from 'node:child_process';
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

/** 找到本机可用的 Chromium 内核浏览器可执行文件。 */
export function findBrowser() {
  for (const p of EDGE_CANDIDATES) if (existsSync(p)) return p;
  throw new Error('找不到 Edge / Chrome 可执行文件，实测无法进行');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitJson(port, path, tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`);
      if (r.ok) return await r.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error(`CDP 端口 ${port} 未就绪`);
}

class CdpConnection {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.onmessage = (m) => {
      let msg;
      try {
        msg = JSON.parse(m.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) rej(new Error(`${msg.error.message} (${msg.error.code})`));
        else res(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg);
      }
    };
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('WebSocket 连接失败'));
    });
    return new CdpConnection(ws);
  }

  on(fn) {
    this.listeners.push(fn);
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error(`CDP 超时: ${method}`));
        }
      }, timeoutMs);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* 已关闭 */
    }
  }
}

// ---------------------------------------------------------------------------
// CDN 本地镜像：把 https://cdn.jsdelivr.net/npm/three@0.170.0/... 映射到本地 node_modules
// ---------------------------------------------------------------------------
const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, '..');
const THREE_ROOT = resolve(PROJECT_ROOT, 'node_modules', 'three');

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
};

/**
 * 把 CDN URL 映射成本地文件路径；映射不到返回 null。
 * 支持：
 *   https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js
 *   https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/controls/OrbitControls.js
 *   https://unpkg.com/three@0.170.0/...
 */
function cdnToLocal(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/jsdelivr\.net|unpkg\.com|esm\.sh/i.test(u.hostname)) return null;
  const p = decodeURIComponent(u.pathname);
  let rel = null;
  let m = /^\/npm\/three@[^/]+\/(.+)$/.exec(p);
  if (m) rel = m[1];
  if (!rel) {
    m = /^\/three@[^/]+\/(.+)$/.exec(p);
    if (m) rel = m[1];
  }
  if (!rel) return null;
  if (!/^(build|examples\/jsm)\//.test(rel)) return null;
  const abs = resolve(THREE_ROOT, rel);
  // 防目录穿越
  if (!abs.startsWith(THREE_ROOT)) return null;
  return existsSync(abs) ? abs : null;
}

async function installCdnMirror(pageCdp, stats) {
  pageCdp.on(async (msg) => {
    if (msg.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = msg.params;
    const local = cdnToLocal(request.url);
    if (!local) {
      try {
        await pageCdp.send('Fetch.continueRequest', { requestId });
      } catch {
        /* 忽略 */
      }
      return;
    }
    try {
      const body = await readFile(local);
      await pageCdp.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: MIME[extname(local)] || 'application/octet-stream' },
          { name: 'Access-Control-Allow-Origin', value: '*' },
          { name: 'Cache-Control', value: 'no-store' },
        ],
        body: body.toString('base64'),
      });
      stats.mirrored += 1;
    } catch (e) {
      stats.mirrorErrors.push(`${request.url}: ${e.message}`);
      try {
        await pageCdp.send('Fetch.continueRequest', { requestId });
      } catch {
        /* 忽略 */
      }
    }
  });
  await pageCdp.send('Fetch.enable', {
    patterns: [
      { urlPattern: '*cdn.jsdelivr.net*', requestStage: 'Request' },
      { urlPattern: '*unpkg.com*', requestStage: 'Request' },
      { urlPattern: '*esm.sh*', requestStage: 'Request' },
    ],
  });
}

// ---------------------------------------------------------------------------
// 浏览器启动（带端口冲突重试）
// ---------------------------------------------------------------------------
const BASE_PORT = 9400;

async function launchOnce({ exe, port, width, height, profile, extraArgs }) {
  return spawn(
    exe,
    [
      '--headless=new',
      '--enable-unsafe-swiftshader',
      '--disable-gpu-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--hide-scrollbars',
      '--mute-audio',
      '--allow-file-access-from-files',
      `--window-size=${width},${height}`,
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      ...extraArgs,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
}

/**
 * 打开页面执行一段逻辑，结束后自动关闭浏览器。
 * @param {{url?:string, width?:number, height?:number, waitMs?:number,
 *          mirror?:boolean, extraArgs?:string[], launchAttempts?:number}} opts
 * @param {(page: PageHandle) => Promise<any>} fn
 */
export async function withPage(opts, fn) {
  const {
    url,
    width = 1600,
    height = 1000,
    waitMs = 2500,
    mirror = true,
    extraArgs = [],
    launchAttempts = 5,
  } = opts || {};
  const exe = findBrowser();

  let proc = null;
  let profile = null;
  let browser = null;
  let pageCdp = null;
  let port = 0;
  const mirrorStats = { mirrored: 0, mirrorErrors: [] };
  const consoleLog = [];
  let lastErr = null;

  try {
    // —— 启动浏览器：端口冲突 / 启动失败则换端口重试 ——
    let ver = null;
    for (let attempt = 0; attempt < launchAttempts; attempt += 1) {
      port = BASE_PORT + Math.floor(Math.random() * 400) + attempt * 7;
      profile = resolve(tmpdir(), `surtr-cdp-${port}-${Date.now()}`);
      await mkdir(profile, { recursive: true });
      proc = await launchOnce({ exe, port, width, height, profile, extraArgs });
      try {
        ver = await waitJson(port, '/json/version', 40);
        break;
      } catch (e) {
        lastErr = e;
        try {
          proc.kill();
        } catch {
          /* 忽略 */
        }
        proc = null;
        await sleep(200);
        await rm(profile, { recursive: true, force: true }).catch(() => {});
      }
    }
    if (!ver) {
      throw new Error(
        `浏览器 CDP 启动失败（已重试 ${launchAttempts} 次）：${lastErr ? lastErr.message : '未知原因'}`,
      );
    }

    browser = await CdpConnection.connect(ver.webSocketDebuggerUrl);
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    const list = await waitJson(port, '/json/list').catch(() => null);
    let target = list ? list.find((t) => t.id === targetId) : null;
    if (!target) {
      // 兜底：/json/list 偶尔不返回新 target，改用 Target.attachToTarget 拿 sessionId
      const attached = await browser.send('Target.attachToTarget', { targetId, flatten: true });
      target = { webSocketDebuggerUrl: null, sessionId: attached.sessionId };
    }

    if (target.webSocketDebuggerUrl) {
      pageCdp = await CdpConnection.connect(target.webSocketDebuggerUrl);
    } else {
      // flatten 模式：在同一 WebSocket 上用 sessionId 路由
      pageCdp = makeSessionConnection(browser, target.sessionId);
    }

    pageCdp.on((msg) => {
      if (msg.method === 'Runtime.consoleAPICalled') {
        const p = msg.params;
        consoleLog.push({
          kind: p.type,
          text: (p.args || [])
            .map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type))
            .join(' '),
        });
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        consoleLog.push({
          kind: 'exception',
          text: `${(d.exception && (d.exception.description || d.exception.value)) || d.text} @${d.url || ''}:${d.lineNumber}`,
        });
      } else if (msg.method === 'Log.entryAdded') {
        const e = msg.params.entry;
        consoleLog.push({ kind: `log-${e.level}`, text: `${e.text} ${e.url || ''}`.trim() });
      }
    });

    await pageCdp.send('Runtime.enable');
    await pageCdp.send('Log.enable');
    await pageCdp.send('Page.enable');
    await pageCdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });

    if (mirror) {
      await installCdnMirror(pageCdp, mirrorStats);
    }

    if (url) {
      await pageCdp.send('Page.navigate', { url });
      await sleep(waitMs);
    }

    const handle = {
      /** 执行一段 JS。脚本里用 `return` 返回结果；支持 await。 */
      async evalJs(body, timeoutMs = 60000) {
        const expression = `(async () => { ${body} })()`;
        const r = await pageCdp.send(
          'Runtime.evaluate',
          { expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs },
          timeoutMs + 5000,
        );
        if (r.exceptionDetails) {
          const d = r.exceptionDetails;
          const desc =
            (d.exception && (d.exception.description || d.exception.value)) || d.text || '未知异常';
          const err = new Error(`页面内脚本抛错: ${desc}`);
          err.pageStack = d.stackTrace;
          throw err;
        }
        return r.result.value;
      },
      /** 轮询执行一段返回布尔值的 JS，直到为 true 或超时。 */
      async waitFor(body, timeoutMs = 20000, intervalMs = 150) {
        const deadline = Date.now() + timeoutMs;
        let lastVal;
        while (Date.now() < deadline) {
          try {
            lastVal = await handle.evalJs(body, Math.min(10000, timeoutMs));
            if (lastVal) return lastVal;
          } catch (e) {
            lastVal = e.message;
          }
          await sleep(intervalMs);
        }
        throw new Error(
          `等待条件超时（${timeoutMs} ms）：${body.replace(/\s+/g, ' ').slice(0, 160)}`,
        );
      },
      /** 导航到新 URL。 */
      async goto(newUrl, waitAfterMs = 0) {
        await pageCdp.send('Page.navigate', { url: newUrl });
        if (waitAfterMs > 0) await sleep(waitAfterMs);
      },
      /** 调整视口（截图尺寸跟着变）。 */
      async setViewport(w, h) {
        await pageCdp.send('Emulation.setDeviceMetricsOverride', {
          width: w,
          height: h,
          deviceScaleFactor: 1,
          mobile: false,
        });
      },
      async screenshot(filePath) {
        const shot = await pageCdp.send('Page.captureScreenshot', { format: 'png' });
        await mkdir(dirname(resolve(filePath)), { recursive: true });
        await writeFile(filePath, Buffer.from(shot.data, 'base64'));
        return filePath;
      },
      console: consoleLog,
      mirrorStats,
      /**
       * 重新加载当前页面。
       * 注意：页面内调 location.reload() 会让 CDP target 失效（报 -32000），
       * 必须走 Page.navigate 重新导航。
       */
      async reload(waitAfterMs = 2200) {
        if (!url) throw new Error('withPage 未提供 url，无法 reload');
        await pageCdp.send('Page.navigate', { url });
        await sleep(waitAfterMs);
      },
      /** 取 console 里属于「错误」的条目。 */
      errors() {
        return consoleLog.filter(
          (l) =>
            l.kind === 'exception' ||
            l.kind === 'error' ||
            l.kind === 'log-error' ||
            (l.kind === 'warning' && /error|fail/i.test(l.text)),
        );
      },
      /** 底层 CDP 连接（高级用法）。 */
      cdp: pageCdp,
    };

    return await fn(handle);
  } finally {
    pageCdp?.close();
    browser?.close();
    try {
      proc?.kill();
    } catch {
      /* 忽略 */
    }
    await sleep(250);
    if (profile) await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * flatten 模式下的 session 连接：所有消息带 sessionId 发送，只处理同 sessionId 的返回。
 * 仅在上游 target 拿不到独立 WebSocket 时使用。
 */
function makeSessionConnection(browserConn, sessionId) {
  const pending = new Map();
  const listeners = [];
  let seq = 0;
  browserConn.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(`${msg.error.message} (${msg.error.code})`));
      else res(msg.result);
    } else if (msg.method) {
      for (const fn of listeners) fn(msg);
    }
  });
  return {
    on(fn) {
      listeners.push(fn);
    },
    send(method, params = {}, timeoutMs = 30000) {
      const id = ++seq;
      return new Promise((res, rej) => {
        pending.set(id, { res, rej });
        browserConn.ws.send(JSON.stringify({ id, method, params, sessionId }));
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            rej(new Error(`CDP 超时: ${method}`));
          }
        }, timeoutMs);
      });
    },
    close() {
      try {
        browserConn.ws.send(
          JSON.stringify({ id: ++seq, method: 'Target.detachFromTarget', params: { sessionId } }),
        );
      } catch {
        /* 忽略 */
      }
    },
  };
}

/** 把仓库内的 HTML 路径转成 file:// URL（处理中文路径）。 */
export function fileUrl(htmlPath) {
  return pathToFileURL(resolve(htmlPath)).href;
}
