import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { EXIT } from '../src/exit.js'
import { sessClose, sessResume } from '../src/sess-registry.js'
import { sessCreate, sessLast, sessLs, sessSend, sessWait } from '../src/sess.js'
import { loadConfig, loadRegistry } from '../src/store.js'
import { addOrigin, git, makeRepo, tempDir } from './helpers.js'
import { at, CWD, makeWorld, OTHER, prompt, say, SID, TERM, turnEnd, WS } from './world.js'

test('ls joins processes, terminals and session files; env value is the last one', () => {
  const { ctx, config } = makeWorld()
  const { data, text } = sessLs(ctx, config)
  assert.equal(data.count, 1)
  assert.equal(data.limit, 5)
  const [mine, outside] = data.sessions
  assert.equal(mine.terminal, TERM)
  assert.equal(mine.sessionId, SID)
  assert.equal(mine.title, 'Моя задача')
  assert.equal(mine.rssMb, 200)
  assert.equal(outside.terminal, null)
  assert.match(text, /Сессий в Superset: 1 из 5/)
})

test('send returns the journal anchor once the session accepted the text', async () => {
  const { ctx, config, world } = makeWorld()
  world.onSend = (text) => world.append(prompt('anchor-1', at(ctx, 1), text))
  const { data } = await sessSend(ctx, config, 'aaaaaaaa', { text: 'Сделай X\n' })
  assert.equal(data.anchor, 'anchor-1')
  assert.deepEqual(world.sent, ['Сделай X'])
})

test('send fails with its own code when nothing reached the journal, refuses while waiting for permission', async () => {
  const { ctx, config, world } = makeWorld()
  await assert.rejects(sessSend(ctx, config, TERM, { text: 'тишина' }), (e) => e.code === EXIT.notAccepted)
  world.state = 'blocked'
  await assert.rejects(sessSend(ctx, config, TERM, { text: 'да' }), (e) => e.code === EXIT.waiting)
  assert.equal(world.sent.length, 1)
})

test('send: hung superset call and missing confirmation end with code 7 within --timeout', async () => {
  const { ctx, config, world } = makeWorld()
  world.sendHangs = true
  await assert.rejects(sessSend(ctx, config, TERM, { text: 'x' }), (e) => e.code === EXIT.notAccepted && /могло дойти/.test(e.message))
  world.sendHangs = false
  const start = ctx.now()
  await assert.rejects(sessSend(ctx, config, TERM, { text: 'тишина', timeout: '5' }), (e) => e.code === EXIT.notAccepted && /за 5 с/.test(e.message))
  assert.ok(ctx.now() - start <= 6000)
  const sendCall = ctx.calls.findLast((c) => c.cmd.endsWith('superset') && c.args[1] === 'send')
  assert.equal(sendCall.opts.timeout, 5000)
})

test('wait: marker after anchor → 0 with the answer; old marker ignored', async () => {
  const { ctx, config, world } = makeWorld()
  world.append(say('old', at(ctx, -100), '[[DONE-A]]'), prompt('p', at(ctx, -50), 'задача'))
  world.state = 'working'
  let polls = 0
  const result = await sessWait(
    { ...ctx, sleep: async (ms) => { ctx.advance(ms); if (++polls === 2) world.append(say('a', at(ctx), 'Итог\n[[DONE-A]]')) } },
    config,
    TERM,
    { marker: 'DONE-A', after: 'p', interval: '5' },
  )
  assert.equal(result.code, EXIT.ok)
  assert.equal(result.data.reason, 'marker')
  assert.equal(result.data.answer.text, 'Итог\n[[DONE-A]]')
})

