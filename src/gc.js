import { statSync } from 'node:fs'

import { closeTerminal, idleTerminals, stalePanes } from './cleanup.js'
import { readChat } from './chat.js'
import { AgentError } from './context.js'
import { lastAnswer } from './journal.js'
import { supportsPen } from './features.js'
import { closeTarget } from './session-close.js'
import { listSessions, sessionJournal, sessionRecords } from './sessions.js'
import { loadSlots } from './slot.js'
import { gitClient } from './git.js'
import { slotBase } from './slot-names.js'
import { loadRegistry } from './store.js'
import { superset } from './superset.js'

/**
 * `agent gc`: освобождает память от законченной работы. Закрывает простаивающие сессии Codex/Claude
 * (idle дольше порога или с маркером «готово»), завершившиеся терминалы, пустые шеллы и панели без
 * терминала — только в выбранных проектах. Без --apply — только план.
 */

const DEFAULT_DONE = '\\[\\[DONE[^\\]]*\\]\\]'

export const parseDuration = (value) => {
  const m = String(value).match(/^(\d+)(s|m|h)$/)
  if (!m) throw new AgentError('--idle — длительность: 45s, 30m, 2h')
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2]]
}

/** Вопрос человеку в ответе: строка, которая кончается «?» (с учётом markdown-хвоста). */
export const hasQuestion = (text) => (text ?? '').split('\n').some((line) => /\?[*_`)»"'\s]*$/.test(line.trim()) && line.trim().length > 1)

/** Проекты уборки: явные (--project a,b) или проект воркспейса, из которого вызван CLI. */
const targetProjects = (ctx, snapshot, workspaces, flag) => {
  if (flag) return new Set(flag.split(',').map((p) => p.trim()).filter(Boolean))
  const own = snapshot.find((w) => w.id === ctx.env.SUPERSET_WORKSPACE_ID)?.project ??
    workspaces.find((w) => w.worktreePath && (ctx.cwd === w.worktreePath || ctx.cwd.startsWith(`${w.worktreePath}/`)))?.projectName
  if (!own) throw new AgentError('Не понял, какой это проект Superset — укажите --project <имя>[,<имя>]')
  return new Set([own])
}

const minutes = (ms) => `${Math.round(ms / 60_000)} мин`

/** Решение по живой сессии: закрыть (reason) или оставить (skip). */
const judgeSession = (ctx, api, s, { idleMs, done, keep, self }) => {
  if (s.terminal === self) return { skip: 'это текущая сессия' }
  if (keep.has(s.sessionId)) return { skip: 'keep' }
  if (s.state !== 'idle') return { skip: s.state === 'waiting' ? 'ждёт разрешения или ответа' : 'работает' }
  let path, answer
  try {
    path = s.kind === 'chat' ? null : sessionJournal(ctx, s)
    const chat = s.kind === 'chat' ? readChat(api, s) : null
    if (chat && chat.state !== 'idle') return { skip: chat.state === 'waiting' ? 'ждёт разрешения или ответа' : 'работает' }
    answer = lastAnswer(chat?.records ?? sessionRecords(ctx, s, api))
  } catch {
    return { skip: 'нет журнала — состояние не проверить' }
  }
  if (hasQuestion(answer?.text)) return { skip: 'вопрос в последнем ответе' }
  if (answer && done.test(answer.text)) return { reason: 'готово (маркер в последнем ответе)' }
  const idleFor = ctx.now() - (s.kind === 'chat' ? s.updatedAt : statSync(path).mtimeMs)
  return idleFor >= idleMs ? { reason: `простаивает ${minutes(idleFor)}` } : { skip: `простаивает ${minutes(idleFor)} — меньше порога` }
}

export const sessGc = async (ctx, config, opts) => {
  const api = superset(ctx, config)
  const snapshot = api.snapshot()
  const projects = targetProjects(ctx, snapshot, api.workspaces(), opts.project)
  const rules = {
    idleMs: parseDuration(opts.idle ?? '30m'),
    done: new RegExp(opts.done ?? DEFAULT_DONE),
    keep: new Set(loadRegistry(ctx).keep),
    self: ctx.env.SUPERSET_TERMINAL_ID,
  }
  const inScope = (project) => projects.has(project)
  const all = listSessions(ctx, config, api)
  const sessions = all.filter((s) => s.terminal && inScope(s.project))
  const liveClaude = new Set(all.map((s) => s.terminal).filter(Boolean))
  const plan = []
  for (const s of sessions) plan.push({ kind: 'session', session: s, ...judgeSession(ctx, api, s, rules) })
  for (const ws of snapshot.filter((w) => inScope(w.project))) {
    for (const t of idleTerminals(api, ws, { liveClaude, self: rules.self })) plan.push({ kind: 'terminal', ws, ...t })
    for (const p of stalePanes(ws)) plan.push({ kind: 'pane', ws, ...p, reason: 'панель без терминала' })
  }
  for (const slot of loadSlots(ctx, config).filter((sl) => inScope(sl.project) && slotBase(sl.name))) {
    const items = plan.filter((p) => p.kind === 'session' && p.session.workspace === slot.id && p.reason)
    let blocked
    if (!slot.exists) blocked = 'рабочая копия слота отсутствует'
    else if (slot.sessions.length > 1) blocked = 'в слоте несколько сессий — автоматическое освобождение запрещено'
    else if (gitClient(ctx, slot.path).status().length) blocked = 'рабочая копия грязная — закрытие и освобождение отложены'
    if (blocked) for (const item of items) { delete item.reason; item.skip = blocked }
    if (!blocked && !slot.sessions.length && slot.exists && (slot.name !== slotBase(slot.name) || gitClient(ctx, slot.path).branch())) {
      plan.push({ kind: 'slot', slot, terminal: slot.id, reason: 'сессий нет — освободить слот и проверить результат' })
    }
  }
  const todo = plan.filter((p) => p.reason)
  if (opts.apply) {
    for (const item of todo) {
      if (item.kind === 'session') {
        item.result = (await closeTarget(ctx, config, item.session, { note: `gc: ${item.reason}`, reason: 'gc', cleanup: false }, api)).data
      } else if (item.kind === 'terminal') closeTerminal(api, item.ws, item.terminal)
      else if (item.kind === 'slot') {
        item.result = (await closeTarget(ctx, config, null, { workspace: item.slot.id, reason: 'gc' }, api)).data
      }
      else api.closePane(item.ws.id, item.pane)
    }
  }
  let pen
  if (supportsPen(ctx)) {
    pen = null
    // В личном CLI проверяем Pen после выхода закрытых сессий.
    if (!opts['keep-pen']) {
      const { penIdleCheck } = await import('./pen-quit.js')
      pen = await penIdleCheck(ctx, config, { apply: opts.apply })
    }
  }
  return report(plan, todo, projects, Boolean(opts.apply), pen)
}

const label = (p) =>
  p.kind === 'slot'
    ? `освободить слот ${p.slot.name}`
    : p.kind === 'session'
    ? `сессия ${p.session.terminal.slice(0, 8)} ${p.session.workspaceName ?? ''} «${p.session.title ?? ''}» ${p.session.rssMb} МБ`
    : `${p.kind === 'pane' ? 'панель' : 'терминал'} ${(p.pane ?? p.terminal).slice(0, 13)} ${p.ws.name ?? ''}`

const report = (plan, todo, projects, applied, pen) => {
  const freed = todo.filter((p) => p.kind === 'session').reduce((sum, p) => sum + p.session.rssMb, 0)
  const lines = [`${applied ? 'Закрыто' : 'Сухой прогон — закрыть'} (${[...projects].join(', ')}):`]
  for (const p of todo) {
    lines.push(`  ✕ ${label(p)} — ${p.reason}`)
  }
  for (const p of plan.filter((x) => x.skip)) lines.push(`  · ${label(p)} — оставляю: ${p.skip}`)
  if (!todo.length) lines.push('  нечего закрывать')
  if (pen) lines.push(`Pen: ${pen.text}`)
  lines.push(`Память сессий: ~${freed} МБ.${applied ? '' : ' Закрыть: agent gc --apply'}`)
  const data = {
    applied,
    projects: [...projects],
    close: todo.map(({ ws, session, slot, ...p }) => ({ ...p, slot: slot?.name, workspace: ws?.id ?? session?.workspace ?? slot?.id, sessionId: session?.sessionId, terminal: p.terminal ?? session?.terminal })),
    keep: plan.filter((p) => p.skip).map(({ ws, session, slot, ...p }) => ({ ...p, slot: slot?.name, terminal: session?.terminal ?? p.terminal, sessionId: session?.sessionId })),
    freedMb: freed,
    ...(pen === undefined ? {} : { pen: pen?.data ?? null }),
  }
  return { data, text: lines.join('\n') }
}
