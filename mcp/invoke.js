import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { main } from '../src/cli.js'
import { AgentError, createContext } from '../src/context.js'
import { containsPath, resolveCurrentWorkspace } from '../src/current.js'
import { doctor } from '../src/doctor.js'
import { installExecutor } from '../src/executor-install.js'
import { lastAnswer, promptText } from '../src/journal.js'
import { sessionRecords, resolveSession } from '../src/sessions.js'
import { skillPath } from '../src/skills.js'
import { loadConfig, loadRegistry } from '../src/store.js'
import { superset } from '../src/superset.js'
import { hostFailure, hostPids } from './host.js'
import { tools } from './tools.js'

const name = process.argv[2]
const args = JSON.parse(readFileSync(0, 'utf8'))
const tool = tools[name]
const ctx = createContext({ includeErrorDetails: true })
ctx.env = { ...ctx.env }
ctx.env.AGENT_CLI_BUNDLED = '1'
const installedLauncher = join(ctx.env.HOME, '.codex', 'plugins', 'multi-agent-mcp', 'launch')
if (existsSync(installedLauncher)) ctx.agentLauncher = installedLauncher
const originalRun = ctx.run
// Bound stalled host calls without putting a deadline on Git or project hooks.
ctx.run = (command, argv, opts = {}) => originalRun(command, argv, {
  ...opts,
  timeout: opts.timeout ?? (command === settings?.superset ? 30_000 : undefined),
})
let settings
let scratch
const flags = []
const positionals = []
const flag = (name, value) => {
  if (value === undefined || value === false) return
  flags.push(value === true ? `--${name}` : `--${name}=${value}`)
}
const tempFile = (name, value) => {
  scratch ??= mkdtempSync(join(tmpdir(), 'agent-mcp-'))
  const path = join(scratch, name)
  writeFileSync(path, value, { mode: 0o600 })
  return path
}
const oneOf = (a, b, required = true) => {
  if (args[a] && args[b] || required && !args[a] && !args[b]) throw new AgentError(`Укажите одно поле: ${a} или ${b}`)
  return args[a] ?? args[b]
}
const emit = (data) => { process.stdout.write(JSON.stringify(data) + '\n') }
const exactWorkspace = (workspaces, id) => {
  const ws = workspaces.find((row) => row.id === id)
  if (!ws) throw new AgentError(`Укажите существующий точный workspaceId: ${id}. Используйте projects.`, 6)
  return ws
}
const projectFor = (projects, ws, cwd) => {
  const candidates = projects.filter((p) => ws
    ? ws.projectId ? p.id === ws.projectId : p.name === ws.projectName
    : containsPath(p.path, cwd))
  if (candidates.length !== 1 || projects.filter((p) => p.name === candidates[0].name).length !== 1) {
    throw new AgentError('Проект Superset не определён однозначно. Выберите точный путь checkout через projects. При одинаковых именах проектов переименуйте один в Paradev.', 9)
  }
  return candidates[0]
}

