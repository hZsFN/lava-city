import { defineConfig } from 'vite';

export default defineConfig({
  // iframe / 子目录部署都依赖相对路径
  base: './',
  publicDir: 'public',
  build: {
    outDir: 'out',
    emptyOutDir: true,
    // three 的 geo + webgpu 单包通常在 1.5 MB 上下，不当作告警
    chunkSizeWarningLimit: 3000,
  },
});
