import { readFileSync } from 'node:fs'

import { chatModel } from './chat.js'
import { AgentError } from './context.js'
import { analyzeAfter, findAccepted, lastAnswer, lastPromptIndex } from './journal.js'
import { EXIT } from './exit.js'
import { agentProcesses } from './procs.js'
import { readWaiting, WAITING_LABEL } from './prompt-screen.js'
import { awaitSession, findWorkspace, listSessions, rememberChat, rememberChatResult, resolveCurrentSession, resolveSession, sessionRecords, setAlias, STATE_LABEL, validateAgent } from './sessions.js'
import { superset } from './superset.js'

const short = (id) => (id ? id.slice(0, 8) : '—')

export const sessLs = (ctx, config) => {
  const sessions = listSessions(ctx, config)
  const counted = sessions.filter((s) => s.terminal).length
  const lines = sessions.map(
    (s) =>
      `${short(s.terminal)}  ${`${s.agent}/${s.kind}`.padEnd(11)}  ${(s.alias ?? '').padEnd(12)} ${(STATE_LABEL[s.state] ?? s.state).padEnd(14)} ` +
      `${String(s.rssMb).padStart(5)} МБ  ${s.project ?? 'вне Superset'}/${s.workspaceName ?? '—'}  ` +
      `${s.title ?? ''}  [${short(s.sessionId)}]`,
  )
  const nested = agentProcesses(ctx).filter((p) => p.nested)
  if (nested.length) {
    lines.push(`Вложенных агентов (codex/claude, подагенты): ${nested.length}, ${Math.round(nested.reduce((s, p) => s + p.rssKb, 0) / 1024)} МБ`)
  }
  lines.push(`Сессий в Superset: ${counted} из ${config.maxSessions}`)
  return { data: { sessions, count: counted, limit: config.maxSessions, nestedPids: nested.map((p) => p.pid) }, text: lines.join('\n') }
}

export const sessCreate = async (ctx, config, opts) => {
  if (!opts.workspace || !opts['prompt-file']) throw new AgentError('Нужны --workspace и --prompt-file')
  const agent = validateAgent(opts.agent)
  if (agent === 'codex' && !opts.cli) chatModel(opts)
  const api = superset(ctx, config)
  const count = listSessions(ctx, config, api).filter((s) => s.terminal).length
  if (count >= config.maxSessions && !opts.force) {
    throw new AgentError(`Уже ${count} сессий из ${config.maxSessions}. Закройте лишнюю или добавьте --force`, EXIT.limit)
  }
  const ws = findWorkspace(api, opts.workspace)
  const prompt = readFileSync(opts['prompt-file'], 'utf8')
  if (agent === 'codex' && !opts.cli) {
    const created = api.chatCreate({ workspace: ws.id, prompt, agent, model: chatModel(opts), mode: opts.mode })
    if (!created.sessionId) throw new AgentError('superset sessions create: нет sessionId')
    const terminal = created.terminalId ?? created.sessionId
    const data = { kind: 'chat', agent, terminal, workspace: ws.id, sessionId: created.sessionId, alias: opts.alias ?? null }
    rememberChat(ctx, data)
    return { data, text: `Chat ${created.sessionId}\n${opts.alias ? `Алиас ${opts.alias}` : ''}` }
  }
  if (opts.mode) throw new AgentError('--mode применяется только к Codex chat')
  const { terminal } = api.createAgent({ workspace: ws.id, prompt, model: opts.model, effort: opts.effort, agent })
  const session = await awaitSession(ctx, config, terminal, 60, agent)
  setAlias(ctx, opts.alias, terminal)
  const data = { kind: 'cli', agent, terminal, workspace: ws.id, sessionId: session.sessionId, pid: session.pid, alias: opts.alias ?? null }
  return { data, text: `Терминал ${terminal}\n${agent} session ${session.sessionId}${opts.alias ? `\nАлиас ${opts.alias}` : ''}` }
}

