import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

import { AgentError } from './context.js'
import { EXIT } from './exit.js'
import { supportsPen } from './features.js'

export const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))
export const SKILLS = ['agent-sessions', 'agent-slots', 'agent-orchestrate', 'agent-commit', 'agent-cleanup', 'agent-pen', 'agent-setup']

export const skillsFor = (ctx) => supportsPen(ctx) ? SKILLS : SKILLS.filter((name) => name !== 'agent-pen')

// The personal Pen workflow is a separate skill. Strip references to it from shared workflows.
export const sharedSkillText = (source) => source.replace(/^.*\bagent-pen\b.*\n/gm, '').replace(' и сохранение Pen.', '.')

export const skillPath = (name, ctx) => {
  if (!skillsFor(ctx).includes(name)) throw new AgentError(`Неизвестный скилл: ${name}. agent skills list`)
  return join(PACKAGE_ROOT, 'skills', name, 'SKILL.md')
}

const stat = (path) => {
  try { return lstatSync(path) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

// Не проходить по симлинкам при записи в личное хранилище или каталог резервных копий.
const checkParents = (path) => {
  const parents = []
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    parents.push(parent)
    if (parent === dirname(parent)) break
  }
  for (const parent of parents.reverse()) {
    const info = stat(parent)
    if (info && (!info.isDirectory() || info.isSymbolicLink())) {
      throw new AgentError(`Каталог должен быть обычной папкой: ${parent}`, EXIT.check)
    }
  }
}

export const agentHomes = (ctx) => {
  const home = ctx.env.HOME ?? homedir()
  return [
    { agent: 'codex', directory: join(home, '.agents', 'skills') },
    { agent: 'claude', directory: join(ctx.claudeHome, 'skills') },
  ]
}

export const routerSource = (ctx) => {
  const source = readFileSync(join(PACKAGE_ROOT, 'examples', 'agent-cli', 'SKILL.md'), 'utf8')
  return supportsPen(ctx) ? source : sharedSkillText(source)
}

const targetState = (path) => {
  checkParents(path)
  const info = stat(path)
  if (info && (!info.isFile() || info.isSymbolicLink())) {
    throw new AgentError(`Скилл должен быть обычным файлом: ${path}`, EXIT.check)
  }
  return info ? readFileSync(path, 'utf8') : null
}

export const installSkills = (ctx, opts) => {
  if (!['codex', 'claude', 'all'].includes(opts.agent)) {
    throw new AgentError('Нужно: agent skills install --agent codex|claude|all [--directory D] [--dry-run] [--force]')
  }
  if (opts.directory && opts.agent === 'all') throw new AgentError('--directory требует одного --agent')
  const source = routerSource(ctx)
  const targets = agentHomes(ctx).filter((item) => opts.agent === 'all' || item.agent === opts.agent).map((item) => {
    const directory = opts.directory
      ? resolve(ctx.cwd, opts.directory.replace(/^~(?=\/|$)/, ctx.env.HOME ?? homedir()))
      : item.directory
    const path = join(directory, 'agent-cli', 'SKILL.md')
    const previous = targetState(path)
    const action = previous === source ? 'unchanged' : previous === null ? 'create' : 'replace'
    return { agent: item.agent, path, previous, action, backup: null }
  })
  // Проверить все назначения до первой записи: конфликт во втором агенте не меняет первого.
  for (const target of targets) {
    if (target.action === 'replace' && !opts.force && !opts['dry-run']) {
      throw new AgentError(`Скилл уже существует или изменён: ${target.path}. Посмотрите --dry-run; --force заменит его с резервной копией. references/ сохраняются.`, EXIT.check)
    }
  }
  if (!opts['dry-run']) {
    for (const target of targets) {
      if (target.action === 'unchanged') continue
      mkdirSync(dirname(target.path), { recursive: true })
      const temporary = `${target.path}.${randomUUID()}.tmp`
      try {
        writeFileSync(temporary, source, { flag: 'wx', mode: 0o600 })
        if (targetState(target.path) !== target.previous) throw new AgentError(`Скилл изменился во время установки: ${target.path}`, EXIT.check)
        if (target.previous !== null) {
          target.backup = join(ctx.agentHome, 'backups', 'skills', `${target.agent}-${randomUUID()}.md`)
          checkParents(target.backup)
          mkdirSync(dirname(target.backup), { recursive: true, mode: 0o700 })
          writeFileSync(target.backup, target.previous, { flag: 'wx', mode: 0o600 })
        }
        renameSync(temporary, target.path)
      } finally { rmSync(temporary, { force: true }) }
    }
  }
  const items = targets.map(({ previous, ...item }) => item)
  return {
    data: { dryRun: Boolean(opts['dry-run']), items },
    text: [...items.map((item) => `${item.action}: ${item.path}${item.backup ? `\n  резервная копия: ${item.backup}` : ''}`),
      opts['dry-run'] ? 'Сухой прогон: файлы не изменены.' : 'Роутер подключён. Если скилл не появился, перезапустите сессию агента.'].join('\n'),
  }
}

export const skillsCommand = async (ctx, sub, args, opts) => {
  try {
    if (sub === 'list' && args.length === 0) {
      const items = skillsFor(ctx).map((name) => ({ name, path: skillPath(name, ctx) }))
      return { data: items, text: items.map((item) => `${item.name}\t${item.path}`).join('\n') }
    }
    if (sub === 'path' && args.length === 1) {
      const path = skillPath(args[0], ctx)
      return { data: { path }, text: path }
    }
    if (sub === 'install' && args.length === 0) {
      if (!opts.agent && !opts.json && process.stdin.isTTY && process.stdout.isTTY) {
        const prompt = createInterface({ input: process.stdin, output: process.stdout })
        try {
          const agent = (await prompt.question('Подключить процессы agent-cli: codex, claude или all? ')).trim()
          return installSkills(ctx, { ...opts, agent })
        } finally { prompt.close() }
      }
      return installSkills(ctx, opts)
    }
    throw new AgentError('Нужно: agent skills list | path <имя> | install --agent codex|claude|all')
  } catch (error) {
    if (error instanceof AgentError) throw error
    throw new AgentError(`Не удалось прочитать или установить скиллы: ${error.message}`)
  }
}

/** An executor launched by the private package can use its bundled CLI directly. */
export const statusInvocation = (ctx) => {
  if (!ctx.env.AGENT_CLI_BUNDLED) return 'agent status --json'
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'"
  const runner = ctx.agentLauncher ? `${quote(ctx.agentLauncher)} --agent-cli` : `${quote(process.execPath)} ${quote(join(PACKAGE_ROOT, 'bin', 'agent.js'))}`
  return `\`${runner} status --json\``
}
