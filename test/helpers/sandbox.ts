import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const created: string[] = [];

/** 建一个临时目录，测试跑完由 cleanup() 统一清理。 */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-preset-'));
  created.push(dir);
  return dir;
}

export function cleanup(): void {
  for (const dir of created.splice(0))
    rmSync(dir, { recursive: true, force: true });
}

export interface SandboxOptions {
  repoPackages?: unknown[];
  repoExtensions?: Record<string, string>;
  agentPackages?: unknown[];
  agentExtensions?: Record<string, string>;
  settings?: Record<string, unknown>;
}

export interface Sandbox {
  repo: string;
  agent: string;
}

/**
 * 造一对假的 repo 与 agent 目录。
 * repo 满足 assertRepoRoot 的要求（package.json 的 name 对得上 + 有 .git）。
 */
export function sandbox({
  repoPackages = [],
  repoExtensions = {},
  agentPackages = [],
  agentExtensions = {},
  settings = {},
}: SandboxOptions = {}): Sandbox {
  const repo = tempDir();
  const agent = tempDir();
  mkdirSync(join(repo, 'extensions'), { recursive: true });
  mkdirSync(join(repo, 'presets'), { recursive: true });
  mkdirSync(join(agent, 'extensions'), { recursive: true });

  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: '@1lon/pi-preset' }));
  mkdirSync(join(repo, '.git'), { recursive: true });
  writeFileSync(join(repo, 'presets', 'public.json'), JSON.stringify({ packages: repoPackages }, null, 2));

  for (const [name, content] of Object.entries(repoExtensions))
    writeFileSync(join(repo, 'extensions', name), content);
  for (const [name, content] of Object.entries(agentExtensions))
    writeFileSync(join(agent, 'extensions', name), content);

  if (agentPackages.length > 0 || Object.keys(settings).length > 0)
    writeFileSync(join(agent, 'settings.json'), JSON.stringify({ ...settings, packages: agentPackages }, null, 2));

  return { repo, agent };
}

/** 临时接管 stdout，用于断言摘要文案。 */
export function captureStdout<T>(fn: () => T): { value: T; out: string } {
  const out: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const value = fn();
    return { value, out: out.join('') };
  }
  finally {
    process.stdout.write = original;
  }
}

export function readJson<T = any>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export { readFileSync, readdirSync, symlinkSync, writeFileSync };

// ---------------------------------------------------------------------------
// e2e：在子进程里跑真实 CLI
// ---------------------------------------------------------------------------

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * 默认用 tsx 直接跑源码，改完不用构建；E2E_TARGET=dist 时改为跑构建产物，
 * 用来验证 bin 指向的 `dist/cli.js` 与源码行为一致。
 */
const useDist = process.env.E2E_TARGET === 'dist';

const ENTRY: { command: string; args: string[] } = useDist
  ? { command: process.execPath, args: [join(ROOT, 'dist', 'cli.js')] }
  : { command: join(ROOT, 'node_modules', '.bin', 'tsx'), args: [join(ROOT, 'src', 'cli', 'index.ts')] };

/**
 * 跑一次 CLI。
 *
 * 之所以必须起子进程：commander 在子命令层面会直接 process.exit()，
 * 在同一个进程里调用会杀掉测试进程本身。
 */
export function cli(
  argv: string[],
  { cwd, env, input }: { cwd?: string; env?: Record<string, string>; input?: string } = {},
): CliResult {
  const result = spawnSync(ENTRY.command, [...ENTRY.args, ...argv], {
    cwd,
    input,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', ...env },
  });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