test('wait: idle without marker → 4, waiting for permission → 3, API error → 5, timeout → 2', async () => {
  const idle = makeWorld()
  idle.world.append(prompt('p', at(idle.ctx), 'задача'), say('a', at(idle.ctx, 1), 'Какой вариант выбрать?'), turnEnd('e', at(idle.ctx, 2)))
  assert.equal((await sessWait(idle.ctx, idle.config, TERM, { marker: 'M' })).code, EXIT.idle)

  const blocked = makeWorld()
  blocked.world.append(prompt('p', at(blocked.ctx), 'задача'))
  blocked.world.state = 'blocked'
  assert.equal((await sessWait(blocked.ctx, blocked.config, TERM, { marker: 'M' })).code, EXIT.waiting)

  const api = makeWorld()
  api.world.append(prompt('p', at(api.ctx), 'задача'), { ...say('x', at(api.ctx, 1), 'API Error: 500'), isApiErrorMessage: true })
  const failed = await sessWait(api.ctx, api.config, TERM, { marker: 'M' })
  assert.equal(failed.code, EXIT.apiError)
  assert.match(failed.text, /API Error: 500/)

  const slow = makeWorld()
  slow.world.state = 'working'
  slow.world.append(prompt('p', at(slow.ctx), 'задача'))
  const late = await sessWait(slow.ctx, slow.config, TERM, { marker: 'M', timeout: '30', interval: '5' })
  assert.equal(late.code, EXIT.timeout)
})

test('wait without marker succeeds when the turn ends; unknown anchor is an error', async () => {
  const { ctx, config, world } = makeWorld()
  world.append(prompt('p', at(ctx), 'задача'), say('a', at(ctx, 1), 'готово'), turnEnd('e', at(ctx, 2)))
  assert.equal((await sessWait(ctx, config, TERM, {})).code, EXIT.ok)
  await assert.rejects(sessWait(ctx, config, TERM, { after: 'nope' }), /Якорь nope не найден/)
  assert.equal(sessLast(ctx, config, TERM).text, 'готово')
})

test('close saves the session to the registry, keeps the alias for resume; resume reopens it', async () => {
  const { ctx, config, world } = makeWorld()
  world.state = 'working'
  await assert.rejects(sessClose(ctx, config, TERM, {}), /Сессия работает/)
  world.state = 'idle'
  mkdirSync(ctx.agentHome, { recursive: true })
  writeFileSync(join(ctx.agentHome, 'sessions.json'), JSON.stringify({ aliases: { 'task-x': TERM } }))
  await sessClose(ctx, config, 'task-x', { note: 'пауза' })
  assert.deepEqual(world.closedPanes, [`pane-${TERM}`], 'закрыто через панель — в приложении не остаётся мёртвой панели')
  const registry = loadRegistry(ctx)
  assert.equal(registry.sessions[0].sessionId, SID)
  assert.equal(registry.sessions[0].note, 'пауза')
  assert.deepEqual(registry.aliases, {})

  const { data } = await sessResume(ctx, config, 'task-x', {})
  assert.equal(data.resumedFrom, SID)
  assert.ok(world.created[0].includes('--resume-session'))
  assert.equal(loadRegistry(ctx).aliases['task-x'], data.terminal)
})

test('create respects the session limit and registers the alias', async () => {
  const repo = makeRepo({ 'a.txt': 'a' }); git(repo, 'switch', '-q', '-c', 'task')
  const { ctx, world } = makeWorld({ cwd: repo, name: 'slot-1 · task' })
  const promptFile = join(tempDir(), 'p.md')
  writeFileSync(promptFile, 'Задача')
  const config = { ...loadConfig(ctx), maxSessions: 1 }
  await assert.rejects(sessCreate(ctx, config, { workspace: 'slot-1', 'prompt-file': promptFile }), (e) => e.code === EXIT.limit)
  world.procs = []
  const { data } = await sessCreate(ctx, { ...config, maxSessions: 5 }, { workspace: 'slot-1', 'prompt-file': promptFile, agent: 'claude', alias: 'job', model: 'opus' })
  assert.equal(data.sessionId, 'sess-new')
  assert.ok(world.created[0][world.created[0].indexOf('--prompt') + 1].endsWith('Задача'))
  assert.equal(JSON.parse(readFileSync(join(ctx.agentHome, 'sessions.json'), 'utf8')).aliases.job, data.terminal)
})

