import { existsSync } from 'node:fs'
import { join } from 'node:path'

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
 * Правила проекта для слота: `.agent-cli.json` основной копии проекта, если он там есть, иначе слота.
 * Неотслеживаемый файл основной копии в worktree не попадает, а читать его надо и из слотов.
 */
export const projectRules = (slot) => {
  const main = slot.mainCheckout && existsSync(join(slot.mainCheckout, '.agent-cli.json')) ? slot.mainCheckout : slot.path
  return loadRepoConfig(main)
}

/** Основная ветка: `slot.mainBranch`, иначе origin/HEAD, иначе main. */
export const mainBranchOf = (g, rules) => {
  if (rules.slot?.mainBranch) return rules.slot.mainBranch
  const remote = rules.slot?.remote ?? 'origin'
  const head = g.raw(['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`])
  return head.status === 0 ? head.stdout.trim().replace(`${remote}/`, '') : 'main'
}

/** HEAD влит в основную ветку — локальную или удалённую (локальная в worktree часто отстаёт). */
export const isMerged = (g, rules, mainBranch) => {
  const remote = rules.slot?.remote ?? 'origin'
  return [mainBranch, `${remote}/${mainBranch}`].some((ref) => g.raw(['merge-base', '--is-ancestor', 'HEAD', ref]).status === 0)
}

/**
 * Можно ли освободить слот: ветка влита в основную или задача закрыта — последний коммит ветки по
 * `slot.closedSubject` из `.agent-cli.json` (по умолчанию `^close\(`).
 */
export const releaseState = (ctx, path, rules = loadRepoConfig(path)) => {
  const g = gitClient(ctx, path)
  const mainBranch = mainBranchOf(g, rules)
  const branch = g.branch() || '(detached)'
  const merged = branch !== mainBranch && isMerged(g, rules, mainBranch)
  const subject = g.git(['log', '-1', '--format=%s']).trim()
  const closed = new RegExp(rules.slot?.closedSubject ?? '^close\\(').test(subject)
  return { branch, mainBranch, merged, closed, releasable: merged || closed }
}
