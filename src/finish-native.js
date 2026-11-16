import { codexSession } from './codex.js'
import { mustRun } from './context.js'
import { containsPath } from './current.js'
import { claudeSessionFile, processSupersetEnv } from './procs.js'

/** Include ACP app-server processes too: listSessions deliberately hides these. Read no env values into logs. */
export const nativeSlotProcesses = (ctx, slot, target) => {
  const output = mustRun(ctx, 'ps', ['-axo', 'pid=,ppid=,rss=,command='])
  return output.split('\n').flatMap((line) => {
    const row = line.trim().match(/^(\d+)\s+\d+\s+\d+\s+(.*)$/)
    if (!row) return []
    const [, id, command] = row
    const exe = command.split(' ')[0]
    const codex = /(?:^|\/)codex$/.test(exe) || /(?:^|\/)node$/.test(exe) && /^\S+\s+\S*\/codex(?:\.js|\/bin\/codex\.js)(?:\s|$)/.test(command)
    const claude = /(?:^|\/)claude$/.test(exe)
    if (!codex && !claude) return []
    const pid = Number(id)
    const env = processSupersetEnv(ctx, pid)
    const meta = codex ? codexSession(ctx, pid) : claudeSessionFile(ctx, pid)
    return env.workspace === slot.id || env.terminal === target.terminal ||
      meta?.sessionId && meta.sessionId === target.nativeSessionId || containsPath(slot.path, meta?.cwd)
      ? [{ pid, sessionId: meta?.sessionId ?? null, own: env.terminal === target.terminal || meta?.sessionId === target.nativeSessionId || (!env.terminal && !meta?.sessionId) }] : []
  })
}
