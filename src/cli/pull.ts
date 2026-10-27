import type { Command } from 'commander';
import { copyFileSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { EXTENSION_RE, indent, isManagedFile, listDirFiles, readJson, sameContent, stamp, writeJson } from '../fs-helpers.js';
import { entrySource, packageIdentity } from '../package-source.js';
import { PACKAGE_ROOT, resolveAgentDir } from '../paths.js';
import type { FileChanges, Manifest, PackageEntry, PullPlan, Settings } from '../types.js';

export interface PullOptions {
  agentDir?: string;
  dryRun?: boolean;
}

export function registerPull(program: Command, withCommon: (command: Command) => Command): void {
  withCommon(program
    .command('pull')
    .description('仓库 → 本机：补齐清单中缺少的包，复制仓库 extensions/ 下的扩展文件')
    .action(runPull));
}

export function runPull(options: PullOptions): void {
  const agentDir = resolveAgentDir(options.agentDir);
  const dryRun = Boolean(options.dryRun);

  const plan = planPull({ repoRoot: PACKAGE_ROOT, agentDir });
  const result = applyPull(plan, { dryRun });
  printPullSummary(plan, result, dryRun);
}

/**
 * 只增不删、不改：清单里某个 source 在本机已存在的，条目原样保留
 * （包括本机自己调过的资源过滤规则），本机没有的才追加。
 */
export function planPull(options: { repoRoot: string; agentDir: string }): PullPlan {
  const manifest = readJson<Manifest>(join(options.repoRoot, 'presets', 'public.json'), { packages: [] });
  const settingsPath = join(options.agentDir, 'settings.json');
  const settings = readJson<Settings>(settingsPath, {});

  const existing = new Set((settings.packages ?? []).map((entry) => packageIdentity(entrySource(entry))));
  const toAdd: PackageEntry[] = [];
  for (const entry of manifest.packages ?? []) {
    const identity = packageIdentity(entrySource(entry));
    if (existing.has(identity))
      continue;
    existing.add(identity);
    toAdd.push(entry);
  }

  const sourceDir = join(options.repoRoot, 'extensions');
  const targetDir = join(options.agentDir, 'extensions');
  const files: FileChanges = { added: [], modified: [], unchanged: [], skipped: [] };
  for (const name of listDirFiles(sourceDir, (file) => EXTENSION_RE.test(file))) {
    const target = join(targetDir, name);
    let isLink = false;
    let exists = true;
    try {
      isLink = lstatSync(target).isSymbolicLink();
    }
    catch {
      exists = false;
    }
    if (!exists) {
      files.added.push(name);
      continue;
    }
    if (isLink) {
      files.skipped.push({ name, reason: '本机是软链' });
      continue;
    }
    if (isManagedFile(target)) {
      files.skipped.push({ name, reason: '文件头声明由其他工具托管' });
      continue;
    }
    if (sameContent(join(sourceDir, name), target))
      files.unchanged.push(name);
    else
      files.modified.push(name);
  }

  return { settingsPath, settings, toAdd, files, sourceDir, targetDir };
}

export function applyPull(plan: PullPlan, options: { dryRun: boolean }): { backupDir?: string } {
  const { settingsPath, settings, toAdd, files, sourceDir, targetDir } = plan;
  if (options.dryRun)
    return {};

  if (toAdd.length > 0) {
    settings.packages = [...(settings.packages ?? []), ...toAdd];
    writeJson(settingsPath, settings);
  }

  const touching = [...files.added, ...files.modified];
  let backupDir: string | undefined;
  if (touching.length > 0) {
    mkdirSync(targetDir, { recursive: true });
    if (files.modified.length > 0) {
      // 备份目录以 . 开头，pi 的扩展发现会跳过它。
      backupDir = join(targetDir, `.backup-${stamp()}`);
      mkdirSync(backupDir, { recursive: true });
      for (const name of files.modified)
        copyFileSync(join(targetDir, name), join(backupDir, name));
    }
    for (const name of touching)
      copyFileSync(join(sourceDir, name), join(targetDir, name));
  }

  return { backupDir };
}

export function printPullSummary(plan: PullPlan, result: { backupDir?: string }, dryRun: boolean): void {
  const lines: string[] = [];
  const touched = [...plan.files.added, ...plan.files.modified];
  if (touched.length > 0) {
    lines.push(`扩展文件 ${dryRun ? '将复制' : '已复制'}：`);
    lines.push(indent(touched));
  }
  if (plan.toAdd.length > 0) {
    lines.push(`包清单 ${dryRun ? '将新增' : '已新增'} ${plan.toAdd.length} 项：`);
    lines.push(indent(plan.toAdd.map((entry) => packageIdentity(entrySource(entry)))));
  }
  if (plan.files.unchanged.length > 0)
    lines.push(`未变化：${plan.files.unchanged.length} 个扩展文件`);
  for (const item of plan.files.skipped)
    lines.push(`跳过 ${item.name}（${item.reason}）`);
  if (result.backupDir)
    lines.push(`旧文件已备份到 ${result.backupDir}`);
  if (touched.length === 0 && plan.toAdd.length === 0)
    lines.push('已是最新，无需改动。');
  process.stdout.write(`${lines.join('\n')}\n`);
}
