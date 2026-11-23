import { readFileSync } from 'node:fs'

import { AgentError } from './context.js'
import { canonicalPath } from './current.js'
import { chatSlotState, sameChat, saveChatSlotState } from './chat-slot-state.js'
import { hasChatSlotAssignment } from './chat-slot.js'
import { assertFinishOwnership, finishOwnership, projectBranchOwnership } from './finish.js'
import { gitClient } from './git.js'
import { nativeSlotProcesses } from './procs.js'
import { completeSlotLocked, findSlot } from './slot.js'
import { advanceSlotGeneration, withSlotLock } from './slot-lock.js'
import { busyName, mainBranchOf, mergedTaskBranch, projectRules, releaseState, slotBase } from './slot-names.js'
import { loadRegistry } from './store.js'
import { superset } from './superset.js'

const reply = (data) => ({ data, text: data.question ?? data.status })
const blocked = (question) => reply({ status: 'blocked', question })
const identity = /^[A-Za-z0-9_-]+$/

const validateTarget = (target) => {
  if (![target?.workspace, target?.sessionId, target?.terminal].every((id) => typeof id === 'string' && identity.test(id)) ||
      typeof target.cwd !== 'string') throw new AgentError('Нужны точные workspace, session, terminal и cwd')
}

const available = (ctx, api, slot, target) => !slot.sessions.some((s) => s.kind !== 'chat' || !sameChat(target, s)) &&
  !api.chatList(slot.id).some((row) => row.live && !sameChat(target, row)) &&
  nativeSlotProcesses(ctx, slot).length === 0

const requireClean = (g) => {
  if (g.status().length || g.operationInProgress()) throw new AgentError('Слот содержит изменения или незавершённую операцию Git', 9)
}

const admission = (ctx, api, slot, g, target, state) => {
  if (!available(ctx, api, slot, target)) return blocked('В слоте осталась другая сессия. Где продолжить работу?')
  if (!matchesCheckout(ctx, slot, g, state.active)) {
    return blocked('Назначение рабочего слота изменилось. Где продолжить работу?')
  }
  if (!state.active.ready) {
    requireClean(g)
    if (g.branch()) return blocked('Слот занят веткой прежней задачи. В каком слоте продолжить работу?')
    if (!releaseState(ctx, slot.path, projectRules(slot)).merged) {
      return blocked('В слоте есть невлитая история Git. В каком слоте продолжить работу?')
    }
    advanceSlotGeneration(ctx, slot)
    state.active = { ...state.active, ready: true, projectOwner: finishOwnership(ctx, slot) }
    delete state.parked[target.sessionId]
    saveChatSlotState(ctx, slot.id, state)
  }
  return reply({ status: 'ready' })
}

const matchesCheckout = (ctx, slot, g, active) =>
  (g.branch() === active.branch && slot.name === active.name) ||
  Boolean(projectBranchOwnership(ctx, slot, active.projectOwner))

const complete = (ctx, config, api, slot, target, state, action) => {
  if (!sameChat(state.active, target)) {
    if (action === 'close' && state.parked[target.sessionId] === target.terminal) {
      delete state.parked[target.sessionId]
      saveChatSlotState(ctx, slot.id, state)
    }
    return reply({ status: 'unchanged' })
  }
  if (action === 'park' && !state.active.completion) return reply({ status: 'unchanged' })
  if (!available(ctx, api, slot, target)) throw new AgentError('В слоте остаётся активный процесс или другая сессия', 9)
  if (state.active.completion && action === 'park') assertFinishOwnership(ctx, slot, state.active.completion)
  const g = gitClient(ctx, slot.path)
  requireClean(g)
  if (!matchesCheckout(ctx, slot, g, state.active)) throw new AgentError('Назначение слота изменилось', 9)
  const active = state.active
  const releasable = active.ready || (action === 'close' && mergedTaskBranch(g, projectRules(slot), active.branch))
  state.active = null
  state.parked[target.sessionId] = target.terminal
  saveChatSlotState(ctx, slot.id, state)
  try {
    if (releasable && (g.branch() || slot.name !== slotBase(slot.name))) {
      advanceSlotGeneration(ctx, slot)
      completeSlotLocked(ctx, config, slot, { cachedBase: action === 'close' })
    }
  } catch (error) {
    state.active = active
    saveChatSlotState(ctx, slot.id, state)
    throw error
  }
  if (!releasable && g.branch()) return reply({ status: 'unchanged' })
  return action === 'park'
    ? reply({ status: 'parked', message: 'Задача закрыта, слот освобождён. Отправьте новое поручение, чтобы занять слот снова.' })
    : reply({ status: 'released' })
}

