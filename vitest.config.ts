import { defineConfig } from 'vitest/config';

// 逻辑层单测必须能在纯 Node 下跑：不加载 DOM、不加载 three。
// 这条配置本身就是「逻辑层禁止 import three」的执行保障之一。
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    reporters: ['default'],
    passWithNoTests: false,
  },
});
