import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { readJson } from './store.js'
import { codexSession } from './codex.js'
import { mustRun } from './context.js'
import { containsPath } from './current.js'

/** Один разбор ps и команд провайдеров; ACP/MCP серверы нужны finish, но не списку CLI-сессий. */
const processRows = (output, includeServers = false) => output.split('\n').flatMap((line) => {
  const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)
  if (!m) return []
  const command = m[4]
  const exe = command.split(' ')[0]
  const launcher = /(?:^|\/)node(?:\s|$)/.test(exe) && /^\S+\s+\S*\/codex(?:\.js|\/bin\/codex\.js)(?:\s|$)/.test(command)
  const server = /^\S+\s+(?:app-server|mcp-server)(?:\s|$)/.test(command)
  const codex = (exe === 'codex' || exe.endsWith('/codex') || launcher) && (includeServers || !server)
  const claude = exe === 'claude' || exe.endsWith('/claude')
  return [{ pid: Number(m[1]), ppid: Number(m[2]), rssKb: Number(m[3]), agent: claude ? 'claude' : codex ? 'codex' : null, launcher }]
})

/** Процессы Codex и Claude Code текущего пользователя: pid и RSS в КБ (`ps`). */
export const agentProcesses = (ctx) => {
  const { stdout } = ctx.run('ps', ['-axo', 'pid=,ppid=,rss=,command='])
  const rows = processRows(stdout)
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

const linuxProcessEnv = (pid) => {
  try {
    return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')
  } catch (error) {
    if (['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) return []
    throw error
  }
}

export const processSupersetEnv = (ctx, pid) => {
  let last
  if ((ctx.platform ?? process.platform) === 'linux') {
    const env = linuxProcessEnv(pid)
    last = (name) => env.findLast((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1) || null
  } else {
    // macOS ps -E appends environment after command arguments, which may contain lookalike values.
    const args = ctx.run('ps', ['-p', String(pid), '-o', 'command=']).stdout.trimEnd()
    const withEnv = ctx.run('ps', ['-E', '-p', String(pid), '-o', 'command=']).stdout.trimEnd()
    const env = withEnv.startsWith(args) ? withEnv.slice(args.length) : withEnv
    last = (name) => [...env.matchAll(new RegExp(` ${name}=([0-9A-Za-z-]+)`, 'g'))].at(-1)?.[1] ?? null
  }
  return { terminal: last('SUPERSET_TERMINAL_ID'), workspace: last('SUPERSET_WORKSPACE_ID') }
}

/** `~/.claude/sessions/<pid>.json`: Claude Code пишет туда текущий sessionId, cwd и busy/idle. */
export const claudeSessionFile = (ctx, pid) => readJson(join(ctx.claudeHome, 'sessions', `${pid}.json`), null)

/** Все живые сессии с терминалом Superset (если запущены в нём) и метаданными журнала. */
export const liveAgentSessions = (ctx) =>
  agentProcesses(ctx).map(({ pid, agent, rssKb, nested }) => {
    const env = processSupersetEnv(ctx, pid)
    const file = nativeSessionMeta(ctx, pid, agent, nested)
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


const nativeSessionMeta = (ctx, pid, agent, nested = false) => agent === 'codex'
  ? (nested ? null : codexSession(ctx, pid)) : claudeSessionFile(ctx, pid)

/** Учитываем и ACP app-server: finish ждёт процессы слота, не только видимые CLI-сессии. */
export const nativeSlotProcesses = (ctx, slot, target = {}) => {
  const output = mustRun(ctx, 'ps', ['-axo', 'pid=,ppid=,rss=,command='])
  return processRows(output, true).filter((proc) => proc.agent).flatMap(({ pid, agent }) => {
    const env = processSupersetEnv(ctx, pid)
    const meta = nativeSessionMeta(ctx, pid, agent)
    const own = Boolean(target.terminal && env.terminal === target.terminal || target.nativeSessionId && meta?.sessionId === target.nativeSessionId)
    const inSlot = env.workspace === slot.id || own || containsPath(slot.path, meta?.cwd)
    const exact = String(pid) === target.runtimePid && agent === target.agent &&
      env.workspace === slot.id && env.terminal === target.terminal &&
      (!meta?.sessionId || meta.sessionId === target.nativeSessionId)
    return inSlot ? [{ pid, sessionId: meta?.sessionId ?? null,
      own: target.exactRuntime ? exact : own || (!env.terminal && !meta?.sessionId) }] : []
  })
}
