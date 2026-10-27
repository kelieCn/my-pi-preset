import { resolve } from 'node:path';

import type { PackageEntry, ParsedSource } from './types.js';

/**
 * 解析一条 package source，与 pi 的 package-manager 保持同一套身份判定。
 * https://github.com/… 与 git@github.com:… 会归一成同一个身份。
 */
export function parseSource(source: string): ParsedSource {
  const raw = source.trim();
  if (raw.startsWith('npm:')) {
    return { type: 'npm', name: npmPackageName(raw.slice('npm:'.length).trim()) };
  }
  if (/^git:/.test(raw) || /^(https?|ssh|git):\/\//i.test(raw) || /^git@/.test(raw)) {
    const git = parseGitLocation(raw);
    if (git)
      return { type: 'git', host: git.host, path: git.path };
  }
  return { type: 'local', path: resolve(raw) };
}

export function packageIdentity(source: string): string {
  const parsed = parseSource(source);
  if (parsed.type === 'npm')
    return `npm:${parsed.name}`;
  if (parsed.type === 'git')
    return `git:${parsed.host}/${parsed.path}`;
  return `local:${parsed.path}`;
}

export function entrySource(entry: PackageEntry): string {
  return typeof entry === 'string' ? entry : entry.source;
}

/**
 * 公开性白名单。只有明确可以公开的形态才写进 public.json。
 * 刻意写成「谁能进」而不是「谁排除」：将来出现新的内网地址时默认被拒绝。
 */
export function isPublicSource(source: string): boolean {
  const parsed = parseSource(source);
  if (parsed.type === 'npm')
    return true;
  if (parsed.type === 'git')
    return parsed.host === 'github.com' || parsed.host === 'www.github.com';
  return false;
}

function npmPackageName(spec: string): string {
  if (!spec.startsWith('@'))
    return spec.split('@')[0] ?? spec;
  const slash = spec.indexOf('/');
  if (slash === -1)
    return spec;
  const at = spec.indexOf('@', slash);
  return at === -1 ? spec : spec.slice(0, at);
}

function parseGitLocation(raw: string): { host: string; path: string } | null {
  let value = raw.replace(/^git:/, '').trim();
  const hash = value.indexOf('#');
  if (hash !== -1)
    value = value.slice(0, hash);
  value = value.replace(/\.git$/, '').replace(/\/$/, '');

  let match = value.match(/^git@([^:]+):(.+)$/);
  if (match)
    return { host: match[1]!, path: match[2]! };
  match = value.match(/^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i);
  if (match)
    return { host: match[1]!, path: match[2]! };
  match = value.match(/^([^/:]+\.[^/:]+)\/(.+)$/);
  if (match)
    return { host: match[1]!, path: match[2]! };
  return null;
}
