import { AgentError } from './context.js'
import { canonicalPath, containsPath } from './current.js'
import { gitClient } from './git.js'
import { nativeSlotProcesses } from './procs.js'
import { recordSession } from './session-history.js'
import { findSlot } from './slot.js'
import { advanceSlotGeneration, slotGeneration, withSlotLock } from './slot-lock.js'
import { mainBranchOf, projectRules, releaseState, slotBase } from './slot-names.js'
import { loadRegistry } from './store.js'
import { superset } from './superset.js'

export const slotPromptLabel = 'agent-cli: проверка рабочего слота'

const blocked = (reason) => { throw new AgentError(reason, 9) }

const checkChat = (ctx, api, slot, target) => {
  const live = api.chatList(slot.id).filter((s) => s.live)
  const own = live.filter((s) => s.harness?.startsWith('codex') && s.terminalId === target.terminal)
  if (own.length !== 1 || !own[0].sessionId ||
      own[0].harnessSessionId && own[0].harnessSessionId !== target.nativeSessionId) {
    blocked('Не удалось однозначно подтвердить этот чат по workspace и terminal ID. Какой слот использовать для задачи?')
  }
  const chat = own[0]
  if (live.length !== 1 || slot.reservation && slot.reservation.sessionId !== chat.sessionId ||
      slot.sessions.some((s) => s.kind !== 'chat' || s.workspace !== slot.id || s.sessionId !== chat.sessionId) ||
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
    a.slotName === slot.name && (a.branch === branch || a.projectBranch && !a.branch) && a.generation === generation
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
  // A CLI launch can deliver the first prompt while it owns the slot lock.
  if (branch !== mainBranch && hasChatSlotAssignment(ctx, initial, branch, session)) return initial

  return withSlotLock(ctx, initial, () => {
    const slot = findSlot(ctx, config, ws.id)
    if (canonicalPath(slot.path) !== canonicalPath(initial.path) || slot.name !== initial.name || g.branch() !== branch) {
      blocked('Назначение слота изменилось. Какой слот использовать для задачи?')
    }
    checkChat(ctx, api, slot, target)
    if (slot.name !== baseName) blocked(`Слот ${slot.name} уже назначен задаче. В каком слоте продолжить работу?`)
    if (g.operationInProgress()) blocked(`В слоте ${slot.name} идёт незавершённая операция Git. В каком слоте продолжить работу?`)
    if (g.status().length) blocked(`В слоте ${slot.name} есть незакоммиченные изменения. В каком слоте продолжить работу?`)
    if (branch || !releaseState(ctx, slot.path, rules).merged) {
      blocked(`В слоте ${slot.name} есть другая ветка или невлитая история. В каком слоте продолжить работу?`)
    }
    advanceSlotGeneration(ctx, slot)
    const active = { ...session, workspaceName: slot.name }
    recordSession(ctx, active, 'checkpoint', { status: 'open', slotAdmission: {
      workspace: slot.id, path: canonicalPath(slot.path), slotName: slot.name, branch: g.branch(), generation: slotGeneration(ctx, slot), projectBranch: true,
    } })
    return slot
  })
}
