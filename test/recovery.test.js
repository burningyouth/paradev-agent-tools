import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { sessClose, sessResume } from '../src/sess-registry.js'
import { sessCreate, sessLs } from '../src/sess.js'
import { sessGc } from '../src/gc.js'
import { recordSession, sessLog } from '../src/session-history.js'
import { loadRegistry, readSessionEvents, saveRegistry } from '../src/store.js'
import { setAlias } from '../src/sessions.js'
import { rememberChatResult } from '../src/sessions.js'
import { AgentError } from '../src/context.js'
import { withSlotLock } from '../src/slot-lock.js'
import { makeWorld, TERM, WS, at, say, turnEnd } from './world.js'
import { git, makeRepo, tempDir } from './helpers.js'

const recoveryWorld = () => {
  const main = makeRepo({ 'a.txt': 'a\n' })
  const origin = join(tempDir(), 'origin.git')
  git(main, 'init', '-q', '--bare', origin)
  git(main, 'remote', 'add', 'origin', origin)
  git(main, 'push', '-q', 'origin', 'main')
  const path = join(tempDir(), 'slot-1')
  git(main, 'worktree', 'add', '-q', '-b', 'task', path)
  const w = makeWorld({ cwd: path, name: 'slot-1 · KEY', main })
  w.world.procs = w.world.procs.filter(([pid]) => pid !== 202)
  w.ctx.cwd = path
  return { ...w, main, path }
}

test('close saves full recovery identity, actually releases Git, then resume restores the branch and context', async () => {
  const w = recoveryWorld()
  setAlias(w.ctx, 'job', TERM)
  const head = git(w.path, 'rev-parse', 'HEAD')
  const closed = await sessClose(w.ctx, w.config, 'job', { note: 'Проверки готовы. Дальше ревью.', reason: 'ram' })
  assert.equal(closed.data.status, 'completed')
  assert.equal(closed.data.release.status, 'released')
  assert.equal(git(w.path, 'branch', '--show-current'), '')
  assert.equal(git(w.main, 'rev-parse', 'task'), head)
  const record = loadRegistry(w.ctx).sessions[0]
  assert.equal(record.branch, 'task'); assert.equal(record.task, 'KEY')
  assert.equal(record.agent, 'claude'); assert.equal(record.kind, 'cli')
  assert.equal(record.closeReason, 'ram'); assert.equal(record.status, 'closed')
  assert.equal(record.workspace, WS); assert.equal(record.note, 'Проверки готовы. Дальше ревью.')
  assert.ok(record.gitCommonDir); assert.ok(record.mainCheckout)
  const resumed = await sessResume(w.ctx, w.config, 'job')
  assert.equal(resumed.data.status, 'resumed')
  assert.equal(resumed.data.release, undefined)
  assert.equal(resumed.data.id, record.id)
  assert.equal(git(w.path, 'branch', '--show-current'), 'task')
  const prompt = w.world.created[0][w.world.created[0].indexOf('--prompt') + 1]
  assert.match(prompt, /Проверки готовы/); assert.match(prompt, /git diff/)
  assert.equal(loadRegistry(w.ctx).sessions.length, 1)
  assert.equal(loadRegistry(w.ctx).sessions[0].release, undefined)
  assert.deepEqual(readSessionEvents(w.ctx).map((e) => e.type), ['close-requested', 'closed', 'released', 'resume-requested', 'resumed', 'resumed'])
})

test('dirty saved branch resumes unchanged; dirty close and foreign occupied branches are blocked before mutations', async () => {
  const w = recoveryWorld()
  sessLs(w.ctx, w.config)
  w.world.procs = []
  writeFileSync(join(w.path, 'a.txt'), 'uncommitted\n')
  const result = await sessResume(w.ctx, w.config, 'sess-1')
  assert.equal(result.data.status, 'resumed')
  assert.equal(readFileSync(join(w.path, 'a.txt'), 'utf8'), 'uncommitted\n')
  await assert.rejects(sessClose(w.ctx, w.config, result.data.sessionId), /грязный/)
  assert.deepEqual(w.world.closedPanes, [])
  git(w.path, 'restore', 'a.txt'); w.world.procs = []
  git(w.path, 'switch', '-q', '-c', 'foreign')
  await assert.rejects(sessResume(w.ctx, w.config, 'sess-1'), /другой веткой/)
  assert.equal(git(w.path, 'branch', '--show-current'), 'foreign')
})

