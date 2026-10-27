import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { cli: 'src/cli/index.ts' },
  outDir: 'dist',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  clean: true,
  dts: false,
  sourcemap: false,
  // 包是 "type": "module"，但 bin 统一用 .js 文件名，避免 .mjs 在部分 npm/npx 版本下的解析差异
  outExtensions: () => ({ js: '.js' }),
  // 保留 shebang：dist/cli.js 要被当作可执行文件直接运行
  banner: '#!/usr/bin/env node',
});