test('close releases a clean slot and refuses a dirty slot before closing its session', async () => {
  for (const dirty of [false, true]) {
    const repo = makeRepo({ 'a.txt': 'a\n' }); addOrigin(repo)
    if (dirty) writeFileSync(join(repo, 'a.txt'), 'changed\n')
    const { ctx, config, world } = makeWorld({ cwd: repo, name: 'slot-1 · task-x' })
    world.procs = world.procs.filter(([pid]) => pid !== 202)
    if (dirty) {
      await assert.rejects(sessClose(ctx, config, TERM, {}), /грязный/)
      assert.deepEqual(world.closedPanes, [])
    } else {
      const { data } = await sessClose(ctx, config, TERM, {})
      assert.equal(data.release.status, 'released')
      assert.equal(git(repo, 'branch', '--show-current'), '')
    }
  }
})

test('close without a ref selects the only session in the current workspace or cwd subdirectory', async () => {
  for (const byEnv of [false, true]) {
    const { ctx, config, world } = makeWorld()
    ctx.cwd = byEnv ? '/elsewhere' : join(CWD, 'src')
    if (byEnv) {
      ctx.env.SUPERSET_WORKSPACE_ID = WS
      ctx.env.SUPERSET_TERMINAL_ID = 'companion-shell'
    }
    const { data } = await sessClose(ctx, config, undefined, { note: 'готово' })
    assert.equal(data.sessionId, SID)
    assert.equal(data.note, 'готово')
    assert.deepEqual(world.closedPanes, [`pane-${TERM}`])
  }
})

test('last without a ref reads the only current session, preserves waiting details and refuses ambiguity', () => {
  const { ctx, config, world } = makeWorld()
  ctx.cwd = join(CWD, 'src')
  world.append(prompt('p', at(ctx), 'задача'), say('a', at(ctx, 1), 'готово'), turnEnd('e', at(ctx, 2)))
  assert.equal(sessLast(ctx, config).text, 'готово')
  world.addSession(303, OTHER, 'neighbor')
  assert.throws(() => sessLast(ctx, config), /agent last <ID\|алиас>/)
  ctx.env.SUPERSET_TERMINAL_ID = TERM
  world.state = 'blocked'
  world.screens[TERM] = PERMISSION_SCREEN
  assert.equal(sessLast(ctx, config).data.waiting.kind, 'permission')
  assert.deepEqual(world.closedPanes, [])
})

test('close without a ref refuses ambiguous, empty, unknown and stale contexts without mutations', async () => {
  for (const scenario of ['ambiguous', 'empty', 'unknown', 'stale-workspace', 'stale-thread', 'neighbor-path']) {
    const { ctx, config, world } = makeWorld()
    ctx.cwd = CWD
    if (scenario === 'ambiguous') world.addSession(303, OTHER, 'neighbor')
    if (scenario === 'empty') world.procs = []
    if (scenario === 'unknown') ctx.cwd = '/somewhere-else'
    if (scenario === 'neighbor-path') ctx.cwd = `${CWD}-other`
    if (scenario === 'stale-workspace') ctx.env.SUPERSET_WORKSPACE_ID = 'missing'
    if (scenario === 'stale-thread') ctx.env.CODEX_THREAD_ID = 'missing'
    await assert.rejects(sessClose(ctx, config), /укажите ID или алиас/)
    assert.deepEqual(world.closedPanes, [])
    assert.deepEqual(loadRegistry(ctx).sessions, [])
  }
})

test('close of its own terminal queues a detached worker after validation; explicit refs work too', async () => {
  for (const ref of [undefined, TERM]) {
    const { ctx, config, world } = makeWorld()
    ctx.env.SUPERSET_TERMINAL_ID = TERM
    world.addSession(303, OTHER, 'neighbor')
    const spawned = []
    ctx.spawn = (...args) => {
      spawned.push(args)
      const child = new EventEmitter()
      child.unref = () => { child.unreffed = true }
      queueMicrotask(() => child.emit('spawn'))
      return child
    }
    world.state = 'working'
    await assert.rejects(sessClose(ctx, config, ref), /Сессия работает/)
    assert.equal(spawned.length, 0)
    const { data } = await sessClose(ctx, config, ref, { force: true, note: 'самозакрытие' })
    assert.equal(data.status, 'queued')
    const job = JSON.parse(readFileSync(data.resultFile, 'utf8'))
    assert.equal(job.target.sessionId, SID)
    assert.equal(job.options.note, 'самозакрытие')
    assert.equal(spawned[0][2].detached, true)
    assert.equal(spawned[0][2].stdio, 'ignore')
    assert.deepEqual(world.closedPanes, [], 'закрытие выполняет worker')
  }
})

