import assert from 'node:assert/strict'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { EXIT } from '../src/exit.js'
import { slotLs, slotPrepare, slotRelease, slotSync } from '../src/slot.js'
import { loadConfig } from '../src/store.js'
import { fakeContext, git, makeRepo, tempDir, writeFiles } from './helpers.js'

const PREPARE = {
  slot: {
    prepare: [{ symlinkIfMissing: 'node_modules' }, { copyIfMissing: ['.env.local', 'config/dev.json', '.env.absent'] }, { run: 'touch generated.txt', ifChanged: ['schema/'] }],
  },
}

/** Основная копия проекта и слот-worktree; superset знает про оба, живых сессий нет (ps пуст). */
const setup = ({ config = PREPARE, files = {}, handlers = {} } = {}) => {
  const main = makeRepo({ ...(config ? { '.agent-cli.json': JSON.stringify(config) } : {}), ...files, '.gitignore': 'node_modules\n.env.*\nconfig/dev.json\ngenerated.txt\n', 'schema/s.txt': '1\n', 'a.txt': 'a\n' })
  mkdirSync(join(main, 'node_modules'))
  writeFileSync(join(main, '.env.local'), 'X=1\n')
  mkdirSync(join(main, 'config'))
  writeFileSync(join(main, 'config/dev.json'), '{}')
  // origin — локальный bare-репозиторий: fetch без сети
  const origin = join(tempDir('origin-'), 'origin.git')
  git(main, 'init', '-q', '--bare', origin)
  git(main, 'remote', 'add', 'origin', origin)
  git(main, 'push', '-q', 'origin', 'main')
  const slot = join(tempDir('slots-'), 'slot-1')
  git(main, 'worktree', 'add', '-q', '-b', 'old-task', slot)
  const workspaces = [
    { id: 'w-main', name: 'proj main', projectName: 'proj', worktreePath: main },
    { id: 'w-1', name: 'slot-1 · old-task', projectName: 'proj', worktreePath: slot },
  ]
  const ctx = fakeContext({
    ...handlers,
    ps: () => '',
    touch: (args, { cwd }) => (writeFileSync(join(cwd, args[0]), ''), ''),
    superset: (args) => {
      if (args[0] === 'sessions' && args[1] === 'list') return '[]'
      if (args[0] === 'ws' && args[1] === 'update') {
        workspaces.find((w) => w.id === args[2]).name = args[args.indexOf('--name') + 1]
        return ''
      }
      if (args[0] === 'ws') return JSON.stringify(workspaces)
      if (args[0] === 'projects') return JSON.stringify([{ name: 'proj', path: main }])
      if (args[0] === 'snapshot') return JSON.stringify({ workspaces: [] })
      throw new Error(args.join(' '))
    },
  })
  return { ctx, config: loadConfig(ctx), main, slot, origin, workspaces }
}

test('ls shows branch, dirtiness and whether the branch is merged into main', () => {
  const { ctx, config, slot } = setup()
  writeFileSync(join(slot, 'a.txt'), 'changed\n')
  const { data } = slotLs(ctx, config, {})
  const row = data.find((r) => r.name === 'slot-1 · old-task')
  assert.equal(row.branch, 'old-task')
  assert.equal(row.dirty, 1)
  assert.equal(row.merged, true)
  assert.equal(row.sessions, 0)
  assert.equal(data.find((r) => r.name === 'proj main').merged, null)
})

test('prepare of a dirty slot backs up changes and stops; --carry moves them to the new branch', () => {
  const { ctx, config, slot } = setup()
  writeFileSync(join(slot, 'a.txt'), 'changed\n')
  writeFileSync(join(slot, 'new.txt'), 'new\n')
  assert.throws(() => slotPrepare(ctx, config, 'slot-1', { branch: 'next' }), (e) => e.code === EXIT.check && /Копия: /.test(e.message))
  const backups = readdirSync(join(ctx.agentHome, 'backups'))
  assert.equal(backups.length, 1)
  const backup = join(ctx.agentHome, 'backups', backups[0])
  assert.equal(readFileSync(join(backup, 'files/new.txt'), 'utf8'), 'new\n')
  assert.match(readFileSync(join(backup, 'diff.patch'), 'utf8'), /\+changed/)
  assert.equal(git(slot, 'branch', '--show-current'), 'old-task')

  ctx.advance(1000)
  const { data } = slotPrepare(ctx, config, 'slot-1', { branch: 'next', carry: true })
  assert.equal(git(slot, 'branch', '--show-current'), 'next')
  assert.equal(readFileSync(join(slot, 'a.txt'), 'utf8'), 'changed\n')
  assert.equal(data.carried, 2)
})

