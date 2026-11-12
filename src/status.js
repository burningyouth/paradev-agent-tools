import { existsSync } from 'node:fs'

import { containsPath, resolveCurrentWorkspace } from './current.js'
import { gitClient } from './git.js'
import { currentSessionCandidates, listSessions, STATE_LABEL } from './sessions.js'
import { slotBase } from './slot-names.js'
import { superset } from './superset.js'

/** Сводка только читает состояние; Git проверяется в выбранном workspace, а не по колонке Superset. */
export const status = (ctx, config) => {
  const api = superset(ctx, config)
  const workspaces = api.workspaces()
  const ws = resolveCurrentWorkspace(ctx, workspaces, { required: false })
  const path = ws?.worktreePath ?? ctx.cwd
  const g = gitClient(ctx, path)
  const exists = existsSync(path)
  const root = exists ? g.raw(['rev-parse', '--show-toplevel']) : { status: 1 }
  const git = root.status === 0 ? {
    root: root.stdout.trim(), branch: g.branch() || null, head: g.raw(['rev-parse', '--verify', 'HEAD']).stdout.trim() || null,
    changes: g.status(),
  } : null
  const sessions = ws ? listSessions(ctx, config, api).filter((s) => s.workspace === ws.id || containsPath(ws.worktreePath, s.cwd)) : []
  const candidates = ws ? currentSessionCandidates(ctx, sessions, [ws]) : []
  const session = candidates.length === 1 ? candidates[0] : null
  const selection = candidates.length > 1 ? 'ambiguous' : session ? 'selected' : sessions.length ? 'unmatched' : 'none'
  const summary = ({ kind, agent, terminal, sessionId, alias, state, pid }) => ({ kind, agent, terminal, sessionId, alias, state, pid })
  const data = {
    project: ws?.projectName ?? null,
    workspace: ws ? { id: ws.id, name: ws.name, path: ws.worktreePath, exists } : null,
    slot: slotBase(ws?.name), git, session: session ? summary(session) : null, selection, sessions: sessions.map(summary),
  }
  const lines = [
    `Проект: ${data.project ?? '(вне Superset)'}`,
    `Workspace: ${ws ? `${ws.name} (${ws.id})` : '(не найден по cwd)'}`,
    `Слот: ${data.slot ?? '—'}`,
    `Путь: ${path}${exists ? '' : ' (нет на диске)'}`,
  ]
  if (git) {
    lines.push(`Ветка: ${git.branch ?? '(detached HEAD)'}${git.head ? ` · ${git.head.slice(0, 9)}` : ''}`)
    lines.push(git.changes.length ? `Изменения: ${git.changes.length}` : 'Изменения: чисто')
    lines.push(...git.changes.map((change) => `  ${change.code} ${change.path}`))
  } else lines.push('Git: не репозиторий')
  if (!sessions.length) lines.push('Сессии: живых сессий нет')
  else {
    if (selection === 'ambiguous') lines.push('Сессии: несколько; для last/close укажите ID или алиас')
    if (selection === 'unmatched') lines.push('Текущая сессия не найдена; остальные сессии workspace:')
    for (const s of sessions) lines.push(`  ${s === session ? '→' : '·'} ${s.agent}/${s.kind} ${s.alias ?? s.sessionId ?? s.terminal ?? `pid ${s.pid}`} — ${STATE_LABEL[s.state] ?? s.state}`)
  }
  return { data, text: lines.join('\n') }
}
