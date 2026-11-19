import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AgentError } from './context.js'
import { canonicalPath, containsPath } from './current.js'
import { assertFinishOwnership, digest, finishOwnership } from './finish.js'
import { gitClient } from './git.js'
import { lastAnswer } from './journal.js'
import { nativeSlotProcesses } from './procs.js'
import { closeTarget } from './session-close.js'
import { recordSession } from './session-history.js'
import { spawnSessionWorker } from './session-jobs.js'
import { listSessions, sessionRecords, validateAgent } from './sessions.js'
import { findSlot } from './slot.js'
import { slotGeneration, withSlotLock } from './slot-lock.js'
import { slotBase } from './slot-names.js'
import { loadRegistry, readJson, writeJson } from './store.js'
import { superset } from './superset.js'

const events = { 'session-start': 'SessionStart', stop: 'Stop', 'session-end': 'SessionEnd' }
const labels = { 'session-start': 'agent-cli: регистрация сессии', stop: 'agent-cli: сохранение состояния', 'session-end': 'agent-cli: освобождение слота' }
const result = (data) => ({ data, text: JSON.stringify(data) })
const ignored = (reason) => result({ status: 'ignored', reason })
const keyPath = (ctx, target) => join(ctx.agentHome, 'hook-sessions', `${digest(target)}.json`)
const expectedRecord = (session) => Object.fromEntries(['sessionId', 'terminal', 'workspace', 'nativeSessionId', 'lifecycleId'].map((k) => [k, session[k]]))
const currentRecord = (ctx, session) => {
  const current = loadRegistry(ctx).sessions.find((s) => s.id === session.id)
  if (!current || current.sessionId !== session.sessionId || current.terminal !== session.terminal ||
      current.workspace !== session.workspace || current.nativeSessionId !== session.nativeSessionId || current.lifecycleId !== session.lifecycleId) {
    throw new AgentError('Сессия уже возобновлена или переназначена — старое событие отменено', 9)
  }
  return current
}

/** Runtime JSON is advisory; identity must also match the Superset launch environment. */
export const sessionHook = async (ctx, config, action, input, opts = {}) => {
  const event = events[action]
  if (!event || input.hook_event_name !== event) throw new AgentError('Неизвестное событие hook или несовпадение команды и JSON')
  const agent = validateAgent(opts.agent)
  if (input.agent_id || input.agentId || ctx.env.SUPERSET_AGENT_ID && ctx.env.SUPERSET_AGENT_ID !== agent) return ignored('subagent-or-foreign-harness')
  if (action === 'session-end' && ['clear', 'compact'].includes(input.reason)) return ignored('context-reset')
  if (action === 'session-start' && ['clear', 'compact', 'fork'].includes(input.source)) return ignored('context-reset-or-fork')
  const target = { agent, nativeSessionId: input.session_id, workspace: ctx.env.SUPERSET_WORKSPACE_ID, terminal: ctx.env.SUPERSET_TERMINAL_ID,
    runtimePid: ctx.env.AGENT_HOOK_RUNTIME_PID }
  if (Object.values(target).some((v) => typeof v !== 'string' || !v)) return ignored('missing-exact-identity')
  const file = keyPath(ctx, target)
  let binding = readJson(file, null)
  if (action === 'session-end') {
    if (!binding) return ignored('no-session-start-checkpoint')
    if (!input.cwd || canonicalPath(input.cwd) !== binding.eventCwd) throw new AgentError('cwd события не совпадает с сохранённой сессией', 9)
    const resultFile = join(ctx.agentHome, 'end-jobs', `${binding.incarnation}.json`)
    const existing = readJson(resultFile, null)
    if (existing) return result({ status: existing.status, resultFile })
    currentRecord(ctx, binding.session)
    const session = recordSession(ctx, binding.session, 'checkpoint', { closeReason: `session-end:${input.reason ?? 'other'}` }, { context: false, expected: expectedRecord(binding.session) })
    const job = { operation: 'session-end', status: 'queued', createdAt: new Date(ctx.now()).toISOString(),
      target: binding.target, owner: binding.owner, session, config,
      close: { status: 'pending' }, release: { status: binding.owner ? 'pending' : 'not-applicable' },
      context: { cwd: session.cwd, agentHome: ctx.agentHome, codexHome: ctx.codexHome, claudeHome: ctx.claudeHome } }
    // Exclusive creation makes duplicate SessionEnd deliveries start at most one worker.
    const queued = await withSlotLock(ctx, { id: binding.incarnation, path: resultFile }, async () => {
      const prior = readJson(resultFile, null)
      if (prior) return prior.status
      writeJson(resultFile, job)
      try { await spawnSessionWorker(ctx, resultFile) } catch (error) {
        writeJson(resultFile, { ...job, status: 'error', code: 1, error: error.message })
        throw error
      }
      return 'queued'
    })
    return result({ status: queued, resultFile })
  }
  const api = superset(ctx, config)
  const ws = api.workspaces().find((w) => w.id === target.workspace)
  if (!ws || !input.cwd || !containsPath(ws.worktreePath, input.cwd)) throw new AgentError('Workspace или cwd события не совпадает с окружением', 9)
  const matches = listSessions(ctx, config, api, false, ws.id).filter((s) => s.workspace === ws.id && s.agent === agent &&
    s.terminal === target.terminal && (s.kind === 'chat' ? !s.nativeSessionId || s.nativeSessionId === target.nativeSessionId : s.sessionId === target.nativeSessionId))
  if (matches.length !== 1) return ignored('no-exact-root-session')
  const session = { ...matches[0], cwd: ws.worktreePath,
    ...(matches[0].kind === 'chat' ? { nativeSessionId: target.nativeSessionId } : {}) }
  const slot = slotBase(ws.name) ? findSlot(ctx, config, ws.id) : null
  if (slot && (!slot.mainCheckout || canonicalPath(slot.path) === canonicalPath(slot.mainCheckout))) throw new AgentError('Основная копия не является слотом', 9)
  if (binding && action === 'stop' && binding.owner && slot &&
      (binding.owner.generation !== slotGeneration(ctx, slot) || binding.owner.branch !== gitClient(ctx, slot.path).branch())) {
    throw new AgentError('Назначение слота изменилось; checkpoint старой сессии не переназначается', 9)
  }
  let note = input.last_assistant_message
  if (!note) try { note = lastAnswer(sessionRecords(ctx, session, api))?.text } catch { /* transcript can be unavailable during startup */ }
  if (binding && action === 'stop') currentRecord(ctx, binding.session)
  const record = recordSession(ctx, session, action === 'session-start' ? 'observed' : 'checkpoint', {
    ...(note ? { note: note.slice(0, 4000) } : {}), ...(action === 'session-start' ? { lifecycleId: randomUUID() } : {}),
  }, binding && action === 'stop' ? { expected: expectedRecord(binding.session) } : {})
  binding = { target, session: record, eventCwd: canonicalPath(input.cwd), owner: slot ? finishOwnership(ctx, slot) : null,
    incarnation: action === 'session-start' || !binding ? randomUUID() : binding.incarnation }
  writeJson(file, binding)
  return result({ status: 'checkpoint', recordId: record.id })
}

