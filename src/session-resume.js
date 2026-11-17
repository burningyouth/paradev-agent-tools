import { existsSync, readFileSync } from 'node:fs'

import { AgentError } from './context.js'
import { canonicalPath } from './current.js'
import { gitClient } from './git.js'
import { nativeSlotProcesses } from './procs.js'
import { matchesHistory, recordSession, selectHistory, withSessionLaunchLock } from './session-history.js'
import { awaitSession, findWorkspace, listSessions, rememberChatResult, validateAgent } from './sessions.js'
import { findSlot, loadSlots, slotPrepare } from './slot.js'
import { slotTake } from './slot-create.js'
import { advanceSlotGeneration, withSlotLock } from './slot-lock.js'
import { slotBase } from './slot-names.js'
import { superset } from './superset.js'

const sameConversation = (record, session) => (record.agent ?? 'claude') === session.agent &&
  (matchesHistory(record, session.sessionId) || session.nativeSessionId && matchesHistory(record, session.nativeSessionId))

const resumeOne = async (ctx, config, api, record, opts) => {
  if (!record.sessionId) throw new AgentError(`У записи ${record.alias ?? record.id} нет UUID — resume невозможен`, 9)
  const agent = validateAgent(opts.agent ?? record.agent ?? 'claude')
  if (record.agent && agent !== record.agent) throw new AgentError(`Сессия ${record.sessionId} принадлежит ${record.agent} — resume другим агентом невозможен`)
  if (record.branch && opts.branch && opts.branch !== record.branch) throw new AgentError(`Сохранённая ветка ${record.branch} не совпадает с --branch ${opts.branch}`, 9)
  const kind = record.kind ?? 'cli'
  if (kind === 'chat' && (opts.cli || opts.model || opts.effort || opts.mode)) throw new AgentError('Chat resume не принимает параметры запуска; используйте их при create')
  const active = listSessions(ctx, config, api)
  const existing = active.find((s) => sameConversation({ ...record, agent }, s))
  if (existing) {
    if (opts.workspace && findWorkspace(api, opts.workspace).id !== existing.workspace) throw new AgentError('Живая сессия находится в другом workspace', 9)
    return { ...existing, status: 'already-open' }
  }
  if (active.filter((s) => s.terminal).length >= config.maxSessions) throw new AgentError('Достигнут лимит сессий — сначала закройте лишнюю', 8)
  const workspaces = api.workspaces()
  let ws = opts.workspace ? findWorkspace(api, opts.workspace) : workspaces.find((w) => w.id === record.workspace)
  if (kind === 'chat' && (!ws || ws.id !== record.workspace || !existsSync(ws.worktreePath))) {
    throw new AgentError(`Workspace chat удалён или изменён. Перенос chat не поддержан; сохранены UUID ${record.sessionId}${record.nativeSessionId ? ` и native UUID ${record.nativeSessionId}` : ''}. Выберите восстановление контекста вручную`, 9)
  }
  const branch = opts.branch ?? record.branch
  let prepare = false, take = false
  if (!ws || !existsSync(ws.worktreePath)) {
    if (!record.project || !record.mainCheckout || !existsSync(record.mainCheckout) || !branch) throw new AgentError('Workspace удалён; для нового слота нужны сохранённые проект, основная копия и ветка', 9)
    const g = gitClient(ctx, record.mainCheckout)
    if (g.raw(['rev-parse', '--verify', `refs/heads/${branch}`]).status !== 0) throw new AgentError(`Сохранённая ветка ${branch} отсутствует — новую вместо неё не создаю`, 9)
    if (loadSlots(ctx, config, record.project).some((s) => s.exists && gitClient(ctx, s.path).branch() === branch)) throw new AgentError(`Ветка ${branch} уже занята другим workspace — укажите его явно`, 9)
    take = true
  } else {
    if (slotBase(ws.name) && active.some((s) => s.workspace === ws.id)) throw new AgentError('В workspace уже есть другая живая сессия', 9)
    if (record.project && ws.projectName !== record.project) throw new AgentError('Workspace принадлежит другому проекту', 9)
    const g = gitClient(ctx, ws.worktreePath)
    if (record.gitCommonDir && canonicalPath(g.git(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()) !== record.gitCommonDir) throw new AgentError('Workspace теперь относится к другому Git-репозиторию', 9)
    if (slotBase(ws.name)) {
      const slot = findSlot(ctx, config, ws.id)
      if (nativeSlotProcesses(ctx, slot).length) throw new AgentError('В слоте остались native-процессы', 9)
      if (!branch) throw new AgentError('В старой записи нет ветки — явно укажите --branch, чтобы проверить назначение', 9)
      const current = g.branch()
      if (current !== branch) {
        if (current || g.status().length) throw new AgentError('Слот занят другой веткой или грязный — переключение запрещено', 9)
        if (g.raw(['rev-parse', '--verify', `refs/heads/${branch}`]).status !== 0) throw new AgentError(`Сохранённая ветка ${branch} отсутствует`, 9)
        prepare = true
      }
      // The exact saved branch may be dirty: resume must see those actual changes.
      if (record.task && ws.name !== `${slotBase(ws.name)} · ${record.task}` && ws.name !== slotBase(ws.name)) throw new AgentError('Имя слота соответствует другой задаче', 9)
    } else {
      if (record.cwd && canonicalPath(record.cwd) !== canonicalPath(ws.worktreePath)) throw new AgentError('Путь рабочей копии изменился', 9)
      if (branch && g.branch() !== branch) throw new AgentError('Git-ветка рабочей копии изменилась', 9)
    }
  }
  const plan = { sessionId: record.sessionId, alias: record.alias, workspace: ws?.id ?? null, branch, action: take ? 'take-slot-and-resume' : prepare ? 'prepare-and-resume' : 'resume' }
  if (opts['dry-run']) return { ...plan, status: 'planned' }
  if (take) {
    const taken = slotTake(ctx, config, { project: record.project, branch, task: record.task, offline: opts.offline })
    ws = findWorkspace(api, taken.data.workspace)
  } else if (prepare) {
    slotPrepare(ctx, config, ws.id, { branch, task: record.task, offline: opts.offline })
    ws = findWorkspace(api, ws.id)
  }
  const launch = async () => {
    // Repeat capacity and occupancy checks immediately before launch, including after prepare.
    const fresh = findWorkspace(api, ws.id)
    if (canonicalPath(fresh.worktreePath) !== canonicalPath(ws.worktreePath) || fresh.projectName !== ws.projectName) throw new AgentError('Назначение workspace изменилось', 9)
    const live = listSessions(ctx, config, api)
    if (live.some((s) => sameConversation({ ...record, agent }, s))) return { ...plan, status: 'already-open' }
    if (live.filter((s) => s.terminal).length >= config.maxSessions) throw new AgentError('Достигнут лимит сессий', 8)
    if (slotBase(ws.name) && live.some((s) => s.workspace === ws.id)) throw new AgentError('Workspace занят другой сессией', 9)
    if (branch && gitClient(ctx, ws.worktreePath).branch() !== branch) throw new AgentError('Ветка изменилась перед resume', 9)
    if (slotBase(ws.name)) {
      const slot = findSlot(ctx, config, ws.id)
      if (nativeSlotProcesses(ctx, slot).length) throw new AgentError('В слоте появились native-процессы', 9)
      advanceSlotGeneration(ctx, slot)
    }
    const note = `Сессия восстановлена. Рабочая копия: ${ws.worktreePath}; ветка: ${branch ?? '(неизвестна)'}.\nГде остановились:\n${record.note ?? 'Заметка не сохранена; прочитай последние сообщения.'}\nСначала проверь agent status --json, фактический git diff и инструкции проекта.`
    const extra = opts['prompt-file'] ? readFileSync(opts['prompt-file'], 'utf8') : ''
    const prompt = `${note}${extra ? `\n\n${extra}` : ''}`
    const base = { ...record, agent, kind, workspace: ws.id, workspaceName: ws.name, cwd: ws.worktreePath, alias: opts.alias ?? record.alias, branch }
    recordSession(ctx, base, 'resume-requested')
    if (kind === 'chat') {
      const resumed = api.chatResume(ws.id, record.sessionId)
      let data = rememberChatResult(ctx, api, base, resumed)
      // Never retry an uncertain prompt delivery: the conversation may already have continued.
      try {
        const sent = api.chatSend(ws.id, data.sessionId, prompt, config.sendAcceptTimeoutSec * 1000)
        if (sent.sessionId !== data.sessionId) data = rememberChatResult(ctx, api, data, sent)
      } catch (error) { throw new AgentError(`Сессия возобновлена; доставка заметки не подтверждена: ${error.message}. Проверьте agent last, не повторяйте resume вслепую`, 7) }
      return { ...data, status: 'resumed', resumedFrom: record.sessionId }
    }
    const { terminal } = api.createAgent({ workspace: ws.id, resumeSession: record.sessionId, prompt, agent, model: opts.model ?? record.model, effort: opts.effort ?? record.effort })
    // Persist launch identity even if discovering the native UUID later times out.
    recordSession(ctx, { ...base, terminal, resumedFrom: record.sessionId }, 'resumed')
    const session = await awaitSession(ctx, config, terminal, 60, agent)
    const data = recordSession(ctx, { ...base, ...session, terminal, alias: base.alias, resumedFrom: record.sessionId }, 'resumed')
    return { ...data, status: 'resumed' }
  }
  return slotBase(ws.name) ? withSlotLock(ctx, findSlot(ctx, config, ws.id), launch) : launch()
}

export const resumeCommand = async (ctx, config, ref, opts = {}) => {
  const api = superset(ctx, config)
  let rows = selectHistory(ctx, ref, opts)
  if (!rows.length && ref) {
    if (!opts.workspace) throw new AgentError(`Сессии ${ref} нет в реестре — укажите --workspace`)
    const ws = findWorkspace(api, opts.workspace)
    if (opts.project && ws.projectName !== opts.project) throw new AgentError('Workspace принадлежит другому проекту', 9)
    const known = listSessions(ctx, config, api, true, ws.id).find((s) => matchesHistory(s, ref))
    rows = [known ?? { sessionId: ref, agent: opts.agent ?? 'codex', workspace: ws.id, branch: opts.branch, cwd: ws.worktreePath }]
  }
  if (!rows.length && !opts['all-open']) throw new AgentError('Подходящей сессии в истории нет', 6)
  const results = []
  for (const row of rows) {
    try { results.push(await withSessionLaunchLock(ctx, () => resumeOne(ctx, config, api, row, opts))) } catch (error) {
      if (!opts['all-open'] || !(error instanceof AgentError)) throw error
      results.push({ sessionId: row.sessionId ?? null, alias: row.alias, status: 'blocked', error: error.message, code: error.code })
    }
  }
  if (!opts['all-open'] && results.length === 1) return { data: results[0], text: `${results[0].sessionId}: ${results[0].status}` }
  return { data: { sessions: results }, text: results.map((r) => `${r.alias ?? r.sessionId ?? '(нет UUID)'}: ${r.status}${r.error ? ` — ${r.error}` : ''}`).join('\n') || 'Нет сессий для восстановления', code: results.find((r) => r.status === 'blocked')?.code ?? 0 }
}
