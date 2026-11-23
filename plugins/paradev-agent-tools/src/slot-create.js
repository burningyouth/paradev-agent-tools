import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { AgentError, mustRun } from './context.js'
import { canonicalPath } from './current.js'
import { EXIT } from './exit.js'
import { gitClient } from './git.js'
import { nativeSlotProcesses } from './procs.js'
import { freshBase, loadSlots, slotPrepare } from './slot.js'
import { mainBranchOf, projectRules, releaseState, slotBase } from './slot-names.js'
import { createWorkspaceArgs, superset } from './superset.js'

/**
 * Новый слот, когда свободных нет: воркспейс Superset без агента. Папку worktree Superset выводит из ветки,
 * поэтому воркспейс создаётся на временной ветке «slot-N» (папка …/slot-N остаётся с ним навсегда), затем
 * слот уводится без ветки на свежий `origin/<base>`, а временная ветка удаляется.
 */

const SLOT_NAME = /^slot-\d+$/

/** Проект Superset по имени или id: id нужен `ws create`, основная копия — git и правилам. */
const findProject = (ctx, config, ref) => {
  if (!ref) throw new AgentError('Нужен --project <имя или id проекта Superset>')
  const projects = JSON.parse(mustRun(ctx, config.superset, ['projects', 'list', '--json'], { what: 'superset projects list' }))
  const project = projects.find((p) => p.name === ref || p.id === ref)
  if (!project) throw new AgentError(`Проект ${ref} не найден в Superset. Есть: ${projects.map((p) => p.name).join(', ')}`)
  if (!project.path || !existsSync(project.path)) throw new AgentError(`У проекта ${project.name} нет основной копии на диске`)
  return project
}

/**
 * Почему имя «slot-N» занято (null — свободно): воркспейс проекта с таким слотом, локальная ветка (Superset
 * взял бы её вместо свежей базы, а удалять чужую ветку нельзя) или папка рядом с другими worktree проекта.
 */
