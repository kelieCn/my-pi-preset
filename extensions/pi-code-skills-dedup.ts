/**
 * 为 pi-code 的 Skills 桥接增加按名称去重和原始输入显示。
 * 保留 Pi 已加载的版本和 Claude 路径中原有的先到先得顺序。
 * 原始输入单独持久化为不进入模型上下文的条目，不改变动态参数展开。
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadSkills, UserMessageComponent, type ExtensionAPI } from '@earendil-works/pi-coding-agent'

const ORIGINAL_INPUT_ENTRY = 'skill-original-input'

/** pi 的 agent 目录：可由 PI_CODING_AGENT_DIR 覆盖，默认 ~/.pi/agent。 */
function resolveAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR
    ? resolve(process.env.PI_CODING_AGENT_DIR.replace(/^~(?=\/|$)/, homedir()))
    : join(homedir(), '.pi', 'agent')
}

/**
 * 定位 pi-code 的 skills 扩展。
 * 不能写死绝对路径：换机器、换用户名、或 pi-code 换安装位置都会失效。
 * 依次尝试：pi 的 agent 目录下的 npm 安装根。
 */
function resolvePiCodeSkills(): string | undefined {
  const agentDir = resolveAgentDir()
  const candidates = [
    join(agentDir, 'npm', 'node_modules', 'pi-code', 'extensions', 'skills.ts'),
    join(agentDir, 'node_modules', 'pi-code', 'extensions', 'skills.ts'),
  ]
  return candidates.find(candidate => existsSync(candidate))
}

export default async function piCodeSkillsDedup(pi: ExtensionAPI) {
  const skillsPath = resolvePiCodeSkills()
  if (!skillsPath) {
    // pi-code 没装（或改了目录结构）：本扩展无事可做，但也不能让 pi 因此报错。
    // UI 只存在于事件回调的 ctx 上，ExtensionAPI 本身没有 ui，所以推迟到 session_start。
    pi.on('session_start', (_event, ctx) => {
      ctx.ui.notify('pi-code-skills-dedup: 未找到 pi-code 的 skills 扩展，已跳过 skill 去重。', 'warning')
    })
    return
  }
  const piCodeSkills = (await import(skillsPath)).default as (api: ExtensionAPI) => unknown

  pi.registerEntryRenderer<{ text: string }>(ORIGINAL_INPUT_ENTRY, (entry) => {
    if (typeof entry.data?.text !== 'string') return undefined
    // 不随 skill 的展开状态折叠；复用 user 组件以兼容现有 UI 样式。
    return new UserMessageComponent(entry.data.text, undefined, pi.getSettings().outputPad)
  })

  const wrapped = new Proxy(pi, {
    get(target, property, receiver) {
      if (property !== 'on') return Reflect.get(target, property, receiver)
      return (event: string, handler: (...args: any[]) => any) => {
        if (event === 'input') {
          return target.on('input', async (input, ctx) => {
            const name = input.text.trimStart().match(/^\/skill:([^\s]+)(?:\s|$)/)?.[1]
            const isUserSkill = input.source !== 'extension' && name && target.getCommands().some(
              command => command.source === 'skill' && command.name === `skill:${name}`,
            )
            if (isUserSkill) {
              // 在原处理器展开/排队之前追加，确保 user 原文排在 skill 块前。
              // custom entry 随会话保存，但不会给模型重复注入用户请求。
              target.appendEntry(ORIGINAL_INPUT_ENTRY, { text: input.text })
            }
            return handler(input, ctx)
          })
        }
        if (event !== 'resources_discover') return target.on(event as any, handler)
        return target.on('resources_discover', async (event, ctx) => {
          const resources = await handler(event, ctx)
          if (!resources?.skillPaths?.length) return resources

          const existingNames = new Set(
            target.getCommands()
              .filter(command => command.source === 'skill')
              .map(command => command.name.replace(/^skill:/, '')),
          )
          // 使用 Pi 自己的解析器，保持 SKILL.md 命名、忽略规则和软链接语义。
          const candidates = loadSkills({
            cwd: ctx.cwd,
            agentDir: resolveAgentDir(),
            skillPaths: resources.skillPaths,
            includeDefaults: false,
          })
          const skillPaths = candidates.skills
            .filter(skill => !existingNames.has(skill.name))
            .map(skill => skill.filePath)

          // 只消除重名项；损坏的文件仍交回 Pi，让其正常显示解析诊断。
          const validPaths = new Set(candidates.skills.map(skill => resolve(skill.filePath)))
          for (const diagnostic of candidates.diagnostics) {
            if (diagnostic.type === 'collision' && diagnostic.path) {
              validPaths.add(resolve(diagnostic.path))
            }
          }
          for (const diagnostic of candidates.diagnostics) {
            if (diagnostic.type !== 'collision' && diagnostic.path && !validPaths.has(resolve(diagnostic.path))) {
              skillPaths.push(diagnostic.path)
            }
          }
          return { ...resources, skillPaths: [...new Set(skillPaths)] }
        })
      }
    },
  })
  return piCodeSkills(wrapped)
}
