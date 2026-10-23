import { readFileSync } from 'node:fs'

import { AgentError } from './context.js'
import { claudeProcesses } from './procs.js'
import { awaitSession, resolveSession, setAlias } from './sessions.js'
import { loadRegistry, saveRegistry } from './store.js'
import { superset } from './superset.js'

/** Реестр сессий (~/.agent-cli/sessions.json): закрытие с сохранением, resume, алиасы. */

export const sessClose = async (ctx, config, ref, opts) => {
  const api = superset(ctx, config)
  const session = resolveSession(ctx, config, ref, api)
  if (session.state === 'working' && !opts.force) {
    throw new AgentError('Сессия работает — закрытие прервёт её. Дождитесь (agent sess wait) или добавьте --force')
  }
  const registry = loadRegistry(ctx)
  const alias = Object.entries(registry.aliases).find(([, t]) => t === session.terminal)?.[0] ?? null
  const record = {
    sessionId: session.sessionId,
    alias,
    workspace: session.workspace,
    workspaceName: session.workspaceName,
    project: session.project,
    cwd: session.cwd,
    terminal: session.terminal,
    title: session.title,
    note: opts.note ?? null,
    closedAt: new Date(ctx.now()).toISOString(),
  }
  registry.sessions = [...registry.sessions.filter((s) => s.sessionId !== session.sessionId), record]
  if (alias) delete registry.aliases[alias]
  saveRegistry(ctx, registry)
  api.close(session.workspace, session.terminal)
  // Процесс Claude выходит через пару секунд — ждём, чтобы следующий ls не показал его живым
  const deadline = ctx.now() + 10_000
  while (claudeProcesses(ctx).some((p) => p.pid === session.pid) && ctx.now() < deadline) await ctx.sleep(500)
  return { data: record, text: `Закрыто. Сессия ${session.sessionId} сохранена в реестре${alias ? ` (алиас ${alias})` : ''}` }
}

export const sessResume = async (ctx, config, ref, opts) => {
  const registry = loadRegistry(ctx)
  const record = registry.sessions.findLast((s) => s.sessionId === ref || s.alias === ref)
  const sessionId = record?.sessionId ?? ref
  const workspace = opts.workspace ?? record?.workspace
  if (!workspace) throw new AgentError(`Сессии ${ref} нет в реестре — укажите --workspace`)
  const prompt = opts['prompt-file'] ? readFileSync(opts['prompt-file'], 'utf8') : undefined
  const { terminal } = superset(ctx, config).createAgent({ workspace, resumeSession: sessionId, prompt })
  const session = await awaitSession(ctx, config, terminal)
  setAlias(ctx, record?.alias ?? opts.alias, terminal)
  const data = { terminal, workspace, sessionId: session.sessionId, resumedFrom: sessionId, alias: record?.alias ?? opts.alias ?? null }
  return { data, text: `Сессия ${sessionId} открыта в терминале ${terminal}` }
}

export const sessAlias = (ctx, name, terminal, opts) => {
  const registry = loadRegistry(ctx)
  if (opts.rm) {
    delete registry.aliases[opts.rm]
    saveRegistry(ctx, registry)
    return { data: registry.aliases, text: `Алиас ${opts.rm} удалён` }
  }
  if (name && terminal) {
    registry.aliases[name] = terminal
    saveRegistry(ctx, registry)
  } else if (name) {
    throw new AgentError('Нужно: agent sess alias <имя> <терминал>')
  }
  const lines = Object.entries(registry.aliases).map(([n, t]) => `${n} → ${t}`)
  return { data: registry.aliases, text: lines.join('\n') || 'Алиасов нет' }
}

export const sessForget = (ctx, ref) => {
  const registry = loadRegistry(ctx)
  const before = registry.sessions.length
  registry.sessions = registry.sessions.filter((s) => s.sessionId !== ref && s.alias !== ref)
  if (registry.sessions.length === before) throw new AgentError(`В реестре нет сессии ${ref}`)
  saveRegistry(ctx, registry)
  return { data: { removed: before - registry.sessions.length }, text: `Удалено из реестра: ${ref}` }
}
