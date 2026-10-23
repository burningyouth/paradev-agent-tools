import { readFileSync } from 'node:fs'

import { AgentError } from './context.js'
import { analyzeAfter, findAccepted, lastAnswer, lastPromptIndex, readJournal } from './journal.js'
import { EXIT } from './exit.js'
import { awaitSession, listSessions, resolveSession, sessionJournal, setAlias, STATE_LABEL } from './sessions.js'
import { superset } from './superset.js'

const short = (id) => (id ? id.slice(0, 8) : '—')

export const sessLs = (ctx, config) => {
  const sessions = listSessions(ctx, config)
  const counted = sessions.filter((s) => s.terminal).length
  const lines = sessions.map(
    (s) =>
      `${short(s.terminal)}  ${(s.alias ?? '').padEnd(12)} ${(STATE_LABEL[s.state] ?? s.state).padEnd(14)} ` +
      `${String(s.rssMb).padStart(5)} МБ  ${s.project ?? 'вне Superset'}/${s.workspaceName ?? '—'}  ` +
      `${s.title ?? ''}  [${short(s.sessionId)}]`,
  )
  lines.push(`Сессий в Superset: ${counted} из ${config.maxSessions}`)
  return { data: { sessions, count: counted, limit: config.maxSessions }, text: lines.join('\n') }
}

const findWorkspace = (api, ref) => {
  const all = api.workspaces()
  const ws = all.find((w) => w.id === ref) ?? all.filter((w) => w.name === ref || w.id.startsWith(ref))
  const one = Array.isArray(ws) ? (ws.length === 1 ? ws[0] : null) : ws
  if (!one) throw new AgentError(`Воркспейс ${ref} не найден или неоднозначен. Список — superset ws list`)
  return one
}

export const sessCreate = async (ctx, config, opts) => {
  if (!opts.workspace || !opts['prompt-file']) throw new AgentError('Нужны --workspace и --prompt-file')
  const api = superset(ctx, config)
  const count = listSessions(ctx, config, api).filter((s) => s.terminal).length
  if (count >= config.maxSessions && !opts.force) {
    throw new AgentError(`Уже ${count} сессий из ${config.maxSessions}. Закройте лишнюю или добавьте --force`, EXIT.limit)
  }
  const ws = findWorkspace(api, opts.workspace)
  const prompt = readFileSync(opts['prompt-file'], 'utf8')
  const { terminal } = api.createAgent({ workspace: ws.id, prompt, model: opts.model, effort: opts.effort })
  const session = await awaitSession(ctx, config, terminal)
  setAlias(ctx, opts.alias, terminal)
  const data = { terminal, workspace: ws.id, sessionId: session.sessionId, pid: session.pid, alias: opts.alias ?? null }
  return { data, text: `Терминал ${terminal}\nClaude session ${session.sessionId}${opts.alias ? `\nАлиас ${opts.alias}` : ''}` }
}

export const sessSend = async (ctx, config, ref, opts) => {
  const text = opts.file ? readFileSync(opts.file, 'utf8') : opts.text
  if (!text?.trim()) throw new AgentError('Нужен --file или --text с непустым текстом')
  const api = superset(ctx, config)
  const session = resolveSession(ctx, config, ref, api)
  if (session.state === 'waiting' && !opts.force) {
    throw new AgentError('Сессия ждёт разрешения или ответа на вопрос — текст попал бы в диалог. --force, если так и нужно', EXIT.waiting)
  }
  const path = sessionJournal(ctx, session)
  const since = ctx.now()
  api.send(session.workspace, session.terminal, text.replace(/\s+$/, ''))
  const deadline = since + config.sendAcceptTimeoutSec * 1000
  while (ctx.now() < deadline) {
    const accepted = findAccepted(readJournal(path), text, since)
    if (accepted) {
      const data = { terminal: session.terminal, sessionId: session.sessionId, ...accepted }
      return { data, text: `Принято${accepted.queued ? ' (в очереди: сессия занята)' : ''}. Якорь: ${accepted.anchor}` }
    }
    await ctx.sleep(1000)
  }
  throw new AgentError(
    `Сессия не приняла сообщение за ${config.sendAcceptTimeoutSec} с: в журнале ${path} его нет. Посмотрите экран: superset terminals read`,
    EXIT.notAccepted,
  )
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
    const records = readJournal(sessionJournal(ctx, session))
    const anchorIndex = opts.after ? records.findIndex((r) => r.uuid === opts.after) : lastPromptIndex(records)
    if (opts.after && anchorIndex < 0) {
      throw new AgentError(`Якорь ${opts.after} не найден в журнале сессии ${session.sessionId} (после /clear журнал новый)`)
    }
    const analysis = analyzeAfter(records, anchorIndex, opts.marker)
    const timedOut = ctx.now() >= deadline
    const [reason, code] = verdict(analysis, session.state, opts.marker) ?? (timedOut ? ['timeout', EXIT.timeout] : [])
    if (reason) {
      const answer = reason === 'api-error' ? { text: analysis.apiError, timestamp: null } : analysis.answer
      const data = { reason, code, marker: opts.marker ?? null, terminal: session.terminal, sessionId: session.sessionId, answer }
      return { data, code, text: `${answer?.text ?? '(ответа после якоря нет)'}\n\n— ${REASON[reason]}` }
    }
    await ctx.sleep(intervalMs)
  }
}

export const sessLast = (ctx, config, ref) => {
  const session = resolveSession(ctx, config, ref)
  const answer = lastAnswer(readJournal(sessionJournal(ctx, session)))
  if (!answer) throw new AgentError('В журнале сессии ещё нет ответа ассистента')
  return { data: { terminal: session.terminal, sessionId: session.sessionId, ...answer }, text: answer.text }
}
