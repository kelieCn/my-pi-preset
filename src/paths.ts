import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 从本模块所在位置向上找最近的 package.json，作为包根。
 * 不能写成 `resolve(dirname(SELF), '..')`：源码在 src/cli/ 下（上两层才是包根），
 * 打包后在 dist/ 下（上一层就是包根），写死层数两边必然有一边错。
 */
function findPackageRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, 'package.json')))
      return dir;
    const parent = dirname(dir);
    if (parent === dir)
      throw new Error(`从 ${start} 向上找不到 package.json`);
    dir = parent;
  }
}

export const PACKAGE_ROOT = findPackageRoot(dirname(fileURLToPath(import.meta.url)));

const PACKAGE_JSON: { name: string; version: string } =
  JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));

export const PACKAGE_NAME = PACKAGE_JSON.name;
export const PACKAGE_VERSION = PACKAGE_JSON.version;

/** pi 的 agent 目录：可由 PI_CODING_AGENT_DIR 覆盖，默认 ~/.pi/agent。 */
export function resolveAgentDir(explicit?: string): string {
  const candidate = explicit ?? process.env.PI_CODING_AGENT_DIR;
  if (candidate)
    return resolve(candidate.replace(/^~(?=\/|$)/, homedir()));
  return join(homedir(), '.pi', 'agent');
}

/** 校验某个目录确实是本仓库的 clone，否则 sync 会写到不该写的地方。 */
export function assertRepoRoot(candidate: string): string {
  const root = resolve(candidate);
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath))
    throw new Error(`${root} 不是本仓库：缺少 package.json`);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string };
  if (pkg.name !== PACKAGE_NAME)
    throw new Error(`${root} 不是本仓库：package.json 的 name 是 ${pkg.name}，应为 ${PACKAGE_NAME}`);
  if (!existsSync(join(root, '.git')))
    throw new Error(`${root} 不是仓库 clone：缺少 .git`);
  return root;
}
