import { AgentError } from './context.js'
import { agentProcesses } from './procs.js'
import { closeTerminal } from './cleanup.js'
import { resolveSession } from './sessions.js'
import { closeCommand, closeTarget } from './session-close.js'
import { resumeCommand } from './session-resume.js'
import { matchesHistory, recordSession } from './session-history.js'
import { loadRegistry, updateRegistry } from './store.js'
import { superset } from './superset.js'

/** Реестр сессий (~/.agent-cli/sessions.json): закрытие с сохранением, resume, алиасы. */

/** Запись о закрываемой сессии в реестр (для resume); алиас переезжает в запись. */
export const recordClosed = (ctx, session, note, reason = 'close', sessionOnly = false) => {
  if (!session.sessionId) throw new AgentError('Нет UUID сессии — закрытие не сохранит возможность resume', 9)
  return recordSession(ctx, session, 'close-requested', { note: note ?? null, closeReason: reason, sessionOnly })
}

/** Агент выходит через пару секунд после закрытия терминала — ждём, чтобы ls не показал его живым. */
export const awaitExit = async (ctx, pid) => {
  const deadline = ctx.now() + 10_000
  while (agentProcesses(ctx).some((p) => p.pid === pid) && ctx.now() < deadline) await ctx.sleep(500)
  if (agentProcesses(ctx).some((p) => p.pid === pid)) throw new AgentError('Процесс сессии не завершился — закрытие не подтверждено', 2)
}

const checkClose = (session, opts) => {
  if (session.state === 'waiting') throw new AgentError('Сессия ждёт ответа или разрешения — закрытие отменено', 3)
  if (session.state === 'working' && !opts.force) {
    throw new AgentError('Сессия работает — закрытие прервёт её. Дождитесь (agent wait) или добавьте --force')
  }
  if (session.agent === 'codex' && !session.sessionId) {
    throw new AgentError(`Не найден session id Codex для процесса ${session.pid} — закрытие не сохранит сессию для resume`)
  }
}

export const sessClose = (ctx, config, ref, opts = {}) => closeCommand(ctx, config, ref, opts)

/** Общая запись для resume и закрытие транспорта: close, finish и gc. */
export const closeSessionTransport = async (ctx, config, session, opts, api = superset(ctx, config)) => {
  const fresh = resolveSession(ctx, config, session.sessionId ?? session.terminal, api, { workspace: session.workspace })
  if (['kind', 'agent', 'sessionId', 'terminal', 'workspace'].some((key) => session[key] !== fresh[key]) ||
      session.nativeSessionId && session.nativeSessionId !== fresh.nativeSessionId) throw new AgentError('Сессия изменилась перед закрытием', 9)
  session = fresh
  checkClose(session, opts)
  const record = recordClosed(ctx, session, opts.note, opts.reason, Boolean(opts['session-only']))
  try {
    if (session.kind === 'chat') {
      api.chatClose(session.workspace, session.sessionId)
      const deadline = ctx.now() + 90_000
      while (api.chatList(session.workspace).some((s) => s.live && s.sessionId === session.sessionId)) {
        if (ctx.now() >= deadline) throw new AgentError('Chat не завершился — закрытие не подтверждено', 2)
        await ctx.sleep(500)
      }
    }
    else {
      const ws = api.snapshot().find((w) => w.id === session.workspace) ?? { id: session.workspace }
      closeTerminal(api, ws, session.terminal)
      await awaitExit(ctx, session.pid)
    }
    return recordSession(ctx, record, 'closed')
  } catch (error) {
    recordSession(ctx, record, 'close-failed', { error: error.message })
    throw error
  }
}

export const closeResolvedSession = (ctx, config, session, opts = {}, api) => closeTarget(ctx, config, session, opts, api)

/** Пометка keep: `agent gc` такую сессию не закрывает. */
export const sessKeep = (ctx, config, ref, opts) => {
  let live
  if (ref) { try { live = resolveSession(ctx, config, ref) } catch { /* Historical refs work offline. */ } }
  const kept = ref ? updateRegistry(ctx, (registry) => {
    const keep = new Set(registry.keep)
    const sessionId = ctx.exactHistory ? ref : live?.sessionId ?? registry.sessions.findLast((s) => matchesHistory(s, ref))?.sessionId ?? ref
    if (opts.rm) keep.delete(sessionId)
    else keep.add(sessionId)
    registry.keep = [...keep]
    return registry.keep
  }) : loadRegistry(ctx).keep
  return { data: kept, text: kept.join('\n') || 'Пометок keep нет' }
}

export const sessResume = (ctx, config, ref, opts = {}) => resumeCommand(ctx, config, ref, opts)

export const sessAlias = (ctx, name, terminal, opts) => {
  if (name && !terminal && !opts.rm) throw new AgentError('Нужно: agent alias <имя> <терминал>')
  if (name && terminal) {
    const record = loadRegistry(ctx).sessions.findLast((s) => s.terminal === terminal)
    if (record) recordSession(ctx, { ...record, alias: name }, 'alias-changed')
  }
  const aliases = name && terminal || opts.rm ? updateRegistry(ctx, (registry) => {
    if (opts.rm) delete registry.aliases[opts.rm]
    else registry.aliases[name] = terminal
    return registry.aliases
  }) : loadRegistry(ctx).aliases
  return { data: aliases, text: Object.entries(aliases).map(([n, t]) => `${n} → ${t}`).join('\n') || 'Алиасов нет' }
}

export const sessForget = (ctx, ref) => {
  const rows = loadRegistry(ctx).sessions.filter((s) => ctx.exactHistory ? s.sessionId === ref && s.workspace === ctx.exactSession : matchesHistory(s, ref))
  if (!rows.length) throw new AgentError(`В реестре нет сессии ${ref}`)
  for (const record of rows) recordSession(ctx, record, 'forgotten')
  return { data: { removed: rows.length }, text: `Удалено из реестра: ${ref}` }
}