test('prepare of a clean slot branches from main and runs the hooks', () => {
  const { ctx, config, slot, main } = setup()
  const { data } = slotPrepare(ctx, config, 'slot-1', { branch: 'feature' })
  assert.equal(git(slot, 'branch', '--show-current'), 'feature')
  assert.equal(git(slot, 'rev-parse', 'HEAD'), git(main, 'rev-parse', 'main'))
  assert.ok(lstatSync(join(slot, 'node_modules')).isSymbolicLink())
  assert.equal(readFileSync(join(slot, '.env.local'), 'utf8'), 'X=1\n')
  assert.ok(existsSync(join(slot, 'config/dev.json')))
  assert.ok(!existsSync(join(slot, 'generated.txt')), 'schema не менялась — генерация не нужна')
  assert.deepEqual(data.hooks, ['ссылка node_modules', 'копия .env.local', 'копия config/dev.json'])
})

test('prepare refuses the main checkout, the base branch and a missing --branch', () => {
  const { ctx, config } = setup()
  assert.throws(() => slotPrepare(ctx, config, 'proj main', { branch: 'x' }), /основная копия/)
  assert.throws(() => slotPrepare(ctx, config, 'slot-1', { branch: 'main' }), /база/)
  assert.throws(() => slotPrepare(ctx, config, 'slot-1', {}), /--branch/)
})

test('release: slot without a branch on fresh origin/main, «slot-N» back, the branch is kept for another slot', () => {
  const { ctx, config, slot, workspaces } = setup()
  const ws = workspaces.find((w) => w.id === 'w-1')
  slotPrepare(ctx, config, 'slot-1', { branch: 'feature', task: 'store-delivery' })
  assert.equal(ws.name, 'slot-1 · store-delivery')
  writeFileSync(join(slot, 'f.txt'), 'f\n')
  assert.throws(() => slotRelease(ctx, config, 'slot-1', {}), (e) => e.code === EXIT.check && /грязный/.test(e.message))
  git(slot, 'add', 'f.txt')
  git(slot, 'commit', '-qm', 'feat: f')
  const { data } = slotRelease(ctx, config, 'slot-1 · store-delivery', {})
  assert.equal(ws.name, 'slot-1')
  assert.equal(data.branch, 'feature')
  assert.ok(data.notes.some((n) => /не запушено коммитов: 1/.test(n)))
  assert.equal(git(slot, 'branch', '--show-current'), '')
  assert.equal(git(slot, 'rev-parse', 'HEAD'), git(slot, 'rev-parse', 'origin/main'))

  // Правки по ревью: та же ветка снова в слоте, с её коммитом
  const again = slotPrepare(ctx, config, 'slot-1', { branch: 'feature' })
  assert.equal(again.data.existing, true)
  assert.equal(git(slot, 'branch', '--show-current'), 'feature')
  assert.ok(existsSync(join(slot, 'f.txt')))
})

test('release without a slot resolves a cwd subdirectory or Superset workspace and keeps the task branch', () => {
  for (const byEnv of [false, true]) {
    const { ctx, config, slot, main } = setup()
    ctx.cwd = byEnv ? main : join(slot, 'schema')
    if (byEnv) ctx.env.SUPERSET_WORKSPACE_ID = 'w-1'
    const { data } = slotRelease(ctx, config)
    assert.equal(data.branch, 'old-task')
    assert.equal(git(slot, 'branch', '--show-current'), '')
    assert.equal(git(slot, 'rev-parse', 'HEAD'), git(slot, 'rev-parse', 'origin/main'))
    assert.ok(git(main, 'branch', '--list', 'old-task').includes('old-task'))
  }
})

