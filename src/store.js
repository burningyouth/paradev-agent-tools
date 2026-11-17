import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { AgentError } from './context.js'

export const DEFAULT_CONFIG = {
  maxSessions: 5,
  superset: '~/.superset/bin/superset',
  sendAcceptTimeoutSec: 20,
}

export const readJson = (path, fallback) => {
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new AgentError(`Не читается JSON ${path}: ${error.message}`)
  }
}

/** Запись через временный файл: прерванный процесс не оставит полузаписанный реестр. */
export const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  const fd = openSync(tmp, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(tmp, path)
  syncDirectory(dirname(path))
}

export const syncDirectory = (path) => {
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } catch (error) {
    if (!['EINVAL', 'ENOTSUP'].includes(error.code)) throw error
  } finally { closeSync(fd) }
}

/** Метка времени для имён бэкапов: 20261023-100000. */
export const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)

const home = (ctx) => ctx.env.HOME || homedir()

const expandHome = (ctx, path) => path.replace(/^~(?=\/|$)/, home(ctx))

/**
 * Путь к superset: агентам и launchd PATH к ~/.superset/bin не всегда достаётся. Голое имя ищем в PATH,
 * не нашли (или задан несуществующий путь) — берём ~/.superset/bin/superset.
 */
export const resolveSuperset = (ctx, value) => {
  const fallback = join(home(ctx), '.superset', 'bin', 'superset')
  const path = expandHome(ctx, value)
  if (!path.includes('/')) {
    const dirs = (ctx.env.PATH ?? '').split(':').filter(Boolean)
    return dirs.map((dir) => join(dir, path)).find((p) => existsSync(p)) ?? fallback
  }
  return existsSync(path) || !existsSync(fallback) ? path : fallback
}

export const loadConfig = (ctx) => {
  const config = { ...DEFAULT_CONFIG, ...readJson(join(ctx.agentHome, 'config.json'), {}) }
  return { ...config, superset: resolveSuperset(ctx, ctx.env.SUPERSET_BIN ?? config.superset) }
}

const registryPath = (ctx) => join(ctx.agentHome, 'sessions.json')

/** Реестр: закрытые сессии и активные chat-сессии (kind: chat|cli), алиасы «имя задачи → терминал», keep — session id, которые gc не трогает. */
export const loadRegistry = (ctx) => {
  const data = readJson(registryPath(ctx), {})
  const registry = { ...data, sessions: data.sessions ?? [], aliases: data.aliases ?? {}, keep: data.keep ?? [] }
  // The durable event is written before the snapshot. Replay after an interrupted write.
  for (const event of readSessionEvents(ctx)) {
    if (event.version <= (registry.historyVersion ?? 0)) continue
    registry.sessions = registry.sessions.filter((s) => s.id !== event.record.id && !((s.agent ?? 'claude') === event.record.agent &&
      (s.sessionId && [event.record.sessionId, ...(event.record.sessionIds ?? [])].includes(s.sessionId) ||
       !s.sessionId && s.terminal && s.terminal === event.record.terminal)))
    if (event.type !== 'forgotten') registry.sessions.push(event.record)
    const { alias, terminal } = event.record
    if (event.record.resumedFrom && registry.keep.includes(event.record.resumedFrom) && event.record.sessionId && !registry.keep.includes(event.record.sessionId)) registry.keep.push(event.record.sessionId)
    if (alias && ['created', 'resumed', 'observed', 'alias-changed'].includes(event.type) && terminal) registry.aliases[alias] = terminal
    if (alias && ['closed', 'forgotten'].includes(event.type) && registry.aliases[alias] === terminal) delete registry.aliases[alias]
    registry.historyVersion = event.version
  }
  return registry
}

export const saveRegistry = (ctx, registry) => writeJson(registryPath(ctx), registry)

export const readSessionEvents = (ctx) => {
  const path = join(ctx.agentHome, 'session-log.jsonl')
  if (!existsSync(path)) return []
  const text = readFileSync(path, 'utf8')
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map((line) => {
    try {
      const event = JSON.parse(line)
      if (!Number.isSafeInteger(event.version) || event.version < 1 || !event.type || !event.record?.id) throw new Error('invalid event')
      return event
    } catch { throw new AgentError(`Повреждён журнал ${path}`, 9) }
  })
}

/** Serialize registry/history writes across CLI processes; never steal an abandoned lock. */
export const updateRegistry = (ctx, action) => {
  mkdirSync(ctx.agentHome, { recursive: true, mode: 0o700 })
  const path = join(ctx.agentHome, 'sessions.lock')
  let fd
  try { fd = openSync(path, 'wx', 0o600) } catch (error) {
    if (error.code === 'EEXIST') throw new AgentError(`Реестр занят другой операцией: ${path}`, 9)
    throw error
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid }))
    const registry = loadRegistry(ctx)
    const result = action(registry)
    saveRegistry(ctx, registry)
    return result
  } finally { closeSync(fd); unlinkSync(path) }
}
