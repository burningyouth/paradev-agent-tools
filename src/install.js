import { lstatSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AgentError } from './context.js'
import { EXIT } from './exit.js'

const installedLink = (path, target) => {
  let stat
  try { stat = lstatSync(path) } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
  if (stat.isSymbolicLink()) {
    try {
      if (realpathSync(path) === target) return true
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  throw new AgentError(`Путь ${path} уже занят. Выберите другой каталог через --directory.`, EXIT.check)
}

export const install = (ctx, opts = {}) => {
  for (const key of Object.keys(opts)) {
    if (!['directory', 'dry-run', 'json'].includes(key)) {
      throw new AgentError(`agent install не принимает --${key}. Справка: agent install --help`)
    }
  }

  const home = ctx.env.HOME ?? homedir()
  const directory = resolve(ctx.cwd, opts.directory?.replace(/^~(?=\/|$)/, () => home) ?? join(home, '.local', 'bin'))
  const path = join(directory, 'agent')
  const dryRun = Boolean(opts['dry-run'])
  try {
    const target = realpathSync(fileURLToPath(new URL('../bin/agent.js', import.meta.url)))
    const unchanged = installedLink(path, target)
    if (!dryRun && !unchanged) {
      mkdirSync(directory, { recursive: true })
      try { symlinkSync(target, path) } catch (error) {
        if (error.code !== 'EEXIST' || !installedLink(path, target)) throw error
      }
    }
    const status = unchanged ? 'unchanged' : dryRun ? 'planned' : 'installed'
    const labels = { unchanged: 'Уже установлено', planned: 'План установки', installed: 'Установлено' }
    return { data: { status, dryRun, path, target }, text: `${labels[status]}: ${path} → ${target}` }
  } catch (error) {
    if (error instanceof AgentError) throw error
    throw new AgentError(`Не удалось установить команду agent: ${error.message}`)
  }
}
