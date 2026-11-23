import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { EXIT } from '../src/exit.js'
import { sessCreate } from '../src/sess.js'
import { loadSlots, slotPrepare } from '../src/slot.js'
import { slotCreate, slotTake } from '../src/slot-create.js'
import { loadConfig } from '../src/store.js'
import { fakeContext, git, jsonl, makeRepo, tempDir } from './helpers.js'

/**
 * Основная копия с origin и свободный slot-1 (без ветки) в общей папке worktree. `ws create` ведёт себя как
 * Superset: папка — по ветке, ветка — от локальной base-branch (та может отставать от origin), иначе от origin/<base>.
 */
const setup = () => {
  const main = makeRepo({ '.agent-cli.json': JSON.stringify({ slot: { prepare: [] } }), 'a.txt': 'a\n' })
  const origin = join(tempDir('origin-'), 'origin.git')
  git(main, 'init', '-q', '--bare', origin)
  git(main, 'remote', 'add', 'origin', origin)
  git(main, 'push', '-q', 'origin', 'main')
  git(main, 'fetch', '-q', 'origin')
  const root = tempDir('worktrees-')
  git(main, 'worktree', 'add', '-q', '--detach', join(root, 'slot-1'), 'main')
  const workspaces = [
    { id: 'w-main', name: 'proj main', projectName: 'proj', projectId: 'p-1', worktreePath: main },
    { id: 'w-1', name: 'slot-1', projectName: 'proj', projectId: 'p-1', worktreePath: join(root, 'slot-1') },
  ]
  const created = [], launched = [], prompts = []
  const flag = (args, name) => args[args.indexOf(name) + 1]
  const ctx = fakeContext({
    ps: () => '',
    superset: (args) => {
      if (args[0] === 'sessions' && args[1] === 'list') return '[]'
      const key = args.slice(0, 2).join(' ')
      if (key === 'sessions create') {
        const chat = { workspace: flag(args, '--workspace'), sessionId: `chat-${launched.length + 1}`, terminalId: `term-${launched.length + 1}` }
        launched.push(chat)
        return JSON.stringify(chat)
      }
      if (key === 'sessions send') {
        prompts.push(flag(args, '--prompt'))
        return JSON.stringify({ sessionId: flag(args, '--session') })
      }
      if (key === 'ws create') {
        created.push(args)
        const branch = flag(args, '--branch')
        const base = flag(args, '--base-branch')
        const local = git(main, 'branch', '--list', base) ? base : `origin/${base}`
        git(main, 'worktree', 'add', '-q', '--no-track', '-b', branch, join(root, branch), local)
        const ws = { id: `w-new-${created.length}`, name: flag(args, '--name'), projectName: 'proj', projectId: flag(args, '--project'), worktreePath: join(root, branch) }
        workspaces.push(ws)
        return JSON.stringify({ id: ws.id, name: ws.name })
      }
      if (key === 'ws update') {
        workspaces.find((w) => w.id === args[2]).name = flag(args, '--name')
        return ''
      }
      if (key === 'ws list') return JSON.stringify(workspaces)
      if (key === 'projects list') return JSON.stringify([{ id: 'p-1', name: 'proj', path: main }])
      if (key === 'snapshot --json') return JSON.stringify({ workspaces: [] })
      throw new Error(args.join(' '))
    },
  })
  return { ctx, config: loadConfig(ctx), main, origin, root, workspaces, created, launched, prompts }
}

const scriptOptions = (w, branch = 'task/script') => {
  const file = join(tempDir(), 'task.md')
  writeFileSync(file, 'Run the work.')
  return { project: 'proj', branch, 'prompt-file': file }
}

