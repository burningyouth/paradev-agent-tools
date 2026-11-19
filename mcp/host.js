import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { readJson } from '../src/store.js'

export const classifyPid = (pid, kill = process.kill) => {
  if (!Number.isSafeInteger(pid) || pid < 1) return 'unknown'
  try {
    kill(pid, 0)
    return 'running'
  } catch (error) {
    if (error.code === 'ESRCH') return 'exited'
    if (error.code === 'EPERM' || error.code === 'EACCES') return 'permission-denied'
    return 'unknown'
  }
}

export const hostPids = (env) => {
  const roots = env.PARADEV_HOME ? [env.PARADEV_HOME] : [join(env.HOME, '.paradev'), join(env.HOME, '.superset')]
  const manifests = roots.flatMap((root) => {
    const dir = join(root, 'host')
    try {
      return readdirSync(dir).map((entry) => join(dir, entry, 'manifest.json')).filter(existsSync)
    } catch { return [] }
  })
  return [...new Set(manifests)].map((path) => {
    try {
      const { pid } = readJson(path, {})
      return { path, pid, process: classifyPid(pid) }
    } catch { return { path, process: 'unknown' } }
  })
}

export const hostFailure = (message, env) => {
  const pids = hostPids(env)
  const hint = pids.some((host) => host.process === 'permission-denied')
    ? 'Нет прав проверить PID хоста. Проверьте доступ клиента к локальному хосту Paradev и повторите диагностику.'
    : 'Проверьте, что Paradev/Superset Desktop открыт, пользователь вошёл в приложение и локальный хост доступен.'
  const detail = message.replace(/^Hint:.*$/gm, '').replace(/ \(recorded PID is dead\)/g, '').trim()
  return { status: 'unavailable', error: detail, pids, hint }
}
