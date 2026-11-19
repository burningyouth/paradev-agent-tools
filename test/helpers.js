import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { createContext, runCommand } from '../src/context.js'

export const tempDir = (prefix = 'agent-test-') => mkdtempSync(join(tmpdir(), prefix))

/**
 * Контекст с подменой внешних команд: `handlers[cmd](args, opts)` → { status, stdout, stderr } или строка.
 * git без обработчика запускается по-настоящему (во временных репозиториях), остальное — ошибка теста.
 */
export const fakeContext = (handlers = {}, overrides = {}) => {
  const home = tempDir('agent-home-')
  const calls = []
  let clock = Date.parse('2026-10-23T10:00:00Z')
  const ctx = createContext({
    platform: 'darwin', // These fake ps responses use the macOS argument format.
    env: { HOME: home, SUPERSET_BIN: 'superset', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    agentHome: join(home, '.agent-cli'),
    claudeHome: join(home, '.claude'),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
      overrides.onSleep?.(clock)
    },
    log: () => {},
    spawn: () => { throw new Error('Неожиданный запуск фонового процесса в тесте') },
    run: (cmd, args = [], opts = {}) => {
      calls.push({ cmd, args, opts })
      // Команду ищем и по имени файла: superset вызывается по абсолютному пути
      const handler = handlers[cmd] ?? handlers[basename(cmd)]
      if (!handler && cmd === 'git') return runCommand(cmd, args, { ...opts, env: { ...ctx.env, ...opts.env } })
      if (!handler) throw new Error(`Неожиданная команда в тесте: ${cmd} ${args.join(' ')}`)
      const result = handler(args, opts)
      return typeof result === 'string' ? { status: 0, stdout: result, stderr: '' } : { stdout: '', stderr: '', status: 0, ...result }
    },
    ...overrides,
  })
  ctx.calls = calls
  ctx.advance = (ms) => (clock += ms)
  return ctx
}

export const git = (cwd, ...args) => {
  const result = runCommand('git', args, {
    cwd,
    env: { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

/** Репозиторий с начальным коммитом из `files` ({путь: содержимое}). */
export const makeRepo = (files) => {
  const dir = tempDir('agent-repo-')
  git(dir, 'init', '-q', '-b', 'main')
  writeFiles(dir, files)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}

export const addOrigin = (repo) => {
  const origin = join(tempDir(), 'origin.git')
  git(repo, 'init', '-q', '--bare', origin)
  git(repo, 'remote', 'add', 'origin', origin)
  git(repo, 'push', '-q', 'origin', 'main')
  return origin
}

export const writeFiles = (dir, files) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
}

export const jsonl = (records) => `${records.map((r) => JSON.stringify(r)).join('\n')}\n`
