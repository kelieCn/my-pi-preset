/**
 * e2e：spawn 真实 CLI，断言退出码、stdout/stderr 与落盘效果。
 * 这是唯一能覆盖 commander 错误路径的地方——它会 process.exit()。
 *
 * 默认跑 `tsx src/cli/index.ts`（改完源码不用构建）；
 * `E2E_TARGET=dist` 时改跑 `node dist/cli.js`，验证产物与源码一致。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { PackageEntry } from '../src/types.js';
import { entrySource, packageIdentity } from '../src/package-source.js';
import { cleanup, cli, readJson, sandbox, tempDir } from '../test/helpers/sandbox.js';

afterAll(cleanup);

describe('help 与版本', () => {
  it('无参数打印帮助并返回 0', () => {
    const r = cli([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Usage: pi-preset/);
    expect(r.stdout).toMatch(/pull \[options\]/);
    expect(r.stdout).toMatch(/sync \[options\]/);
  });

  it('--help 返回 0', () => {
    const r = cli(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/个人 pi 扩展 preset/);
  });

  it('--version 打印版本号并返回 0', () => {
    const r = cli(['--version']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('子命令 --help 返回 0 且不含 --repo', () => {
    const r = cli(['pull', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/--agent-dir/);
    expect(r.stdout).not.toMatch(/--repo/);
  });
});

describe('错误路径', () => {
  it('未知子命令返回 1', () => {
    const r = cli(['bogus']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/unknown command 'bogus'/);
  });

  it('子命令传未知选项返回 1——这条只有子进程能测', () => {
    const r = cli(['pull', '--nope']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/unknown option '--nope'/);
  });

  it('pull --repo 已移除，传了返回 1', () => {
    const r = cli(['pull', '--repo', '/tmp']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/unknown option '--repo'/);
  });

  it('sync 在非仓库目录上返回非 0 并说明原因', () => {
    const r = cli(['sync', '--repo', tempDir()]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/不是本仓库/);
  });
});

describe('pull 端到端', () => {
  it('把包内清单与扩展复制到干净的 agent 目录，并保留非托管文件', () => {
    const agent = tempDir();
    mkdirSync(join(agent, 'extensions'), { recursive: true });
    writeFileSync(join(agent, 'extensions', 'not-managed.ts'), 'keep me');

    const r = cli(['pull', '--agent-dir', agent]);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);

    const settings = readJson(join(agent, 'settings.json'));
    const identities = settings.packages.map((e: PackageEntry) => packageIdentity(entrySource(e)));
    expect(identities).toHaveLength(7);
    expect(identities).toContain('npm:pi-code');
    expect(identities).toContain('git:github.com/obra/superpowers');

    // 对象条目的资源过滤规则要原样带过去
    const piCode = settings.packages.find((e: any) => typeof e === 'object' && e.source === 'npm:pi-code');
    expect(piCode.extensions).toEqual(['!extensions/mcp/**', '!extensions/subagent/**', '!extensions/skills.ts']);

    const files = readdirSync(join(agent, 'extensions')).sort();
    expect(files).toContain('pi-code-skills-dedup.ts');
    expect(files).toContain('question-render.ts');
    expect(files).toContain('user-message-frame.ts');
    expect(readFileSync(join(agent, 'extensions', 'not-managed.ts'), 'utf8')).toBe('keep me');
  });

  it('内网包不出现——清单是公开的', () => {
    const agent = tempDir();
    expect(cli(['pull', '--agent-dir', agent]).code).toBe(0);
    expect(readFileSync(join(agent, 'settings.json'), 'utf8')).not.toContain('basemind');
  });

  it('重复执行是幂等的', () => {
    const agent = tempDir();
    cli(['pull', '--agent-dir', agent]);
    const before = readJson(join(agent, 'settings.json')).packages;

    const r = cli(['pull', '--agent-dir', agent]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/已是最新/);
    expect(readJson(join(agent, 'settings.json')).packages).toEqual(before);
  });

  it('--dry-run 不落盘', () => {
    const agent = tempDir();
    const r = cli(['pull', '--agent-dir', agent, '--dry-run']);

    expect(r.code).toBe(0);
    expect(existsSync(join(agent, 'settings.json'))).toBe(false);
    expect(existsSync(join(agent, 'extensions'))).toBe(false);
  });

  it('PI_CODING_AGENT_DIR 生效，无需 --agent-dir', () => {
    const agent = tempDir();
    const r = cli(['pull'], { env: { PI_CODING_AGENT_DIR: agent } });

    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(existsSync(join(agent, 'settings.json'))).toBe(true);
  });
});

describe('sync 端到端', () => {
  it('把家目录的改动写回 clone 并打印三段摘要', () => {
    const { repo, agent } = sandbox({
      repoPackages: ['npm:keep', 'npm:gone'],
      repoExtensions: { 'changed.ts': 'old' },
      agentPackages: ['npm:keep', 'npm:fresh'],
      agentExtensions: { 'changed.ts': 'new' },
    });

    const r = cli(['sync', '--repo', repo, '--agent-dir', agent]);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/新增 \(1\)/);
    expect(r.stdout).toMatch(/修改 \(1\)/);
    expect(r.stdout).toMatch(/删除 \(1\)/);

    expect(readFileSync(join(repo, 'extensions', 'changed.ts'), 'utf8')).toBe('new');
    expect(readJson(join(repo, 'presets', 'public.json')).packages).toEqual(['npm:keep', 'npm:fresh']);
  });

  it('默认用当前目录当 clone', () => {
    const { repo, agent } = sandbox({ agentPackages: ['npm:a'] });
    const r = cli(['sync', '--agent-dir', agent], { cwd: repo });

    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(readJson(join(repo, 'presets', 'public.json')).packages).toEqual(['npm:a']);
  });

  it('--dry-run 只看差异不落盘', () => {
    const { repo, agent } = sandbox({ repoPackages: ['npm:old'], agentPackages: ['npm:new'] });
    const r = cli(['sync', '--repo', repo, '--agent-dir', agent, '--dry-run']);

    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/变更预览/);
    expect(readJson(join(repo, 'presets', 'public.json')).packages).toEqual(['npm:old']);
  });

  it('--include 吸收本机新增的扩展', () => {
    const { repo, agent } = sandbox({ agentExtensions: { 'extra.ts': 'local' } });
    const r = cli(['sync', '--repo', repo, '--agent-dir', agent, '--include', 'extra.ts']);

    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(readFileSync(join(repo, 'extensions', 'extra.ts'), 'utf8')).toBe('local');
  });

  it('仓库有未提交改动时不覆盖，--force 才覆盖', () => {
    const { repo, agent } = sandbox({
      repoExtensions: { 'a.ts': 'committed' },
      agentExtensions: { 'a.ts': 'home' },
    });
    execFileSync('git', ['-C', repo, 'init', '-q']);
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
    writeFileSync(join(repo, 'extensions', 'a.ts'), 'uncommitted');

    const guarded = cli(['sync', '--repo', repo, '--agent-dir', agent]);
    expect(guarded.stdout).toMatch(/冲突：仓库有未提交改动/);
    expect(readFileSync(join(repo, 'extensions', 'a.ts'), 'utf8')).toBe('uncommitted');

    const forced = cli(['sync', '--repo', repo, '--agent-dir', agent, '--force']);
    expect(forced.code).toBe(0);
    expect(readFileSync(join(repo, 'extensions', 'a.ts'), 'utf8')).toBe('home');
  });
});