test('self-close reports a worker launch error and keeps the session alive', async () => {
  const { ctx, config, world } = makeWorld()
  ctx.env.SUPERSET_TERMINAL_ID = TERM
  ctx.spawn = () => {
    const child = new EventEmitter()
    queueMicrotask(() => child.emit('error', new Error('spawn failed')))
    return child
  }
  await assert.rejects(sessClose(ctx, config), /Не удалось запустить закрытие: spawn failed/)
  assert.deepEqual(world.closedPanes, [])
  assert.equal(loadRegistry(ctx).sessions[0].sessionId, SID)
})

test('resume resolves a slot name (also «slot-N · task») to the workspace id', async () => {
  const repo = makeRepo({ 'a.txt': 'a' }); git(repo, 'switch', '-q', '-c', 'task-x')
  const { ctx, config, world } = makeWorld({ cwd: repo, name: 'slot-1 · task-x' }); world.procs = []
  await sessResume(ctx, config, 'sess-old', { workspace: 'slot-1', branch: 'task-x' })
  assert.equal(world.created[0][world.created[0].indexOf('--workspace') + 1], 'ws-1')
  await assert.rejects(sessResume(ctx, config, 'sess-old', { workspace: 'slot-9' }), /Воркспейс slot-9 не найден/)
})