/** SessionEnd never closes another transport. Wait for actual disappearance, then use normal close/release. */
export const runSessionEndJob = async (baseCtx, job, resultFile, { exitMs = 90_000 } = {}) => {
  const operationDeadline = baseCtx.now() + exitMs + 120_000
  const ctx = { ...baseCtx, run: (cmd, args, opts = {}) => {
    if (baseCtx.now() >= operationDeadline) throw new AgentError('Истёк общий срок SessionEnd', 2)
    return baseCtx.run(cmd, args, { ...opts, timeout: Math.max(1, Math.min(opts.timeout ?? 30_000, operationDeadline - baseCtx.now())) })
  } }
  const save = () => writeJson(resultFile, job)
  const deadline = ctx.now() + exitMs
  const api = superset(ctx, job.config)
  try {
    job.status = 'waiting_exit'; save()
    while (true) {
      currentRecord(ctx, job.session)
      const sessions = listSessions(ctx, job.config, api, false, job.target.workspace)
      const own = sessions.some((s) => s.workspace === job.target.workspace && s.terminal === job.target.terminal &&
        (s.kind === 'chat' ? s.nativeSessionId === job.target.nativeSessionId || s.sessionId === job.session.sessionId : s.sessionId === job.target.nativeSessionId))
      const slot = job.owner ? findSlot(ctx, job.config, job.owner.workspace) : null
      const native = slot ? nativeSlotProcesses(ctx, slot, job.target).some((p) => p.own) : false
      if (!own && !native) break
      if (ctx.now() >= deadline) throw new AgentError('Сессия/native-процессы не завершились в срок — слот не освобождён', 2)
      await ctx.sleep(500)
    }
    job.close = { status: 'closed' }
    const current = currentRecord(ctx, job.session)
    if (job.owner && current.release?.status !== 'released') assertFinishOwnership(ctx, findSlot(ctx, job.config, job.owner.workspace), job.owner)
    const record = recordSession(ctx, job.session, 'closed', { closeReason: job.session.closeReason }, { context: false, expected: expectedRecord(job.session) })
    if (job.owner) {
      while (true) {
        // A concurrent explicit close may already have completed the same release.
        const current = loadRegistry(ctx).sessions.find((s) => s.id === record.id)
        if (current?.sessionId === record.sessionId && current.release?.status === 'released') {
          job.release = { ...current.release, duplicate: true }; break
        }
        try {
          const closed = await closeTarget(ctx, job.config, null, { workspace: job.owner.workspace, historical: record,
            expectedOwner: job.owner, reason: record.closeReason, cleanup: false }, api)
          job.release = closed.data.release; break
        } catch (error) {
          // A running close/finish owns the lock until its release is fully recorded.
          if (error.code !== 9 || !error.message.startsWith('Слот занят другой операцией') || ctx.now() >= deadline) throw error
          await ctx.sleep(500)
        }
      }
    }
    job.status = 'completed'; job.code = 0
  } catch (error) {
    job.status = 'blocked'; job.code = error.code ?? 1; job.error = error.message
    if (job.release.status === 'pending') job.release.status = 'blocked'
  }
  job.finishedAt = new Date(ctx.now()).toISOString(); save()
  try {
    const sent = ctx.run(job.config.superset, ['notifications', 'show', job.status === 'completed' ? 'Сессия сохранена' : 'Слот не освобождён',
      '--body', job.status === 'completed' ? (job.owner ? 'Слот освобождён; продолжение доступно через agent resume' : 'Продолжение доступно через agent resume') : 'Подробности: agent close --result ' + resultFile,
      '--workspace', job.target.workspace, '--json'], { timeout: 10_000, env: { SUPERSET_TERMINAL_ID: '' } })
    job.notification = { status: sent.status === 0 ? 'accepted' : 'error' }
  } catch (error) { job.notification = { status: 'error', error: error.message } }
  save()
  return job
}

