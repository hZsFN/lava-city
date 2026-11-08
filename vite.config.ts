import { defineConfig, type Plugin } from 'vite';

/**
 * 平台协议脚本 shared/save-protocol.js 是**非模块**脚本（挂 window.WL）。
 * Vite 遇到非 module 的 <script src> 会尝试打包并报错。
 * 这里在 pre 阶段把它从 HTML 里摘掉，在 post 阶段以相对路径原样塞回去；
 * 文件本身由 public/ 拷贝到 out/ 根（out/shared/save-protocol.js）。
 */
function platformScript(): Plugin {
  const TAG = /<script\s+src="\.?\/?shared\/save-protocol\.js"\s*><\/script>\s*/i;
  return {
    name: 'platform-script',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return html.replace(TAG, '');
      },
    },
  };
}

function restorePlatformScript(): Plugin {
  return {
    name: 'restore-platform-script',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        if (html.includes('shared/save-protocol.js')) return html;
        const tag = '<script src="./shared/save-protocol.js"></script>';

        // 关键：必须插在业务 module 脚本【之前】。
        // Vite 会把 module 脚本插到 </head> 前，所以直接插 </head> 前会排到它后面。
        // 这里改为插到第一个 <script type="module" 之前；找不到就退回 </head> 前。
        const moduleIdx = html.search(/<script\s+type="module"/i);
        if (moduleIdx >= 0) {
          return html.slice(0, moduleIdx) + `  ${tag}\n  ` + html.slice(moduleIdx);
        }
        return html.replace('</head>', `  ${tag}\n</head>`);
      },
    },
  };
}

export default defineConfig({
  // iframe / 子目录部署都依赖相对路径
  base: './',
  publicDir: 'public',
  plugins: [platformScript(), restorePlatformScript()],
  server: {
    watch: {
      // 打包产物（release/*.zip、out/、dist/）被打包脚本占用时会让 chokidar 抛 EBUSY，
      // 进而把整个 dev server 带崩。这些目录本来也不需要热更新，一律不监视。
      ignored: ['**/release/**', '**/out/**', '**/dist/**', '**/*.zip'],
    },
  },
  build: {
    outDir: 'out',
    emptyOutDir: true,
    // three 的 geo + webgpu 单包通常在 1.5 MB 上下，不当作告警
    chunkSizeWarningLimit: 3000,
  },
});