test('close dry-run and repeated close of an empty detached slot do not switch branches or run release twice', async () => {
  const w = recoveryWorld()
  const planned = await sessClose(w.ctx, w.config, TERM, { 'dry-run': true })
  assert.equal(planned.data.dryRun, true)
  assert.equal(git(w.path, 'branch', '--show-current'), 'task')
  assert.equal(loadRegistry(w.ctx).sessions.length, 0)
  await sessClose(w.ctx, w.config, TERM)
  const fetches = w.ctx.calls.filter((c) => c.cmd === 'git' && c.args[0] === 'fetch').length
  await sessClose(w.ctx, w.config)
  assert.equal(w.ctx.calls.filter((c) => c.cmd === 'git' && c.args[0] === 'fetch').length, fetches)
})

test('no UUID, foreign live session, and concurrent slot operations never close or release the target', async () => {
  const w = recoveryWorld()
  w.world.addSession(404, 'other-term', 'other-session')
  await assert.rejects(sessClose(w.ctx, w.config, TERM), /другая активная/)
  assert.deepEqual(w.world.closedPanes, [])
  w.world.procs = w.world.procs.filter(([pid]) => pid !== 404)
  await withSlotLock(w.ctx, { id: WS, path: w.path }, async () => {
    await assert.rejects(sessClose(w.ctx, w.config, TERM), /занят другой операцией/)
  })
  assert.equal(git(w.path, 'branch', '--show-current'), 'task')
  recordSession(w.ctx, { agent: 'codex', terminal: 'unknown-terminal', workspace: WS, cwd: w.path }, 'created')
  await assert.rejects(sessResume(w.ctx, w.config, 'unknown-terminal'), /нет UUID/)
})

test('journal remains readable offline, recovers an event ahead of the snapshot, and tolerates a torn trailing append', () => {
  const w = recoveryWorld()
  const record = recordSession(w.ctx, { agent: 'claude', sessionId: 'uuid-full', workspace: WS, cwd: w.path, project: 'proj', task: 'KEY' }, 'created')
  const file = join(w.ctx.agentHome, 'sessions.json')
  writeFileSync(file, JSON.stringify({ sessions: [], aliases: {}, keep: [] }))
  assert.equal(loadRegistry(w.ctx).sessions[0].id, record.id)
  appendFileSync(join(w.ctx.agentHome, 'session-log.jsonl'), '{"incomplete"')
  recordSession(w.ctx, record, 'checkpoint', { note: 'saved' })
  w.ctx.run = () => { throw new Error('Superset must not be called') }
  const log = sessLog(w.ctx, { project: 'proj', task: 'KEY' })
  assert.equal(log.data.sessions.length, 1); assert.equal(log.data.events.length, 2)
  assert.equal(log.data.sessions[0].note, 'saved')
})

test('resume selectors disambiguate tasks, last-closed and all-open; capacity applies to CLI and force cannot bypass it', async () => {
  const w = recoveryWorld()
  const first = recordSession(w.ctx, { agent: 'claude', kind: 'cli', sessionId: 'first', alias: 'one', project: 'proj', task: 'KEY', workspace: WS, cwd: w.path }, 'created')
  recordSession(w.ctx, { ...first, id: 'different', sessionId: 'second', alias: 'two', resumedFrom: undefined }, 'created')
  // Import a second legacy record with the same task to exercise ambiguity independently of ID chaining.
  const registry = loadRegistry(w.ctx)
  registry.sessions.push({ agent: 'claude', kind: 'cli', sessionId: 'third', task: 'KEY', project: 'proj', workspace: WS, cwd: w.path })
  saveRegistry(w.ctx, registry)
  await assert.rejects(sessResume(w.ctx, w.config, undefined, { task: 'KEY' }), /Несколько сессий/)
  await assert.rejects(sessResume(w.ctx, w.config, 'first', { 'all-open': true }), /один селектор/)
  const capped = await sessResume(w.ctx, { ...w.config, maxSessions: 1 }, undefined, { 'all-open': true, force: true })
  assert.ok(capped.data.sessions.some((s) => s.code === 8))
  assert.equal(w.world.created.length, 0)
})

test('deleted chat workspace and missing native UUID retain their journal entry without inventing a replacement', async () => {
  const w = recoveryWorld()
  recordSession(w.ctx, { kind: 'chat', agent: 'codex', sessionId: 'chat-uuid', nativeSessionId: 'native-uuid', workspace: 'deleted', project: 'proj', task: 'KEY', cwd: w.path }, 'closed')
  await assert.rejects(sessResume(w.ctx, w.config, undefined, { 'last-closed': true }), /Перенос chat не поддержан/)
  assert.equal(loadRegistry(w.ctx).sessions[0].nativeSessionId, 'native-uuid')
  assert.equal(w.world.created.length, 0)
})