const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`
const ownedHook = (hook, action, agent, command, legacy) => {
  if (hook.command === command || hook.command === legacy) return true
  // Labels plus our exact generated command shape survive a Node/CLI path upgrade.
  // A similarly named foreign command must not be rewritten.
  const path = String.raw`'(?:[^']|'\\'')*`
  const shape = new RegExp(String.raw`^(?:AGENT_HOOK_RUNTIME_PID="\$PPID" )?${path}/node(?:\.exe)?' ${path}/bin/agent\.js' hook ${action} --agent ${agent}$`)
  return hook.type === 'command' && hook.statusMessage === labels[action] && typeof hook.command === 'string' && shape.test(hook.command)
}
export const installHooks = (ctx, opts = {}) => {
  const agent = validateAgent(opts.agent)
  const path = join(agent === 'codex' ? ctx.codexHome : ctx.claudeHome, agent === 'codex' ? 'hooks.json' : 'settings.json')
  let info
  try { info = lstatSync(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (info && (!info.isFile() || info.isSymbolicLink())) throw new AgentError(`Настройки должны быть обычным файлом: ${path}`, 9)
  const original = readJson(path, {})
  if (!original || typeof original !== 'object' || Array.isArray(original) || original.hooks !== undefined &&
      (!original.hooks || typeof original.hooks !== 'object' || Array.isArray(original.hooks))) throw new AgentError(`Неверный формат hooks: ${path}`, 9)
  const data = structuredClone(original)
  data.hooks ??= {}
  const bin = ctx.bundledBin ?? fileURLToPath(new URL('../bin/agent.js', import.meta.url))
  for (const [action, event] of Object.entries(events)) {
    const legacy = `${quote(ctx.bundledNode ?? process.execPath)} ${quote(bin)} hook ${action} --agent ${agent}`
    // The command shell's parent is the provider runtime, stable across its events.
    // A delayed callback from an earlier runtime must never read a newer binding.
    const command = `AGENT_HOOK_RUNTIME_PID="$PPID" ${legacy}`
    const metadata = { statusMessage: labels[action], timeout: event === 'SessionEnd' ? 3 : 30 }
    const groups = data.hooks[event] ??= []
    if (!Array.isArray(groups) || groups.some((group) => !group || !Array.isArray(group.hooks) ||
        group.hooks.some((hook) => !hook || typeof hook !== 'object' || Array.isArray(hook)))) throw new AgentError(`Неверный формат ${event}: ${path}`, 9)
    let owned = false
    data.hooks[event] = groups.flatMap((group) => {
      let removed = false
      group.hooks = group.hooks.filter((hook) => {
        if (!ownedHook(hook, action, agent, command, legacy)) return true
        if (owned) { removed = true; return false }
        owned = true
        Object.assign(hook, { command, ...metadata })
        return true
      })
      return removed && !group.hooks.length ? [] : [group]
    })
    if (!owned) data.hooks[event].push({ hooks: [{ type: 'command', command, ...metadata }] })
  }
  const changed = JSON.stringify(data) !== JSON.stringify(original)
  let backup = null
  if (changed && !opts['dry-run']) {
    if (JSON.stringify(readJson(path, {})) !== JSON.stringify(original)) throw new AgentError(`Настройки изменились во время установки: ${path}`, 9)
    if (existsSync(path)) { backup = `${path}.agent-cli-${Date.now()}.bak`; copyFileSync(path, backup) }
    writeJson(path, data)
  }
  return result({ path, changed, dryRun: Boolean(opts['dry-run']), backup, hooks: data.hooks,
    ...(agent === 'codex' ? { next: 'Запустите codex в терминале: экран Hooks need review предложит проверить и подтвердить хуки. Внутри терминального Codex также доступна /hooks; в чате Superset её нет.' } : {}) })
}

export const hookCommand = (ctx, config, action, opts) => {
  if (action === 'install') return installHooks(ctx, opts)
  let input
  try { input = JSON.parse(readFileSync(0, 'utf8')) } catch { throw new AgentError('Hook ожидает JSON runtime на stdin') }
  return sessionHook(ctx, config, action, input, opts)
}