const nameTaken = (ctx, project, workspaces) => {
  const g = gitClient(ctx, project.path)
  const worktrees = g
    .git(['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
  const roots = new Set(worktrees.filter((path) => path !== project.path).map((path) => dirname(path)))
  return (name) => {
    if (workspaces.some((ws) => slotBase(ws.name) === name)) return `воркспейс ${name} уже есть`
    if (g.raw(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]).status === 0) return `ветка ${name} уже есть`
    if (worktrees.some((path) => basename(path) === name) || [...roots].some((root) => existsSync(join(root, name)))) {
      return `папка ${name} уже занята`
    }
    return null
  }
}

export const slotCreate = (ctx, config, opts) => {
  const project = findProject(ctx, config, opts.project)
  if (opts.name && !SLOT_NAME.test(opts.name)) throw new AgentError(`Имя слота — «slot-N», а не «${opts.name}»`)
  const api = superset(ctx, config)
  const own = (ws) => ws.projectName === project.name || ws.projectId === project.id
  const taken = nameTaken(ctx, project, api.workspaces().filter(own))
  const reason = opts.name && taken(opts.name)
  if (reason) throw new AgentError(`${opts.name}: ${reason}`, EXIT.check)
  let name = opts.name
  for (let n = 1; !name; n++) if (!taken(`slot-${n}`)) name = `slot-${n}`

  const rules = projectRules({ path: project.path, mainCheckout: project.path })
  const g = gitClient(ctx, project.path)
  const remote = rules.slot?.remote ?? 'origin'
  const base = (opts.base ?? mainBranchOf(g, rules)).replace(new RegExp(`^${remote}/`), '')
  const start = freshBase(g, remote, base, Boolean(opts.offline))
  const request = { project: project.id, name, branch: name, baseBranch: base }
  const baseLine = `без ветки на ${start.ref} ${start.sha.slice(0, 9)}${opts.offline ? ' (без fetch, --offline)' : ''}`
  if (opts['dry-run']) {
    const command = `superset ws create ${createWorkspaceArgs(request).join(' ')}`
    const data = { dryRun: true, slot: name, project: project.name, from: start.ref, base: start.sha, fetched: !opts.offline, command }
    return { data, text: `Сухой прогон: ${project.name}/${name} ${baseLine}\n  ${command}\n  затем git switch --detach ${start.sha.slice(0, 9)} и git branch -D ${name}` }
  }

  const created = api.createWorkspace(request)
  const id = created.id ?? created.workspace?.id ?? created.workspaceId
  const after = api.workspaces()
  const ws = after.find((w) => id && w.id === id) ?? after.find((w) => own(w) && w.name === name)
  if (!ws?.worktreePath) throw new AgentError(`superset ws create: воркспейс ${name} не найден после создания\n${JSON.stringify(created)}`)
  const wg = gitClient(ctx, ws.worktreePath)
  try {
    wg.git(['switch', '--quiet', '--detach', start.sha])
    wg.git(['branch', '--quiet', '-D', name])
  } catch (error) {
    if (!(error instanceof AgentError)) throw error
    throw new AgentError(`${error.message}\nВоркспейс ${name} (${ws.id}) создан: ${ws.worktreePath} — без ветки его не увёл`)
  }
  const dirty = wg.status().length
  const notes = [baseLine]
  if (basename(ws.worktreePath) !== name) notes.push(`папка не по имени слота: ${ws.worktreePath}`)
  if (dirty) notes.push(`грязно после создания: ${dirty} файлов (setup проекта?) — prepare остановится`)
  const data = { slot: name, workspace: ws.id, project: project.name, path: ws.worktreePath, from: start.ref, base: start.sha, fetched: !opts.offline, dirty, notes }
  const text = [`${name} создан: ${ws.worktreePath}`, ...notes.map((n) => `  ${n}`), `воркспейс: ${ws.id}`].join('\n')
  return { data, text, code: dirty ? EXIT.check : undefined }
}

/** Свободные слоты по номеру. Detached HEAD тоже должен содержать только влитую историю. */
const freeSlots = (ctx, config, slots) => {
  const api = superset(ctx, config)
  const order = (s) => Number(s.name.slice('slot-'.length))
  return slots
    .filter((s) => s.exists && s.mainCheckout && canonicalPath(s.path) !== canonicalPath(s.mainCheckout) && SLOT_NAME.test(s.name) &&
      !s.sessions.length && !s.reservation)
    .map((s) => ({ ...s, state: releaseState(ctx, s.path, projectRules(s)), dirty: gitClient(ctx, s.path).status().length }))
    .filter((s) => !s.dirty && s.state.merged && !nativeSlotProcesses(ctx, s).length && !api.chatList(s.id).some((chat) => chat.live))
    .sort((a, b) => order(a) - order(b))
}

/**
 * Взять слот под задачу одной командой: свободный слот проекта, а нет его — `slot create`; затем
 * `slot prepare`. Последняя строка — id воркспейса для `sess create --workspace`.
 */
export const slotTake = (ctx, config, opts) => {
  if (!opts.branch) throw new AgentError('Нужен --branch <ветка задачи>')
  const project = findProject(ctx, config, opts.project)
  const g = gitClient(ctx, project.path)
  if (!g.validBranch(opts.branch)) throw new AgentError(`Некорректное имя ветки: ${opts.branch}`)
  const slots = loadSlots(ctx, config, project.name)
  const holder = slots.find((s) => s.exists && s.path !== s.mainCheckout && gitClient(ctx, s.path).branch() === opts.branch)
  if (holder) throw new AgentError(`Ветка ${opts.branch} уже в ${holder.name} (${holder.id}) — работайте там`, EXIT.check)
  const prepareOpts = { ...opts, project: project.name, expectedFree: true }
  for (const free of freeSlots(ctx, config, slots)) {
    try {
      const prepared = slotPrepare(ctx, config, free.id, prepareOpts)
      const data = { workspace: free.id, slot: prepared.data.slot, path: free.path, created: false, prepare: prepared.data }
      return { data, text: `${prepared.text}\nворкспейс: ${free.id}`, code: prepared.code }
    } catch (error) {
      if (!error.details?.slotUnavailable && !error.details?.slotLocked) throw error
    }
  }
  if (opts.existingOnly) {
    const question = `В проекте ${project.name} нет свободных слотов. Создать новый слот для ${opts.task ?? opts.branch}?`
    return { data: { status: 'confirmation_required', project: project.name, question }, text: question, code: EXIT.waiting }
  }
  const created = slotCreate(ctx, config, { project: project.name, base: opts.from, offline: opts.offline, 'dry-run': opts['dry-run'] })
  if (opts['dry-run']) {
    const data = { dryRun: true, workspace: null, slot: created.data.slot, created: true, create: created.data, prepare: null }
    return { data, text: `Свободного слота нет.\n${created.text}\nзатем slot prepare ${created.data.slot} --branch ${opts.branch}` }
  }
  if (created.code) throw new AgentError(`${created.text}\nprepare не запускаю: слот грязный сразу после создания`, created.code)
  const prepared = slotPrepare(ctx, config, created.data.workspace, prepareOpts)
  const data = { workspace: created.data.workspace, slot: prepared.data.slot, path: created.data.path, created: true, create: created.data, prepare: prepared.data }
  const text = [`Свободного слота нет — ${created.data.slot} создан: ${created.data.path}`, prepared.text, `воркспейс: ${created.data.workspace}`]
  return { data, text: text.join('\n'), code: prepared.code }
}
