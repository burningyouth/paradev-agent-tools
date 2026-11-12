import { readChat } from './chat.js'
import { AgentError } from './context.js'
import { resolveCurrentWorkspace } from './current.js'
import { analyzeAfter, journalPath, lastPromptIndex, readJournal } from './journal.js'
import { liveAgentSessions } from './procs.js'
import { loadRegistry, saveRegistry } from './store.js'
import { slotBase } from './slot-names.js'
import { flattenTerminals, superset } from './superset.js'

/** Состояние сессии для человека: Superset знает про «ждёт разрешения», файл сессии — busy/idle. */
export const sessionState = (agentState, status) => {
  if (agentState === 'blocked') return 'waiting'
  if (agentState === 'working' || status === 'busy') return 'working'
  if (agentState === 'idle' || status === 'idle') return 'idle'
  return agentState ?? status ?? 'unknown'
}

export const validateAgent = (agent = 'codex') => {
  if (!['codex', 'claude'].includes(agent)) throw new AgentError('--agent: выберите codex или claude')
  return agent
}

export const STATE_LABEL = { working: 'работает', idle: 'ждёт задачу', waiting: 'ждёт разрешения/ответа', unknown: '?' }

/** Все живые Codex/Claude-сессии: процесс + терминал Superset + воркспейс + алиас. */
export const listSessions = (ctx, config, api = superset(ctx, config), includeStopped = false, chatWorkspace) => {
  const terminals = new Map(flattenTerminals(api.snapshot()).map((t) => [t.terminal, t]))
  const paths = new Map(api.workspaces().map((ws) => [ws.id, ws]))
  const { aliases } = loadRegistry(ctx)
  const aliasOf = new Map(Object.entries(aliases).map(([name, terminal]) => [terminal, name]))
  const chats = [...paths.values()].filter((ws) => !chatWorkspace || ws.id === chatWorkspace).flatMap((ws) => api.chatList(ws.id).filter((s) => /^(codex|claude)/.test(s.harness)).map((s) => ({
    kind: 'chat', agent: s.harness.startsWith('codex') ? 'codex' : 'claude',
    terminal: s.terminalId ?? s.sessionId, sessionId: s.sessionId, nativeSessionId: s.harnessSessionId,
    workspace: ws.id, workspaceName: ws.name, project: ws.projectName, cwd: ws.worktreePath,
    alias: aliasOf.get(s.terminalId ?? s.sessionId) ?? null, title: s.title, rssMb: 0, pid: null,
    state: ['idle', 'not_loaded', 'offline', 'dead'].includes(s.status) ? 'idle' : ['awaiting_input'].includes(s.status) ? 'waiting' : 'working',
    live: s.live, updatedAt: s.updatedAt,
  })))
  const processes = liveAgentSessions(ctx).filter((proc) => !proc.nested).map((proc) => {
    const term = proc.terminal ? terminals.get(proc.terminal) : undefined
    const ws = paths.get(proc.workspace ?? term?.workspace)
    // Журнал дополняет состояние Superset. working/blocked в Superset всегда приоритетны:
    // новый ход мог начаться до появления его первых записей в rollout.
    let status = proc.status
    if (proc.agent === 'codex' && proc.journal) {
      const records = readJournal(proc.journal)
      const analysis = analyzeAfter(records, lastPromptIndex(records))
      status = analysis.turnEnded ? 'idle' : records.some((r) => r.subtype === 'turn_started' || r.type === 'user') ? 'busy' : null
    }
    return {
      kind: 'cli',
      agent: proc.agent,
      terminal: proc.terminal,
      alias: proc.terminal ? (aliasOf.get(proc.terminal) ?? null) : null,
      workspace: proc.workspace ?? term?.workspace ?? null,
      workspaceName: term?.workspaceName ?? ws?.name ?? null,
      project: term?.project ?? ws?.projectName ?? null,
      title: term?.title ?? null,
      state: sessionState(term?.agentState, status),
      sessionId: proc.sessionId,
      cwd: proc.cwd,
      pid: proc.pid,
      rssMb: Math.round(proc.rssKb / 1024),
      journal: proc.journal,
    }
  }).filter((s) => !chats.some((chat) => chat.live && chat.nativeSessionId && chat.nativeSessionId === s.sessionId))
  return [...processes, ...chats.filter((s) => includeStopped || s.live)]
}