export const chatSlotLifecycle = (ctx, config, action, input) => {
  const target = input.target
  validateTarget(target)
  if (!['reserve', 'admit', 'completion-pending', 'park', 'close'].includes(action)) throw new AgentError('Неизвестное событие жизненного цикла чата')
  if (action === 'completion-pending') {
    const { active } = chatSlotState(ctx, target.workspace)
    if (!sameChat(active, target) || !active.completion ||
        canonicalPath(active.cwd) !== canonicalPath(target.cwd)) return reply({ status: 'unchanged' })
  }
  const api = superset(ctx, config)
  const workspace = api.workspaces().find((w) => w.id === target.workspace)
  if (!workspace || !workspace.worktreePath || canonicalPath(workspace.worktreePath) !== canonicalPath(target.cwd)) {
    return blocked('Путь чата и workspace не совпали. Где продолжить задачу?')
  }
  if (!slotBase(workspace.name)) return reply({ status: 'unmanaged' })
  let slot = findSlot(ctx, config, target.workspace)
  if (!slot.exists || !slot.mainCheckout || canonicalPath(slot.path) === canonicalPath(slot.mainCheckout)) {
    return blocked('Рабочий слот не подтверждён. Где продолжить задачу?')
  }
  // The CLI's existing close transaction holds the slot lock while asking the host to stop the chat.
  if (action === 'close' && loadRegistry(ctx).sessions.some((s) =>
    s.workspace === slot.id && s.status === 'closing' && sameChat(target, s))) return reply({ status: 'unchanged' })
  try {
    return withSlotLock(ctx, slot, () => {
      slot = findSlot(ctx, config, target.workspace)
      if (canonicalPath(slot.path) !== canonicalPath(target.cwd)) throw new AgentError('Путь слота изменился', 9)
      const state = chatSlotState(ctx, slot.id)
      const g = gitClient(ctx, slot.path)
      if (action === 'completion-pending') {
        if (!sameChat(state.active, target) || !state.active.completion) return reply({ status: 'unchanged' })
        try {
          assertFinishOwnership(ctx, slot, state.active.completion)
          requireClean(g)
          return reply({ status: 'pending' })
        } catch (error) {
          if (!(error instanceof AgentError)) throw error
          delete state.active.completion
          saveChatSlotState(ctx, slot.id, state)
          return blocked(`${error.message.split('\n')[0]}. Завершение задачи нужно подтвердить заново.`)
        }
      }
      if (action === 'park' || action === 'close') {
        try { return complete(ctx, config, api, slot, target, state, action) } catch (error) {
          if (action === 'park' && sameChat(state.active, target)) {
            delete state.active.completion
            saveChatSlotState(ctx, slot.id, state)
          }
          throw error
        }
      }
      if (state.active && !sameChat(state.active, target)) return blocked('Слот уже зарезервирован другим чатом. Где продолжить задачу?')
      if (!state.active) {
        requireClean(g)
        if (!available(ctx, api, slot, target)) return blocked('В слоте уже работает другая сессия. Где продолжить задачу?')
        const rules = projectRules(slot)
        const branch = g.branch()
        const free = !branch && slot.name === slotBase(slot.name) && releaseState(ctx, slot.path, rules).merged
        const scripted = api.chatList(slot.id).find((row) => sameChat(target, row) && row.harness?.startsWith('codex'))
        const prepared = branch && branch !== mainBranchOf(g, rules) && scripted &&
          hasChatSlotAssignment(ctx, slot, branch, { ...target, agent: 'codex', kind: 'chat', nativeSessionId: scripted.harnessSessionId })
        const label = slotBase(slot.name)
        const reusable = (slot.name === label || slot.name.startsWith(busyName(label, ''))) &&
          mergedTaskBranch(g, rules, branch)
        if (!free && !prepared && !reusable) {
          return blocked('Слот уже назначен задаче или занят веткой. Где продолжить работу?')
        }
        state.active = { ...target, ready: Boolean(prepared), branch, name: slot.name }
        saveChatSlotState(ctx, slot.id, state)
      }
      return action === 'admit' ? admission(ctx, api, slot, g, target, state)
        : reply({ status: 'reserved' })
    })
  } catch (error) {
    if (!(error instanceof AgentError)) throw error
    const question = `${error.message.split('\n')[0]}. Как продолжить работу со слотом?`
    if (action === 'close') {
      try {
        ctx.run(config.superset, ['notifications', 'show', 'Слот не освобождён', '--body', question,
          '--workspace', target.workspace, '--json'], { timeout: 2000 })
      } catch { /* The close result still contains the blocker. */ }
    }
    return blocked(question)
  }
}

export const chatSlotHook = (ctx, config, action) => chatSlotLifecycle(ctx, config, action, JSON.parse(readFileSync(0, 'utf8')))

/** A project workflow explicitly requests task completion. Git operations never call this. */
export const requestTaskCompletion = (ctx, config, sessionId, opts) => {
  if (!sessionId || !opts.workspace) throw new AgentError('Укажите точные ID чата и workspace')
  const slot = findSlot(ctx, config, opts.workspace)
  if (canonicalPath(slot.path) !== canonicalPath(ctx.cwd)) throw new AgentError('cwd должен совпадать с рабочим слотом', 9)
  return withSlotLock(ctx, slot, () => {
    const state = chatSlotState(ctx, slot.id)
    const current = state.active
    if (!current?.ready || current.sessionId !== sessionId) throw new AgentError('У чата нет активного назначения слота', 9)
    if (!superset(ctx, config).chatList(slot.id).some((s) => s.live && sameChat(current, s))) {
      throw new AgentError('Работающий чат с таким назначением не найден', 9)
    }
    const g = gitClient(ctx, slot.path)
    requireClean(g)
    if (!g.branch() || !matchesCheckout(ctx, slot, g, current)) throw new AgentError('Назначение задачи изменилось', 9)
    const completion = finishOwnership(ctx, slot)
    if (!opts['dry-run']) {
      state.active = { ...current, completion }
      saveChatSlotState(ctx, slot.id, state)
    }
    return reply({ status: opts['dry-run'] ? 'planned' : 'queued', workspace: slot.id, sessionId })
  })
}
