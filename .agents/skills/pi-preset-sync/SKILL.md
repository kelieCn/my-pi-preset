---
name: pi-preset-sync
description: 把本机 ~/.pi/agent 里的自定义扩展和第三方包清单同步回 my-pi-preset 仓库，并在用户确认后提交推送。当用户说「同步 preset」「把这个扩展同步进仓库」「更新我的 pi 扩展清单并提交」时使用。
---

# pi-preset-sync

在 my-pi-preset 仓库的 clone 根目录中运行。把本机最新的 pi 扩展内容与包清单回写进仓库，
经用户确认后提交并推送到 GitHub 的 `main`。

`npx -y @1lon/pi-preset sync` 只负责让文件和清单一致；**git 操作由本 skill 编排**，
因为它们需要用户拍板。

## 流程

### 1. 前置检查

- 确认当前目录是本仓库 clone：`package.json` 的 `name` 为 `@1lon/pi-preset`。不是就停下来，
  问用户仓库在哪。
- 确认当前分支是 `main`：`git rev-parse --abbrev-ref HEAD`。不是 `main` 就停下来报告，
  **不要自动切分支**。
- 确认 git 身份：`git config user.name` 应为 `kelieCn`，`git config user.email` 应为
  `kelieCn720@gmail.com`。不符就先提示用户（本仓库是 GitHub 个人仓库，公司身份会导致
  CLA 校验失败且贡献不计数）。**只提示，绝不擅自修改全局 git 配置**；用户要求时用
  `git config --local` 在本仓库内修正。

### 2. 执行 sync

```bash
npx -y @1lon/pi-preset sync
```

`npx -y` 里的 `-y` 不能省，否则 npx 会停在「是否安装」的交互上。

若用户提到要纳入某个本机新增的扩展文件，加 `--include <文件名>` 后重跑。
若本机还没装过这个包、或想先确认差异，可先跑 `npx -y @1lon/pi-preset sync --dry-run`。

### 3. 展示改动

把 cli 输出的「新增 / 修改 / 删除」三段原样呈现给用户，**不要改写、不要省略、不要总结成一句话**。
需要时补充说明：哪些文件变了、清单里都是哪些包、哪些本机包因为不可公开被排除。

若三段皆空（输出「已是最新」），报告一句「已是最新，无需提交」然后结束——**不要提交空 commit**。

### 4. 等用户确认

停下来等明确答复。用户没说「可以 / 提交 / 推送」之前，不执行任何 git 命令。
用户要求调整时，改完重跑第 2 步。

### 5. 提交并推送

用户确认后：

```bash
git add <本次 sync 触及的路径>     # 见下方约束
git commit -m "<message>"
git push origin main
```

commit message 按实际改动写，中文，一句话说明这次同步了什么（例如
`sync: 更新 question-render 扩展并新增 pi-x 包`），不加 emoji。

### 6. 报告

给出 commit sha、推送结果（远端 + 分支），以及工作区是否干净。

## 硬约束

- **`git add` 只能加本次 sync 写过的具体路径**——`extensions/` 下变动的文件、
  `presets/public.json`。**绝不能 `git add -A`、`git add .`、`git commit -a`**：
  工作区里可能还有与本次同步无关的改动，一并提交会把它们带进仓库。
- **commit message 不得包含 `Co-Authored-By` 之类的 AI 协作者 trailer。**
- 只在当前 `main` 分支上提交推送，不切分支、不建分支、不 `--force`。
- 推送失败（远端有新提交）时停下来报告，由用户决定 `pull --rebase` 还是合并；
  不自动处理冲突。
- 公司内网的包（如 `git:git@gitlab.basemind.com:...`）由 cli 自动排除在公开清单之外。
  如果发现它出现在将被提交的内容里，**立刻停下**，不要推送。
