import { readFileSync } from 'node:fs'

import { AgentError } from './context.js'
import { canonicalPath, containsPath, resolveCurrentWorkspace } from './current.js'
import { gitClient } from './git.js'
import { nativeSlotProcesses } from './procs.js'
import { closeSessionTransport } from './sess-registry.js'
import { matchesHistory, recordSession } from './session-history.js'
import { findWorkspace, isCurrentSession, listSessions, resolveCurrentSession, resolveSession, sessionRecords } from './sessions.js'
import { lastAnswer } from './journal.js'
import { queueSelfClose } from './session-jobs.js'
import { assertFinishOwnership, finishOwnership, sessFinish } from './finish.js'
import { completeSlotLocked, findSlot } from './slot.js'
import { advanceSlotGeneration, withSlotLock } from './slot-lock.js'
import { slotBase } from './slot-names.js'
import { loadRegistry, readJson } from './store.js'
import { superset } from './superset.js'
import { tidyWorkspace } from './cleanup.js'
import { formatSync } from './local-files.js'

const targetSlot = (ctx, config, ws) => slotBase(ws.name) ? findSlot(ctx, config, ws.id) : null
const same = (a, b) => a && b && a.kind === b.kind && a.sessionId === b.sessionId && a.terminal === b.terminal

const checkSlot = (ctx, slot, session) => {
  if (!slot.exists || !slot.mainCheckout || canonicalPath(slot.path) === canonicalPath(slot.mainCheckout)) throw new AgentError('Нужен существующий отдельный слот с известной основной копией', 9)
  if (slot.sessions.some((s) => !same(s, session))) throw new AgentError('В слоте другая активная сессия — слот не освобождён', 9)
  const target = session ? { ...session, nativeSessionId: session.nativeSessionId ?? session.sessionId } : {}
  if (nativeSlotProcesses(ctx, slot, target).some((p) => !session || !p.own)) throw new AgentError('В слоте другой native-процесс — слот не освобождён', 9)
  if (gitClient(ctx, slot.path).status().length) throw new AgentError('Слот грязный — закоммитьте или сохраните правки по процессу проекта; сессия оставлена открытой', 9)
}

