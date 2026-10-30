import { join } from 'node:path'

import { readJson } from './store.js'
import { codexSession } from './codex.js'

const isClaudeCommand = (command) => {
  const exe = command.split(' ')[0]
  return exe === 'claude' || exe.endsWith('/claude')
}

/** Процессы Codex и Claude Code текущего пользователя: pid и RSS в КБ (`ps`). */
export const agentProcesses = (ctx) => {
  const { stdout } = ctx.run('ps', ['-axo', 'pid=,ppid=,rss=,command='])
  const rows = stdout
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((m) => {
      const command = m[4]
      const exe = command.split(' ')[0]
      const launcher = /(?:^|\/)node(?:\s|$)/.test(exe) && /^\S+\s+\S*\/codex(?:\.js|\/bin\/codex\.js)(?:\s|$)/.test(command)
      const codex = (exe === 'codex' || exe.endsWith('/codex') || launcher) && !/^\S+\s+(?:app-server|mcp-server)(?:\s|$)/.test(command)
      return { pid: Number(m[1]), ppid: Number(m[2]), rssKb: Number(m[3]), agent: isClaudeCommand(command) ? 'claude' : codex ? 'codex' : null, launcher }
    })
  const parent = new Map(rows.map((r) => [r.pid, r.ppid]))
  const hasAncestor = (pid, wanted) => {
    for (let p = parent.get(pid), depth = 0; p > 1 && depth < 64; p = parent.get(p), depth++) {
      if (wanted.has(p)) return true
    }
    return false
  }
  // npm запускает node bin/codex.js → нативный codex. Это одна сессия, RSS берём у нативного процесса.
  const agents = rows.filter((r) => r.agent && !(r.launcher && rows.some((c) => c.agent === 'codex' && !c.launcher && hasAncestor(c.pid, new Set([r.pid])))))
  const agentPids = new Set(agents.map((r) => r.pid))
  // Вложенный агент (codex exec, claude -p, подагент) наследует SUPERSET_TERMINAL_ID родителя —
  // отдельной сессией терминала он не считается
  return agents.map((r) => ({ pid: r.pid, agent: r.agent, rssKb: r.rssKb, nested: hasAncestor(r.pid, agentPids) }))
}

export const claudeProcesses = (ctx) => agentProcesses(ctx).filter((p) => p.agent === 'claude')

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

/** Все живые сессии с терминалом Superset (если запущены в нём) и метаданными журнала. */
export const liveAgentSessions = (ctx) =>
  agentProcesses(ctx).map(({ pid, agent, rssKb, nested }) => {
    const env = processSupersetEnv(ctx, pid)
    const file = agent === 'codex' ? (nested ? null : codexSession(ctx, pid)) : claudeSessionFile(ctx, pid)
    return {
      pid,
      agent,
      rssKb,
      nested,
      terminal: nested ? null : env.terminal,
      workspace: env.workspace,
      sessionId: file?.sessionId ?? null,
      cwd: file?.cwd ?? null,
      status: file?.status ?? null,
      journal: file?.journal ?? null,
    }
  })

export const liveClaudeSessions = (ctx) => liveAgentSessions(ctx).filter((p) => p.agent === 'claude')
