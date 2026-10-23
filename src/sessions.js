import { AgentError } from './context.js'
import { journalPath } from './journal.js'
import { liveClaudeSessions } from './procs.js'
import { loadRegistry, saveRegistry } from './store.js'
import { flattenTerminals, superset } from './superset.js'

/** Состояние сессии для человека: Superset знает про «ждёт разрешения», файл сессии — busy/idle. */
export const sessionState = (agentState, status) => {
  if (agentState === 'blocked') return 'waiting'
  if (agentState === 'working' || status === 'busy') return 'working'
  if (agentState === 'idle' || status === 'idle') return 'idle'
  return agentState ?? status ?? 'unknown'
}

export const STATE_LABEL = { working: 'работает', idle: 'ждёт задачу', waiting: 'ждёт разрешения/ответа', unknown: '?' }

/** Все живые Claude-сессии: процесс + терминал Superset + воркспейс + алиас. */
export const listSessions = (ctx, config, api = superset(ctx, config)) => {
  const terminals = new Map(flattenTerminals(api.snapshot()).map((t) => [t.terminal, t]))
  const paths = new Map(api.workspaces().map((ws) => [ws.id, ws]))
  const { aliases } = loadRegistry(ctx)
  const aliasOf = new Map(Object.entries(aliases).map(([name, terminal]) => [terminal, name]))
  return liveClaudeSessions(ctx).map((proc) => {
    const term = proc.terminal ? terminals.get(proc.terminal) : undefined
    const ws = paths.get(proc.workspace ?? term?.workspace)
    return {
      terminal: proc.terminal,
      alias: proc.terminal ? (aliasOf.get(proc.terminal) ?? null) : null,
      workspace: proc.workspace ?? term?.workspace ?? null,
      workspaceName: term?.workspaceName ?? ws?.name ?? null,
      project: term?.project ?? ws?.projectName ?? null,
      title: term?.title ?? null,
      state: sessionState(term?.agentState, proc.status),
      sessionId: proc.sessionId,
      cwd: proc.cwd,
      pid: proc.pid,
      rssMb: Math.round(proc.rssKb / 1024),
    }
  })
}

/** Терминал по алиасу, полному id или однозначному префиксу (от 6 символов). */
export const resolveSession = (ctx, config, ref, api = superset(ctx, config)) => {
  if (!ref) throw new AgentError('Укажите терминал или алиас сессии')
  const { aliases } = loadRegistry(ctx)
  const terminal = aliases[ref] ?? ref
  const sessions = listSessions(ctx, config, api).filter((s) => s.terminal)
  const exact = sessions.find((s) => s.terminal === terminal)
  if (exact) return exact
  const byPrefix = terminal.length >= 6 ? sessions.filter((s) => s.terminal.startsWith(terminal)) : []
  if (byPrefix.length === 1) return byPrefix[0]
  if (byPrefix.length > 1) throw new AgentError(`Префикс ${terminal} подходит нескольким терминалам — уточните`)
  const hint = aliases[ref] ? ` (алиас ${ref} → ${aliases[ref]})` : ''
  throw new AgentError(`Живая Claude-сессия в терминале ${terminal} не найдена${hint}. Список — agent sess ls`, 6)
}

export const sessionJournal = (ctx, session) => {
  if (!session.sessionId || !session.cwd) {
    throw new AgentError(`У процесса ${session.pid} нет ~/.claude/sessions/${session.pid}.json — журнал не найти`)
  }
  return journalPath(ctx, session.cwd, session.sessionId)
}

/** Ждём, пока у нового терминала появится процесс Claude с файлом сессии. */
export const awaitSession = async (ctx, config, terminal, timeoutSec = 60) => {
  const deadline = ctx.now() + timeoutSec * 1000
  while (ctx.now() < deadline) {
    const found = listSessions(ctx, config).find((s) => s.terminal === terminal && s.sessionId)
    if (found) return found
    await ctx.sleep(2000)
  }
  throw new AgentError(`Терминал ${terminal} создан, но процесс Claude с сессией не появился за ${timeoutSec} с`)
}

export const setAlias = (ctx, name, terminal) => {
  if (!name) return
  const registry = loadRegistry(ctx)
  registry.aliases[name] = terminal
  saveRegistry(ctx, registry)
}