export const closeCommand = async (ctx, config, ref, opts = {}) => {
  if (opts.result) {
    const job = readJson(opts.result, null)
    if (!job?.status) throw new AgentError('Нет результата закрытия')
    return { data: job, text: JSON.stringify(job, null, 2), code: job.code ?? 0 }
  }
  if (opts['after-reply'] && (!opts.workspace || !ref || opts.force)) {
    throw new AgentError('Для --after-reply нужны точные UUID сессии и workspace; --force несовместим', 9)
  }
  if (opts['session-only'] && !ref && opts.workspace) throw new AgentError('Для закрытия только сессии укажите её UUID', 9)
  const api = superset(ctx, config)
  let session, ws, historical
  if (opts.workspace) {
    ws = findWorkspace(api, opts.workspace)
    if (ref) {
      session = resolveSession(ctx, config, ref, api)
      if (session.workspace !== ws.id) throw new AgentError('Сессия принадлежит другому workspace', 9)
    } else if (listSessions(ctx, config, api).some((s) => s.workspace === ws.id)) {
      throw new AgentError('В workspace есть сессии — укажите точный алиас или UUID', 9)
    }
  } else {
    try { session = ref ? resolveSession(ctx, config, ref, api) : resolveCurrentSession(ctx, config, api) } catch (error) {
      if (!(error instanceof AgentError) || error.code !== 6) throw error
      const records = ref ? loadRegistry(ctx).sessions.filter((s) => matchesHistory(s, ref)) : []
      if (ref && records.length !== 1) throw error
      historical = records[0]
      try { ws = ref ? findWorkspace(api, records[0].workspace) : resolveCurrentWorkspace(ctx, api.workspaces()) } catch (contextError) {
        if (!(contextError instanceof AgentError)) throw contextError
        throw new AgentError(`${contextError.message} — укажите ID или алиас`, contextError.code)
      }
      if (listSessions(ctx, config, api).some((s) => s.workspace === ws.id)) throw error
    }
    ws ??= findWorkspace(api, session.workspace)
  }
  // A stopped chat is history, not a running target. Release its empty workspace.
  if (opts.project && opts.project !== ws.projectName) throw new AgentError('Workspace принадлежит другому проекту', 9)
  if (session?.kind === 'chat' && session.live === false) {
    historical = loadRegistry(ctx).sessions.findLast((s) => matchesHistory(s, session.sessionId))
    if (!historical) throw new AgentError('Нет сохранённого назначения закрытой сессии — выберите пустой слот явно через --workspace', 9)
    session = null
  }
  const slot = opts['session-only'] ? null : targetSlot(ctx, config, ws)
  if (!session && !slot) throw new AgentError('Нет живой сессии или слота — укажите ID или алиас', 6)
  if (slot) checkSlot(ctx, slot, session)
  if (historical && slot) checkHistorical(ctx, slot, historical)
  if (session && !session.sessionId) throw new AgentError('Нет UUID сессии — автоматическое продолжение невозможно; сессия не закрыта', 9)
  if (session?.state === 'waiting') throw new AgentError('Сессия ждёт решения — сначала ответьте на вопрос или разрешение', 3)
  if (opts['after-reply'] && (session?.kind !== 'chat' || session.sessionId !== ref || ws.id !== opts.workspace ||
      !containsPath(ws.worktreePath, ctx.cwd))) {
    throw new AgentError('Для --after-reply нужен точный живой чат в выбранном workspace и его cwd', 9)
  }
  const self = session && isCurrentSession(ctx, session)
  const afterReply = Boolean(opts['after-reply'] || self && session.kind === 'chat' && (slot || opts['session-only']))
  if (session?.state === 'working' && !afterReply && !opts.force) throw new AgentError('Сессия работает — дождитесь завершения или явно укажите --force. Для своего чата используйте --after-reply с точными UUID.', 9)
  if (opts['dry-run']) {
    const actions = [session && `Закрыть ${session.sessionId}${afterReply ? ' после финального ответа' : ''}`,
      slot && `освободить ${slot.name} и проверить результат`]
    return { data: { dryRun: true, workspace: ws.id, sessionId: session?.sessionId ?? null,
      release: Boolean(slot), ...(afterReply ? { afterReply } : {}) }, text: actions.filter(Boolean).join('. ') }
  }
  if (afterReply) return sessFinish(ctx, config, [], {
    'release-slot': Boolean(slot), 'summary-file': opts['summary-file'], note: opts.note, reason: opts.reason,
  }, { session, ws, slot })
  if (self) {
    // Save before handing off to a worker; failure to persist must not close anything.
    const note = closeNote(ctx, session, api, opts)
    recordSession(ctx, session, 'checkpoint', { note, closeReason: opts.reason ?? 'close' })
    return queueSelfClose(ctx, config, session, { ...opts, note })
  }
  return closeTarget(ctx, config, session, { ...opts, workspace: ws.id, historical }, api)
}

