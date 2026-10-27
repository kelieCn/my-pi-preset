/** pi settings.json 中的一条 package 声明：字符串，或带资源过滤的对象。 */
export type PackageEntry = string | {
  source: string;
  autoload?: boolean;
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
};

export interface Settings {
  packages?: PackageEntry[];
  [key: string]: unknown;
}

export interface Manifest {
  packages?: PackageEntry[];
}

export type ParsedSource =
  | { type: 'npm'; name: string }
  | { type: 'git'; host: string; path: string }
  | { type: 'local'; path: string };

export interface FileChanges {
  added: string[];
  modified: string[];
  unchanged: string[];
  skipped: Array<{ name: string; reason: string }>;
}

export interface PullPlan {
  settingsPath: string;
  settings: Settings;
  toAdd: PackageEntry[];
  files: FileChanges;
  sourceDir: string;
  targetDir: string;
}

export interface SyncPlan {
  homeExtDir: string;
  repoExtDir: string;
  extensions: {
    added: string[];
    modified: string[];
    missing: string[];
    unmanaged: string[];
    /** 仓库里这份有未提交改动、家目录又不一样：不能擅自覆盖，交给用户决定。 */
    conflicts: Array<{ name: string; reason: string }>;
  };
  manifestPath: string;
  packages: { added: string[]; modified: string[]; deleted: string[] };
  nextPackages: PackageEntry[];
  dropped: string[];
}