const execute = async () => {
  const cli = () => main(['--json', ...flags, '--', ...tool.command, ...positionals], ctx)
  if (name === 'executor_install') {
    const { code, data } = installExecutor(ctx, { agent: args.agent, force: args.force, 'dry-run': args.dryRun ?? true })
    emit(data)
    return code
  }
  if (name === 'skill_read') {
    const path = skillPath(args.skill, ctx)
    return emit({ path, instructions: readFileSync(path, 'utf8') })
  }
  if (name === 'commit_plan') {
    oneOf('plan', 'planFile')
    positionals.push(args.planFile ? resolve(ctx.cwd, args.planFile) : tempFile('plan.json', JSON.stringify(args.plan)))
  }
  if (tool.prompt) {
    oneOf('prompt', 'promptFile', name === 'session_create')
    if (args.prompt !== undefined) {
      if (!args.prompt.trim()) throw new AgentError('Задание пустое')
      flag('prompt-file', tempFile('prompt.md', args.prompt))
    }
  }
  if (name === 'session_send') oneOf('text', 'file')

  if (name === 'diagnose') {
    const report = doctor(ctx)
    let host
    try {
      settings = loadConfig(ctx)
      const workspaceCount = superset(ctx, settings).workspaces().length
      host = { status: 'reachable', workspaceCount, pids: hostPids(ctx.env) }
    } catch (error) { host = hostFailure(error.message, ctx.env) }
    emit({ ...report.data, ok: report.data.ok && host.status === 'reachable', host,
      nodePath: process.execPath })
    return report.code || (host.status === 'reachable' ? 0 : 9)
  }

  const hostContext = name === 'projects' || name === 'status' || tool.project || tool.session && !tool.historical
  if (hostContext || name === 'session_list') settings = loadConfig(ctx)
  const api = hostContext ? superset(ctx, settings) : null
  const workspaces = api?.workspaces()
  const ws = args.workspaceId && hostContext ? exactWorkspace(workspaces, args.workspaceId) : null
  const projects = name === 'projects' || tool.project ? api.projects() : null
  if (name === 'projects') return emit({
    projects: projects.map(({ id, name, path }) => ({ id, name, path })),
    workspaces: workspaces.map(({ id, name, projectId, projectName, worktreePath }) => ({ id, name, projectId, projectName, path: worktreePath })),
  })
  if (name === 'status' || tool.project) {
    const inheritedWorkspace = ctx.env.SUPERSET_WORKSPACE_ID
    delete ctx.env.SUPERSET_WORKSPACE_ID
    if (ws && !tool.project && !containsPath(ws.worktreePath, ctx.cwd)) {
      throw new AgentError('cwd должен находиться в выбранном workspace', 9)
    }
    const current = name === 'status' && ws ? ws : resolveCurrentWorkspace(ctx, workspaces, { required: false })
    if (name === 'status' && current) ctx.env.SUPERSET_WORKSPACE_ID = current.id
    if (inheritedWorkspace && current?.id !== inheritedWorkspace && name === 'status') {
      delete ctx.env.SUPERSET_TERMINAL_ID
      delete ctx.env.CODEX_THREAD_ID
    }
    if (tool.project) {
      const project = projectFor(projects, current, ctx.cwd)
      if (ws && projectFor(projects, ws, ctx.cwd).id !== project.id) throw new AgentError('Workspace принадлежит другому проекту, выберите его путь явно', 9)
      if (!['session_create', 'slot_sync', 'slot_sync_back'].includes(name)) flag('project', project.name)
      if (name === 'cleanup' && project.name.includes(',')) throw new AgentError('GC использует запятую как разделитель имён проектов', 9)
    }
  }

  let session
  if (tool.session || tool.optionalSession && args.sessionId) {
    if (tool.historical) {
      const registry = loadRegistry(ctx)
      const match = registry.sessions.filter((row) => row.sessionId === args.sessionId && row.workspace === args.workspaceId)
      if (match.length !== 1) {
        throw new AgentError('Укажите точную запись из session_history для выбранного workspace', 9)
      }
      ctx.exactHistory = true
      ctx.exactSession = args.workspaceId
    } else {
      session = resolveSession(ctx, settings, args.sessionId, api, { workspace: ws.id })
      ctx.exactSession = ws.id
    }
  }
  if (name === 'session_journal') {
    const records = session.records ?? sessionRecords(ctx, session, api)
    const start = args.after ? records.findIndex((record) => record.uuid === args.after) : -1
    if (args.after && start < 0) throw new AgentError('Якорь не найден. Проверьте актуальный sessionId и журнал.')
    const entries = records.slice(start + 1).flatMap((record) => {
      const prompt = promptText(record)
      const reply = record.type === 'assistant' ? lastAnswer([record])?.text : null
      if (!prompt && !reply) return []
      return [{ anchor: record.uuid, timestamp: record.timestamp, role: prompt ? 'user' : 'assistant',
        text: prompt ?? reply, queued: record.type === 'attachment' }]
    })
    return emit({ workspace: ws.id, sessionId: session.sessionId, state: session.state, waiting: session.waiting,
      entries: entries.slice(-(args.limit ?? 20)) })
  }
  if (name === 'session_resume') {
    if ([args.sessionId, args.task, args.lastClosed, args.allOpen].filter(Boolean).length !== 1) {
      throw new AgentError('Выберите один селектор: sessionId, task, lastClosed или allOpen')
    }
    ctx.exactHistory = true
  }
  if (name === 'session_alias') {
    if (args.remove) {
      if (loadRegistry(ctx).aliases[args.alias] !== session.terminal) throw new AgentError('Алиас принадлежит другому терминалу или отсутствует', 9)
      flag('rm', args.alias)
    } else positionals.push(args.alias, session.terminal)
  } else if (name === 'session_keep' && args.remove) flag('rm', args.sessionId)
  else if (args.sessionId) positionals.push(args.sessionId)

  if (ws) {
    if (name.startsWith('slot_')) positionals.push(ws.id)
    else if (['session_create', 'session_close', 'session_resume', 'task_complete'].includes(name)) flag('workspace', ws.id)
  }
  if (args.skill) positionals.push(args.skill)
  if (args.paths) positionals.push(...args.paths)
  if (name.startsWith('executor_')) flag('dry-run', args.dryRun ?? true)
  if (name === 'session_wait') {
    flag('timeout', args.timeout ?? 15)
    flag('interval', Math.min(args.interval ?? 3, args.timeout ?? 15))
  }

  const reserved = ['cwd', 'workspaceId', 'sessionId', 'prompt', 'plan', 'planFile', 'paths', 'skill', 'remove']
  for (const [key, value] of Object.entries(args)) {
    if (reserved.includes(key) || name === 'session_alias' && key === 'alias' ||
      name === 'session_wait' && ['timeout', 'interval'].includes(key) || name.startsWith('executor_') && key === 'dryRun') continue
    flag(key.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase()), value)
  }
  return await cli()
}

try {
  process.exitCode = await execute() ?? 0
} catch (error) {
  process.exitCode = error.code && Number.isInteger(error.code) ? error.code : 1
  emit({ error: error.message, code: process.exitCode })
} finally {
  if (scratch) rmSync(scratch, { force: true, recursive: true })
}
