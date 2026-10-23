import { existsSync, lstatSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AgentError } from './context.js'
import { EXIT } from './exit.js'
import { gitClient, loadRepoConfig, requireRepo } from './git.js'
import { matchesAny } from './glob.js'
import { buildPatch, parseDiff, selectHunks } from './hunks.js'
import { readPlan } from './plan.js'

const checkFail = (msg) => new AgentError(msg, EXIT.check)
// Пустое дерево git: база сравнения в репозитории, где ещё нет коммитов
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const headOrNull = (g) => (g.raw(['rev-parse', '--verify', '--quiet', 'HEAD']).status === 0 ? g.head() : null)
const fill = (template, task) => template.replaceAll('{task}', task)
const covers = (listed, file) => file === listed || file.startsWith(`${listed.replace(/\/$/, '')}/`)

export const checkMessage = (message, rules, n) => {
  const subject = message.split('\n')[0]
  if (rules.messagePattern && !new RegExp(rules.messagePattern).test(subject)) {
    throw checkFail(`Коммит ${n}: «${subject}» не подходит под messagePattern ${rules.messagePattern}`)
  }
  if (rules.trailerPattern && !message.split('\n').some((line) => new RegExp(rules.trailerPattern).test(line))) {
    throw checkFail(`Коммит ${n}: нет строки по trailerPattern ${rules.trailerPattern}`)
  }
}

const checkForbidden = (files, rules, n) => {
  const bad = files.filter((file) => matchesAny(file, rules.forbiddenPaths ?? []))
  if (bad.length) throw checkFail(`Коммит ${n}: запрещённые пути (forbiddenPaths): ${bad.join(', ')}`)
}

/** Индексирует коммит плана: пути целиком через `git add --`, ханки — частичным патчем. */
const stageEntry = (g, entry, n) => {
  if (entry.paths.length) g.git(['add', '--', ...entry.paths])
  for (const { path, include } of entry.hunks) {
    const { header, hunks } = parseDiff(g.unstagedPatch(path))
    if (!hunks.length) throw checkFail(`Коммит ${n}: у ${path} нет неиндексированных изменений (новый файл — в paths)`)
    g.git(['apply', '--cached', '-'], { input: buildPatch(header, selectHunks(hunks, include, path)) })
  }
}

/** В индексе ровно заявленное: каждый файл покрыт планом, каждый путь плана что-то дал, ханков — сколько выбрано. */
const verifyStaged = (g, entry, base, rules, n) => {
  const staged = g.staged(base)
  const hunkPaths = entry.hunks.map((h) => h.path)
  const extra = staged.filter((f) => !entry.paths.some((p) => covers(p, f)) && !hunkPaths.includes(f))
  if (extra.length) throw checkFail(`Коммит ${n}: в индексе лишнее: ${extra.join(', ')}`)
  const empty = [...entry.paths, ...hunkPaths].filter((p) => !staged.some((f) => covers(p, f)))
  if (empty.length) throw checkFail(`Коммит ${n}: без изменений: ${empty.join(', ')}`)
  for (const { path, include } of entry.hunks) {
    const all = parseDiff(g.unstagedPatch(path)).hunks.length + parseDiff(g.stagedPatch(base, path)).hunks.length
    const got = parseDiff(g.stagedPatch(base, path)).hunks.length
    const want = Array.isArray(include) && include.every(Number.isInteger) ? include.length : null
    if (want !== null && got !== want) throw checkFail(`Коммит ${n}: ${path} — в индексе ${got} ханков вместо ${want} (всего ${all})`)
  }
  checkForbidden(staged, rules, n)
  return staged
}

