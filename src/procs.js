import { join } from 'node:path'

import { readJson } from './store.js'

const isClaudeCommand = (command) => {
  const exe = command.split(' ')[0]
  return exe === 'claude' || exe.endsWith('/claude')
}

/** Процессы Claude Code текущего пользователя: pid и RSS в КБ (`ps`). */
export const claudeProcesses = (ctx) => {
  const { stdout } = ctx.run('ps', ['-axo', 'pid=,ppid=,rss=,command='])
  const rows = stdout
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), rssKb: Number(m[3]), claude: isClaudeCommand(m[4]) }))
  const parent = new Map(rows.map((r) => [r.pid, r.ppid]))
  const claudePids = new Set(rows.filter((r) => r.claude).map((r) => r.pid))
  // Вложенный claude (`claude -p` из скрипта сессии, подагент) наследует SUPERSET_TERMINAL_ID родителя —
  // отдельной сессией терминала он не считается
  const nestedIn = (pid) => {
    for (let p = parent.get(pid), depth = 0; p > 1 && depth < 64; p = parent.get(p), depth++) {
      if (claudePids.has(p)) return true
    }
    return false
  }
  return rows.filter((r) => r.claude).map((r) => ({ pid: r.pid, rssKb: r.rssKb, nested: nestedIn(r.pid) }))
}

/**
 * Переменные Superset из окружения процесса. `ps -E` печатает окружение после аргументов; аргументы
 * (текст промпта) тоже могут содержать `SUPERSET_TERMINAL_ID=`, поэтому отрезаем вывод `ps` без `-E`.
 */
export const processSupersetEnv = (ctx, pid) => {
  const args = ctx.run('ps', ['-p', String(pid), '-o', 'command=']).stdout.trimEnd()
  const withEnv = ctx.run('ps', ['-E', '-p', String(pid), '-o', 'command=']).stdout.trimEnd()
  const env = withEnv.startsWith(args) ? withEnv.slice(args.length) : withEnv
  const last = (name) => [...env.matchAll(new RegExp(` ${name}=([0-9A-Za-z-]+)`, 'g'))].at(-1)?.[1] ?? null
  return { terminal: last('SUPERSET_TERMINAL_ID'), workspace: last('SUPERSET_WORKSPACE_ID') }
}

/** `~/.claude/sessions/<pid>.json`: Claude Code пишет туда текущий sessionId, cwd и busy/idle. */
export const claudeSessionFile = (ctx, pid) => readJson(join(ctx.claudeHome, 'sessions', `${pid}.json`), null)

/** Все живые сессии Claude с терминалом Superset (если запущены в нём) и файлом сессии. */
export const liveClaudeSessions = (ctx) =>
  claudeProcesses(ctx).map(({ pid, rssKb, nested }) => {
    const env = processSupersetEnv(ctx, pid)
    const file = claudeSessionFile(ctx, pid)
    return {
      pid,
      rssKb,
      nested,
      terminal: nested ? null : env.terminal,
      workspace: env.workspace,
      sessionId: file?.sessionId ?? null,
      cwd: file?.cwd ?? null,
      status: file?.status ?? null,
    }
  })
