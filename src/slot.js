import { copyFileSync, existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { AgentError, mustRun } from './context.js'
import { canonicalPath, resolveCurrentWorkspace } from './current.js'
import { EXIT } from './exit.js'
import { gitClient } from './git.js'
import { formatSync, localEntries, syncLocalFiles } from './local-files.js'
import { listSessions } from './sessions.js'
import { prepareSteps, runSteps } from './slot-steps.js'
import { busyName, isMerged, mainBranchOf, matchesSlot, projectRules, releaseState, renameSlot, slotBase } from './slot-names.js'
import { stamp } from './store.js'
import { advanceSlotGeneration, withSlotLock } from './slot-lock.js'
import { superset } from './superset.js'
import { nativeSlotProcesses } from './procs.js'

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

const slotGitState = (ctx, slot, rules) => {
  const g = gitClient(ctx, slot.path)
  const mainBranch = mainBranchOf(g, rules)
  const branch = g.branch() || '(detached)'
  const dirty = g.status().length
  const merged = branch === mainBranch || branch === '(detached)' ? null : isMerged(g, rules, mainBranch)
  return { branch, dirty, merged }
}

export const slotLs = (ctx, config, opts) => {
  const rows = loadSlots(ctx, config, opts.project).map((slot) => {
    if (!slot.exists) return { ...slot, sessions: slot.sessions.length, branch: null, dirty: null, merged: null }
    return { ...slot, ...slotGitState(ctx, slot, projectRules(slot)), sessions: slot.sessions.length }
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

/** Локальные файлы слота по правилам проекта; null — список пуст или нет основной копии. */
const syncSlotFiles = (ctx, slot, rules, steps, apply) =>
  syncLocalFiles(ctx, { slotPath: slot.path, mainPath: slot.mainCheckout, slotName: slot.name, entries: localEntries(rules), steps, apply })

/** Команда проекта из `.agent-cli.json` (`slot.take` / `slot.release`) с подстановкой {branch} и {base}. */
const fillCommand = (template, values) => template.replace(/\{(branch|base)\}/g, (_, key) => values[key] ?? '')

/** Запуск в слоте; в ответ — строки-итоги команды (✅/⚠️), иначе последние строки вывода. */
const runSlotCommand = (ctx, slot, command) => {
  const [cmd, ...args] = command.split(/\s+/).filter(Boolean)
  const lines = mustRun(ctx, cmd, args, { cwd: slot.path, what: command }).split('\n').filter(Boolean)
  const summary = lines.filter((line) => /^(✅|⚠️)/.test(line))
  return summary.length ? summary : lines.slice(-10)
}

/** Проверяем результат и проектной, и встроенной подготовки до отметки слота готовым. */
const assertPreparedBranch = (g, branch, { start, existing, remoteHead }) => {
  if (g.branch() !== branch) throw new AgentError(`Подготовка не переключила слот на ветку ${branch}`, EXIT.check)
  const required = existing ? remoteHead : start
  if (required && g.raw(['merge-base', '--is-ancestor', required.sha, 'HEAD']).status !== 0) {
    throw new AgentError(`Ветка ${branch} не содержит актуальный ${required.ref} ${required.sha.slice(0, 9)} — слот не готов; результат подготовки сохранён`, EXIT.check)
  }
}

/** `slot prepare` через команду проекта: общий fetch до запуска и проверка результата до переименования. */
const takeByCommand = (ctx, config, slot, rules, opts, assignment) => {
  const { start, existing } = assignment
  const command = fillCommand(rules.slot.take, opts)
  const baseData = { existing, from: start.ref, base: start.sha, fetched: !opts.offline }
  if (opts['dry-run']) {
    const files = syncSlotFiles(ctx, slot, rules, ['back', 'forward'], false)
    const data = { dryRun: true, slot: slot.name, path: slot.path, branch: opts.branch, ...baseData, command, localFiles: files }
    return { data, text: [`Сухой прогон: ${slot.name} → ${command}`, ...formatSync(files)].join('\n') }
  }
  const files = syncSlotFiles(ctx, slot, rules, ['back', 'forward'], true)
  const output = runSlotCommand(ctx, slot, command)
  assertPreparedBranch(gitClient(ctx, slot.path), opts.branch, assignment)
  const slotBaseName = slotBase(slot.name)
  const busy = slotBaseName ? busyName(slotBaseName, opts.task ?? opts.branch) : slot.name
  if (busy !== slot.name) renameSlot(ctx, config, slot.id, busy)
  const data = { slot: busy, path: slot.path, branch: opts.branch, ...baseData, command, output, localFiles: files }
  return { data, text: [`${busy}: ${command}`, ...output.map((line) => `  ${line}`), ...formatSync(files)].join('\n') }
}

/**
 * Обновляем все remote-ветки атомарно и удаляем устаревшие tracking refs, чтобы отсутствующая ветка
 * задачи не воскресла из кеша. Рабочую копию основной копии fetch не трогает. Базу закрепляем по SHA.
 * Упал fetch или ветки нет — ошибка, а не старая база;
 * `--offline` — явно от уже имеющегося `<remote>/<base>`.
 */
export const freshBase = (g, remote, base, offline) => {
  const ref = `refs/remotes/${remote}/${base}`
  if (!offline) {
    const fetched = g.raw(['fetch', '--quiet', '--atomic', '--prune', remote, `+refs/heads/*:refs/remotes/${remote}/*`])
    if (fetched.status !== 0) {
      throw new AgentError(
        `git fetch ${remote} не прошёл — от старой базы ${remote}/${base} не ответвляю:\n${fetched.stderr.trim()}\nБез сети: --offline (ветка от текущего ${remote}/${base})`,
      )
    }
  }
  const sha = g.raw(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  if (sha.status !== 0) throw new AgentError(`Нет ${remote}/${base}${offline ? ' — с --offline нужна уже полученная ветка' : ''}`)
  return { ref: `${remote}/${base}`, sha: sha.stdout.trim() }
}

export const slotPrepare = (ctx, config, name, opts) => {
  const slot = findSlot(ctx, config, name, opts.project)
  return withSlotLock(ctx, slot, () => {
    if (opts.expectedFree) {
      const current = findSlot(ctx, config, slot.id, opts.project)
      if (current.name !== slotBase(current.name) || current.sessions.length || nativeSlotProcesses(ctx, current).length) {
        throw new AgentError('Слот уже заняли — обновите список слотов', EXIT.check)
      }
    }
    if (!opts['dry-run']) advanceSlotGeneration(ctx, slot)
    return prepareLocked(ctx, config, name, opts)
  })
}

const prepareLocked = (ctx, config, name, opts) => {
  if (!opts.branch) throw new AgentError('Нужен --branch <ветка задачи>')
  const dry = Boolean(opts['dry-run'])
  const slot = findSlot(ctx, config, name, opts.project)
  if (slot.mainCheckout && canonicalPath(slot.path) === canonicalPath(slot.mainCheckout)) throw new AgentError('Это основная копия проекта, а не слот — её ветку не переключаю')
  if (slot.sessions.length && !opts.force) {
    throw new AgentError(`В слоте живая сессия (${slot.sessions.map((s) => s.terminal ?? s.pid).join(', ')}) — переключение ветки её сломает`)
  }
  const rules = projectRules(slot)
  const g = gitClient(ctx, slot.path)
  const remote = rules.slot?.remote ?? 'origin'
  const base = (opts.from ?? mainBranchOf(g, rules)).replace(new RegExp(`^${remote}/`), '')
  if (opts.branch === base) throw new AgentError(`${base} — база, а не ветка задачи`)
  const start = freshBase(g, remote, base, Boolean(opts.offline))
  const has = (ref) => g.raw(['rev-parse', '--verify', '--quiet', ref]).status === 0
  const remoteRef = `refs/remotes/${remote}/${opts.branch}`
  const remoteBranch = has(remoteRef)
  const existing = has(`refs/heads/${opts.branch}`) || remoteBranch
  const remoteHead = remoteBranch ? { ref: `${remote}/${opts.branch}`, sha: g.git(['rev-parse', `${remoteRef}^{commit}`]).trim() } : null
  const assignment = { start, existing, remoteHead }
  if (rules.slot?.take) return takeByCommand(ctx, config, slot, rules, { ...opts, base }, assignment)
  const state = releaseState(ctx, slot.path, rules)
  // Имя «slot-N» возвращается без слияния — ветка слота может быть не влита: не уводим слот с неё молча
  if (state.branch !== state.mainBranch && !state.merged && !opts['allow-unmerged']) {
    throw new AgentError(`Ветка слота ${state.branch} не влита в ${state.mainBranch} — влейте её или повторите с --allow-unmerged`, EXIT.check)
  }
  const entries = g.status()
  if (entries.length && !opts.carry && dry) {
    throw new AgentError(`Слот грязный (${entries.length} файлов) — prepare сделает бэкап и остановится; перенести правки: --carry`, EXIT.check)
  }
  const backup = entries.length && !dry ? backupSlot(ctx, slot, entries) : null
  if (backup && !opts.carry) {
    throw new AgentError(
      `Слот грязный (${entries.length} файлов). Копия: ${backup}\nОчистите слот или повторите с --carry, чтобы перенести правки на новую ветку`,
      EXIT.check,
    )
  }
  const steps = prepareSteps(ctx, slot, rules)
  const baseLine = existing
    ? 'существующая'
    : `${opts.offline ? 'без fetch (--offline), ' : ''}от ${start.ref} ${start.sha.slice(0, 9)}`
  if (dry) {
    const files = syncSlotFiles(ctx, slot, rules, ['back', 'forward'], false)
    const data = { dryRun: true, slot: slot.name, path: slot.path, branch: opts.branch, existing, from: start.ref, base: start.sha, fetched: !opts.offline, carry: entries.length, hooks: steps, localFiles: files }
    const text = [`Сухой прогон: ${slot.name} → ветка ${opts.branch} ${baseLine}`, entries.length && `  перенесу правки: ${entries.length} файлов`, steps.length && `  хуки: ${steps.length}`, ...formatSync(files)]
    return { data, text: text.filter(Boolean).join('\n') }
  }
  // Сначала забрать из слота наработки прошлой задачи, потом раздать слоту актуальное из основной копии
  const files = syncSlotFiles(ctx, slot, rules, ['back', 'forward'], true)
  const previous = g.head()
  const switchArgs = existing ? ['switch', opts.branch] : ['switch', '--no-track', '-c', opts.branch, start.sha]
  const switched = g.raw(switchArgs)
  if (switched.status !== 0) {
    throw new AgentError(`git ${switchArgs.join(' ')}: ${switched.stderr.trim()}${backup ? `\nКопия правок: ${backup}` : ''}`)
  }
  if (existing && remoteHead) g.git(['merge', '--ff-only', '--quiet', remoteHead.sha])
  const hooks = runSteps(ctx, slot, steps, previous)
  assertPreparedBranch(g, opts.branch, assignment)
  const behind = Number(g.git(['rev-list', '--count', `HEAD..${start.sha}`]).trim())
  if (behind) hooks.push(`позади ${start.ref} на ${behind}: merge — по решению человека`)
  const slotBaseName = slotBase(slot.name)
  const busy = slotBaseName ? busyName(slotBaseName, opts.task ?? opts.branch) : slot.name
  if (busy !== slot.name) renameSlot(ctx, config, slot.id, busy)
  const data = { slot: busy, path: slot.path, branch: opts.branch, existing, from: start.ref, base: start.sha, fetched: !opts.offline, carried: entries.length, backup, hooks, localFiles: files }
  const text = [`${busy}: ветка ${opts.branch} ${baseLine}`, backup && `Правки перенесены, копия: ${backup}`, ...hooks.map((h) => `  ${h}`), ...formatSync(files)]
  return { data, text: text.filter(Boolean).join('\n') }
}

export const findSlot = (ctx, config, ref, project) => {
  const matches = loadSlots(ctx, config, project).filter((s) => matchesSlot(s, ref))
  if (matches.length !== 1) throw new AgentError(`Слот ${ref} ${matches.length ? 'неоднозначен — добавьте --project' : 'не найден'}`)
  return matches[0]
}

/** Без имени нужен именно текущий слот; основную копию и чужой --project не подставляем. */
export const findCurrentSlot = (ctx, config, project) => {
  const slots = loadSlots(ctx, config).map((slot) => ({ ...slot, worktreePath: slot.path }))
  let slot
  try { slot = resolveCurrentWorkspace(ctx, slots) } catch (error) {
    if (!(error instanceof AgentError)) throw error
    throw new AgentError(`${error.message} — укажите слот явно`, error.code)
  }
  if (project && slot.project !== project) throw new AgentError(`Текущий workspace принадлежит проекту ${slot.project}, а не ${project}`)
  if (slot.mainCheckout && canonicalPath(slot.path) === canonicalPath(slot.mainCheckout)) {
    throw new AgentError('Это основная копия проекта, а не слот')
  }
  if (!slotBase(slot.name)) throw new AgentError(`Текущий workspace «${slot.name}» не является слотом slot-N`)
  if (!slot.exists) throw new AgentError(`Рабочая копия текущего слота ${slot.name} отсутствует: ${slot.path}`)
  return slot
}

/**
 * Освободить слот: без живых сессий; команда проекта `slot.release` или встроенное — чистая копия без ветки на
 * свежем `origin/<база>` (ветка задачи остаётся и доступна другому слоту). Затем локальные файлы → основная
 * копия и имя «slot-N».
 */
export const slotRelease = (ctx, config, ref, opts = {}) => {
  const slot = ref ? findSlot(ctx, config, ref, opts.project) : findCurrentSlot(ctx, config, opts.project)
  return withSlotLock(ctx, slot, () => {
    advanceSlotGeneration(ctx, slot)
    return releaseSlotLocked(ctx, config, slot.id, opts)
  })
}

/** Internal: caller must hold withSlotLock for this worktree. */
export const releaseSlotLocked = (ctx, config, ref, opts = {}) => {
  const slot = findSlot(ctx, config, ref, opts.project)
  const base = slotBase(slot.name)
  if (!base) throw new AgentError(`Имя «${slot.name}» без префикса slot-N — освобождать нечего`)
  if (slot.mainCheckout && canonicalPath(slot.path) === canonicalPath(slot.mainCheckout)) throw new AgentError('Это основная копия проекта, а не слот')
  if (slot.sessions.length) throw new AgentError(`В слоте живая сессия (${slot.sessions.map((s) => s.terminal ?? s.pid).join(', ')})`, EXIT.check)
  const rules = projectRules(slot)
  const g = gitClient(ctx, slot.path)
  const remote = rules.slot?.remote ?? 'origin'
  const baseBranch = (opts.from ?? mainBranchOf(g, rules)).replace(new RegExp(`^${remote}/`), '')
  const branch = g.branch() || null
  const notes = []
  if (opts.finishDetached && !branch) notes.push('Git уже без ветки; повторный release пропущен')
  else if (rules.slot?.release) notes.push(...runSlotCommand(ctx, slot, fillCommand(rules.slot.release, { branch, base: baseBranch })))
  else {
    const dirty = g.status().length
    if (dirty) throw new AgentError(`Слот грязный (${dirty} файлов) — закоммитьте или уберите правки`, EXIT.check)
    const start = freshBase(g, remote, baseBranch, Boolean(opts.offline))
    const unpushed = Number(g.git(['rev-list', '--count', 'HEAD', '--not', '--remotes']).trim())
    if (unpushed && branch) notes.push(`не запушено коммитов: ${unpushed} — остаются в ветке ${branch}`)
    g.git(['switch', '--quiet', '--detach', start.ref])
    notes.push(`без ветки на ${start.ref}`)
  }
  const files = syncSlotFiles(ctx, slot, rules, ['back'], true)
  if (slot.name !== base) renameSlot(ctx, config, slot.id, base)
  const text = [slot.name === base ? `${base} свободен` : `${slot.name} → ${base}`, ...notes.map((n) => `  ${n}`), ...formatSync(files)]
  return { data: { slot: base, was: slot.name, branch, notes, localFiles: files }, text: text.join('\n') }
}

/** The shared completion contract: success means verified Git AND Superset release. Lock required. */
export const completeSlotLocked = (ctx, config, slot, opts = {}) => {
  const g = gitClient(ctx, slot.path)
  const owner = { path: canonicalPath(slot.path), main: canonicalPath(slot.mainCheckout), project: slot.project,
    gitDir: canonicalPath(g.git(['rev-parse', '--absolute-git-dir']).trim()), branch: g.branch(), head: g.head() }
  const result = releaseSlotLocked(ctx, config, slot.id, { ...opts, finishDetached: true })
  const after = findSlot(ctx, config, slot.id)
  if (canonicalPath(after.path) !== owner.path || canonicalPath(after.mainCheckout) !== owner.main || after.project !== owner.project ||
      canonicalPath(g.git(['rev-parse', '--absolute-git-dir']).trim()) !== owner.gitDir || after.name !== slotBase(slot.name) ||
      after.sessions.length || nativeSlotProcesses(ctx, after).length || g.branch() || g.status().length ||
      owner.branch && g.git(['rev-parse', `refs/heads/${owner.branch}`]).trim() !== owner.head) {
    throw new AgentError('Release вернулся, но Git/Superset postconditions не выполнены', 9)
  }
  if (result.data.localFiles?.error || result.data.localFiles?.conflicts?.length) throw new AgentError('Слот освобождён, но перенос локальных файлов требует разбора', 9)
  return { result: result.data, verified: { name: after.name, head: g.head(), detached: true, clean: true, sessions: 0 } }
}

/** `slot sync-back` (только слот → основная копия) и `slot sync` (туда и обратно); без --apply — сухой прогон. */
export const slotSync = (ctx, config, ref, opts, steps) => {
  const slot = ref ? findSlot(ctx, config, ref, opts.project) : findCurrentSlot(ctx, config, opts.project)
  if (slot.mainCheckout && canonicalPath(slot.path) === canonicalPath(slot.mainCheckout)) throw new AgentError('Это основная копия проекта, а не слот')
  const rules = projectRules(slot)
  if (!localEntries(rules).length) throw new AgentError('В .agent-cli.json проекта нет slot.localFiles — переносить нечего')
  const files = syncSlotFiles(ctx, slot, rules, steps, Boolean(opts.apply))
  const text = [...formatSync(files, { indent: '' }), !opts.apply && 'Применить: --apply']
  return { data: files, text: text.filter(Boolean).join('\n'), code: files.conflicts.length ? EXIT.check : undefined }
}
