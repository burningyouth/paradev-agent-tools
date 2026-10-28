import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

/** Временный индекс: коммиты собираются в нём, общий индекс рабочей копии (и чужое в нём) не участвует. */
const withTempIndex = (ctx, root, fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-commit-'))
  try {
    const index = join(dir, 'index')
    return fn(gitClient(ctx, root, index), index, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const readBase = (g, base) => g.git(base ? ['read-tree', base] : ['read-tree', '--empty'])

/** Сухой прогон: коммиты-объекты через commit-tree, HEAD и общий индекс не меняются. */
const simulate = (ctx, root, plan, rules) =>
  withTempIndex(ctx, root, (g) => {
    let parent = headOrNull(g)
    readBase(g, parent)
    const steps = []
    plan.forEach((entry, i) => {
      const n = i + 1
      if (entry.message) {
        stageEntry(g, entry, n)
        const files = verifyStaged(g, entry, parent ?? EMPTY_TREE, rules, n)
        parent = writeCommit(g, parent, entry.message)
        steps.push({ n, kind: 'commit', message: entry.message, files, hunks: entry.hunks })
      }
      if (entry.closeChange) steps.push(closeStep(root, entry.closeChange, rules, n))
    })
    return steps
  })

const writeCommit = (g, parent, message) => {
  const tree = g.git(['write-tree']).trim()
  return g.git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-F', '-'], { input: `${message.replace(/\n+$/, '')}\n` }).trim()
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

/** Команда закрытия индексирует во временный индекс (`GIT_INDEX_FILE`), а не в общий. */
const runClose = (ctx, g, root, index, step, rules) => {
  const [cmd, ...args] = step.command.split(/\s+/)
  const result = ctx.run(cmd, args, { cwd: root, env: { GIT_INDEX_FILE: index } })
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

/**
 * Хуки `pre-commit` и `commit-msg` репозитория — как у `git commit`, но над временным индексом;
 * `commit-msg` может переписать сообщение. `post-commit` — после сдвига ветки.
 */
const hookPath = (g, name) => {
  const path = g.git(['rev-parse', '--git-path', `hooks/${name}`]).trim()
  const full = path.startsWith('/') ? path : join(g.root(), path)
  try {
    return statSync(full).mode & 0o111 ? full : null
  } catch {
    return null
  }
}

const runHook = (ctx, g, root, index, name, args = []) => {
  const path = hookPath(g, name)
  if (!path) return
  const result = ctx.run(path, args, { cwd: root, env: { GIT_INDEX_FILE: index } })
  if (result.status !== 0) throw checkFail(`Хук ${name} отказал (код ${result.status})\n${(result.stderr || result.stdout).trim()}`)
}

const hookedMessage = (ctx, g, root, index, dir, message) => {
  runHook(ctx, g, root, index, 'pre-commit')
  if (!hookPath(g, 'commit-msg')) return message
  const file = join(dir, 'COMMIT_EDITMSG')
  writeFileSync(file, `${message.replace(/\n+$/, '')}\n`)
  runHook(ctx, g, root, index, 'commit-msg', [file])
  return readFileSync(file, 'utf8')
}

const ZERO = '0'.repeat(40)
const MOVE_ATTEMPTS = 3

/**
 * Применение: каждый коммит собирается во временном индексе от текущего HEAD, ветка сдвигается
 * сверкой `update-ref HEAD <новый> <ожидаемый>` — коммит другой сессии в ту же секунду не затирается:
 * коммит пересобирается на новом HEAD. В общем индексе обновляются только закоммиченные пути, чужое
 * staged остаётся staged.
 */
const applyPlan = (ctx, root, plan, rules) =>
  withTempIndex(ctx, root, (g, index, dir) => {
    const real = gitClient(ctx, root)
    const done = []
    const commitStep = (n, build) => {
      for (let attempt = 1; ; attempt += 1) {
        const base = headOrNull(real)
        readBase(g, base)
        const { files, message } = build(base, attempt)
        const finalMessage = hookedMessage(ctx, g, root, index, dir, message)
        const sha = writeCommit(g, base, finalMessage)
        const moved = real.raw(['update-ref', '-m', `commit: ${finalMessage.split('\n')[0]}`, 'HEAD', sha, base ?? ZERO])
        if (moved.status === 0) {
          real.git(['reset', '-q', '--', ...files])
          runHook(ctx, g, root, index, 'post-commit')
          return { files, message: finalMessage.replace(/\n+$/, ''), sha }
        }
        if (attempt === MOVE_ATTEMPTS) throw checkFail(`Коммит ${n}: HEAD сдвигается другой сессией, коммит не сделан\n${moved.stderr.trim()}`)
      }
    }
    try {
      for (const [i, entry] of plan.entries()) {
        const n = i + 1
        if (entry.message) {
          const result = commitStep(n, (base) => {
            stageEntry(g, entry, n)
            return { files: verifyStaged(g, entry, base ?? EMPTY_TREE, rules, n), message: entry.message }
          })
          done.push({ n, kind: 'commit', ...result })
        }
        if (entry.closeChange) {
          const step = closeStep(root, entry.closeChange, rules, n)
          let closed
          // Команда закрытия правит рабочую копию один раз; при пересборке её пути индексируются заново
          const result = commitStep(n, (base, attempt) => {
            if (attempt === 1) closed = runClose(ctx, g, root, index, step, rules)
            else g.git(['add', '-A', '--', ...closed.files])
            return closed
          })
          done.push({ ...step, ...result })
        }
      }
    } catch (error) {
      const tail = `\nУже закоммичено: ${done.map((d) => d.sha.slice(0, 9)).join(', ') || 'ничего'}`
      throw new AgentError(`${error.message}${tail}`, error.code ?? EXIT.error)
    }
    return done
  })

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
  // Чужое в общем индексе не мешает; мешает только staged-версия файла плана: какая из версий — своя, неясно
  const real = gitClient(ctx, root)
  const planned = plan.flatMap((entry) => [...entry.paths, ...entry.hunks.map((h) => h.path)])
  const clash = real.staged(headOrNull(real) ?? EMPTY_TREE).filter((f) => planned.some((p) => covers(p, f)))
  if (clash.length) throw checkFail(`Файлы плана уже в индексе — уберите их оттуда (git restore --staged -- <путь>):\n${clash.join('\n')}`)
  const steps = simulate(ctx, root, plan, rules)
  if (!apply) return { data: { applied: false, steps }, text: formatSteps(steps, false) }
  const done = applyPlan(ctx, root, plan, rules)
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