export const sessionRecords = (ctx, session, api, options) => session.kind === 'chat'
  ? readChat(api, session, options).records : readJournal(sessionJournal(ctx, session))

const withChat = (api, session) => {
  if (session.kind !== 'chat') return session
  const chat = readChat(api, session)
  // Последний завершённый ход в журнале может быть старше текущего running/awaiting_input.
  return { ...session, ...chat, state: ['working', 'waiting'].includes(session.state) ? session.state : chat.state }
}

/** Точная идентичность вызывающей сессии; cwd сам по себе не означает «это я». */
export const isCurrentSession = (ctx, session) => Boolean(
  (ctx.env.SUPERSET_TERMINAL_ID && session.terminal === ctx.env.SUPERSET_TERMINAL_ID) ||
  (ctx.env.CODEX_THREAD_ID && session.agent === 'codex' &&
    [session.sessionId, session.nativeSessionId].includes(ctx.env.CODEX_THREAD_ID)),
)

/** Кандидаты для close/last и сводки status; история закрытых сессий сюда не передаётся. */
export const currentSessionCandidates = (ctx, all, workspaces) => {
  const sessions = all.filter((s) => s.terminal)
  // Нативный ID надёжнее унаследованного terminal id; при устаревшем ID соседа не выбираем.
  if (ctx.env.CODEX_THREAD_ID) return sessions.filter((s) => s.agent === 'codex' &&
    [s.sessionId, s.nativeSessionId].includes(ctx.env.CODEX_THREAD_ID))
  const own = sessions.filter((s) => isCurrentSession(ctx, s))
  if (own.length) return own
  const workspace = resolveCurrentWorkspace(ctx, workspaces)
  return sessions.filter((s) => s.workspace === workspace.id)
}

/** Без аргумента: свой агент/терминал, иначе единственная живая сессия своего workspace. */
export const resolveCurrentSession = (ctx, config, api = superset(ctx, config), command = 'close') => {
  const sessions = listSessions(ctx, config, api)
  let matches
  try { matches = currentSessionCandidates(ctx, sessions, api.workspaces()) } catch (error) {
    if (!(error instanceof AgentError)) throw error
    throw new AgentError(`${error.message} — укажите ID или алиас: agent sess ${command} <ID|алиас>`, error.code)
  }
  const hint = `укажите ID или алиас: agent sess ${command} <ID|алиас>. Список — agent sess ls`
  if (matches.length > 1) throw new AgentError(`В текущем контексте несколько сессий — ${hint}`)
  if (!matches.length) throw new AgentError(`В текущем контексте нет живой сессии — ${hint}`, 6)
  return withChat(api, matches[0])
}

/** Терминал по алиасу, полному id или однозначному префиксу (от 6 символов). */
export const resolveSession = (ctx, config, ref, api = superset(ctx, config)) => {
  if (!ref) throw new AgentError('Укажите терминал или алиас сессии')
  const registry = loadRegistry(ctx)
  const { aliases } = registry
  const target = aliases[ref] ?? ref
  const record = registry.sessions.findLast((s) => s.kind === 'chat' && (s.sessionId === target || s.terminal === target || (!aliases[ref] && s.alias === ref)))
  const terminal = record?.sessionId ?? aliases[ref] ?? ref
  const sessions = listSessions(ctx, config, api, true, record?.workspace).filter((s) => s.terminal)
  const exact = sessions.find((s) => s.terminal === terminal || s.sessionId === terminal)
  if (exact) return withChat(api, { ...exact, alias: exact.alias ?? record?.alias ?? null })
  const byPrefix = terminal.length >= 6 ? sessions.filter((s) => (s.terminal.startsWith(terminal) || s.sessionId?.startsWith(terminal))) : []
  if (byPrefix.length === 1) return withChat(api, byPrefix[0])
  if (byPrefix.length > 1) throw new AgentError(`Префикс ${terminal} подходит нескольким терминалам — уточните`)
  const hint = aliases[ref] ? ` (алиас ${ref} → ${aliases[ref]})` : ''
  throw new AgentError(`Живая Codex/Claude-сессия в терминале ${terminal} не найдена${hint}. Список — agent sess ls`, 6)
}