export const sessSend = async (ctx, config, ref, opts) => {
  const text = opts.file ? readFileSync(opts.file, 'utf8') : opts.text
  if (!text?.trim()) throw new AgentError('Нужен --file или --text с непустым текстом')
  const api = superset(ctx, config)
  let session = resolveSession(ctx, config, ref, api)
  if (session.kind === 'chat' && !session.live && listSessions(ctx, config, api).filter((s) => s.terminal).length >= config.maxSessions && !opts.force) throw new AgentError('Достигнут лимит сессий', EXIT.limit)
  if (session.state === 'waiting' && !opts.force) {
    throw new AgentError('Сессия ждёт разрешения или ответа на вопрос — текст попал бы в диалог. --force, если так и нужно', EXIT.waiting)
  }
  const timeoutSec = Number(opts.timeout ?? config.sendAcceptTimeoutSec)
  const since = ctx.now()
  const before = new Set((session.records ?? sessionRecords(ctx, session, api)).map((r) => r.uuid))
  // Один срок на всё: и вызов superset, и появление сообщения в журнале
  const deadline = since + timeoutSec * 1000
  const maybeDelivered = (why) =>
    new AgentError(
      `${why}. Сообщение могло дойти — не отправляйте повторно вслепую: agent sess last ${ref} или agent sess wait ${ref} --marker … (без --after — от последнего сообщения)`,
      EXIT.notAccepted,
    )
  try {
    if (session.kind === 'chat') {
      const sent = api.chatSend(session.workspace, session.sessionId, text.trimEnd(), Math.max(1, deadline - ctx.now()))
      if (sent.sessionId && sent.sessionId !== session.sessionId) session = { ...session, ...rememberChatResult(ctx, api, session, sent), records: undefined }
    }
    else api.send(session.workspace, session.terminal, text.trimEnd(), Math.max(1, deadline - ctx.now()))
  } catch (error) {
    throw maybeDelivered(error.message)
  }
  while (ctx.now() < deadline) {
    let records
    try { records = sessionRecords(ctx, session, api, { deadline, now: ctx.now }) }
    catch (error) { throw maybeDelivered(error.message) }
    const accepted = findAccepted(records.filter((r) => !before.has(r.uuid)), text, since)
    if (accepted) {
      const data = { terminal: session.terminal, sessionId: session.sessionId, ...accepted }
      return { data, text: `Принято${accepted.queued ? ' (в очереди: сессия занята)' : ''}. Якорь: ${accepted.anchor}` }
    }
    await ctx.sleep(1000)
  }
  throw maybeDelivered(`Подтверждения нет за ${timeoutSec} с: сообщения нет в журнале ${session.sessionId}`)
}

const REASON = {
  marker: 'маркер найден',
  idle: 'ход закончен',
  'idle-no-marker': 'ход закончен без маркера',
  waiting: 'ждёт разрешения или ответа',
  'api-error': 'ошибка API',
  timeout: 'таймаут',
}

const verdict = (analysis, state, marker) => {
  if (analysis.markerFound) return ['marker', EXIT.ok]
  if (analysis.apiError) return ['api-error', EXIT.apiError]
  if (state === 'waiting') return ['waiting', EXIT.waiting]
  if (analysis.turnEnded && state === 'idle') return marker ? ['idle-no-marker', EXIT.idle] : ['idle', EXIT.ok]
  return null
}

export const sessWait = async (ctx, config, ref, opts) => {
  const timeoutMs = Number(opts.timeout ?? 1800) * 1000
  const intervalMs = Number(opts.interval ?? 5) * 1000
  const deadline = ctx.now() + timeoutMs
  const api = superset(ctx, config)
  for (;;) {
    const session = resolveSession(ctx, config, ref, api)
    const records = session.records ?? sessionRecords(ctx, session, api)
    const anchorIndex = opts.after ? records.findIndex((r) => r.uuid === opts.after) : lastPromptIndex(records)
    if (opts.after && anchorIndex < 0) {
      throw new AgentError(`Якорь ${opts.after} не найден в журнале сессии ${session.sessionId} (после /clear журнал новый)`)
    }
    const analysis = analyzeAfter(records, anchorIndex, opts.marker)
    const timedOut = ctx.now() >= deadline
    const [reason, code] = verdict(analysis, session.state, opts.marker) ?? (timedOut ? ['timeout', EXIT.timeout] : [])
    if (reason) {
      const answer = reason === 'api-error' ? { text: analysis.apiError, timestamp: null } : analysis.answer
      const waiting = reason === 'waiting' ? (session.kind === 'chat' ? session.waiting ?? { kind: 'permission', text: 'Chat ждёт ответа или разрешения', options: [] } : readWaiting(api, session)) : null
      const data = { reason, code, marker: opts.marker ?? null, terminal: session.terminal, sessionId: session.sessionId, answer, waiting }
      const screen = waiting ? `\n\n— на экране (${WAITING_LABEL[waiting.kind]}):\n${waiting.text}` : ''
      return { data, code, text: `${answer?.text ?? '(ответа после якоря нет)'}${screen}\n\n— ${REASON[reason]}${waiting ? `: ${WAITING_LABEL[waiting.kind]}` : ''}` }
    }
    await ctx.sleep(intervalMs)
  }
}

export const sessLast = (ctx, config, ref) => {
  const api = superset(ctx, config)
  const session = ref ? resolveSession(ctx, config, ref, api) : resolveCurrentSession(ctx, config, api, 'last')
  const answer = lastAnswer(session.records ?? sessionRecords(ctx, session, api))
  const waiting = session.state === 'waiting' ? (session.kind === 'chat' ? session.waiting ?? { kind: 'permission', text: 'Chat ждёт ответа или разрешения', options: [] } : readWaiting(api, session)) : null
  if (!answer && !waiting) throw new AgentError('В журнале сессии ещё нет ответа ассистента')
  const screen = waiting ? `— на экране (${WAITING_LABEL[waiting.kind]}):\n${waiting.text}` : null
  return {
    data: { terminal: session.terminal, sessionId: session.sessionId, ...answer, waiting },
    text: [answer?.text, screen].filter(Boolean).join('\n\n'),
  }
}
