import { basename, resolve } from 'node:path'

import { AgentError } from './context.js'
import { containsPath } from './current.js'
import { listSessions, sessionRecords } from './sessions.js'
import { superset } from './superset.js'

/** Read-only activity query for local tools. Journal content never leaves this process. */
export const fileActivity = (ctx, config, names, { recent = '30m' } = {}) => {
  if (!names.length) throw new AgentError('Нужен путь: paradev-agent activity FILE... [--recent 30m]')
  if (!/^\d{1,6}m?$/.test(recent)) throw new AgentError('--recent задаётся в минутах, например 30m')
  const since = ctx.now() - Number.parseInt(recent, 10) * 60_000
  const api = superset(ctx, config)
  const sessions = listSessions(ctx, config, api).filter((s) => !s.terminal || s.terminal !== ctx.env.SUPERSET_TERMINAL_ID ||
    s.workspace !== ctx.env.SUPERSET_WORKSPACE_ID)
  const files = names.map((file) => ({ file, path: resolve(ctx.cwd, file), name: basename(file) }))
  const busy = sessions.flatMap((session) => {
    const terminal = session.terminal ?? `pid ${session.pid}`
    const pending = files.filter(({ path }) => session.state === 'idle' || !containsPath(session.cwd, path))
    let recentRecords = []
    if (pending.length) {
      try {
        recentRecords = sessionRecords(ctx, session, api)
          .filter((r) => Date.parse(r.timestamp) >= since)
          .map((r) => JSON.stringify(r))
      } catch (error) {
        // A newly started terminal may not have a journal yet. Chat host failures
        // must not be interpreted as an empty transcript.
        if (session.kind !== 'cli' || !(error instanceof AgentError)) throw error
      }
    }
    return files.flatMap(({ file, path, name }) => {
      if (session.state !== 'idle' && containsPath(session.cwd, path)) return [{ file, terminal, why: 'в worktree работающей сессии' }]
      if (recentRecords.some((text) => text.includes(name))) return [{ file, terminal, why: 'упомянут в журнале недавно' }]
      return []
    })
  })
  return { data: { busy }, text: busy.map(({ file, terminal, why }) => `${file} — ${terminal}: ${why}`).join('\n') || 'Активность по файлам не найдена' }
}
