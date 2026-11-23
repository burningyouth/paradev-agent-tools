import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

import { AgentError } from './context.js'

export const canonicalPath = (path) => {
  try { return realpathSync(path) } catch { return resolve(path) }
}

export const containsPath = (dir, path) => {
  if (!dir || !path) return false
  const rel = relative(canonicalPath(dir), canonicalPath(path))
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel))
}

/** Окружение задаёт workspace точно; при устаревшем ID не переключаемся на cwd молча. */
export const resolveCurrentWorkspace = (ctx, workspaces, { required = true } = {}) => {
  const id = ctx.env.SUPERSET_WORKSPACE_ID
  let matches
  if (id) matches = workspaces.filter((ws) => ws.id === id)
  else {
    const inside = workspaces.filter((ws) => ws.worktreePath && containsPath(ws.worktreePath, ctx.cwd))
      .sort((a, b) => canonicalPath(b.worktreePath).length - canonicalPath(a.worktreePath).length)
    const path = inside[0]?.worktreePath
    matches = path ? inside.filter((ws) => canonicalPath(ws.worktreePath) === canonicalPath(path)) : []
  }
  if (matches.length > 1) throw new AgentError('Текущий workspace Superset неоднозначен')
  if (matches.length === 1) return matches[0]
  if (!required && !id) return null
  throw new AgentError(id
    ? `Workspace Superset ${id} из окружения не найден`
    : 'Не удалось определить текущий workspace Superset по cwd', 6)
}
