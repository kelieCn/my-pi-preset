/** planPull / applyPull / printPullSummary 的行为与边界，不经过 commander。 */
import { existsSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { applyPull, planPull, printPullSummary } from '../../src/cli/pull.js';
import { captureStdout, cleanup, readJson, sandbox } from '../helpers/sandbox.js';

afterAll(cleanup);

function pull(repo: string, agent: string, { dryRun = false } = {}) {
  return captureStdout(() => {
    const plan = planPull({ repoRoot: repo, agentDir: agent });
    const result = applyPull(plan, { dryRun });
    printPullSummary(plan, result, dryRun);
    return plan;
  });
}

describe('planPull', () => {
  it('只增：本机已有的包不重复加入', () => {
    const { repo, agent } = sandbox({
      repoPackages: ['npm:pi-code', 'npm:pi-new'],
      agentPackages: ['npm:pi-code'],
    });
    const { value: plan } = pull(repo, agent);

    expect(plan.toAdd).toEqual(['npm:pi-new']);
  });

  it('不改：本机条目的资源过滤规则原样保留，不被清单写法覆盖', () => {
    const filtered = { source: 'npm:pi-code', extensions: ['!extensions/mcp/**'] };
    const { repo, agent } = sandbox({
      repoPackages: ['npm:pi-code', 'npm:pi-new', 'git:github.com/obra/superpowers'],
      agentPackages: [filtered],
    });
    pull(repo, agent);

    const settings = readJson(join(agent, 'settings.json'));
    expect(settings.packages[0]).toEqual(filtered);
    expect(settings.packages).toHaveLength(3);
  });

  it('清单里的重复项只加一次', () => {
    const { repo } = sandbox({ repoPackages: ['npm:dup', 'npm:dup@1.0.0', 'npm:dup'] });
    const { agent } = sandbox({});
    const { value: plan } = pull(repo, agent);

    expect(plan.toAdd).toHaveLength(1);
  });

  it('本机有额外的包时不动它们', () => {
    const { repo, agent } = sandbox({
      repoPackages: ['npm:a'],
      agentPackages: ['npm:mine-1', 'npm:mine-2'],
    });
    pull(repo, agent);

    expect(readJson(join(agent, 'settings.json')).packages).toEqual(['npm:mine-1', 'npm:mine-2', 'npm:a']);
  });

  it('把扩展文件分成新增 / 修改 / 未变化 / 跳过', () => {
    const { repo, agent } = sandbox({
      repoExtensions: { 'a.ts': 'repo-a', 'b.ts': 'repo-b', 'c.ts': 'same' },
      agentExtensions: { 'b.ts': 'local-b', 'c.ts': 'same', 'other.ts': 'untouched' },
    });
    const { value: plan } = pull(repo, agent);

    expect(plan.files.added).toEqual(['a.ts']);
    expect(plan.files.modified).toEqual(['b.ts']);
    expect(plan.files.unchanged).toEqual(['c.ts']);
    expect(plan.files.skipped).toEqual([]);
  });

  it('非扩展后缀与 . 开头的条目不计入', () => {
    const { repo, agent } = sandbox({
      repoExtensions: { 'note.md': 'x', '.hidden.ts': 'y', 'real.ts': 'z' },
    });
    const { value: plan } = pull(repo, agent);

    expect(plan.files.added).toEqual(['real.ts']);
  });
});

describe('applyPull', () => {
  it('settings.json 不存在时创建', () => {
    const { repo, agent } = sandbox({ repoPackages: ['npm:pi-a'], settings: { theme: 'x' } });
    rmSync(join(agent, 'settings.json'), { force: true });

    pull(repo, agent);
    expect(readJson(join(agent, 'settings.json'))).toEqual({ packages: ['npm:pi-a'] });
  });

  it('settings.json 存在时保留其它字段', () => {
    const { repo, agent } = sandbox({
      repoPackages: ['npm:pi-a'],
      settings: { theme: 'github-dark-pro' },
    });
    pull(repo, agent);

    expect(readJson(join(agent, 'settings.json')).theme).toBe('github-dark-pro');
  });

  it('覆盖改动过的扩展前先备份，只备份真正被覆盖的', () => {
    const { repo, agent } = sandbox({
      repoExtensions: { 'a.ts': 'repo-a', 'b.ts': 'repo-b', 'c.ts': 'same' },
      agentExtensions: { 'b.ts': 'local-b', 'c.ts': 'same' },
    });
    pull(repo, agent);

    expect(readFileSync(join(agent, 'extensions', 'a.ts'), 'utf8')).toBe('repo-a');
    expect(readFileSync(join(agent, 'extensions', 'b.ts'), 'utf8')).toBe('repo-b');

    const backups = readdirSync(join(agent, 'extensions')).filter((n) => n.startsWith('.backup-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(agent, 'extensions', backups[0]!, 'b.ts'), 'utf8')).toBe('local-b');
    expect(existsSync(join(agent, 'extensions', backups[0]!, 'c.ts'))).toBe(false);
  });

  it('没有需要覆盖的文件时不产生备份目录', () => {
    const { repo, agent } = sandbox({ repoExtensions: { 'a.ts': 'x' } });
    pull(repo, agent);

    expect(readdirSync(join(agent, 'extensions')).filter((n) => n.startsWith('.backup-'))).toHaveLength(0);
  });

  it('跳过文件头声明由其他工具托管的文件', () => {
    const { repo, agent } = sandbox({
      repoExtensions: { 'managed.ts': 'mine' },
      agentExtensions: { 'managed.ts': '// installed by herdr\n// managed by herdr\nbody' },
    });
    const { value: plan } = pull(repo, agent);

    expect(plan.files.skipped.map((s) => s.name)).toEqual(['managed.ts']);
    expect(readFileSync(join(agent, 'extensions', 'managed.ts'), 'utf8')).toMatch(/installed by herdr/);
  });

  it('跳过旁挂指纹文件对应的托管文件', () => {
    const { repo, agent } = sandbox({
      repoExtensions: { 'hashy.ts': 'mine' },
      agentExtensions: { 'hashy.ts': 'body' },
    });
    writeFileSync(join(agent, 'extensions', 'hashy.ts.agentd-hash'), 'abc123');
    const { value: plan } = pull(repo, agent);

    expect(plan.files.skipped.map((s) => s.name)).toEqual(['hashy.ts']);
  });

  it('跳过软链，不写穿它', () => {
    const { repo, agent } = sandbox({
      repoExtensions: { 'linked.ts': 'mine' },
      agentExtensions: { 'target.ts': 'original' },
    });
    symlinkSync(join(agent, 'extensions', 'target.ts'), join(agent, 'extensions', 'linked.ts'));
    const { value: plan } = pull(repo, agent);

    expect(plan.files.skipped[0]!.name).toBe('linked.ts');
    expect(readFileSync(join(agent, 'extensions', 'target.ts'), 'utf8')).toBe('original');
  });

  it('--dry-run 完全不落盘', () => {
    const { repo, agent } = sandbox({
      repoPackages: ['npm:pi-a'],
      repoExtensions: { 'a.ts': 'repo-a' },
    });
    pull(repo, agent, { dryRun: true });

    expect(existsSync(join(agent, 'settings.json'))).toBe(false);
    expect(readdirSync(join(agent, 'extensions'))).toEqual([]);
  });

  it('重复执行幂等', () => {
    const { repo, agent } = sandbox({ repoPackages: ['npm:pi-a'], repoExtensions: { 'a.ts': 'x' } });
    pull(repo, agent);
    const { out } = pull(repo, agent);

    expect(out).toMatch(/已是最新/);
    expect(readJson(join(agent, 'settings.json')).packages).toHaveLength(1);
  });
});

describe('printPullSummary', () => {
  it('列出新增、跳过与备份路径', () => {
    const { repo, agent } = sandbox({
      repoPackages: ['npm:new'],
      repoExtensions: { 'a.ts': 'repo-a' },
      agentExtensions: { 'a.ts': 'local-a' },
    });
    const { out } = pull(repo, agent);

    expect(out).toMatch(/已复制[\s\S]*a\.ts/);
    expect(out).toMatch(/已新增 1 项[\s\S]*npm:new/);
    expect(out).toMatch(/旧文件已备份到 /);
  });
});
