import { defineConfig } from 'vitest/config';

/**
 * e2e 套件——每条用例都 spawn 真实进程，断言 stdout/stderr、退出码与落盘效果。
 *
 * 两个目标：
 *   dev  `tsx src/cli/index.ts`   默认，改完源码立刻能跑，不需要构建
 *   dist `node dist/cli.js`       CI 与发布前验证产物，靠 E2E_TARGET=dist 切换
 *
 * 用 forks 而不是 threads：子进程里会 process.exit()，隔离在独立进程更干净。
 */
export default defineConfig({
  test: {
    include: ['test-e2e/**/*.e2e.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    passWithNoTests: true,
  },
});
