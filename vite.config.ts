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
        // 插到 </head> 前，保证 WL 在任何业务脚本之前可用
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
  build: {
    outDir: 'out',
    emptyOutDir: true,
    // three 的 geo + webgpu 单包通常在 1.5 MB 上下，不当作告警
    chunkSizeWarningLimit: 3000,
  },
});