test('scripted create prepares the first free slot by number and sends work only there', async () => {
  const w = setup()
  const one = w.workspaces.find((ws) => ws.id === 'w-1')
  git(one.worktreePath, 'switch', '-c', 'old-merged-task')
  slotCreate(w.ctx, w.config, { project: 'proj', name: 'slot-10' })
  slotCreate(w.ctx, w.config, { project: 'proj', name: 'slot-2' })
  const result = await sessCreate(w.ctx, w.config, scriptOptions(w), () => assert.fail('unexpected confirmation'))
  assert.equal(result.data.workspace, one.id)
  assert.equal(w.launched[0].workspace, one.id)
  assert.equal(w.created.length, 2)
  assert.ok(w.prompts[0].endsWith('Run the work.'))
  assert.equal(git(one.worktreePath, 'branch', '--show-current'), 'task/script')
  const next = await sessCreate(w.ctx, w.config, scriptOptions(w, 'task/next'))
  assert.equal(w.workspaces.find((ws) => ws.id === next.data.workspace).name, 'slot-2 · task/next')
})

test('no free slots returns a question and waits for an explicit yes before create/prepare/launch', async () => {
  const w = setup()
  slotTake(w.ctx, w.config, { project: 'proj', branch: 'task/occupied' })
  const opts = scriptOptions(w)
  const waiting = await sessCreate(w.ctx, w.config, opts)
  assert.equal(waiting.code, EXIT.waiting)
  assert.equal(waiting.data.status, 'confirmation_required')
  assert.match(waiting.data.question, /Создать новый слот/)
  assert.equal(w.created.length + w.launched.length + w.prompts.length, 0)
  const declined = await sessCreate(w.ctx, w.config, opts, async (question) => {
    assert.equal(question, waiting.data.question)
    return false
  })
  assert.equal(declined.data.status, 'cancelled')
  assert.equal(w.created.length + w.launched.length + w.prompts.length, 0)
  const approved = await sessCreate(w.ctx, w.config, opts, async () => {
    assert.equal(w.created.length + w.launched.length + w.prompts.length, 0)
    return true
  })
  assert.equal(approved.data.workspace, 'w-new-1')
  assert.equal(git(join(w.root, 'slot-2'), 'branch', '--show-current'), 'task/script')
  assert.equal(w.created.length, 1)
  assert.equal(w.launched.length, 1)
})

test('two scripted launches race for the last free slot; only one receives it', async () => {
  const w = setup()
  const [first, second] = await Promise.all([
    sessCreate(w.ctx, w.config, scriptOptions(w, 'task/first')),
    sessCreate(w.ctx, w.config, scriptOptions(w, 'task/second')),
  ])
  assert.equal(first.data.workspace, 'w-1')
  assert.equal(second.data.status, 'confirmation_required')
  assert.equal(w.created.length, 0)
  assert.equal(w.launched.length, 1)
  assert.equal(w.prompts.length, 1)
  assert.equal(git(join(w.root, 'slot-1'), 'branch', '--show-current'), 'task/first')
})

test('approval reselects an existing slot that became free while waiting', async () => {
  const w = setup()
  const slot = w.workspaces.find((ws) => ws.id === 'w-1')
  slot.name = 'slot-1 · occupied'
  const result = await sessCreate(w.ctx, w.config, scriptOptions(w), async () => {
    slot.name = 'slot-1'
    return true
  })
  assert.equal(result.data.workspace, slot.id)
  assert.equal(w.created.length, 0)
})

/** «Коллега» двигает origin/main: локальный main основной копии отстаёт. */
const pushFresh = (origin, file) => {
  const clone = join(tempDir('clone-'), 'c')
  git(origin, 'clone', '-q', '-b', 'main', origin, clone)
  writeFileSync(join(clone, file), `${file}\n`)
  git(clone, 'add', file)
  git(clone, 'commit', '-qm', `feat: ${file}`)
  git(clone, 'push', '-q', 'origin', 'main')
  return git(clone, 'rev-parse', 'HEAD')
}