test('implicit release refuses dirty slots and live chat before fetch, branch switches or renames', () => {
  for (const reason of ['dirty', 'live']) {
    const { ctx, config, slot } = setup()
    ctx.cwd = slot
    if (reason === 'dirty') writeFileSync(join(slot, 'a.txt'), 'dirty\n')
    else {
      const run = ctx.run
      ctx.run = (cmd, args, opts) => args[0] === 'sessions' && args[1] === 'list' && args.includes('w-1')
        ? { status: 0, stdout: JSON.stringify([{ harness: 'codex-acp', sessionId: 'live', live: true, status: 'idle' }]) }
        : run(cmd, args, opts)
    }
    assert.throws(() => slotRelease(ctx, config), (e) => e.code === EXIT.check && /грязный|живая сессия/.test(e.message))
    assert.equal(git(slot, 'branch', '--show-current'), 'old-task')
    assert.ok(!ctx.calls.some((c) => c.args[0] === 'fetch' || c.args[0] === 'switch' || c.args[1] === 'update'))
  }
})

test('implicit slot commands refuse main, missing or ambiguous context and a mismatched project', () => {
  for (const reason of ['main', 'stale', 'unknown', 'sibling', 'ambiguous', 'project']) {
    const { ctx, config, slot, main, workspaces } = setup()
    ctx.cwd = slot
    if (reason === 'main') ctx.cwd = main
    if (reason === 'stale') ctx.env.SUPERSET_WORKSPACE_ID = 'missing'
    if (reason === 'unknown') ctx.cwd = '/unknown'
    if (reason === 'sibling') ctx.cwd = `${slot}-other`
    if (reason === 'ambiguous') workspaces.push({ ...workspaces[1], id: 'duplicate' })
    const opts = reason === 'project' ? { project: 'other-project' } : {}
    assert.throws(() => slotRelease(ctx, config, undefined, opts), /основная копия|не найден|Не удалось|неоднозначен|а не other-project/)
    assert.throws(() => slotSync(ctx, config, undefined, opts, ['back']), /основная копия|не найден|Не удалось|неоднозначен|а не other-project/)
    assert.equal(git(slot, 'branch', '--show-current'), 'old-task')
    assert.ok(!ctx.calls.some((c) => c.args[0] === 'fetch' || c.args[0] === 'switch' || c.args[1] === 'update'))
  }
})

test('prepare refuses to leave an unmerged branch even when the slot is free by name', () => {
  const { ctx, config, slot } = setup()
  writeFileSync(join(slot, 'w.txt'), 'w\n')
  git(slot, 'add', 'w.txt')
  git(slot, 'commit', '-qm', 'feat(old-task): не влито')
  assert.throws(() => slotPrepare(ctx, config, 'slot-1', { branch: 'next' }), (e) => e.code === EXIT.check && /не влита в main.*--allow-unmerged/.test(e.message))
  assert.equal(git(slot, 'branch', '--show-current'), 'old-task')
  slotPrepare(ctx, config, 'slot-1', { branch: 'next', 'allow-unmerged': true })
  assert.equal(git(slot, 'branch', '--show-current'), 'next')
})

/** Ещё один клон origin: «коллега» двигает main или заводит ветку. */
const pushFromClone = (origin, branch, file) => {
  const clone = join(tempDir('clone-'), 'c')
  git(origin, 'clone', '-q', '-b', 'main', origin, clone)
  if (branch !== 'main') git(clone, 'switch', '-q', '-c', branch)
  writeFileSync(join(clone, file), `${file}\n`)
  git(clone, 'add', file)
  git(clone, 'commit', '-qm', `feat: ${file}`)
  git(clone, 'push', '-q', 'origin', branch)
  return git(clone, 'rev-parse', 'HEAD')
}

test('prepare fetches origin and branches from fresh origin/<base>; the main checkout is left alone', () => {
  const { ctx, config, slot, main, origin } = setup()
  const fresh = pushFromClone(origin, 'main', 'fresh.txt')
  writeFileSync(join(main, 'a.txt'), 'local edit\n')
  const mainHead = git(main, 'rev-parse', 'HEAD')
  const { data, text } = slotPrepare(ctx, config, 'slot-1', { branch: 'feature' })
  assert.equal(git(slot, 'rev-parse', 'HEAD'), fresh)
  assert.equal(data.from, 'origin/main')
  assert.equal(data.base, fresh)
  assert.match(text, /от origin\/main/)
  assert.equal(git(main, 'rev-parse', 'HEAD'), mainHead, 'основная копия не переключалась')
  assert.equal(readFileSync(join(main, 'a.txt'), 'utf8'), 'local edit\n', 'правки основной копии целы')
})

