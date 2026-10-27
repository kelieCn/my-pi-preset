/**
 * CLI 表面的单元测试：命令注册、选项声明、版本号。
 * 这里**不跑**任何子命令——凡是会走到 commander 错误路径的都在 e2e 里，
 * 因为 commander 在子命令层面会直接 process.exit()，同进程调用会杀掉测试进程。
 */
import { describe, expect, it } from 'vitest';

import { buildProgram } from '../../src/cli/index.js';

const program = buildProgram();
const find = (name: string) => {
  const command = program.commands.find((c) => c.name() === name);
  if (!command)
    throw new Error(`没有 ${name} 子命令`);
  return command;
};

describe('命令树', () => {
  it('注册了 pull 与 sync', () => {
    expect(program.commands.map((c) => c.name()).sort()).toEqual(['pull', 'sync']);
  });

  it('每个子命令都带 --agent-dir 与 --dry-run', () => {
    for (const command of program.commands) {
      const longs = command.options.map((o) => o.long);
      expect(longs, `${command.name()} 缺少 --agent-dir`).toContain('--agent-dir');
      expect(longs, `${command.name()} 缺少 --dry-run`).toContain('--dry-run');
    }
  });

  it('pull 不再有 --repo，来源固定为包自身', () => {
    expect(find('pull').options.map((o) => o.long)).not.toContain('--repo');
  });

  it('sync 有 --repo / --include / --force', () => {
    const longs = find('sync').options.map((o) => o.long);
    expect(longs).toContain('--repo');
    expect(longs).toContain('--include');
    expect(longs).toContain('--force');
  });

  it('--include 可重复指定', () => {
    const include = find('sync').options.find((o) => o.long === '--include');
    expect(include?.attributeName()).toBe('include');
    // 声明了默认值 [] 才说明走的是 collect 累积而不是覆盖
    expect(include?.defaultValue).toEqual([]);
  });

  it('program 有名字与版本', () => {
    expect(program.name()).toBe('pi-preset');
    expect(program.version()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
