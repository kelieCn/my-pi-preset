/** planSync / applySync / printSyncSummary 的行为与边界，不经过 commander。 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { assertRepoRoot } from '../../src/paths.js';
import { applySync, planSync, printSyncSummary } from '../../src/cli/sync.js';
import { captureStdout, cleanup, readJson, sandbox, tempDir } from '../helpers/sandbox.js';

afterAll(cleanup);

interface SyncOptions {
  dryRun?: boolean;
  include?: string[];
  force?: boolean;
}

function sync(repo: string, agent: string, { dryRun = false, include = [], force = false }: SyncOptions = {}) {
  // 与 CLI 同样先过一遍 clone 校验，这样单元测试也覆盖了那条前置守卫
  assertRepoRoot(repo);
  return captureStdout(() => {
    const plan = planSync({ repoRoot: repo, agentDir: agent, include, force });
    printSyncSummary(plan, dryRun);
    applySync(plan, { dryRun });
    return plan;
  });
}

describe('planSync 的包清单', () => {
  it('按新增 / 修改 / 删除三段分类', () => {
    const { repo, agent } = sandbox({
      repoPackages: ['npm:keep', 'npm:gone', { source: 'npm:changed', extensions: ['!a'] }],
      agentPackages: ['npm:keep', 'npm:fresh', { source: 'npm:changed', extensions: ['!b'] }],
    });
    const { value: plan } = sync(repo, agent);

    expect(plan.packages.added).toEqual(['npm:fresh']);
    expect(plan.packages.modified).toEqual(['npm:changed']);
    expect(plan.packages.deleted).toEqual(['npm:gone']);
  });

  it('整表覆盖：清单永远等于本机现状', () => {
    const { repo, agent } = sandbox({
      repoPackages: ['npm:old'],
      agentPackages: ['npm:new'],
    });
    sync(repo, agent);

    expect(readJson(join(repo, 'presets', 'public.json')).packages).toEqual(['npm:new']);
  });

  it('内网包不写入公开清单', () => {
    const { repo, agent } = sandbox({
      agentPackages: ['npm:ok', 'git:git@gitlab.basemind.com:team/secret.git'],
    });
    const { value: plan, out } = sync(repo, agent);

    expect(plan.dropped).toEqual(['git:git@gitlab.basemind.com:team/secret.git']);
    expect(readJson(join(repo, 'presets', 'public.json')).packages).toEqual(['npm:ok']);
    expect(out).toMatch(/不写入公开清单/);
    expect(readFileSync(join(repo, 'presets', 'public.json'), 'utf8')).not.toContain('basemind');
  });

  it('本机 settings.json 不存在时得到空清单', () => {
    const { repo, agent } = sandbox({ repoPackages: ['npm:old'] });
    rmSync(join(agent, 'settings.json'), { force: true });
    sync(repo, agent);

    expect(readJson(join(repo, 'presets', 'public.json')).packages).toEqual([]);
  });
});

describe('planSync 的扩展文件', () => {
  it('家目录内容不同的记为修改', () => {
    const { repo, agent } = sandbox({
      repoExtensions: { 'changed.ts': 'old' },
      agentExtensions: { 'changed.ts': 'new' },
    });
    const { value: plan } = sync(repo, agent);

    expect(plan.extensions.modified).toEqual(['changed.ts']);
    expect(readFileSync(join(repo, 'extensions', 'changed.ts'), 'utf8')).toBe('new');
  });

  it('本机新增的扩展默认不吸收', () => {
    const { repo, agent } = sandbox({ agentExtensions: { 'extra.ts': 'local' } });
    const { value: plan, out } = sync(repo, agent);

    expect(plan.extensions.unmanaged).toEqual(['extra.ts']);
    expect(plan.extensions.added).toEqual([]);
    expect(existsSync(join(repo, 'extensions', 'extra.ts'))).toBe(false);
    expect(out).toMatch(/本机新增但未纳入管理/);
  });

  it('--include 指定后才吸收本机新增的扩展', () => {
    const { repo, agent } = sandbox({ agentExtensions: { 'extra.ts': 'local' } });
    const { value: plan } = sync(repo, agent, { include: ['extra.ts'] });

    expect(plan.extensions.added).toEqual(['extra.ts']);
    expect(readFileSync(join(repo, 'extensions', 'extra.ts'), 'utf8')).toBe('local');
  });

  it('本机缺失的扩展保留仓库版本，不删除', () => {
    const { repo, agent } = sandbox({ repoExtensions: { 'only-repo.ts': 'keep-me' } });
    const { value: plan, out } = sync(repo, agent);

    expect(plan.extensions.missing).toEqual(['only-repo.ts']);
    expect(readFileSync(join(repo, 'extensions', 'only-repo.ts'), 'utf8')).toBe('keep-me');
    expect(out).toMatch(/本机缺失、已保留仓库版本/);
  });

  it('--dry-run 不写任何文件', () => {
    const { repo, agent } = sandbox({
      repoPackages: ['npm:old'],
      repoExtensions: { 'a.ts': 'old' },
      agentPackages: ['npm:new'],
      agentExtensions: { 'a.ts': 'new' },
    });
    sync(repo, agent, { dryRun: true });

    expect(readJson(join(repo, 'presets', 'public.json')).packages).toEqual(['npm:old']);
    expect(readFileSync(join(repo, 'extensions', 'a.ts'), 'utf8')).toBe('old');
  });
});

describe('planSync 的冲突保护', () => {
  /** 造一个真的 git 仓库：仓库里 a.ts 有未提交改动。 */
  function dirtyRepo() {
    const { repo, agent } = sandbox({
      repoExtensions: { 'a.ts': 'committed' },
      agentExtensions: { 'a.ts': 'home-version' },
    });
    execFileSync('git', ['-C', repo, 'init', '-q']);
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
    writeFileSync(join(repo, 'extensions', 'a.ts'), 'repo-uncommitted');
    return { repo, agent };
  }

  it('仓库这份有未提交改动时归为冲突，不覆盖', () => {
    const { repo, agent } = dirtyRepo();
    const { value: plan, out } = sync(repo, agent);

    expect(plan.extensions.conflicts.map((c) => c.name)).toEqual(['a.ts']);
    expect(plan.extensions.modified).toEqual([]);
    expect(readFileSync(join(repo, 'extensions', 'a.ts'), 'utf8')).toBe('repo-uncommitted');
    expect(out).toMatch(/冲突：仓库有未提交改动/);
  });

  it('--force 时才用家目录版本覆盖', () => {
    const { repo, agent } = dirtyRepo();
    sync(repo, agent, { force: true });

    expect(readFileSync(join(repo, 'extensions', 'a.ts'), 'utf8')).toBe('home-version');
  });

  it('两边内容相同时不算冲突', () => {
    const { repo, agent } = sandbox({ repoExtensions: { 'a.ts': 'same' }, agentExtensions: { 'a.ts': 'same' } });
    execFileSync('git', ['-C', repo, 'init', '-q']);
    writeFileSync(join(repo, 'extensions', 'a.ts'), 'same');
    const { value: plan } = sync(repo, agent);

    expect(plan.extensions.conflicts).toEqual([]);
  });
});

describe('assertRepoRoot', () => {
  it('认下合法的 clone', () => {
    const { repo } = sandbox({});
    expect(assertRepoRoot(repo)).toBe(repo);
  });

  it('缺少 .git 时报错', () => {
    const { repo } = sandbox({});
    rmSync(join(repo, '.git'), { recursive: true });
    expect(() => assertRepoRoot(repo)).toThrow(/不是仓库 clone/);
  });

  it('package.json 的 name 不符时报错', () => {
    const { repo } = sandbox({});
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'something-else' }));
    expect(() => assertRepoRoot(repo)).toThrow(/不是本仓库/);
  });

  it('目录不存在时报错', () => {
    expect(() => assertRepoRoot(join(tempDir(), 'nope'))).toThrow(/缺少 package\.json/);
  });
});
