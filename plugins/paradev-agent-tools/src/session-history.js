import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, truncateSync, writeSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { AgentError } from './context.js'
import { canonicalPath } from './current.js'
import { gitClient } from './git.js'
import { chatSlotName, slotBase } from './slot-names.js'
import { loadRegistry, readSessionEvents, syncDirectory, updateRegistry } from './store.js'
import { withSlotLock } from './slot-lock.js'

export const withSessionLaunchLock = (ctx, action) => withSlotLock(ctx, { id: 'session-capacity', path: join(ctx.agentHome, 'session-capacity') }, action)

export const matchesHistory = (s, ref) => Boolean(ref) && [s.id, s.alias, s.sessionId, s.nativeSessionId, s.terminal, ...(s.sessionIds ?? [])].includes(ref)

/** Git, never the possibly stale branch column in Superset. Missing data stays unknown. */
export const sessionContext = (ctx, session) => {
  const path = session.cwd ?? session.startup?.path
  const slot = slotBase(session.workspaceName)
  const context = { ...(path ? { cwd: path } : {}), ...(slot ? { slot } : {}) }
  const task = session.workspaceName?.match(/^slot-\d+ · (.+)$/)?.[1]
  if (task) context.task = session.workspaceName === chatSlotName(slot) ? session.task ?? null : task
  if (!path || !existsSync(path)) return context
  const g = gitClient(ctx, path)
  const root = g.raw(['rev-parse', '--show-toplevel'])
  if (root.status !== 0) return context
  const common = g.git(['rev-parse', '--git-common-dir']).trim()
  const gitCommonDir = canonicalPath(isAbsolute(common) ? common : resolve(path, common))
  const branch = g.branch()
  const mainCheckout = g.git(['worktree', 'list', '--porcelain']).split('\n').find((line) => line.startsWith('worktree '))?.slice(9)
  return { ...context, cwd: root.stdout.trim(), gitCommonDir, mainCheckout,
    ...(branch ? { branch } : {}), head: g.raw(['rev-parse', '--verify', 'HEAD']).stdout.trim() || null,
    dirty: g.status().length }
}

const appendEvent = (ctx, event) => {
  const path = join(ctx.agentHome, 'session-log.jsonl')
  if (existsSync(path)) {
    const bytes = readFileSync(path)
    if (bytes.length && bytes.at(-1) !== 10) truncateSync(path, bytes.lastIndexOf(10) + 1)
  }
  const fd = openSync(path, 'a', 0o600)
  try {
    const bytes = Buffer.from(`${JSON.stringify(event)}\n`)
    let offset = 0
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset)
    fsyncSync(fd)
  } finally { closeSync(fd) }
  syncDirectory(dirname(path))
}

/** One logical conversation survives transport ID changes. Events precede the atomic snapshot. */
export const recordSession = (ctx, session, type, patch = {}, options = {}) => {
  const context = options.context === false ? {} : sessionContext(ctx, session)
  return updateRegistry(ctx, (registry) => {
    const agent = session.agent ?? 'claude'
    const previous = registry.sessions.findLast((s) => (s.agent ?? 'claude') === agent &&
      (session.id && s.id === session.id || matchesHistory(s, session.resumedFrom) ||
       session.nativeSessionId && s.nativeSessionId === session.nativeSessionId && s.workspace === session.workspace && (s.kind ?? 'cli') === (session.kind ?? 'cli') ||
       session.sessionId && matchesHistory(s, session.sessionId) ||
       session.terminal && s.terminal === session.terminal && (!s.sessionId || !session.sessionId)))
    if (options.expected && (!previous || Object.entries(options.expected).some(([key, value]) => previous[key] !== value))) {
      throw new AgentError('Сессия уже возобновлена или переназначена — старое событие отменено', 9)
    }
    const now = new Date(ctx.now()).toISOString()
    const clean = Object.fromEntries(Object.entries(session).filter(([, value]) => value !== undefined && value !== null))
    // Do not copy whole transcripts or volatile process data into the recovery journal.
    const allowed = ['id', 'kind', 'agent', 'sessionId', 'nativeSessionId', 'alias', 'workspace', 'workspaceName', 'project',
      'cwd', 'title', 'terminal', 'branch', 'task', 'mainCheckout', 'gitCommonDir', 'model', 'mode', 'effort', 'resumedFrom', 'startup']
    const metadata = Object.fromEntries(allowed.filter((key) => key in clean).map((key) => [key, clean[key]]))
    const record = { ...previous, ...metadata, ...context, id: previous?.id ?? session.id ?? randomUUID(),
      kind: session.kind ?? previous?.kind ?? 'cli', agent, lifecycleId: previous?.lifecycleId ?? randomUUID(),
      createdAt: previous?.createdAt ?? now, updatedAt: now, ...patch }
    if (previous?.sessionId && session.sessionId && previous.sessionId !== session.sessionId) record.resumedFrom = previous.sessionId
    record.sessionIds = [...new Set([...(previous?.sessionIds ?? []), previous?.sessionId, session.sessionId, session.nativeSessionId].filter(Boolean))]
    // Invalidate old callbacks before the provider starts. Later launch acknowledgements
    // must preserve a lifecycle already checkpointed by its SessionStart hook.
    if (type === 'resume-requested') record.lifecycleId = randomUUID()
    if (['created', 'resumed', 'observed'].includes(type)) {
      if (previous?.status === 'closed') record.lifecycleId = randomUUID()
      record.status = 'open'; record.closedAt = null; record.lastSeenAt = now
      // A previous release belongs to history, not to the newly active slot.
      delete record.release
      delete record.sessionOnly
      delete record.error
    }
    if (type === 'close-requested') record.status = 'closing'
    if (type === 'closed') { record.status = 'closed'; record.closedAt = now }
    if (type === 'close-failed') record.status = 'unknown'
    if (!record.alias) record.alias = Object.entries(registry.aliases).find(([, target]) => target === session.terminal)?.[0] ?? null
    const event = { version: (registry.historyVersion ?? 0) + 1, type, at: now, record }
    appendEvent(ctx, event)
    registry.historyVersion = event.version
    registry.sessions = registry.sessions.filter((s) => s !== previous)
    if (type !== 'forgotten') registry.sessions.push(record)
    if (record.resumedFrom && registry.keep.includes(record.resumedFrom) && record.sessionId && !registry.keep.includes(record.sessionId)) registry.keep.push(record.sessionId)
    if (record.alias && ['created', 'resumed', 'observed', 'alias-changed'].includes(type) && record.terminal) registry.aliases[record.alias] = record.terminal
    if (record.alias && ['closed', 'forgotten'].includes(type) && registry.aliases[record.alias] === record.terminal) delete registry.aliases[record.alias]
    return record
  })
}