test('create: next free slot-N in its own folder, detached on fresh origin/main, clean, temporary branch removed', () => {
  const { ctx, config, main, origin, root, workspaces, created } = setup()
  const fresh = pushFresh(origin, 'fresh.txt')
  const { data, text } = slotCreate(ctx, config, { project: 'proj' })
  assert.deepEqual(created[0], ['ws', 'create', '--local', '--project', 'p-1', '--name', 'slot-2', '--branch', 'slot-2', '--skip-branch-prefix', '--base-branch', 'main', '--json'])
  const path = join(root, 'slot-2')
  assert.equal(data.path, path)
  assert.equal(data.workspace, 'w-new-1')
  assert.equal(git(path, 'rev-parse', 'HEAD'), fresh, 'от свежего origin/main, а не от отставшего локального main')
  assert.equal(git(path, 'branch', '--show-current'), '')
  assert.equal(git(path, 'status', '--porcelain'), '')
  assert.equal(git(main, 'branch', '--list', 'slot-2'), '', 'временная ветка удалена')
  assert.equal(workspaces.at(-1).name, 'slot-2')
  assert.match(text, /^slot-2 создан: .*\n {2}без ветки на origin\/main [0-9a-f]{9}\nворкспейс: w-new-1$/)

  // Дальше — обычный prepare
  const prepared = slotPrepare(ctx, config, 'slot-2', { branch: 'feature', task: 't', project: 'proj' })
  assert.equal(prepared.data.slot, 'slot-2 · t')
  assert.equal(git(path, 'branch', '--show-current'), 'feature')
})

test('create skips names with a workspace, a branch or a folder; --name must be a free slot-N; dry run creates nothing', () => {
  const { ctx, config, main, root, created } = setup()
  git(main, 'branch', 'slot-2')
  mkdirSync(join(root, 'slot-3'))
  assert.throws(() => slotCreate(ctx, config, { project: 'proj', name: 'slot-1' }), (e) => e.code === EXIT.check && /воркспейс slot-1 уже есть/.test(e.message))
  assert.throws(() => slotCreate(ctx, config, { project: 'proj', name: 'slot-2' }), (e) => e.code === EXIT.check && /ветка slot-2 уже есть/.test(e.message))
  assert.throws(() => slotCreate(ctx, config, { project: 'proj', name: 'slot-3' }), (e) => e.code === EXIT.check && /папка slot-3/.test(e.message))
  assert.throws(() => slotCreate(ctx, config, { project: 'proj', name: 'my-slot' }), /slot-N/)
  assert.throws(() => slotCreate(ctx, config, {}), /--project/)
  assert.throws(() => slotCreate(ctx, config, { project: 'nope' }), /не найден/)

  const dry = slotCreate(ctx, config, { project: 'p-1', 'dry-run': true })
  assert.equal(dry.data.slot, 'slot-4')
  assert.match(dry.data.command, /--name slot-4 --branch slot-4 --skip-branch-prefix --base-branch main$/)
  assert.equal(created.length, 0)
  assert.ok(!existsSync(join(root, 'slot-4')))
})

test('create --base forks from another fresh origin branch; fetch failure stops before Superset is called', () => {
  const { ctx, config, main, created } = setup()
  assert.throws(() => slotCreate(ctx, config, { project: 'proj', base: 'nope' }), /Нет origin\/nope/)
  assert.equal(created.length, 0)
  git(main, 'push', '-q', 'origin', 'main:release-1')
  const { data } = slotCreate(ctx, config, { project: 'proj', base: 'origin/release-1' })
  assert.equal(data.from, 'origin/release-1')
  assert.equal(created[0].at(-2), 'release-1')
})