test('GC never closes a dirty slot and uses the same verified release for a clean one', async () => {
  const w = recoveryWorld()
  w.ctx.env.SUPERSET_WORKSPACE_ID = WS
  w.world.append(say('a', at(w.ctx), 'Готово [[DONE-X]]'), turnEnd('e', at(w.ctx)))
  writeFileSync(join(w.path, 'a.txt'), 'dirty\n')
  const dirty = await sessGc(w.ctx, w.config, { apply: true, 'keep-pen': true })
  assert.equal(dirty.data.close.length, 0)
  assert.match(dirty.data.keep[0].skip, /грязная/)
  assert.equal(w.world.closedPanes.length, 0)
  git(w.path, 'restore', 'a.txt')
  const clean = await sessGc(w.ctx, w.config, { apply: true, 'keep-pen': true })
  assert.equal(clean.data.close[0].result.release.status, 'released')
  assert.equal(git(w.path, 'branch', '--show-current'), '')
})

test('flat and legacy log syntax are equivalent and offline; help advertises only the flat API', () => {
  const home = tempDir('agent-cli-log-')
  const bin = new URL('../bin/agent.js', import.meta.url)
  const run = (...args) => spawnSync(process.execPath, [bin.pathname, ...args], { encoding: 'utf8', env: { ...process.env, AGENT_CLI_HOME: home, SUPERSET_BIN: '/nonexistent' } })
  assert.deepEqual(JSON.parse(run('log', '--json').stdout), { sessions: [], events: [] })
  assert.equal(run('log', '--json').stdout, run('sess', 'log', '--json').stdout)
  assert.match(run('resume', '--help').stdout, /--all-open/)
  assert.doesNotMatch(run('--help').stdout, /agent sess|agent finish|slot release/)
  writeFileSync(join(home, 'config.json'), '{broken config')
  assert.equal(run('log', '--json').status, 0)
})

test('a deleted CLI workspace is restored in a free slot on the saved existing branch; dry-run performs no fetch', async () => {
  const w = recoveryWorld()
  const second = join(tempDir(), 'slot-2')
  git(w.main, 'worktree', 'add', '-q', '--detach', second, 'origin/main')
  const row = recordSession(w.ctx, { agent: 'claude', kind: 'cli', sessionId: 'saved-session', alias: 'saved',
    cwd: w.path, workspace: 'deleted-workspace', workspaceName: 'slot-1 · KEY', project: 'proj', branch: 'task', task: 'KEY' }, 'created')
  git(w.main, 'worktree', 'remove', w.path)
  const next = makeWorld({ cwd: second, name: 'slot-2', main: w.main })
  next.world.procs = []
  next.ctx.agentHome = w.ctx.agentHome
  const dry = await sessResume(next.ctx, next.config, 'saved', { 'dry-run': true })
  assert.equal(dry.data.action, 'take-slot-and-resume')
  assert.ok(!next.ctx.calls.some((c) => c.cmd === 'git' && ['fetch', 'switch'].includes(c.args[0])))
  const resumed = await sessResume(next.ctx, next.config, 'saved')
  assert.equal(resumed.data.id, row.id)
  assert.equal(resumed.data.workspace, WS)
  assert.equal(git(second, 'branch', '--show-current'), 'task')
  assert.equal(loadRegistry(next.ctx).sessions.length, 1)
})

test('failure to save blocks closing; a transport error is recorded as unknown, never as confirmed closed', async () => {
  const w = recoveryWorld()
  // A lock conflict is a reproducible persistence failure without touching real session data.
  mkdirSync(w.ctx.agentHome, { recursive: true })
  writeFileSync(join(w.ctx.agentHome, 'sessions.lock'), 'another operation')
  await assert.rejects(sessClose(w.ctx, w.config, TERM), /Реестр занят/)
  assert.deepEqual(w.world.closedPanes, [])
  rmSync(join(w.ctx.agentHome, 'sessions.lock'))
  const run = w.ctx.run
  w.ctx.run = (cmd, args, opts) => args[0] === 'panes' && args[1] === 'close'
    ? { status: 1, stdout: '', stderr: 'transport failed' } : run(cmd, args, opts)
  await assert.rejects(sessClose(w.ctx, w.config, TERM), /transport failed/)
  const record = loadRegistry(w.ctx).sessions[0]
  assert.equal(record.status, 'unknown')
  assert.equal(record.closedAt, undefined)
  assert.deepEqual(readSessionEvents(w.ctx).map((e) => e.type), ['close-requested', 'close-failed'])
  assert.equal(git(w.path, 'branch', '--show-current'), 'task')
})

