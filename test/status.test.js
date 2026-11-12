import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { resolveCurrentWorkspace } from '../src/current.js'
import { status } from '../src/status.js'
import { git, makeRepo, tempDir } from './helpers.js'
import { makeWorld, OTHER, SID, TERM, WS } from './world.js'

test('current workspace resolves canonical subdirectories and the deepest path, and refuses duplicate roots or stale IDs', () => {
  const root = tempDir('agent-context-')
  const slot = join(root, 'slot')
  mkdirSync(join(slot, 'src'), { recursive: true })
  const alias = join(tempDir(), 'alias')
  symlinkSync(slot, alias)
  const workspaces = [{ id: 'main', worktreePath: root }, { id: 'slot', worktreePath: slot }]
  const ctx = { env: {}, cwd: join(alias, 'src') }
  assert.equal(resolveCurrentWorkspace(ctx, workspaces).id, 'slot')
  assert.throws(() => resolveCurrentWorkspace(ctx, [...workspaces, { id: 'duplicate', worktreePath: alias }]), /неоднозначен/)
  ctx.env.SUPERSET_WORKSPACE_ID = 'main'
  assert.equal(resolveCurrentWorkspace(ctx, workspaces).id, 'main')
  ctx.env.SUPERSET_WORKSPACE_ID = 'stale'
  assert.throws(() => resolveCurrentWorkspace(ctx, workspaces, { required: false }), /из окружения не найден/)
  delete ctx.env.SUPERSET_WORKSPACE_ID
  ctx.cwd = `${root}-neighbor`
  assert.equal(resolveCurrentWorkspace(ctx, workspaces, { required: false }), null)
})

test('status reads the actual Git branch and staged, unstaged, deleted and untracked changes without writes', () => {
  const repo = makeRepo({ 'tracked.txt': 'a\n', 'deleted.txt': 'b\n' })
  git(repo, 'switch', '-q', '-c', 'actual-task')
  writeFileSync(join(repo, 'tracked.txt'), 'staged\n')
  git(repo, 'add', 'tracked.txt')
  writeFileSync(join(repo, 'tracked.txt'), 'unstaged\n')
  rmSync(join(repo, 'deleted.txt'))
  writeFileSync(join(repo, 'new file.txt'), 'new\n')
  const { ctx, config, world } = makeWorld({ cwd: repo, name: 'slot-1 · status' })
  world.procs = world.procs.filter(([pid]) => pid !== 202)
  mkdirSync(join(repo, 'src'))
  ctx.cwd = join(repo, 'src')
  const indexBefore = readFileSync(join(repo, '.git/index'))
  const { data, text } = status(ctx, config)
  assert.equal(data.project, 'proj')
  assert.equal(data.workspace.id, WS)
  assert.equal(data.slot, 'slot-1')
  assert.equal(data.git.branch, 'actual-task', 'колонка snapshot содержит другую ветку')
  assert.deepEqual(data.git.changes, [
    { code: ' D', path: 'deleted.txt' }, { code: 'MM', path: 'tracked.txt' }, { code: '??', path: 'new file.txt' },
  ])
  assert.equal(data.session.sessionId, SID)
  assert.equal(data.selection, 'selected')
  assert.match(text, /Ветка: actual-task/)
  assert.match(text, /Изменения: 3/)
  assert.match(text, /→ claude\/cli sess-1/)
  assert.deepEqual(readFileSync(join(repo, '.git/index')), indexBefore)
  assert.ok(!ctx.calls.some((c) => ['update', 'close', 'send'].includes(c.args[1])))
})

test('status lists ambiguous sessions and selects the own terminal, but never substitutes a neighbor for a stale thread', () => {
  const repo = makeRepo({ 'a.txt': 'a\n' })
  const { ctx, config, world } = makeWorld({ cwd: repo })
  ctx.cwd = repo
  world.procs = world.procs.filter(([pid]) => pid !== 202)
  world.addSession(303, OTHER, 'neighbor')
  const ambiguous = status(ctx, config)
  assert.equal(ambiguous.data.session, null)
  assert.equal(ambiguous.data.selection, 'ambiguous')
  assert.equal(ambiguous.data.sessions.length, 2)
  assert.match(ambiguous.text, /несколько; для last\/close укажите ID/)
  ctx.env.SUPERSET_TERMINAL_ID = TERM
  assert.equal(status(ctx, config).data.session.sessionId, SID)
  ctx.env.CODEX_THREAD_ID = 'stale'
  const unmatched = status(ctx, config)
  assert.equal(unmatched.data.session, null)
  assert.equal(unmatched.data.selection, 'unmatched')
  assert.match(unmatched.text, /Текущая сессия не найдена/)
})

test('status supports an empty workspace, detached HEAD and the main checkout', () => {
  const repo = makeRepo({ 'a.txt': 'a\n' })
  git(repo, 'switch', '-q', '--detach')
  const { ctx, config, world } = makeWorld({ cwd: repo, name: 'proj main' })
  ctx.env.SUPERSET_WORKSPACE_ID = WS
  ctx.cwd = '/elsewhere'
  world.procs = []
  const { data, text } = status(ctx, config)
  assert.equal(data.slot, null)
  assert.equal(data.git.branch, null)
  assert.equal(data.git.head, git(repo, 'rev-parse', 'HEAD'))
  assert.equal(data.selection, 'none')
  assert.deepEqual(data.sessions, [])
  assert.match(text, /detached HEAD/)
  assert.match(text, /живых сессий нет/)
})

test('status shows local Git outside Superset, non-repositories and missing worktrees truthfully', () => {
  const repo = makeRepo({ 'a.txt': 'a\n' })
  const { ctx, config } = makeWorld()
  ctx.cwd = repo
  const local = status(ctx, config)
  assert.equal(local.data.workspace, null)
  assert.equal(local.data.git.branch, 'main')
  ctx.cwd = tempDir('not-a-repo-')
  assert.equal(status(ctx, config).data.git, null)
  ctx.env.SUPERSET_WORKSPACE_ID = WS
  const missing = status(ctx, config)
  assert.equal(missing.data.workspace.exists, false)
  assert.equal(missing.data.git, null)
  assert.match(missing.text, /нет на диске/)
})
