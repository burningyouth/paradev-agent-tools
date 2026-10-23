import { statSync } from 'node:fs'

import { closeTerminal, idleTerminals, stalePanes } from './cleanup.js'
import { AgentError } from './context.js'
import { lastAnswer, readJournal } from './journal.js'
import { penIdleCheck } from './pen-quit.js'
import { awaitExit, recordClosed, syncLines } from './sess-registry.js'
import { listSessions, sessionJournal } from './sessions.js'
import { loadSlots, syncBackFinished } from './slot.js'
import { gitClient } from './git.js'
import { renameSlot, slotBase } from './slot-names.js'
import { loadRegistry } from './store.js'
import { superset } from './superset.js'

/**
 * `agent sess gc`: освобождает память от законченной работы. Закрывает простаивающие сессии Claude
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
const judgeSession = (ctx, s, { idleMs, done, keep, self }) => {
  if (s.terminal === self) return { skip: 'это текущая сессия' }
  if (keep.has(s.sessionId)) return { skip: 'keep' }
  if (s.state !== 'idle') return { skip: s.state === 'waiting' ? 'ждёт разрешения или ответа' : 'работает' }
  let path
  try {
    path = sessionJournal(ctx, s)
  } catch {
    return { skip: 'нет журнала — состояние не проверить' }
  }
  const answer = lastAnswer(readJournal(path))
  if (hasQuestion(answer?.text)) return { skip: 'вопрос в последнем ответе' }
  if (answer && done.test(answer.text)) return { reason: 'готово (маркер в последнем ответе)' }
  const idleFor = ctx.now() - statSync(path).mtimeMs
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
  for (const s of sessions) plan.push({ kind: 'session', session: s, ...judgeSession(ctx, s, rules) })
  for (const ws of snapshot.filter((w) => inScope(w.project))) {
    for (const t of idleTerminals(api, ws, { liveClaude, self: rules.self })) plan.push({ kind: 'terminal', ws, ...t })
    for (const p of stalePanes(ws)) plan.push({ kind: 'pane', ws, ...p, reason: 'панель без терминала' })
  }
  const closing = new Set(plan.filter((p) => p.reason && p.kind === 'session').map((p) => p.session.terminal))
  for (const slot of loadSlots(ctx, config).filter((sl) => inScope(sl.project) && sl.exists)) {
    const base = slotBase(slot.name)
    if (!base || base === slot.name || slot.sessions.some((s) => !closing.has(s.terminal))) continue
    // Вернуть имя «slot-N» — не освободить слот: ветка и «влита/не влита» не важны, важна чистая копия
    const dirty = gitClient(ctx, slot.path).status().length
    const item = { kind: 'slot', slot, base, terminal: slot.id }
    plan.push(dirty ? { ...item, skip: `рабочая копия грязная (${dirty} файлов) — имя оставлено` } : { ...item, reason: 'сессий нет, копия чистая' })
  }
  const todo = plan.filter((p) => p.reason)
  if (opts.apply) {
    for (const item of todo) {
      if (item.kind === 'session') {
        recordClosed(ctx, item.session, `gc: ${item.reason}`)
        const ws = snapshot.find((w) => w.id === item.session.workspace) ?? { id: item.session.workspace }
        closeTerminal(api, ws, item.session.terminal)
        await awaitExit(ctx, item.session.pid)
      } else if (item.kind === 'terminal') closeTerminal(api, item.ws, item.terminal)
      else if (item.kind === 'slot') {
        renameSlot(ctx, config, item.slot.id, item.base)
        // Работа в слоте закончена — локальные файлы слота в основную копию (как sess close)
        item.localFiles = syncBackFinished(ctx, config, { id: item.slot.id, name: item.slot.name, projectName: item.slot.project, worktreePath: item.slot.path })
      }
      else api.closePane(item.ws.id, item.pane)
    }
  }
  // Pen — после закрытия сессий: закрытые уже не считаются его пользователями
  const pen = opts['keep-pen'] ? null : await penIdleCheck(ctx, config, { apply: opts.apply })
  return report(plan, todo, projects, Boolean(opts.apply), pen)
}

const label = (p) =>
  p.kind === 'slot'
    ? `слот ${p.slot.name} → ${p.base}`
    : p.kind === 'session'
    ? `сессия ${p.session.terminal.slice(0, 8)} ${p.session.workspaceName ?? ''} «${p.session.title ?? ''}» ${p.session.rssMb} МБ`
    : `${p.kind === 'pane' ? 'панель' : 'терминал'} ${(p.pane ?? p.terminal).slice(0, 13)} ${p.ws.name ?? ''}`

const report = (plan, todo, projects, applied, pen) => {
  const freed = todo.filter((p) => p.kind === 'session').reduce((sum, p) => sum + p.session.rssMb, 0)
  const lines = [`${applied ? 'Закрыто' : 'Сухой прогон — закрыть'} (${[...projects].join(', ')}):`]
  for (const p of todo) {
    lines.push(`  ✕ ${label(p)} — ${p.reason}`)
    if (p.kind === 'slot') lines.push(...(applied ? syncLines(p.localFiles).map((l) => `  ${l}`) : ['      + локальные файлы слота → основная копия (slot.localFiles)']))
  }
  for (const p of plan.filter((x) => x.skip)) lines.push(`  · ${label(p)} — оставляю: ${p.skip}`)
  if (!todo.length) lines.push('  нечего закрывать')
  if (pen) lines.push(`Pen: ${pen.text}`)
  lines.push(`Память сессий: ~${freed} МБ.${applied ? '' : ' Закрыть: agent sess gc --apply'}`)
  const data = {
    applied,
    projects: [...projects],
    close: todo.map(({ ws, session, slot, ...p }) => ({ ...p, slot: slot?.name, workspace: ws?.id ?? session?.workspace ?? slot?.id, sessionId: session?.sessionId, terminal: p.terminal ?? session?.terminal })),
    keep: plan.filter((p) => p.skip).map(({ ws, session, slot, ...p }) => ({ ...p, slot: slot?.name, terminal: session?.terminal ?? p.terminal, sessionId: session?.sessionId })),
    freedMb: freed,
    pen: pen?.data ?? null,
  }
  return { data, text: lines.join('\n') }
}