test('a historical alias cannot release a slot reused by another task', async () => {
  const w = recoveryWorld()
  setAlias(w.ctx, 'old-task', TERM)
  await sessClose(w.ctx, w.config, 'old-task')
  git(w.path, 'switch', '-q', '-c', 'foreign-task')
  await assert.rejects(sessClose(w.ctx, w.config, 'old-task'), /назначение.*не совпадает/)
  assert.equal(git(w.path, 'branch', '--show-current'), 'foreign-task')
  assert.equal(loadRegistry(w.ctx).sessions[0].branch, 'task')
})

test('closing a crashed session by alias or from its empty slot marks the saved open record closed', async () => {
  for (const ref of ['crashed-task', undefined]) {
    const w = recoveryWorld()
    setAlias(w.ctx, 'crashed-task', TERM)
    sessLs(w.ctx, w.config)
    w.world.procs = []
    const head = git(w.path, 'rev-parse', 'HEAD')
    await sessClose(w.ctx, w.config, ref)
    const record = loadRegistry(w.ctx).sessions[0]
    assert.equal(record.status, 'closed')
    assert.ok(record.closedAt)
    assert.equal(record.release.status, 'released')
    assert.equal(record.head, head)
    assert.equal(record.branch, 'task')
    assert.equal((await sessResume(w.ctx, w.config, undefined, { 'all-open': true })).data.sessions.length, 0)
  }
})

test('closing rechecks running/waiting state after preflight and before touching transport', async () => {
  for (const state of ['working', 'blocked']) {
    const w = recoveryWorld()
    const run = w.ctx.run
    w.ctx.run = (cmd, args, opts) => {
      if (args[0] === 'projects' && args[1] === 'list') w.world.state = state
      return run(cmd, args, opts)
    }
    await assert.rejects(sessClose(w.ctx, w.config, TERM), /Сессия работает|ждёт ответа или разрешения/)
    assert.deepEqual(w.world.closedPanes, [])
    assert.equal(git(w.path, 'branch', '--show-current'), 'task')
  }
})

test('changed chat IDs are durable before enrichment fails, including alias/keep and crash replay', () => {
  const w = recoveryWorld()
  const original = recordSession(w.ctx, { agent: 'codex', kind: 'chat', sessionId: 'old-ui', nativeSessionId: 'native-uuid',
    terminal: 'old-term', workspace: WS, cwd: w.path, alias: 'job' }, 'created')
  const registry = loadRegistry(w.ctx); registry.keep.push('old-ui'); saveRegistry(w.ctx, registry)
  const updated = rememberChatResult(w.ctx, { chatList: () => {
    const saved = loadRegistry(w.ctx)
    assert.equal(saved.sessions[0].sessionId, 'new-ui')
    assert.equal(saved.aliases.job, 'new-term')
    assert.ok(saved.keep.includes('new-ui'))
    throw new AgentError('host disappeared')
  } }, original, { sessionId: 'new-ui', terminalId: 'new-term' })
  assert.equal(updated.sessionId, 'new-ui')
  assert.equal(updated.id, original.id)
  assert.ok(updated.sessionIds.includes('old-ui'))
})

test('observing a replaced chat transport with the same native UUID preserves one record and its alias', () => {
  const w = recoveryWorld()
  const original = recordSession(w.ctx, { agent: 'codex', kind: 'chat', sessionId: 'old-ui', nativeSessionId: 'native-uuid',
    terminal: 'old-term', workspace: WS, cwd: w.path, alias: 'job' }, 'created')
  const kept = loadRegistry(w.ctx); kept.keep.push('old-ui'); saveRegistry(w.ctx, kept)
  const updated = recordSession(w.ctx, { agent: 'codex', kind: 'chat', sessionId: 'new-ui', nativeSessionId: 'native-uuid',
    terminal: 'new-term', workspace: WS, cwd: w.path }, 'observed')
  assert.equal(updated.id, original.id)
  assert.equal(updated.alias, 'job')
  const registry = loadRegistry(w.ctx)
  assert.equal(registry.sessions.length, 1)
  assert.equal(registry.aliases.job, 'new-term')
  assert.ok(registry.keep.includes('new-ui'))
})
