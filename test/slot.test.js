import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { EXIT } from '../src/exit.js'
import { slotLs, slotPrepare, slotRelease } from '../src/slot.js'
import { loadConfig } from '../src/store.js'
import { fakeContext, git, makeRepo, tempDir } from './helpers.js'

const PREPARE = {
  slot: {
    prepare: [{ symlinkIfMissing: 'node_modules' }, { copyIfMissing: ['.env.local', 'config/dev.json', '.env.absent'] }, { run: 'touch generated.txt', ifChanged: ['schema/'] }],
  },
}

/** Основная копия проекта и слот-worktree; superset знает про оба, живых сессий нет (ps пуст). */
const setup = () => {
  const main = makeRepo({ '.agent-cli.json': JSON.stringify(PREPARE), '.gitignore': 'node_modules\n.env.*\nconfig/dev.json\ngenerated.txt\n', 'schema/s.txt': '1\n', 'a.txt': 'a\n' })
  mkdirSync(join(main, 'node_modules'))
  writeFileSync(join(main, '.env.local'), 'X=1\n')
  mkdirSync(join(main, 'config'))
  writeFileSync(join(main, 'config/dev.json'), '{}')
  const slot = join(tempDir('slots-'), 'slot-1')
  git(main, 'worktree', 'add', '-q', '-b', 'old-task', slot)
  const workspaces = [
    { id: 'w-main', name: 'proj main', projectName: 'proj', worktreePath: main },
    { id: 'w-1', name: 'slot-1 · old-task', projectName: 'proj', worktreePath: slot },
  ]
  const ctx = fakeContext({
    ps: () => '',
    touch: (args, { cwd }) => (writeFileSync(join(cwd, args[0]), ''), ''),
    superset: (args) => {
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
  return { ctx, config: loadConfig(ctx), main, slot, workspaces }
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

test('prepare refuses the main checkout, existing branches and slots with a live session', () => {
  const { ctx, config } = setup()
  assert.throws(() => slotPrepare(ctx, config, 'proj main', { branch: 'x' }), /основная копия/)
  assert.throws(() => slotPrepare(ctx, config, 'slot-1', { branch: 'main' }), /уже есть/)
  assert.throws(() => slotPrepare(ctx, config, 'slot-1', {}), /--branch/)
})

test('prepare names the slot «slot-N · task», release returns «slot-N» only when merged or closed', () => {
  const { ctx, config, slot, main, workspaces } = setup()
  const ws = workspaces.find((w) => w.id === 'w-1')
  slotPrepare(ctx, config, 'slot-1', { branch: 'feature', task: 'store-delivery' })
  assert.equal(ws.name, 'slot-1 · store-delivery')
  writeFileSync(join(slot, 'f.txt'), 'f\n')
  git(slot, 'add', 'f.txt')
  git(slot, 'commit', '-qm', 'feat(store-delivery): x')
  assert.throws(() => slotRelease(ctx, config, 'slot-1', {}), (e) => e.code === EXIT.check && /не влита/.test(e.message))
  git(slot, 'commit', '-q', '--allow-empty', '-m', 'close(change): store-delivery')
  assert.equal(slotRelease(ctx, config, 'slot-1 · store-delivery', {}).data.closed, true)
  assert.equal(ws.name, 'slot-1')

  ws.name = 'slot-1 · other'
  git(main, 'merge', '-q', '--ff-only', 'feature')
  git(slot, 'reset', '-q', '--hard', 'HEAD~1')
  assert.equal(slotRelease(ctx, config, 'w-1', {}).data.merged, true)
  assert.equal(ws.name, 'slot-1')
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