test('prepare --from takes another base branch (also as origin/<base>); slot.mainBranch sets the default', () => {
  const { ctx, config, slot, main, origin } = setup()
  const release = pushFromClone(origin, 'release-1', 'r.txt')
  slotPrepare(ctx, config, 'slot-1', { branch: 'hotfix', from: 'release-1' })
  assert.equal(git(slot, 'rev-parse', 'HEAD'), release)
  git(slot, 'switch', '-q', '--detach', 'main')
  slotPrepare(ctx, config, 'slot-1', { branch: 'hotfix-2', from: 'origin/release-1', 'allow-unmerged': true })
  assert.equal(git(slot, 'rev-parse', 'HEAD'), release)

  writeFileSync(join(main, '.agent-cli.json'), JSON.stringify({ slot: { mainBranch: 'release-1' } }))
  git(slot, 'switch', '-q', '--detach', 'main')
  const { data } = slotPrepare(ctx, config, 'slot-1', { branch: 'hotfix-3', 'allow-unmerged': true })
  assert.equal(data.from, 'origin/release-1')
})

test('prepare fails loudly when fetch fails or the base is missing; --offline uses the fetched origin/<base> explicitly', () => {
  const { ctx, config, slot, main } = setup()
  assert.throws(() => slotPrepare(ctx, config, 'slot-1', { branch: 'x', from: 'nope' }), (e) => e.code === EXIT.error && /Нет origin\/nope/.test(e.message))
  git(main, 'remote', 'set-url', 'origin', join(tempDir(), 'gone.git'))
  assert.throws(() => slotPrepare(ctx, config, 'slot-1', { branch: 'x' }), (e) => e.code === EXIT.error && /не прошёл.*--offline/s.test(e.message))
  assert.equal(git(slot, 'branch', '--show-current'), 'old-task', 'от старой базы молча не ответвились')
  assert.throws(() => slotPrepare(ctx, config, 'slot-1', { branch: 'x', from: 'nope', offline: true }), /Нет origin\/nope/)
  const { data, text } = slotPrepare(ctx, config, 'slot-1', { branch: 'x', offline: true })
  assert.equal(data.fetched, false)
  assert.match(text, /без fetch \(--offline\)/)
  assert.equal(git(slot, 'branch', '--show-current'), 'x')
})

const LOCAL = { slot: { ...PREPARE.slot, localFiles: ['.ai/local/rules.md', '.ai/local/ctx/'] } }
const RULES = '# Правила\n\n## Общее\n\nбазовое\n\n## Другое\n\nдругое\n\n## Оба\n\nоба\n'

/**
 * Слот с локальными файлами: список — только в рабочей копии основной (в слоте `.agent-cli.json` без него),
 * сами файлы исключены из Git через общий .git/info/exclude.
 */
const setupLocal = () => {
  const world = setup()
  const { main } = world
  writeFileSync(join(main, '.git/info/exclude'), '.ai/local/\n')
  writeFileSync(join(main, '.agent-cli.json'), JSON.stringify(LOCAL))
  writeFiles(main, { '.ai/local/rules.md': RULES, '.ai/local/ctx/a.json': '{"a":1}\n' })
  return world
}

test('sync-back and sync without a slot keep dry-run, sync both ways and do not switch branches', () => {
  const { ctx, config, slot, main } = setupLocal()
  ctx.cwd = join(slot, 'schema')
  writeFiles(slot, { '.ai/local/new.md': '# From slot\n' })
  // Include the new file in project rules, which live in the main checkout.
  const rules = { slot: { ...LOCAL.slot, localFiles: ['.ai/local/'] } }
  writeFileSync(join(main, '.agent-cli.json'), JSON.stringify(rules))
  const dry = slotSync(ctx, config, undefined, {}, ['back'])
  assert.equal(dry.data.runs[0].direction, 'back')
  assert.ok(!existsSync(join(main, '.ai/local/new.md')))
  slotSync(ctx, config, undefined, { apply: true }, ['back'])
  assert.equal(readFileSync(join(main, '.ai/local/new.md'), 'utf8'), '# From slot\n')
  ctx.env.SUPERSET_WORKSPACE_ID = 'w-1'
  const both = slotSync(ctx, config, undefined, { apply: true }, ['back', 'forward'])
  assert.deepEqual(both.data.runs.map((r) => r.direction), ['back', 'forward'])
  assert.equal(readFileSync(join(slot, '.ai/local/rules.md'), 'utf8'), RULES)
  assert.equal(git(slot, 'branch', '--show-current'), 'old-task')
})

