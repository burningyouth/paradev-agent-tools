import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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
  renameSync(tmp, path)
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
  return { sessions: data.sessions ?? [], aliases: data.aliases ?? {}, keep: data.keep ?? [] }
}

export const saveRegistry = (ctx, registry) => writeJson(registryPath(ctx), registry)
