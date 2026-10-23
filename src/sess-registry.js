import { readFileSync } from 'node:fs'

import { AgentError } from './context.js'
import { claudeProcesses } from './procs.js'
import { closeTerminal, tidyWorkspace } from './cleanup.js'
import { formatSync } from './local-files.js'
import { restoreSlotName } from './slot-names.js'
import { syncBackFinished } from './slot.js'
import { awaitSession, findWorkspace, listSessions, resolveSession, setAlias } from './sessions.js'
import { loadRegistry, saveRegistry } from './store.js'
import { superset } from './superset.js'

/** Реестр сессий (~/.agent-cli/sessions.json): закрытие с сохранением, resume, алиасы. */

/** Запись о закрываемой сессии в реестр (для resume); алиас переезжает в запись. */
export const recordClosed = (ctx, session, note) => {
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
    note: note ?? null,
    closedAt: new Date(ctx.now()).toISOString(),
  }
  registry.sessions = [...registry.sessions.filter((s) => s.sessionId !== session.sessionId), record]
  if (alias) delete registry.aliases[alias]
  saveRegistry(ctx, registry)
  return record
}

/** Процесс Claude выходит через пару секунд после закрытия терминала — ждём, чтобы ls не показал его живым. */
export const awaitExit = async (ctx, pid) => {
  const deadline = ctx.now() + 10_000
  while (claudeProcesses(ctx).some((p) => p.pid === pid) && ctx.now() < deadline) await ctx.sleep(500)
}

export const sessClose = async (ctx, config, ref, opts) => {
  const api = superset(ctx, config)
  const session = resolveSession(ctx, config, ref, api)
  if (session.state === 'working' && !opts.force) {
    throw new AgentError('Сессия работает — закрытие прервёт её. Дождитесь (agent sess wait) или добавьте --force')
  }
  const record = recordClosed(ctx, session, opts.note)
  const ws = api.snapshot().find((w) => w.id === session.workspace) ?? { id: session.workspace }
  closeTerminal(api, ws, session.terminal)
  await awaitExit(ctx, session.pid)
  const live = listSessions(ctx, config, api)
  const liveClaude = new Set(live.map((s) => s.terminal).filter(Boolean))
  const tidied = tidyWorkspace(api, session.workspace, { liveClaude, self: ctx.env.SUPERSET_TERMINAL_ID })
  const workspace = api.workspaces().find((w) => w.id === session.workspace)
  const slot = restoreSlotName(ctx, config, workspace, live)
  // Работа в слоте закончена — его локальные файлы (правила и т. п.) переносим в основную копию
  const localFiles = slot?.renamed ? syncBackFinished(ctx, config, workspace) : null
  const extra = tidied.map((t) => `  + ${t.reason}: ${(t.pane ?? t.terminal).slice(0, 13)}`)
  if (slot) extra.push(`  ${slot.renamed ? `слот → ${slot.name}` : `имя «${slot.name}» оставлено: ${slot.reason}`}`)
  extra.push(...syncLines(localFiles))
  const text = [`Закрыто. Сессия ${session.sessionId} сохранена в реестре${record.alias ? ` (алиас ${record.alias})` : ''}`, ...extra]
  return { data: { ...record, tidied, slot, localFiles }, text: text.join('\n') }
}

/** Строки отчёта об автоматическом переносе локальных файлов (или его сбое). */
export const syncLines = (result) => (result?.error ? [`  ! локальные файлы не перенесены: ${result.error}`] : formatSync(result))

/** Пометка keep: `agent sess gc` такую сессию не закрывает. */
export const sessKeep = (ctx, config, ref, opts) => {
  const registry = loadRegistry(ctx)
  const keep = new Set(registry.keep ?? [])
  if (ref) {
    const live = (() => {
      try {
        return resolveSession(ctx, config, ref)
      } catch {
        return null
      }
    })()
    const sessionId = live?.sessionId ?? ref
    if (opts.rm) keep.delete(sessionId)
    else keep.add(sessionId)
    registry.keep = [...keep]
    saveRegistry(ctx, registry)
  }
  return { data: registry.keep ?? [], text: [...keep].join('\n') || 'Пометок keep нет' }
}

export const sessResume = async (ctx, config, ref, opts) => {
  const registry = loadRegistry(ctx)
  const record = registry.sessions.findLast((s) => s.sessionId === ref || s.alias === ref)
  const sessionId = record?.sessionId ?? ref
  const wanted = opts.workspace ?? record?.workspace
  if (!wanted) throw new AgentError(`Сессии ${ref} нет в реестре — укажите --workspace`)
  const api = superset(ctx, config)
  const workspace = findWorkspace(api, wanted).id
  const prompt = opts['prompt-file'] ? readFileSync(opts['prompt-file'], 'utf8') : undefined
  const { terminal } = api.createAgent({ workspace, resumeSession: sessionId, prompt })
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
