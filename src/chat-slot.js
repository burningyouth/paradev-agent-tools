import { AgentError } from './context.js'
import { canonicalPath, containsPath } from './current.js'
import { gitClient } from './git.js'
import { nativeSlotProcesses } from './procs.js'
import { recordSession } from './session-history.js'
import { findSlot, prepareSlotLocked } from './slot.js'
import { slotGeneration, withSlotLock } from './slot-lock.js'
import { busyName, mainBranchOf, projectRules, releaseState, slotBase } from './slot-names.js'
import { loadRegistry } from './store.js'
import { superset } from './superset.js'

export const slotPromptLabel = 'agent-cli: проверка рабочего слота'

const blocked = (reason) => { throw new AgentError(reason, 9) }

export const assignmentFrom = (prompt) => {
  const fields = {}
  const names = { 'ветка': 'branch', branch: 'branch', 'задача': 'task', task: 'task', 'база': 'from', base: 'from' }
  for (const line of String(prompt ?? '').trimStart().split('\n')) {
    if (!line.trim()) continue
    const match = line.match(/^\s*(Ветка|Branch|Задача|Task|База|Base):[ \t]*(.*)$/iu)
    if (!match) break
    const key = names[match[1].toLowerCase()]
    if (Object.hasOwn(fields, key)) blocked('Укажите одно назначение слота с одной веткой, задачей и, при необходимости, базой.')
    fields[key] = match[2].trim()
  }
  return fields
}

const checkChat = (ctx, api, slot, target) => {
  const live = api.chatList(slot.id).filter((s) => s.live)
  const own = live.filter((s) => s.harness?.startsWith('codex') && s.terminalId === target.terminal)
  if (own.length !== 1 || !own[0].sessionId ||
      own[0].harnessSessionId && own[0].harnessSessionId !== target.nativeSessionId) {
    blocked('Не удалось однозначно подтвердить этот чат по workspace и terminal ID. Какой слот использовать для задачи?')
  }
  const chat = own[0]
  if (live.length !== 1 || slot.sessions.some((s) => s.kind !== 'chat' || s.workspace !== slot.id || s.sessionId !== chat.sessionId) ||
      nativeSlotProcesses(ctx, slot, { ...target, exactRuntime: true }).some((p) => !p.own)) {
    blocked(`Слот ${slot.name} занят другой или неидентифицированной сессией. В каком слоте продолжить задачу?`)
  }
  return { kind: 'chat', agent: 'codex', sessionId: chat.sessionId, terminal: target.terminal, nativeSessionId: target.nativeSessionId,
    workspace: slot.id, workspaceName: slot.name, project: slot.project, cwd: slot.path }
}

const worktree = (ctx, slot, input) => {
  if (!slot.exists || !slot.mainCheckout || canonicalPath(slot.path) === canonicalPath(slot.mainCheckout) ||
      !containsPath(slot.path, input.cwd) || !containsPath(slot.path, ctx.cwd)) {
    blocked('Путь чата не совпал с отдельным рабочим слотом. Какой слот использовать для задачи?')
  }
  const g = gitClient(ctx, slot.path)
  if (canonicalPath(g.root()) !== canonicalPath(slot.path)) blocked('Путь слота не является корнем Git worktree.')
  return g
}

export const hasChatSlotAssignment = (ctx, slot, branch, session) => {
  const generation = slotGeneration(ctx, slot)
  const matches = (a) => a && a.workspace === slot.id && a.path === canonicalPath(slot.path) &&
    a.slotName === slot.name && a.branch === branch && a.generation === generation
  return loadRegistry(ctx).sessions.some((s) => s.status === 'open' && s.kind === session.kind && s.agent === session.agent &&
    s.workspace === session.workspace && s.terminal === session.terminal && s.sessionId === session.sessionId &&
    (!s.nativeSessionId || s.nativeSessionId === session.nativeSessionId) && (matches(s.startup) || matches(s.slotAdmission)))
}

