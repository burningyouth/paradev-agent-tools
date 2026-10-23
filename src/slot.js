import { copyFileSync, existsSync, lstatSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { AgentError, mustRun } from './context.js'
import { EXIT } from './exit.js'
import { gitClient, loadRepoConfig } from './git.js'
import { listSessions } from './sessions.js'
import { busyName, matchesSlot, releaseState, renameSlot, slotBase } from './slot-names.js'
import { superset } from './superset.js'

const inside = (cwd, dir) => Boolean(cwd) && (cwd === dir || cwd.startsWith(`${dir}/`))

/** Слоты проекта Superset: путь, основная копия проекта, живая ли в слоте сессия. */
export const loadSlots = (ctx, config, project) => {
  const api = superset(ctx, config)
  const projects = mustRun(ctx, config.superset, ['projects', 'list', '--json'], { what: 'superset projects list' })
  const projectPath = new Map(JSON.parse(projects).map((p) => [p.name, p.path]))
  const sessions = listSessions(ctx, config, api)
  return api
    .workspaces()
    .filter((ws) => ws.worktreePath && (!project || ws.projectName === project))
    .map((ws) => ({
      id: ws.id,
      name: ws.name,
      project: ws.projectName,
      path: ws.worktreePath,
      exists: ws.worktreeExists !== false && existsSync(ws.worktreePath),
      mainCheckout: projectPath.get(ws.projectName) ?? null,
      sessions: sessions.filter((s) => s.workspace === ws.id || inside(s.cwd, ws.worktreePath)),
    }))
}

const slotGitState = (ctx, slot, mainBranch) => {
  const g = gitClient(ctx, slot.path)
  const branch = g.branch() || '(detached)'
  const dirty = g.status().length
  const merged = branch === mainBranch ? null : g.raw(['merge-base', '--is-ancestor', 'HEAD', mainBranch]).status === 0
  return { branch, dirty, merged }
}

export const slotLs = (ctx, config, opts) => {
  const rows = loadSlots(ctx, config, opts.project).map((slot) => {
    if (!slot.exists) return { ...slot, sessions: slot.sessions.length, branch: null, dirty: null, merged: null }
    const mainBranch = loadRepoConfig(slot.path).slot?.mainBranch ?? 'main'
    return { ...slot, ...slotGitState(ctx, slot, mainBranch), sessions: slot.sessions.length }
  })
  const text = rows
    .map((r) => {
      if (!r.exists) return `${r.project}/${r.name}  (worktree нет на диске)`
      const merged = r.merged === null ? '' : r.merged ? 'влита' : 'не влита'
      const dirty = r.dirty ? `грязно: ${r.dirty}` : 'чисто'
      return `${r.project}/${r.name}  ${r.branch}  ${dirty}  ${merged}  ${r.sessions ? `сессий: ${r.sessions}` : 'свободен'}`
    })
    .join('\n')
  return { data: rows, text }
}

const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)

/** Копия изменённых и неотслеживаемых файлов (удалённые — только в status.txt) и полный дифф. */
const backupSlot = (ctx, slot, entries) => {
  const dir = join(ctx.agentHome, 'backups', `${slot.name}-${stamp(ctx.now())}`)
  mkdirSync(dir, { recursive: true })
  for (const { path } of entries) {
    const from = join(slot.path, path)
    if (!existsSync(from) || lstatSync(from).isDirectory()) continue
    mkdirSync(dirname(join(dir, 'files', path)), { recursive: true })
    copyFileSync(from, join(dir, 'files', path))
  }
  const g = gitClient(ctx, slot.path)
  writeFileSync(join(dir, 'status.txt'), entries.map((e) => `${e.code} ${e.path}`).join('\n') + '\n')
  writeFileSync(join(dir, 'diff.patch'), g.git(['diff', '--binary', 'HEAD']))
  return dir
}

