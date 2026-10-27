import type { Command } from 'commander';
import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  EXTENSION_RE,
  hasUncommittedChanges,
  indent,
  isManagedFile,
  listDirFiles,
  readJson,
  sameContent,
  writeJson,
} from '../fs-helpers.js';
import { entrySource, isPublicSource, packageIdentity } from '../package-source.js';
import { assertRepoRoot, resolveAgentDir } from '../paths.js';
import type { Manifest, PackageEntry, Settings, SyncPlan } from '../types.js';

export interface SyncOptions {
  repo?: string;
  agentDir?: string;
  dryRun?: boolean;
  include?: string[];
  force?: boolean;
}

export function registerSync(program: Command, withCommon: (command: Command) => Command): void {
  withCommon(program
    .command('sync')
    .description('本机 → 仓库：把扩展文件与包清单写回当前 clone（不执行 git 操作）')
    .option('--repo <path>', 'clone 路径，默认当前目录')
    .option('--include <file>', '把本机某个新扩展文件纳入仓库（可多次指定）', collect, [])
    .option('-f, --force', '忽略「仓库有未提交改动」的保护，用家目录版本覆盖')
    .action(runSync));
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function runSync(options: SyncOptions): void {
  const repoRoot = assertRepoRoot(options.repo ?? process.cwd());
  const agentDir = resolveAgentDir(options.agentDir);
  const dryRun = Boolean(options.dryRun);

  const plan = planSync({
    repoRoot,
    agentDir,
    include: options.include ?? [],
    force: Boolean(options.force),
  });
  printSyncSummary(plan, dryRun);
  applySync(plan, { dryRun });
}

export function planSync(options: {
  repoRoot: string;
  agentDir: string;
  include?: string[];
  force?: boolean;
}): SyncPlan {
  const include = options.include ?? [];
  const homeExtDir = join(options.agentDir, 'extensions');
  const repoExtDir = join(options.repoRoot, 'extensions');
  const repoFiles = listDirFiles(repoExtDir, (file) => EXTENSION_RE.test(file));
  const homeFiles = listDirFiles(homeExtDir, (file) => EXTENSION_RE.test(file));

  const extensions = {
    added: [] as string[],
    modified: [] as string[],
    missing: [] as string[],
    unmanaged: [] as string[],
    conflicts: [] as Array<{ name: string; reason: string }>,
  };
  for (const name of repoFiles) {
    const home = join(homeExtDir, name);
    if (!existsSync(home) || isManagedFile(home)) {
      extensions.missing.push(name);
      continue;
    }
    if (sameContent(join(repoExtDir, name), home))
      continue;
    if (!options.force && hasUncommittedChanges(options.repoRoot, join('extensions', name))) {
      extensions.conflicts.push({
        name,
        reason: '仓库这份有未提交的改动，家目录也不同步；先用 --force 覆盖或手工合并',
      });
      continue;
    }
    extensions.modified.push(name);
  }
  for (const name of homeFiles) {
    if (repoFiles.includes(name))
      continue;
    if (include.includes(name)) {
      extensions.added.push(name);
      continue;
    }
    if (isManagedFile(join(homeExtDir, name)))
      continue;
    extensions.unmanaged.push(name);
  }

  const settings = readJson<Settings>(join(options.agentDir, 'settings.json'), {});
  const incoming: PackageEntry[] = [];
  const dropped: string[] = [];
  for (const entry of settings.packages ?? []) {
    const source = entrySource(entry);
    if (isPublicSource(source))
      incoming.push(entry);
    else
      dropped.push(source);
  }

  const manifestPath = join(options.repoRoot, 'presets', 'public.json');
  const previous = readJson<Manifest>(manifestPath, { packages: [] }).packages ?? [];
  const previousByIdentity = new Map(previous.map((entry) => [packageIdentity(entrySource(entry)), entry]));
  const incomingIdentities = new Set<string>();

  const packages = { added: [] as string[], modified: [] as string[], deleted: [] as string[] };
  for (const entry of incoming) {
    const identity = packageIdentity(entrySource(entry));
    incomingIdentities.add(identity);
    const before = previousByIdentity.get(identity);
    if (before === undefined)
      packages.added.push(identity);
    else if (JSON.stringify(before) !== JSON.stringify(entry))
      packages.modified.push(identity);
  }
  for (const entry of previous) {
    const identity = packageIdentity(entrySource(entry));
    if (!incomingIdentities.has(identity))
      packages.deleted.push(identity);
  }

  return { homeExtDir, repoExtDir, extensions, manifestPath, packages, nextPackages: incoming, dropped };
}

export function applySync(plan: SyncPlan, options: { dryRun: boolean }): void {
  if (options.dryRun)
    return;
  for (const name of [...plan.extensions.added, ...plan.extensions.modified])
    copyFileSync(join(plan.homeExtDir, name), join(plan.repoExtDir, name));
  const changed = plan.packages.added.length + plan.packages.modified.length + plan.packages.deleted.length;
  if (changed > 0)
    writeJson(plan.manifestPath, { packages: plan.nextPackages });
}

/** 输出「新增 / 修改 / 删除」三段，供 pi-preset-sync skill 原样转发给用户确认。 */
export function printSyncSummary(plan: SyncPlan, dryRun: boolean): void {
  const { extensions, packages } = plan;
  const added = [...extensions.added, ...packages.added];
  const modified = [...extensions.modified, ...packages.modified];
  const deleted = [...packages.deleted];

  const sections: string[] = [];
  sections.push(dryRun ? '变更预览（--dry-run，未落盘）' : '已同步到当前 clone');
  for (const [label, items] of [['新增', added], ['修改', modified], ['删除', deleted]] as const) {
    if (items.length === 0)
      continue;
    sections.push(`\n${label} (${items.length})`);
    sections.push(indent(items));
  }
  if (added.length + modified.length + deleted.length === 0)
    sections.push('\n已是最新。');

  if (extensions.conflicts.length > 0) {
    sections.push(`\n冲突：仓库有未提交改动，已跳过 (${extensions.conflicts.length})`);
    sections.push(indent(extensions.conflicts.map((item) => item.name)));
    for (const item of extensions.conflicts)
      sections.push(`  ${item.reason}`);
  }
  if (extensions.missing.length > 0) {
    sections.push(`\n本机缺失、已保留仓库版本 (${extensions.missing.length})`);
    sections.push(indent(extensions.missing));
  }
  if (extensions.unmanaged.length > 0) {
    sections.push(`\n本机新增但未纳入管理 (${extensions.unmanaged.length})`);
    sections.push(indent(extensions.unmanaged));
    sections.push('  确认要纳入时重跑：npx -y @1lon/pi-preset sync --include <文件名>');
  }
  if (plan.dropped.length > 0) {
    sections.push(`\n不写入公开清单 (${plan.dropped.length})`);
    sections.push(indent(plan.dropped));
  }
  process.stdout.write(`${sections.join('\n')}\n`);
}
