# my-pi-preset

我自己使用的 [pi](https://pi.dev) 扩展 preset。第三方包清单 + 手写的自定义扩展，
换机时一条命令恢复，日常一条命令回写。

```
.
├── src/
│   ├── cli/
│   │   ├── bin.ts             # 进程入口 → dist/cli.js
│   │   ├── index.ts           # 注册所有命令 + main()
│   │   ├── pull.ts            # pull 命令
│   │   └── sync.ts            # sync 命令
│   ├── types.ts               # 共用类型
│   ├── paths.ts               # 包根 / agent 目录 / clone 校验
│   ├── package-source.ts      # source 解析、身份归一、公开性白名单
│   └── fs-helpers.ts          # 读写 JSON / 托管文件识别 / git 脏状态
├── dist/cli.js                # 构建产物，bin 指向它
├── test/unit/                 # vitest 单元套件（import src/，不构建）
├── test/helpers/sandbox.ts    # 临时目录沙盒 + 子进程封装
├── test-e2e/cli.e2e.ts        # spawn 真实进程的 e2e
├── extensions/                # 手写的 pi 扩展
├── presets/public.json        # 公开的第三方包清单
└── .agents/skills/pi-preset-sync  # sync → 确认 → 提交推送
```

## 换机恢复

```bash
npx -y @1lon/pi-preset pull
```

做两件事，**只增不删、不改**：

1. 把 `presets/public.json` 里本机还没有的包追加进 `~/.pi/agent/settings.json` 的 `packages`。
   本机已存在的包原样保留——包括自己调过的资源过滤规则，不会被清单覆盖。
2. 把 `extensions/` 下的扩展复制到 `~/.pi/agent/extensions/`。本机同名文件若内容不同，
   先备份到 `.backup-<时间戳>/` 再覆盖。

本机多出来的包（公司内部包、正在试用的包）一律不碰，因此两台机器之间可能出现漂移，
这是刻意换来的：恢复命令永远不会破坏你正在进行的工作。

跳过不碰的文件：软链、文件头声明 `installed by` / `managed by` 的文件、
以及旁边带指纹文件（`xxx.js.xxx-hash`）的工具产物。

公司内部使用的扩展不在本清单里，换公司机器时自己 `pi install` 一条。

## 日常回写

改完 `~/.pi/agent/extensions/` 下的扩展、或用 `pi install` / `pi remove` 调整过包之后，
在本仓库 clone 的根目录触发 `pi-preset-sync` skill：它会跑 `sync`、把「新增/修改/删除」
列给你确认，确认后执行 `git add`（只加本次同步的文件）/ `commit` / `push`。

手动执行也可以（不提交，只写文件）：

```bash
npx -y @1lon/pi-preset sync --dry-run              # 只看差异
npx -y @1lon/pi-preset sync                        # 写回当前目录的 clone
npx -y @1lon/pi-preset sync --include new-ext.ts   # 顺带把本机新增的扩展纳入仓库
```

`sync` **不做任何 git 操作**。清单按白名单过滤：只有 `npm:` 和 `github.com` 的 git 源
会写进 `presets/public.json`，任何内网地址或本地路径都会被丢弃并提示。

`sync` 方向是「家目录覆盖仓库」，所以仓库里那份若有**未提交的改动**，默认跳过并列为
冲突，不静默覆盖。确实要用家目录版本覆盖时加 `--force`。

## 注意

- 改扩展就改 `~/.pi/agent/extensions/` 下那份，重启 pi 生效，然后跑 sync。
- **不要在 clone 里 `pi -e ./extensions/xxx.ts`**，也**不要 `pi install` 本仓库**。
  pi 按解析后的绝对路径去重，同一扩展出现在两个路径下会被加载两次（工具名冲突、
  renderer 重复注册）。本仓库的 `package.json` 不含 `pi` 字段、也没有 `pi-package` 关键词，
  避免被当成资源包。
- `pull` / `sync` 默认读 `~/.pi/agent`，可用 `--agent-dir` 或 `PI_CODING_AGENT_DIR` 指向别处。
- 本仓库不要发布到公司私服：`publishConfig.registry` 已固定为公开 npm。
- `extensions/pi-code-skills-dedup.ts` 在启动时从 `$PI_CODING_AGENT_DIR`（默认 `~/.pi/agent`）
  下的 `npm/node_modules/pi-code/extensions/skills.ts` 解析 pi-code，不写死绝对路径。
  找不到时只打一条 warning 并跳过 skill 去重，不会让 pi 启动失败。

## 开发

包管理器用 **pnpm**（`packageManager` 字段已锁 `pnpm@9.15.9`）。

**Node 版本**：`engines` 声明 `>=22.19.0`，这是依赖决定的硬下限——
`commander@15` 要求 `>=22.12.0`，`@earendil-works/*` 这两个 peer 要求 `>=22.19.0`。
Node 20 装不上，`>=20` 是错的。

本地开发还要再严一点：`tsdown@0.23` 的 `engines` 是
`^22.18.0 || ^24.11.0 || >=26.0.0`，**排除了 23.x 和 25.x**。
所以可用的开发版本是 22.19+、24.11+、26+。这条没写进 `engines`，
因为它只影响构建，装包的人不需要满足。

```bash
pnpm install          # 装依赖
pnpm dev --help       # = tsx src/cli/index.ts，改完不用构建
pnpm typecheck        # tsc --noEmit，覆盖 src / extensions / test / test-e2e
pnpm build            # tsdown → dist/cli.js
pnpm test             # vitest 单元套件，进程内跑，不构建
pnpm test:watch       # 单元套件 watch 模式
pnpm test:e2e         # vitest e2e，spawn tsx 跑源码，不构建
pnpm test:e2e:dist    # 先 build，再 spawn node dist/cli.js 验证产物
pnpm test:all         # 三段全跑
```

测试分两层，和 `deck-cli` 同一个分法：

- `test/unit/` — 只调纯函数（`planPull` / `planSync` / `parseSource` …），
  import 的是 `src/`，vitest 自己转译 TypeScript，**改完源码立刻能跑**。
  全部落在临时目录，不碰真实的 `~/.pi/agent`。
- `test-e2e/` — spawn 真实进程，断言退出码、stdout/stderr 与落盘效果。
  默认跑 `tsx src/cli/index.ts`，`E2E_TARGET=dist` 时改跑 `node dist/cli.js`。

commander 的错误路径（未知子命令、未知选项）**只能在 e2e 里测**：
它在子命令层面直接 `process.exit()`，同进程调用会杀掉测试进程本身。

`bin` 始终指向 `dist/cli.js`，`prepublishOnly` 会先 typecheck 再 build，
所以发布前不需要手动记住构建这一步。

依赖的划分：

- `dependencies` 只有 `commander`，CLI 运行时真正需要。
- `@earendil-works/pi-coding-agent` / `pi-tui` 同时写在 `peerDependencies`（`"*"`）
  和 `devDependencies`。peer 声明表达「`extensions/` 下的代码依赖宿主提供这两个模块」，
  dev 声明让本仓库能做类型检查。
