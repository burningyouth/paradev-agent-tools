import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { AgentError, mustRun } from './context.js'
import { readJson } from './store.js'

/** git в репозитории `cwd`; `index` — альтернативный индекс (GIT_INDEX_FILE) для сухого прогона. */
export const gitClient = (ctx, cwd, index = undefined) => {
  const env = index ? { GIT_INDEX_FILE: index } : undefined
  const git = (args, opts = {}) => mustRun(ctx, 'git', args, { cwd, env, what: `git ${args[0]}`, ...opts })
  const lines = (out) => out.split('\n').filter(Boolean)
  return {
    git,
    raw: (args, opts = {}) => ctx.run('git', args, { cwd, env, ...opts }),
    root: () => git(['rev-parse', '--show-toplevel']).trim(),
    head: () => git(['rev-parse', 'HEAD']).trim(),
    branch: () => git(['branch', '--show-current']).trim(),
    validBranch: (name) => Boolean(name) && !name.startsWith('-') &&
      ctx.run('git', ['check-ref-format', `refs/heads/${name}`], { cwd }).status === 0,
    operationInProgress: () => lines(git(['rev-parse', '--path-format=absolute',
      '--git-path', 'MERGE_HEAD', '--git-path', 'CHERRY_PICK_HEAD', '--git-path', 'REVERT_HEAD',
      '--git-path', 'rebase-merge', '--git-path', 'rebase-apply', '--git-path', 'sequencer', '--git-path', 'BISECT_START',
    ])).some(existsSync),
    /** Файлы, отличающиеся в индексе от `base` (по умолчанию HEAD), без поиска переименований. */
    staged: (base = 'HEAD') => lines(git(['diff-index', '--cached', '--name-only', '--no-renames', base])),
    stagedPatch: (base, path) => git(['diff-index', '--cached', '-p', '--no-renames', base, '--', path]),
    unstagedPatch: (path) => git(['diff', '--no-renames', '--', path]),
    /** Изменённые и неотслеживаемые файлы рабочей копии (`git status --porcelain`). */
    status: () =>
      lines(git(['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all']).replace(/\0/g, '\n')).map((line) => ({
        code: line.slice(0, 2),
        path: line.slice(3),
      })),
  }
}

/** Правила проекта: `.agent-cli.json` в корне репозитория. */
export const loadRepoConfig = (root) => readJson(join(root, '.agent-cli.json'), {})

export const requireRepo = (ctx, cwd) => {
  const result = ctx.run('git', ['rev-parse', '--show-toplevel'], { cwd })
  if (result.status !== 0) throw new AgentError(`${cwd} — не git-репозиторий`)
  return result.stdout.trim()
}
