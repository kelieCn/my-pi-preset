import { defineConfig } from 'vitest/config';

/**
 * 单元套件——同一个进程内跑，不构建、不起子进程、无网络。
 *
 * 直接 import `src/`，靠 vitest 自己转译 TypeScript，所以改完源码立刻能跑，
 * 不需要先 `tsdown`。凡是要驱动真实二进制的用例都在 `test-e2e/`。
 */
export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