/** Хуки подготовки из `.agent-cli.json` слота: ссылки и копии из основной копии проекта, команды. */
const runHooks = (ctx, slot, steps, from) => {
  const done = []
  for (const step of steps) {
    if (step.symlinkIfMissing) {
      const target = join(slot.path, step.symlinkIfMissing)
      if (!existsSync(target) && slot.mainCheckout) {
        symlinkSync(join(slot.mainCheckout, step.symlinkIfMissing), target)
        done.push(`ссылка ${step.symlinkIfMissing}`)
      }
    }
    for (const path of step.copyIfMissing ?? []) {
      const source = slot.mainCheckout && join(slot.mainCheckout, path)
      if (!existsSync(join(slot.path, path)) && source && existsSync(source)) {
        mkdirSync(dirname(join(slot.path, path)), { recursive: true })
        copyFileSync(source, join(slot.path, path))
        done.push(`копия ${path}`)
      }
    }
    if (step.run) {
      const changed = !step.ifChanged || ctx.run('git', ['diff', '--quiet', from, '--', ...step.ifChanged], { cwd: slot.path }).status !== 0
      if (!changed) continue
      const [cmd, ...args] = step.run.split(/\s+/)
      mustRun(ctx, cmd, args, { cwd: slot.path, what: step.run })
      done.push(step.run)
    }
  }
  return done
}

export const slotPrepare = (ctx, config, name, opts) => {
  if (!opts.branch) throw new AgentError('Нужен --branch <новая ветка>')
  const from = opts.from ?? 'main'
  const slot = findSlot(ctx, config, name, opts.project)
  if (slot.path === slot.mainCheckout) throw new AgentError('Это основная копия проекта, а не слот — её ветку не переключаю')
  if (slot.sessions.length && !opts.force) {
    throw new AgentError(`В слоте живая сессия (${slot.sessions.map((s) => s.terminal ?? s.pid).join(', ')}) — переключение ветки её сломает`)
  }
  const g = gitClient(ctx, slot.path)
  if (g.raw(['rev-parse', '--verify', '--quiet', `refs/heads/${opts.branch}`]).status === 0) {
    throw new AgentError(`Ветка ${opts.branch} уже есть`)
  }
  const entries = g.status()
  const backup = entries.length ? backupSlot(ctx, slot, entries) : null
  if (backup && !opts.carry) {
    throw new AgentError(
      `Слот грязный (${entries.length} файлов). Копия: ${backup}\nОчистите слот или повторите с --carry, чтобы перенести правки на новую ветку`,
      EXIT.check,
    )
  }
  const switched = g.raw(['switch', '-c', opts.branch, from])
  if (switched.status !== 0) {
    throw new AgentError(`git switch -c ${opts.branch} ${from}: ${switched.stderr.trim()}${backup ? `\nКопия правок: ${backup}` : ''}`)
  }
  const hooks = runHooks(ctx, slot, loadRepoConfig(slot.path).slot?.prepare ?? [], from)
  const base = slotBase(slot.name)
  const busy = base ? busyName(base, opts.task ?? opts.branch) : slot.name
  if (busy !== slot.name) renameSlot(ctx, config, slot.id, busy)
  const data = { slot: busy, path: slot.path, branch: opts.branch, from, carried: entries.length, backup, hooks }
  const text = [`${busy}: ветка ${opts.branch} от ${from}`, backup && `Правки перенесены, копия: ${backup}`, ...hooks.map((h) => `  ${h}`)]
  return { data, text: text.filter(Boolean).join('\n') }
}

const findSlot = (ctx, config, ref, project) => {
  const matches = loadSlots(ctx, config, project).filter((s) => matchesSlot(s, ref))
  if (matches.length !== 1) throw new AgentError(`Слот ${ref} ${matches.length ? 'неоднозначен — добавьте --project' : 'не найден'}`)
  return matches[0]
}

/** Освободить слот: вернуть имя «slot-N». Только без живых сессий и когда ветка влита или задача закрыта. */
export const slotRelease = (ctx, config, ref, opts) => {
  const slot = findSlot(ctx, config, ref, opts.project)
  const base = slotBase(slot.name)
  if (!base) throw new AgentError(`Имя «${slot.name}» без префикса slot-N — освобождать нечего`)
  if (slot.sessions.length) throw new AgentError(`В слоте живая сессия (${slot.sessions.map((s) => s.terminal ?? s.pid).join(', ')})`, EXIT.check)
  const state = releaseState(ctx, slot.path)
  if (!state.releasable && !opts.force) {
    throw new AgentError(`Ветка ${state.branch} не влита и задача не закрыта — освободить: --force`, EXIT.check)
  }
  if (slot.name !== base) renameSlot(ctx, config, slot.id, base)
  return { data: { slot: base, was: slot.name, ...state }, text: slot.name === base ? `${base} уже свободен` : `${slot.name} → ${base}` }
}
