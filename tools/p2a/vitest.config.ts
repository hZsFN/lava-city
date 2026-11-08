import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // 允许采集 root 之外的 ../../src
      allowExternal: true,
      include: ['**/src/combat/**', '**/src/player/**'],
      reporter: ['text', 'html'],
      reportsDirectory: 'coverage',
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 85,
        statements: 85,
      },
    },
  },
});
