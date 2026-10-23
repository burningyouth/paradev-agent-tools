import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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

const expandHome = (ctx, path) => path.replace(/^~(?=\/|$)/, ctx.env.HOME ?? '')

export const loadConfig = (ctx) => {
  const config = { ...DEFAULT_CONFIG, ...readJson(join(ctx.agentHome, 'config.json'), {}) }
  return { ...config, superset: expandHome(ctx, ctx.env.SUPERSET_BIN ?? config.superset) }
}

const registryPath = (ctx) => join(ctx.agentHome, 'sessions.json')

/** Реестр: закрытые сессии (для resume), алиасы «имя задачи → терминал», keep — session id, которые gc не трогает. */
export const loadRegistry = (ctx) => {
  const data = readJson(registryPath(ctx), {})
  return { sessions: data.sessions ?? [], aliases: data.aliases ?? {}, keep: data.keep ?? [] }
}

export const saveRegistry = (ctx, registry) => writeJson(registryPath(ctx), registry)