const checkHistorical = (ctx, slot, record) => {
  const g = gitClient(ctx, slot.path)
  const branch = g.branch()
  if (record.project && record.project !== slot.project || record.cwd && canonicalPath(record.cwd) !== canonicalPath(slot.path) ||
      record.gitCommonDir && canonicalPath(g.git(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()) !== record.gitCommonDir ||
      branch && (!record.branch || branch !== record.branch) ||
      record.task && slot.name !== slotBase(slot.name) && slot.name !== `${slotBase(slot.name)} · ${record.task}`) {
    throw new AgentError('Сохранённое назначение сессии не совпадает со слотом — чужую задачу не освобождаю', 9)
  }
}

const closeNote = (ctx, session, api, opts) => {
  if (opts['summary-file']) return readFileSync(opts['summary-file'], 'utf8').trim()
  if (opts.note) return opts.note
  try { return lastAnswer(sessionRecords(ctx, session, api))?.text?.slice(0, 4000) ?? 'Последний ответ отсутствует' } catch {
    return loadRegistry(ctx).sessions.findLast((s) => matchesHistory(s, session.sessionId))?.note ?? 'Состояние сохранено перед закрытием'
  }
}

/** Also used by the detached worker and GC. No queueing and no alternate release path. */
export const closeTarget = async (ctx, config, session, opts = {}, api = superset(ctx, config)) => {
  const ws = findWorkspace(api, opts.workspace ?? session.workspace)
  const initial = opts['session-only'] ? null : targetSlot(ctx, config, ws)
  const run = async () => {
    const slot = initial ? findSlot(ctx, config, initial.id) : null
    if (slot && opts.expectedOwner) assertFinishOwnership(ctx, slot, opts.expectedOwner)
    if (slot && (canonicalPath(slot.path) !== canonicalPath(initial.path) || slot.project !== initial.project || slot.name !== initial.name)) throw new AgentError('Назначение слота изменилось до закрытия', 9)
    if (slot) checkSlot(ctx, slot, session)
    if (slot && opts.historical) checkHistorical(ctx, slot, opts.historical)
    const owner = slot ? finishOwnership(ctx, slot) : null
    const records = []
    if (session) records.push(await closeSessionTransport(ctx, config, session, { ...opts, note: closeNote(ctx, session, api, opts) }, api))
    else if (slot) {
      const branch = gitClient(ctx, slot.path).branch()
      const historical = opts.historical ? [opts.historical] : loadRegistry(ctx).sessions.filter((s) =>
        s.workspace === slot.id && s.status === 'open' && branch && s.branch === branch &&
        (!s.project || s.project === slot.project) && s.cwd && canonicalPath(s.cwd) === canonicalPath(slot.path))
      for (const record of historical) {
        checkHistorical(ctx, slot, record)
        records.push(recordSession(ctx, record, 'closed', { closeReason: opts.reason ?? 'close',
          ...(opts.note ? { note: opts.note } : {}) }, { context: false }))
      }
    }
    const close = { status: session ? 'closed' : 'already-closed' }
    const release = { status: slot ? 'pending' : 'not-applicable' }
    try {
      let tidied = []
      if (session?.kind === 'cli' && !opts['session-only'] && opts.cleanup !== false) {
        const live = listSessions(ctx, config, api)
        tidied = tidyWorkspace(api, ws.id, { liveClaude: new Set(live.map((s) => s.terminal).filter(Boolean)), self: ctx.env.SUPERSET_TERMINAL_ID })
      }
      if (slot) {
        const deadline = ctx.now() + 90_000
        while (true) {
          const fresh = findSlot(ctx, config, slot.id)
          assertFinishOwnership(ctx, fresh, owner)
          if (!fresh.sessions.length && !nativeSlotProcesses(ctx, fresh).length) break
          if (ctx.now() >= deadline) throw new AgentError('Сессия/native-процессы не завершились — слот не освобождён', 2)
          await ctx.sleep(500)
        }
        assertFinishOwnership(ctx, findSlot(ctx, config, slot.id), owner)
        advanceSlotGeneration(ctx, slot)
        Object.assign(release, completeSlotLocked(ctx, config, slot, opts), { status: 'released' })
        for (const record of records) recordSession(ctx, record, 'released', { release }, { context: false })
      }
      const data = { ...records[0], status: 'completed', workspace: ws.id, tidied, localFiles: release.result?.localFiles, close, release }
      return { data, text: [slot ? `Сессия закрыта, слот ${release.verified.name} освобождён и проверен` : 'Сессия закрыта', ...formatSync(data.localFiles)].join('\n') }
    } catch (error) {
      if (!(error instanceof AgentError)) throw error
      error.details = {
        status: 'partial', workspace: ws.id, sessionId: session?.sessionId ?? null, close,
        release: release.status === 'pending' ? { status: 'unverified' } : release,
      }
      throw error
    }
  }
  const lock = initial ?? (opts['session-only'] && ws.worktreePath ? { id: ws.id, path: ws.worktreePath } : null)
  return lock ? withSlotLock(ctx, lock, run) : run()
}