const QUESTION_SCREEN = [
  'Тут была прошлая реплика ассистента',
  '────────────────────────────────────────',
  '☐ Вариант',
  '',
  'Какой вариант выбрать?',
  '',
  '❯ 1. Первый',
  '     Быстро',
  '  2. Второй',
  '  3. Type something.',
  '────────────────────────────────────────',
  '  Chat about this',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n')

const PERMISSION_SCREEN = [
  'Bash command',
  '  rm -rf build',
  '',
  'Do you want to proceed?',
  '❯ 1. Yes',
  "  2. Yes, and don't ask again for rm commands",
  '  3. No',
  'Esc to cancel',
].join('\n')

test('wait/last: screen of a waiting session tells question from permission', async () => {
  for (const [screen, kind, option] of [[QUESTION_SCREEN, 'question', 'Второй'], [PERMISSION_SCREEN, 'permission', 'No']]) {
    const { ctx, config, world } = makeWorld()
    world.append(prompt('p', at(ctx), 'задача'), say('a', at(ctx, 1), 'Спрошу'))
    world.state = 'blocked'
    world.screens[TERM] = screen
    const result = await sessWait(ctx, config, TERM, { marker: 'M' })
    assert.equal(result.code, EXIT.waiting)
    assert.equal(result.data.waiting.kind, kind)
    assert.ok(result.data.waiting.options.some((o) => o.label === option))
    assert.ok(!result.data.waiting.text.includes('прошлая реплика'))
    assert.match(result.text, new RegExp(kind === 'question' ? 'вопрос с вариантами' : 'запрос разрешения'))
    const last = sessLast(ctx, config, TERM)
    assert.equal(last.data.waiting.kind, kind)
    assert.match(last.text, /Спрошу[\s\S]*на экране/)
  }
})

test('wait/last: no screen when the session is not waiting; last works without an answer while waiting', async () => {
  const { ctx, config, world } = makeWorld()
  world.append(prompt('p', at(ctx), 'задача'), say('a', at(ctx, 1), 'готово'), turnEnd('e', at(ctx, 2)))
  world.screens[TERM] = QUESTION_SCREEN
  assert.equal((await sessWait(ctx, config, TERM, {})).data.waiting, null)
  assert.equal(sessLast(ctx, config, TERM).data.waiting, null)

  const fresh = makeWorld()
  fresh.world.state = 'blocked'
  fresh.world.screens[TERM] = PERMISSION_SCREEN
  assert.equal(sessLast(fresh.ctx, fresh.config, TERM).data.waiting.kind, 'permission')
})

test('executor launch rejects unprepared, dirty, occupied and mismatched slots even with --force', async () => {
  for (const reason of ['detached', 'base', 'free-name', 'branch', 'task', 'dirty', 'occupied']) {
    const repo = makeRepo({ 'a.txt': 'a' })
    if (reason === 'detached') git(repo, 'switch', '-q', '--detach')
    else if (reason !== 'base') git(repo, 'switch', '-q', '-c', 'task')
    const name = reason === 'free-name' ? 'slot-1' : 'slot-1 · task'
    const { ctx, config, world } = makeWorld({ cwd: repo, name })
    if (reason !== 'occupied') world.procs = []
    if (reason === 'dirty') writeFileSync(join(repo, 'a.txt'), 'keep this')
    const file = join(tempDir(), 'task.md'); writeFileSync(file, 'Do work')
    const opts = { workspace: WS, 'prompt-file': file, force: true,
      ...(reason === 'branch' ? { branch: 'other' } : {}), ...(reason === 'task' ? { task: 'other' } : {}) }
    const before = git(repo, 'status', '--porcelain')
    const branch = git(repo, 'branch', '--show-current')
    await assert.rejects(sessCreate(ctx, config, opts), (e) => e.code === 9, reason)
    assert.equal(world.created.length, 0, reason)
    assert.equal(git(repo, 'status', '--porcelain'), before, reason)
    assert.equal(git(repo, 'branch', '--show-current'), branch, reason)
  }
})

test('executor prompt includes exact assignment and independent self-check without duplicating prepare', async () => {
  const repo = makeRepo({ 'a.txt': 'a' }); git(repo, 'switch', '-q', '-c', 'task')
  const { ctx, config, world } = makeWorld({ cwd: repo, name: 'slot-1 · KEY' }); world.procs = []
  const file = join(tempDir(), 'task.md'); writeFileSync(file, 'Original task, unchanged.')
  const result = await sessCreate(ctx, config, { workspace: WS, 'prompt-file': file, branch: 'task', task: 'KEY', agent: 'claude' })
  const args = world.created[0]
  const prompt = args[args.indexOf('--prompt') + 1]
  assert.match(prompt, /agent status --json/)
  assert.ok(prompt.includes(JSON.stringify({ workspace: WS, path: repo, branch: 'task', task: 'KEY' })))
  assert.match(prompt, /повторный prepare не нужен/)
  assert.match(prompt, /не запускай нового исполнителя/)
  assert.ok(prompt.endsWith('Original task, unchanged.'))
  assert.equal(result.data.startup.branch, 'task')
  assert.equal(ctx.calls.some((c) => c.cmd === 'git' && ['fetch', 'switch', 'reset'].includes(c.args[0])), false)
})

test('orphan ACP process blocks executor launch even when no live chat or CLI session is listed', async () => {
  const repo = makeRepo({ 'a.txt': 'a' }); git(repo, 'switch', '-q', '-c', 'task')
  const { ctx, config, world } = makeWorld({ cwd: repo, name: 'slot-1 · task' }); world.procs = []
  world.addSession(404, OTHER, 'native-orphan', { agent: 'codex' })
  const run = ctx.run
  ctx.run = (cmd, args, opts) => {
    const r = run(cmd, args, opts)
    return cmd === 'ps' ? { ...r, stdout: r.stdout.replace(/codex --model test/g, 'codex app-server') } : r
  }
  const file = join(tempDir(), 'task.md'); writeFileSync(file, 'Do work')
  await assert.rejects(sessCreate(ctx, config, { workspace: WS, 'prompt-file': file, branch: 'task' }), /живая сессия/)
  assert.deepEqual(world.created, [])
})