test('prepare copies local files from the main checkout (config read from there), dry run writes nothing', () => {
  const { ctx, config, slot, workspaces } = setupLocal()
  const dry = slotPrepare(ctx, config, 'slot-1', { branch: 'feature', 'dry-run': true })
  assert.equal(git(slot, 'branch', '--show-current'), 'old-task')
  assert.ok(!existsSync(join(slot, '.ai/local')))
  assert.equal(workspaces[1].name, 'slot-1 · old-task')
  assert.deepEqual(dry.data.localFiles.runs[1].items.map((i) => [i.path, i.action]), [['.ai/local/rules.md', 'copy'], ['.ai/local/ctx/a.json', 'copy']])
  assert.match(dry.text, /Сухой прогон.*\n(.*\n)*.*\+ \.ai\/local\/rules\.md — скопировано/)

  const { data } = slotPrepare(ctx, config, 'slot-1', { branch: 'feature' })
  assert.equal(readFileSync(join(slot, '.ai/local/rules.md'), 'utf8'), RULES)
  assert.equal(readFileSync(join(slot, '.ai/local/ctx/a.json'), 'utf8'), '{"a":1}\n')
  assert.ok(!lstatSync(join(slot, '.ai/local/rules.md')).isSymbolicLink())
  assert.equal(data.localFiles.backup, null)
  const again = slotSync(ctx, config, 'slot-1', {}, ['back', 'forward'])
  assert.ok(again.data.runs.every((r) => r.items.every((i) => i.action === 'same')))
})