export const sessionJournal = (ctx, session) => {
  if (session.agent === 'codex') {
    if (session.journal && session.sessionId) return session.journal
    throw new AgentError(`У процесса Codex ${session.pid} не найден единственный открытый rollout-файл (lsof); журнал не определён`)
  }
  if (!session.sessionId || !session.cwd) {
    throw new AgentError(`У процесса ${session.pid} нет ~/.claude/sessions/${session.pid}.json — журнал не найти`)
  }
  return journalPath(ctx, session.cwd, session.sessionId)
}

/** Ждём, пока у нового терминала появится процесс агента с журналом сессии. */
export const awaitSession = async (ctx, config, terminal, timeoutSec = 60, agent) => {
  const deadline = ctx.now() + timeoutSec * 1000
  while (ctx.now() < deadline) {
    const found = listSessions(ctx, config).find((s) => s.terminal === terminal && s.sessionId && (!agent || s.agent === agent))
    if (found) return found
    await ctx.sleep(2000)
  }
  throw new AgentError(`Терминал ${terminal} создан, но процесс ${agent ?? 'Codex/Claude'} с сессией не появился за ${timeoutSec} с`)
}

export const setAlias = (ctx, name, terminal) => {
  if (!name) return
  const registry = loadRegistry(ctx)
  registry.aliases[name] = terminal
  saveRegistry(ctx, registry)
}

/** Воркспейс по id, имени, префиксу id или имени слота «slot-N» (в том числе занятого «slot-N · задача»). */
export const findWorkspace = (api, ref) => {
  const all = api.workspaces()
  const exact = all.find((w) => w.id === ref)
  if (exact) return exact
  const found = all.filter((w) => w.name === ref || w.id.startsWith(ref) || slotBase(w.name) === ref)
  if (found.length !== 1) throw new AgentError(`Воркспейс ${ref} не найден или неоднозначен. Список — superset ws list`)
  return found[0]
}

/** Persist chat transport independently from native provider session IDs. */
export const rememberChat = (ctx, data) => {
  const registry = loadRegistry(ctx)
  registry.sessions = [...registry.sessions.filter((s) => s.sessionId !== data.sessionId), { ...data, closedAt: null }]
  if (data.alias) registry.aliases[data.alias] = data.terminal
  saveRegistry(ctx, registry)
}

/** Resume/send may replace both Superset IDs while preserving the provider conversation. */
export const rememberChatResult = (ctx, api, session, result) => {
  if (!result.sessionId) throw new AgentError('superset chat: в ответе нет sessionId')
  const listed = result.terminalId ? null : api.chatList(session.workspace).find((s) => s.sessionId === result.sessionId)
  const data = {
    kind: 'chat', agent: session.agent, workspace: session.workspace,
    sessionId: result.sessionId, terminal: result.terminalId ?? listed?.terminalId ?? result.sessionId,
    alias: session.alias ?? null,
    ...(result.sessionId !== session.sessionId ? { resumedFrom: session.sessionId } : {}),
  }
  const registry = loadRegistry(ctx)
  if (registry.keep.includes(session.sessionId) && !registry.keep.includes(data.sessionId)) {
    registry.keep.push(data.sessionId)
    saveRegistry(ctx, registry)
  }
  rememberChat(ctx, data)
  return data
}