test('take: a free slot when there is one, otherwise create + prepare; prints the workspace id', () => {
  const { ctx, config, root, created } = setup()
  const first = slotTake(ctx, config, { project: 'proj', branch: 'task-a', task: 'a' })
  assert.equal(first.data.workspace, 'w-1')
  assert.equal(first.data.created, false)
  assert.equal(first.data.slot, 'slot-1 · a')
  assert.match(first.text, /\nворкспейс: w-1$/)
  assert.equal(created.length, 0)

  const dry = slotTake(ctx, config, { project: 'proj', branch: 'task-b', 'dry-run': true })
  assert.equal(dry.data.slot, 'slot-2')
  assert.equal(created.length, 0)

  const second = slotTake(ctx, config, { project: 'proj', branch: 'task-b', task: 'b' })
  assert.equal(second.data.created, true)
  assert.equal(second.data.workspace, 'w-new-1')
  assert.equal(second.data.slot, 'slot-2 · b')
  assert.equal(git(join(root, 'slot-2'), 'branch', '--show-current'), 'task-b')
  assert.match(second.text, /^Свободного слота нет — slot-2 создан: .*\n(.*\n)*воркспейс: w-new-1$/)

  assert.throws(() => slotTake(ctx, config, { project: 'proj', branch: 'task-a' }), (e) => e.code === EXIT.check && /уже в slot-1 · a \(w-1\)/.test(e.message))
  assert.throws(() => slotTake(ctx, config, { project: 'proj' }), /--branch/)
})

test('take passes over a dirty slot-N and a slot on an unmerged branch', () => {
  const { ctx, config, root, workspaces, created } = setup()
  writeFileSync(join(root, 'slot-1', 'junk.txt'), 'x\n')
  slotTake(ctx, config, { project: 'proj', branch: 'task-a' })
  assert.equal(created.length, 1, 'грязный slot-1 не свободен')

  // Работа закончена (имя «slot-2» вернул sess close), но ветка не влита — слот не свободен
  git(join(root, 'slot-2'), 'commit', '-q', '--allow-empty', '-m', 'feat: не влито')
  workspaces.find((w) => w.id === 'w-new-1').name = 'slot-2'
  const { data } = slotTake(ctx, config, { project: 'proj', branch: 'task-b' })
  assert.equal(data.slot, 'slot-3 · task-b')
})

test('take skips a clean detached slot occupied by Codex and creates another slot', () => {
  const { ctx, config, root, created } = setup()
  const occupied = join(root, 'slot-1')
  const dir = join(ctx.codexHome, 'sessions', '2026', '10', '30')
  mkdirSync(dir, { recursive: true })
  const rollout = join(dir, 'rollout-2026-10-30T10-00-00-live-codex.jsonl')
  writeFileSync(rollout, jsonl([
    { type: 'session_meta', payload: { id: 'live-codex', cwd: occupied, source: 'cli' } },
    { type: 'event_msg', payload: { type: 'task_started' } },
  ]))
  const run = ctx.run
  ctx.run = (cmd, args, opts) => {
    const result = (stdout) => ({ status: 0, stdout, stderr: '' })
    if (cmd === 'ps') {
      if (args[0] === '-axo') return result('401 1 204800 /opt/bin/codex')
      if (args[0] === '-p') return result('/opt/bin/codex')
      return result('/opt/bin/codex SUPERSET_TERMINAL_ID=codex-terminal SUPERSET_WORKSPACE_ID=w-1')
    }
    if (cmd === 'lsof') return result(`p401\nfcwd\nn${occupied}\nf12\nn${rollout}\n`)
    return run(cmd, args, opts)
  }
  const slot = loadSlots(ctx, config, 'proj').find((s) => s.id === 'w-1')
  assert.equal(slot.sessions[0].agent, 'codex')
  assert.equal(slot.sessions[0].sessionId, 'live-codex')
  const taken = slotTake(ctx, config, { project: 'proj', branch: 'task-with-codex' })
  assert.equal(taken.data.created, true)
  assert.equal(taken.data.workspace, 'w-new-1')
  assert.equal(taken.data.slot, 'slot-2 · task-with-codex')
  assert.equal(created.length, 1)
  assert.equal(git(occupied, 'branch', '--show-current'), '', 'занятый Codex слот не переключается')
  assert.equal(git(occupied, 'status', '--porcelain'), '')
})