/** Сухой прогон на временном индексе: коммиты-объекты через commit-tree, HEAD и рабочий индекс не меняются. */
const simulate = (ctx, root, plan, rules) => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-commit-'))
  try {
    const g = gitClient(ctx, root, join(dir, 'index'))
    let parent = headOrNull(g)
    g.git(parent ? ['read-tree', parent] : ['read-tree', '--empty'])
    const steps = []
    plan.forEach((entry, i) => {
      const n = i + 1
      if (entry.message) {
        stageEntry(g, entry, n)
        const files = verifyStaged(g, entry, parent ?? EMPTY_TREE, rules, n)
        const tree = g.git(['write-tree']).trim()
        const parentArgs = parent ? ['-p', parent] : []
        parent = g.git(['commit-tree', tree, ...parentArgs, '-F', '-'], { input: entry.message }).trim()
        steps.push({ n, kind: 'commit', message: entry.message, files, hunks: entry.hunks })
      }
      if (entry.closeChange) steps.push(closeStep(root, entry.closeChange, rules, n))
    })
    return steps
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const closeStep = (root, task, rules, n) => {
  if (!rules.closeCommand || !(rules.closeMessage || rules.closeMessageFrom)) {
    throw checkFail(`Коммит ${n}: closeChange требует closeCommand и closeMessage или closeMessageFrom в .agent-cli.json`)
  }
  // closeMessageFrom: сообщение печатает сама команда закрытия; до запуска известен только шаблон
  const message = rules.closeMessage ? fill(rules.closeMessage, task) : `(из вывода: ${fill(rules.closeCommand, task)})`
  if (rules.closeMessage) checkMessage(message, { messagePattern: rules.messagePattern }, n)
  const expected = (rules.closeRequires ?? []).map((p) => fill(p, task))
  const warning = expected.length && !expected.some((p) => existsSync(join(root, p))) ? `нет ни одного из: ${expected.join(', ')}` : null
  return { n, kind: 'close', message, command: fill(rules.closeCommand, task), warning }
}

const runClose = (ctx, g, root, step, rules) => {
  const [cmd, ...args] = step.command.split(/\s+/)
  const result = ctx.run(cmd, args, { cwd: root })
  if (result.status !== 0) throw new AgentError(`${step.command}: код ${result.status}\n${(result.stderr || result.stdout).trim()}`)
  const staged = g.staged()
  if (!staged.length) throw checkFail(`${step.command} ничего не проиндексировал`)
  checkForbidden(staged, rules, step.n)
  if (!rules.closeMessageFrom) return { files: staged, message: step.message }
  const message = `${result.stdout}\n${result.stderr}`.match(new RegExp(rules.closeMessageFrom))?.[1]?.trim()
  if (!message) throw checkFail(`В выводе ${step.command} нет сообщения по closeMessageFrom ${rules.closeMessageFrom}`)
  checkMessage(message, { messagePattern: rules.messagePattern }, step.n)
  return { files: staged, message }
}

const commitIndex = (g, message) => {
  g.git(['commit', '-q', '-F', '-'], { input: `${message}\n` })
  return g.head()
}

export const commitCommand = (ctx, cwd, file, { apply }) => {
  const root = requireRepo(ctx, cwd)
  const rules = loadRepoConfig(root).commit ?? {}
  const plan = readPlan(file)
  plan.forEach((entry, i) => entry.message && checkMessage(entry.message, rules, i + 1))
  // Каталог в paths захватил бы и чужие правки (параллельная сессия) — только файлы
  plan.forEach((entry, i) => {
    const dirs = entry.paths.filter((p) => existsSync(join(root, p)) && lstatSync(join(root, p)).isDirectory())
    if (dirs.length) throw checkFail(`Коммит ${i + 1}: в paths — только файлы, а это каталоги: ${dirs.join(', ')}`)
  })
  const real = gitClient(ctx, root)
  const before = real.staged(headOrNull(real) ?? EMPTY_TREE)
  if (before.length) throw checkFail(`В индексе уже есть изменения — уберите их или закоммитьте отдельно:\n${before.join('\n')}`)
  const steps = simulate(ctx, root, plan, rules)
  if (!apply) return { data: { applied: false, steps }, text: formatSteps(steps, false) }

  const done = []
  try {
    for (const [i, entry] of plan.entries()) {
      if (entry.message) {
        const base = headOrNull(real) ?? EMPTY_TREE
        stageEntry(real, entry, i + 1)
        const files = verifyStaged(real, entry, base, rules, i + 1)
        done.push({ n: i + 1, kind: 'commit', message: entry.message, files, sha: commitIndex(real, entry.message) })
      }
      if (entry.closeChange) {
        const step = closeStep(root, entry.closeChange, rules, i + 1)
        const { files, message } = runClose(ctx, real, root, step, rules)
        done.push({ ...step, message, files, sha: commitIndex(real, message) })
      }
    }
  } catch (error) {
    const staged = real.staged()
    const tail = `\nУже закоммичено: ${done.map((d) => d.sha.slice(0, 9)).join(', ') || 'ничего'}` +
      (staged.length ? `\nВ индексе осталось: ${staged.join(', ')}` : '')
    throw new AgentError(`${error.message}${tail}`, error.code ?? EXIT.error)
  }
  return { data: { applied: true, steps: done }, text: formatSteps(done, true) }
}

const formatSteps = (steps, applied) => {
  const out = [applied ? 'Закоммичено (push не выполнялся):' : 'Сухой прогон — индекс и HEAD не тронуты:']
  for (const s of steps) {
    out.push(`${s.n}. ${s.sha ? `${s.sha.slice(0, 9)} ` : ''}${s.message.split('\n')[0]}`)
    if (s.kind === 'close') out.push(`   ← ${s.command}${s.warning ? `\n   ⚠ ${s.warning}` : ''}`)
    for (const f of s.files ?? []) out.push(`   ${f}`)
    for (const h of s.hunks ?? []) out.push(`   ханки ${h.path}: ${JSON.stringify(h.include)}`)
  }
  if (!applied) out.push('Проверки пройдены. Применить: agent commit <план> --apply')
  return out.join('\n')
}

/** Пронумерованные ханки неиндексированных изменений — чтобы написать `include` в плане. */
export const hunksCommand = (ctx, cwd, paths) => {
  const g = gitClient(ctx, requireRepo(ctx, cwd))
  const files = paths.map((path) => ({ path, hunks: parseDiff(g.unstagedPatch(path)).hunks }))
  const text = files
    .map((f) => [`== ${f.path}`, ...(f.hunks.length ? f.hunks.map((h) => `-- ханк ${h.index}\n${h.text}`) : ['(нет изменений)'])].join('\n'))
    .join('\n')
  return { data: files, text }
}
