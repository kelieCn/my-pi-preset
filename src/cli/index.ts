/**
 * pi-preset — 把本仓库（清单 + 自定义扩展）与本机 pi 配置双向对齐。
 *
 *   pull   仓库 → 本机
 *   sync   本机 → 仓库（不做 git 操作）
 *
 * 作为 bin（dist/cli.js 或 tsx src/cli/index.ts）直接执行时会自己跑 main()，
 * 被 import 时则什么都不做。
 */
import { Command, CommanderError } from 'commander';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PACKAGE_VERSION } from '../paths.js';
import { registerPull } from './pull.js';
import { registerSync } from './sync.js';

export { planPull, applyPull, runPull, printPullSummary } from './pull.js';
export { planSync, applySync, runSync, printSyncSummary } from './sync.js';
export { entrySource, isPublicSource, packageIdentity, parseSource } from '../package-source.js';
export { assertRepoRoot, resolveAgentDir } from '../paths.js';
export type * from '../types.js';

/** pull 与 sync 共有的选项。 */
function withCommonOptions(command: Command): Command {
  return command
    .option('--agent-dir <path>', 'pi 配置目录，默认 $PI_CODING_AGENT_DIR 或 ~/.pi/agent')
    .option('-n, --dry-run', '只打印将要做的改动，不落盘');
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('pi-preset')
    .description('个人 pi 扩展 preset：把仓库里的包清单与自定义扩展对齐到本机，或反向写回')
    .version(PACKAGE_VERSION);

  registerPull(program, withCommonOptions);
  registerSync(program, withCommonOptions);

  return program;
}

/**
 * 跑一次 CLI，返回退出码。
 *
 * 只对根命令 exitOverride：子命令报错时 commander 仍会直接 process.exit()，
 * 退出码正确，只是超过约 128 KB 的输出可能被截断（本项目输出只有几百字节）。
 */
export function main(argv: string[] = process.argv.slice(2)): number {
  const program = buildProgram();
  program.exitOverride();
  program.configureOutput({ writeErr: (str) => process.stderr.write(str) });

  if (argv.length === 0) {
    program.outputHelp();
    return 0;
  }

  try {
    program.parse(argv, { from: 'user' });
    return 0;
  }
  catch (error) {
    // --help / --version 是正常退出；其余错误 commander 已经输出过了
    if (error instanceof CommanderError)
      return error.exitCode === 0 ? 0 : 1;
    throw error;
  }
}

/**
 * 本文件既是 bin 也是可 import 的模块。判断「是否被直接执行」不能只比
 * resolve(argv[1])：通过 npm/pnpm 的 bin 软链调用时 argv[1] 是软链路径，
 * 而 import.meta.url 是 dist/cli.js 的真实路径，两者不相等会让 CLI 静默什么都不做。
 */
function isEntryPoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1)
    return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(argv1) === realpathSync(self);
  }
  catch {
    return resolve(argv1) === self;
  }
}

if (isEntryPoint()) {
  try {
    process.exitCode = main();
  }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