export const promptSlot = (ctx, config, input, target) => {
  const api = superset(ctx, config)
  const ws = api.workspaces().find((w) => w.id === target.workspace)
  if (!ws || !containsPath(ws.worktreePath, input.cwd)) blocked('Не удалось подтвердить workspace чата. Где продолжить задачу?')
  if (!slotBase(ws.name)) return null
  if (!target.terminal || !target.nativeSessionId || !target.runtimePid) {
    blocked('Не удалось подтвердить идентификаторы этого чата. Какой слот использовать для задачи?')
  }
  const initial = findSlot(ctx, config, ws.id)
  const g = worktree(ctx, initial, input)
  if (initial.sessions.some((s) => s.kind === 'cli' && s.agent === target.agent && s.sessionId === target.nativeSessionId &&
      s.terminal === target.terminal && s.workspace === target.workspace && String(s.pid) === target.runtimePid)) return null
  const branch = g.branch()
  const session = checkChat(ctx, api, initial, target)
  const baseName = slotBase(initial.name)
  const rules = projectRules(initial)
  const mainBranch = mainBranchOf(g, rules)
  const prepared = branch && branch !== mainBranch && initial.name.startsWith(`${baseName} · `)
  const assignment = assignmentFrom(input.prompt)
  // The CLI can deliver its first prompt while it still holds the slot lock.
  // An exact recorded launch or earlier admission only authorizes the current checkout.
  if (branch && branch !== mainBranch && hasChatSlotAssignment(ctx, initial, branch, session) &&
      (!assignment.branch || assignment.branch === branch) &&
      (!assignment.task || initial.name === busyName(baseName, assignment.task))) return initial

  return withSlotLock(ctx, initial, () => {
    const current = findSlot(ctx, config, ws.id)
    if (canonicalPath(current.path) !== canonicalPath(initial.path) || current.name !== initial.name || g.branch() !== branch) {
      blocked('Назначение слота изменилось. Какой слот использовать для задачи?')
    }
    checkChat(ctx, api, current, target)
    const sameTask = prepared && assignment.branch === branch && current.name === busyName(baseName, assignment.task) &&
      !g.status().length && !g.operationInProgress()
    if (!sameTask) {
      if (current.name !== baseName) {
        blocked(`Слот ${current.name} уже назначен задаче. Для продолжения в чистом слоте укажите текущие «Ветка: …» и «Задача: …» и повторите запрос. Какой слот использовать?`)
      }
      const checkFree = (slot) => {
        checkChat(ctx, api, slot, target)
        if (g.operationInProgress()) blocked(`В слоте ${slot.name} идёт незавершённая операция Git. Какой слот использовать для задачи?`)
        if (g.status().length) blocked(`В слоте ${slot.name} есть незакоммиченные изменения. Какой слот использовать для задачи?`)
        const state = releaseState(ctx, slot.path, projectRules(slot))
        if (g.branch() !== branch || (state.branch !== state.mainBranch && (branch || !state.merged))) {
          blocked(`В слоте ${slot.name} есть другая или невлитая ветка. Какой слот использовать для задачи?`)
        }
      }
      checkFree(current)
      if (!assignment.branch || !assignment.task) {
        blocked('Для какой ветки и задачи подготовить этот слот? Укажите «Ветка: …» и «Задача: …» отдельными строками и повторите запрос.')
      }
      const remote = rules.slot?.remote ?? 'origin'
      const base = assignment.from?.startsWith(`${remote}/`) ? assignment.from.slice(remote.length + 1) : assignment.from
      if (!g.validBranch(assignment.branch) || (base !== undefined && !g.validBranch(base))) {
        blocked('Какое корректное Git-имя использовать для ветки или базы?')
      }
      prepareSlotLocked(ctx, config, current, assignment, checkFree)
    }
    const slot = findSlot(ctx, config, ws.id)
    const active = { ...session, workspaceName: slot.name }
    recordSession(ctx, active, 'checkpoint', { status: 'open', slotAdmission: {
      workspace: slot.id, path: canonicalPath(slot.path), slotName: slot.name, branch: g.branch(), generation: slotGeneration(ctx, slot),
    } })
    return slot
  })
}