test('sync-back merges markdown by sections: new and slot-only edits go to main, conflicts are shown and kept', () => {
  const { ctx, config, slot, main } = setupLocal()
  ctx.cwd = slot
  slotPrepare(ctx, config, 'slot-1', { branch: 'feature' })
  const slotRules = RULES.replace('базовое', 'базовое, уточнено в слоте').replace('оба\n', 'оба — слот\n').replace('## Другое', '## Новое из слота\n\nновое\n\n## Другое')
  writeFileSync(join(slot, '.ai/local/rules.md'), slotRules)
  const mainRules = RULES.replace('другое\n', 'другое — основная\n').replace('оба\n', 'оба — основная\n')
  writeFileSync(join(main, '.ai/local/rules.md'), mainRules)

  const dry = slotSync(ctx, config, undefined, {}, ['back'])
  assert.equal(dry.code, EXIT.check)
  assert.equal(readFileSync(join(main, '.ai/local/rules.md'), 'utf8'), mainRules, 'сухой прогон по умолчанию')
  const item = dry.data.runs[0].items[0]
  assert.deepEqual([item.action, item.added, item.updated, item.conflicts.map((c) => c.section)], ['merge', ['## Новое из слота'], ['## Общее'], ['## Оба']])
  assert.match(dry.text, /КОНФЛИКТ \(не перетираю\): ## Оба/)

  const { data } = slotSync(ctx, config, undefined, { apply: true }, ['back'])
  const merged = readFileSync(join(main, '.ai/local/rules.md'), 'utf8')
  assert.match(merged, /базовое, уточнено в слоте/)
  assert.match(merged, /## Общее\n\nбазовое, уточнено в слоте\n\n## Новое из слота\n\nновое\n\n## Другое\n\nдругое — основная/)
  assert.match(merged, /оба — основная/, 'конфликтующий раздел основной копии не перетёрт')
  assert.equal(readFileSync(join(data.backup, 'main/.ai/local/rules.md'), 'utf8'), mainRules)

  // Обратно в слот уходит то, что слот не менял («Другое»); «Оба» — по-прежнему конфликт
  const forward = slotSync(ctx, config, 'slot-1', { apply: true }, ['forward'])
  assert.match(readFileSync(join(slot, '.ai/local/rules.md'), 'utf8'), /другое — основная/)
  assert.match(readFileSync(join(slot, '.ai/local/rules.md'), 'utf8'), /оба — слот/)
  assert.deepEqual(forward.data.conflicts, [{ direction: 'forward', path: '.ai/local/rules.md' }])
})

test('whole files: changed only on one side since the last sync are copied with a backup, changed on both sides are a conflict', () => {
  const { ctx, config, slot, main } = setupLocal()
  writeFiles(slot, { '.ai/local/ctx/a.json': '{"a":"slot"}\n' })
  const first = slotSync(ctx, config, 'slot-1', { apply: true }, ['back', 'forward'])
  assert.deepEqual(first.data.runs.map((r) => r.items.find((i) => i.path.endsWith('a.json')).action), ['conflict', 'conflict'])
  assert.equal(readFileSync(join(main, '.ai/local/ctx/a.json'), 'utf8'), '{"a":1}\n')
  assert.equal(readFileSync(join(slot, '.ai/local/ctx/a.json'), 'utf8'), '{"a":"slot"}\n')

  writeFileSync(join(slot, '.ai/local/ctx/a.json'), '{"a":1}\n')
  slotSync(ctx, config, 'slot-1', { apply: true }, ['back'])
  writeFileSync(join(main, '.ai/local/ctx/a.json'), '{"a":2}\n')
  const { data } = slotSync(ctx, config, 'slot-1', { apply: true }, ['back', 'forward'])
  assert.deepEqual(data.runs.map((r) => r.items.find((i) => i.path.endsWith('a.json')).action), ['ahead', 'update'])
  assert.equal(readFileSync(join(slot, '.ai/local/ctx/a.json'), 'utf8'), '{"a":2}\n')
  assert.equal(readFileSync(join(data.backup, 'slot/.ai/local/ctx/a.json'), 'utf8'), '{"a":1}\n')
})

test('release moves new local files of the slot to the main checkout', () => {
  const { ctx, config, slot, main } = setupLocal()
  slotPrepare(ctx, config, 'slot-1', { branch: 'feature', task: 't' })
  writeFiles(slot, { '.ai/local/ctx/b.json': '{"b":1}\n' })
  git(slot, 'commit', '-q', '--allow-empty', '-m', 'close(change): t')
  const { data, text } = slotRelease(ctx, config, 'slot-1', {})
  assert.equal(readFileSync(join(main, '.ai/local/ctx/b.json'), 'utf8'), '{"b":1}\n')
  assert.equal(data.localFiles.runs[0].direction, 'back')
  assert.match(text, /слот → основная копия:\n(.*\n)*.*\+ \.ai\/local\/ctx\/b\.json — скопировано/)
})

test('existing branch on origin: prepare takes it and fast-forwards; behind the base is only reported', () => {
  const { ctx, config, slot, origin } = setup()
  pushFromClone(origin, 'review', 'r1.txt')
  pushFromClone(origin, 'main', 'm1.txt')
  const { data } = slotPrepare(ctx, config, 'slot-1', { branch: 'review' })
  assert.equal(git(slot, 'branch', '--show-current'), 'review')
  assert.ok(existsSync(join(slot, 'r1.txt')))
  assert.ok(!existsSync(join(slot, 'm1.txt')), 'база не вливается сама')
  assert.ok(data.hooks.some((h) => /позади origin\/main на 1/.test(h)))
})

test('prepare does not resurrect a deleted remote branch from an outdated tracking ref', () => {
  const { ctx, config, main, slot, origin } = setup()
  pushFromClone(origin, 'review', 'deleted-review.txt')
  git(main, 'fetch', '-q', 'origin')
  git(origin, 'update-ref', '-d', 'refs/heads/review')
  const fresh = pushFromClone(origin, 'main', 'fresh.txt')
  const { data } = slotPrepare(ctx, config, 'slot-1', { branch: 'review' })
  assert.equal(data.existing, false)
  assert.equal(git(slot, 'rev-parse', 'HEAD'), fresh)
  assert.ok(!existsSync(join(slot, 'deleted-review.txt')))
})

test('prepare reports a divergent existing branch instead of ignoring a failed fast-forward', () => {
  const { ctx, config, slot, origin, workspaces } = setup()
  git(slot, 'switch', '-q', '-c', 'review')
  git(slot, 'commit', '-q', '--allow-empty', '-m', 'feat: local work')
  const local = git(slot, 'rev-parse', 'HEAD')
  git(slot, 'switch', '-q', 'old-task')
  pushFromClone(origin, 'review', 'remote-work.txt')
  assert.throws(() => slotPrepare(ctx, config, 'slot-1', { branch: 'review' }), /fast-forward|ff-only/i)
  assert.equal(git(slot, 'rev-parse', 'refs/heads/review'), local, 'local commits are preserved')
  assert.equal(workspaces[1].name, 'slot-1 · old-task', 'failed preparation is not marked ready')
})

test('slot.take refreshes master before the project command and verifies the new branch', () => {
  const commands = { mainBranch: 'master', take: 'node tools/slot.mjs --branch {branch} --from {base}' }
  const node = (args, { cwd }) => {
    git(cwd, 'switch', '-q', '--no-track', '-c', args[2], `origin/${args[4]}`)
    return '✅ готово'
  }
  const { ctx, config, main, slot, origin } = setup({ config: { slot: commands }, handlers: { node } })
  git(main, 'branch', 'master')
  git(main, 'push', '-q', 'origin', 'master')
  const previous = git(main, 'rev-parse', 'master')
  const fresh = pushFromClone(origin, 'master', 'fresh-master.txt')
  const { data } = slotPrepare(ctx, config, 'slot-1', { branch: 'feature' })
  assert.equal(git(slot, 'rev-parse', 'HEAD'), fresh)
  assert.equal(data.from, 'origin/master')
  assert.equal(data.base, fresh)
  assert.equal(data.fetched, true)
  assert.equal(git(main, 'rev-parse', 'master'), previous, 'local master is not switched or reset')
})

test('slot.take rejects a project command that branches from stale local master', () => {
  const commands = { mainBranch: 'master', take: 'node tools/slot.mjs --branch {branch} --from {base}' }
  const node = (args, { cwd }) => {
    git(cwd, 'switch', '-q', '--no-track', '-c', args[2], args[4])
    return '✅ готово'
  }
  const { ctx, config, main, slot, origin, workspaces } = setup({ config: { slot: commands }, handlers: { node } })
  git(main, 'branch', 'master')
  git(main, 'push', '-q', 'origin', 'master')
  const previous = git(main, 'rev-parse', 'master')
  pushFromClone(origin, 'master', 'fresh-master.txt')
  assert.throws(() => slotPrepare(ctx, config, 'slot-1', { branch: 'feature' }), (e) => e.code === EXIT.check && /не содержит.*origin\/master/.test(e.message))
  assert.equal(git(slot, 'rev-parse', 'HEAD'), previous, 'the faulty hook result is preserved for inspection')
  assert.equal(workspaces[1].name, 'slot-1 · old-task', 'stale branch is not marked ready')
})

test('slot.take does not invoke the project command when refreshing the remote fails', () => {
  const calls = []
  const { ctx, config, slot, main } = setup({ config: { slot: { take: 'node tools/slot.mjs --branch {branch}' } },
    handlers: { node: (args) => (calls.push(args), '✅ готово') } })
  git(main, 'remote', 'set-url', 'origin', join(tempDir(), 'missing.git'))
  assert.throws(() => slotPrepare(ctx, config, 'slot-1', { branch: 'feature' }), /git fetch.*не прошёл/s)
  assert.deepEqual(calls, [])
  assert.equal(git(slot, 'branch', '--show-current'), 'old-task')
  assert.equal(git(slot, 'branch', '--list', 'feature'), '')
})

test('slot.take / slot.release: the project command does the work, agent-cli keeps names and local files', () => {
  const calls = []
  const node = (args, { cwd }) => {
    calls.push({ args, cwd })
    if (args.includes('--branch')) git(cwd, 'switch', '-q', '--no-track', '-c', args[2], `origin/${args[4]}`)
    return '✅ готово\nшум установки\n⚠️  позади'
  }
  const commands = { take: 'node tools/slot.mjs --branch {branch} --from {base}', release: 'node tools/slot.mjs --release --from {base}' }
  const { ctx, config, slot, workspaces } = setup({ config: { slot: commands }, handlers: { node } })
  const ws = workspaces.find((w) => w.id === 'w-1')
  const taken = slotPrepare(ctx, config, 'slot-1', { branch: 'feature', task: 'x' })
  assert.deepEqual(calls[0], { args: ['tools/slot.mjs', '--branch', 'feature', '--from', 'main'], cwd: slot })
  assert.deepEqual(taken.data.output, ['✅ готово', '⚠️  позади'])
  assert.equal(ws.name, 'slot-1 · x')
  assert.equal(git(slot, 'branch', '--show-current'), 'feature', 'ветку переключает команда проекта, agent-cli проверяет результат')
  slotRelease(ctx, config, 'slot-1', {})
  assert.deepEqual(calls[1].args, ['tools/slot.mjs', '--release', '--from', 'main'])
  assert.equal(ws.name, 'slot-1')
})

test('defaults without slot.prepare: node_modules cloned from the main checkout, npm ci only when needed, husky hooks', () => {
  const run = []
  const handlers = {
    cp: (args) => (run.push(`cp ${args.slice(0, -2).join(' ')}`), mkdirSync(args.at(-1), { recursive: true }), ''),
    npm: (args, { cwd, env }) => (run.push(`npm ${args.join(' ')} @${cwd} ${env?.npm_config_userconfig ?? ''}`), mkdirSync(join(cwd, 'node_modules'), { recursive: true }), ''),
    npx: (args) => (run.push(`npx ${args.join(' ')}`), ''),
  }
  const files = { 'package-lock.json': '{}', 'tools/pkg/package-lock.json': '{}', 'other/package-lock.json': '{}', '.husky/pre-commit': 'x', '.gitignore': 'node_modules\n' }
  const { ctx, config, main, slot } = setup({ config: null, files, handlers })
  ctx.platform = 'darwin'
  mkdirSync(join(main, 'tools/pkg/node_modules'), { recursive: true })
  writeFileSync(join(main, '.npmrc'), '')
  git(slot, 'config', 'core.hooksPath', '.husky/_')
  slotPrepare(ctx, config, 'slot-1', { branch: 'feature' })
  // корень и вложенный пакет с node_modules в основной копии — клоном; other без node_modules в основной — пропуск
  assert.deepEqual(run, ['cp -c -R', 'cp -c -R', 'npx husky'])

  run.length = 0
  ctx.platform = 'win32'
  rmSync(join(slot, 'node_modules'), { recursive: true })
  slotRelease(ctx, config, 'slot-1', {})
  slotPrepare(ctx, config, 'slot-1', { branch: 'feature' })
  assert.deepEqual(run, [`npm ci @${slot} ${join(main, '.npmrc')}`, 'npx husky'])
})

test('defaults, npm: nested workspace node_modules from package-lock.json cloned, ready by a sample package, only with the same lock', () => {
  const run = []
  const handlers = {
    cp: (args) => (run.push(`cp ${args.at(-1)}`), cpSync(args.at(-2), args.at(-1), { recursive: true }), ''),
    npm: (args, { cwd }) => (run.push(`npm ${args.join(' ')} @${cwd}`), ''),
  }
  const packages = { 'node_modules/a': {}, 'node_modules/opt': { optional: true }, 'libs/x/node_modules/b': {} }
  const files = { 'package-lock.json': JSON.stringify({ packages }), '.gitignore': 'node_modules\n' }
  const { ctx, config, main, slot } = setup({ config: null, files, handlers })
  ctx.platform = 'darwin'
  for (const path of ['node_modules/a', 'libs/x/node_modules/b']) mkdirSync(join(main, path), { recursive: true })
  mkdirSync(join(slot, 'node_modules/a'), { recursive: true })
  mkdirSync(join(slot, 'libs/x/node_modules/.cache'), { recursive: true })
  const taken = slotPrepare(ctx, config, 'slot-1', { branch: 'feature' })
  // корень готов (нет только необязательного opt), вложенная папка — только кэш: клон заменяет её
  assert.deepEqual(run, [`cp ${join(slot, 'libs/x/node_modules')}`])
  assert.ok(existsSync(join(slot, 'libs/x/node_modules/b')) && !existsSync(join(slot, 'libs/x/node_modules/.cache')))
  assert.ok(taken.data.hooks.includes('клон libs/x/node_modules'))

  run.length = 0
  rmSync(join(slot, 'libs/x/node_modules'), { recursive: true })
  writeFileSync(join(main, 'package-lock.json'), '{}')
  slotRelease(ctx, config, 'slot-1', {})
  slotPrepare(ctx, config, 'slot-1', { branch: 'feature' })
  assert.deepEqual(run, [`npm ci @${slot}`], 'lock-файл основной копии другой — без клона, установка')
})
