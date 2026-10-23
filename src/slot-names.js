import { existsSync } from 'node:fs'

import { mustRun } from './context.js'
import { gitClient, loadRepoConfig } from './git.js'

/**
 * Имена слотов Superset: свободный — «slot-N», занятый — «slot-N · <задача>». Папка worktree имени не
 * меняет, поэтому слот ищется по имени воркспейса (или «slot-N», или id), а не по пути.
 */

const SEPARATOR = ' · '

/** «slot-3 · task» → «slot-3»; имя без префикса slot-N — null (такой воркспейс не переименовываем). */
export const slotBase = (name) => name?.match(/^slot-\d+/)?.[0] ?? null

export const busyName = (base, task) => `${base}${SEPARATOR}${task}`

export const matchesSlot = (ws, ref) => [ws.id, ws.name, slotBase(ws.name), ws.path ?? ws.worktreePath].includes(ref)

export const renameSlot = (ctx, config, workspaceId, name) =>
  mustRun(ctx, config.superset, ['ws', 'update', workspaceId, '--local', '--name', name], { what: 'superset ws update' })

/**
 * Можно ли освободить слот: ветка влита в основную или задача закрыта — последний коммит ветки по
 * `slot.closedSubject` из `.agent-cli.json` (по умолчанию `^close\(`).
 */
export const releaseState = (ctx, path) => {
  const rules = loadRepoConfig(path).slot ?? {}
  const mainBranch = rules.mainBranch ?? 'main'
  const g = gitClient(ctx, path)
  const branch = g.branch() || '(detached)'
  const merged = branch !== mainBranch && g.raw(['merge-base', '--is-ancestor', 'HEAD', mainBranch]).status === 0
  const subject = g.git(['log', '-1', '--format=%s']).trim()
  const closed = new RegExp(rules.closedSubject ?? '^close\\(').test(subject)
  return { branch, merged, closed, releasable: merged || closed }
}

const inside = (cwd, dir) => Boolean(cwd && dir) && (cwd === dir || cwd.startsWith(`${dir}/`))

/**
 * Работа в слоте закончена — вернуть имя «slot-N». Это не освобождение слота: ветка, папка и «влита/не
 * влита» не меняются. Только если в воркспейсе не осталось Claude-сессий и рабочая копия чистая;
 * грязная — имя остаётся, чтобы было видно, что в слоте незакоммиченная работа.
 * `live` — живые сессии (listSessions); null — воркспейс не слот или имя уже «slot-N».
 */
export const restoreSlotName = (ctx, config, ws, live) => {
  const base = slotBase(ws?.name)
  if (!base || base === ws.name) return null
  if (live.some((s) => s.workspace === ws.id || inside(s.cwd, ws.worktreePath))) {
    return { renamed: false, name: ws.name, reason: 'в слоте ещё есть сессия' }
  }
  const dirty = ws.worktreePath && existsSync(ws.worktreePath) ? gitClient(ctx, ws.worktreePath).status().length : 0
  if (dirty) return { renamed: false, name: ws.name, reason: `рабочая копия грязная (${dirty} файлов)` }
  renameSlot(ctx, config, ws.id, base)
  return { renamed: true, name: base }
}