export const observeSessions = (ctx, sessions) => sessions.map((s) => recordSession(ctx, s, 'observed'))

export const selectHistory = (ctx, ref, opts = {}) => {
  const selectors = [Boolean(ref), Boolean(opts.task), Boolean(opts['last-closed']), Boolean(opts['all-open'])].filter(Boolean).length
  if (selectors !== 1) throw new AgentError('Укажите один селектор: <алиас|UUID>, --task KEY, --last-closed или --all-open')
  let rows = loadRegistry(ctx).sessions.filter((s) => !opts.project || s.project === opts.project)
  if (ref) rows = rows.filter((s) => ctx.exactHistory ? s.sessionId === ref : matchesHistory(s, ref))
  if (opts.task) rows = rows.filter((s) => s.task === opts.task)
  if (opts['last-closed']) rows = rows.filter((s) => s.status === 'closed' || s.closedAt).sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? '')).slice(0, 1)
  if (opts['all-open']) rows = rows.filter((s) => s.status === 'open' || s.closedAt === null).sort((a, b) => (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? ''))
  if (!opts['all-open'] && rows.length > 1) throw new AgentError(`Несколько сессий — выберите UUID:\n${rows.map((s) => `${s.sessionId ?? s.id} ${s.project ?? '—'} ${s.task ?? s.alias ?? ''}`).join('\n')}`, 9)
  return rows
}

export const sessLog = (ctx, opts = {}) => {
  const sessions = loadRegistry(ctx).sessions.filter((s) => (!opts.project || s.project === opts.project) && (!opts.task || s.task === opts.task))
    .sort((a, b) => (b.updatedAt ?? b.closedAt ?? '').localeCompare(a.updatedAt ?? a.closedAt ?? ''))
  const ids = new Set(sessions.map((s) => s.id).filter(Boolean))
  const events = readSessionEvents(ctx).filter((e) => ids.has(e.record.id))
  return { data: { sessions, events }, text: sessions.map((s) =>
    `${s.alias ?? '—'}  ${s.agent ?? 'claude'}/${s.kind ?? 'cli'}  ${s.sessionId ?? '(нет UUID)'}  ${s.project ?? '—'}/${s.task ?? '—'}  ${s.status ?? (s.closedAt ? 'closed' : 'unknown')}  ${s.updatedAt ?? s.closedAt ?? '—'}\n` +
    `  workspace ${s.workspace ?? '—'} · ${s.workspaceName ?? '—'} · ветка ${s.branch ?? '—'} · ${s.cwd ?? '—'}${s.nativeSessionId ? `\n  native UUID ${s.nativeSessionId}` : ''}${s.closeReason ? `\n  причина: ${s.closeReason}` : ''}${s.note ? `\n  ${s.note}` : ''}`
  ).join('\n') || 'История сессий пуста' }
}
