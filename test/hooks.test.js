import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { sessionHook, runSessionEndJob, installHooks } from '../src/hooks.js'
import { closeTarget } from '../src/session-close.js'
import { recordSession } from '../src/session-history.js'
import { advanceSlotGeneration } from '../src/slot-lock.js'
import { findSlot } from '../src/slot.js'
import { loadRegistry, readJson, writeJson } from '../src/store.js'
import { addOrigin, fakeContext, git, makeRepo, tempDir } from './helpers.js'

const setup = () => {
  const main = makeRepo({ 'a.txt': 'a\n' }); addOrigin(main)
  const path = join(tempDir(), 'slot-1'); git(main, 'worktree', 'add', '-q', '-b', 'task', path)
  const ws = { id: 'ws', name: 'slot-1 · task', projectName: 'proj', worktreePath: path }
  const chat = { sessionId: 'ui-id', terminalId: 'term', harnessSessionId: 'native-id', harness: 'codex-acp', status: 'idle', live: true }
  const w = { main, path, ws, chat, native: false, spawns: 0, notifications: [], closeCalls: 0, other: [] }
  const ctx = fakeContext({
    ps: (args) => args[0] === '-axo' ? (w.native ? '123 1 100 /opt/codex app-server\n' : '') :
      '/opt/codex app-server' + (args[0] === '-E' ? ' SUPERSET_WORKSPACE_ID=ws SUPERSET_TERMINAL_ID=term' : ''),
    lsof: () => '',
    superset: (args) => {
      const key = args.slice(0, 2).join(' ')
      if (key === 'ws list') return JSON.stringify([ws])
      if (key === 'snapshot --json') return JSON.stringify({ workspaces: [] })
      if (key === 'projects list') return JSON.stringify([{ name: 'proj', path: main }])
      if (key === 'sessions list') return JSON.stringify([chat, ...w.other])
      if (key === 'sessions read') return JSON.stringify({ ok: true, envelopes: [] })
      if (key === 'sessions close') { w.closeCalls++; chat.live = false; return '{}' }
      if (key === 'ws update') { ws.name = args[args.indexOf('--name') + 1]; return '{}' }
      if (key === 'notifications show') { w.notifications.push(args); return '{}' }
      throw new Error(key)
    },
  })
  ctx.cwd = path; ctx.env.SUPERSET_WORKSPACE_ID = ws.id; ctx.env.SUPERSET_TERMINAL_ID = chat.terminalId; ctx.env.AGENT_HOOK_RUNTIME_PID = '123'
  ctx.spawn = () => { w.spawns++; const e = new EventEmitter(); e.unref = () => {}; queueMicrotask(() => e.emit('spawn')); return e }
  const sleep = ctx.sleep; ctx.sleep = async (ms) => { await sleep(ms); w.onSleep?.() }
  const config = { superset: 'superset' }
  const hook = (action, patch = {}, opts = {}) => sessionHook(ctx, config, action, {
    hook_event_name: { 'session-start': 'SessionStart', stop: 'Stop', 'session-end': 'SessionEnd' }[action],
    session_id: 'native-id', cwd: path, ...patch,
  }, opts)
  w.start = () => hook('session-start', { source: 'startup' })
  w.end = () => hook('session-end', { reason: 'other' })
  w.run = async (file) => runSessionEndJob(ctx, readJson(file), file, { exitMs: 2000 })
  return Object.assign(w, { ctx, config, hook })
}

test('SessionEnd queues once, waits for actual exit, saves note and releases the real Git slot', async () => {
  const w = setup(); await w.start()
  await w.hook('stop', { last_assistant_message: 'Stopped at verify. Next: tests.' })
  assert.equal(w.spawns, 0); assert.equal(git(w.path, 'branch', '--show-current'), 'task')
  w.native = true
  const queued = await w.end()
  assert.equal((await w.end()).data.resultFile, queued.data.resultFile)
  assert.equal(w.spawns, 1)
  w.onSleep = () => { w.chat.live = false; w.native = false }
  const job = await w.run(queued.data.resultFile)
  assert.equal(job.status, 'completed', JSON.stringify(job))
  assert.equal(job.release.status, 'released'); assert.equal(job.notification.status, 'accepted')
  assert.equal(w.ws.name, 'slot-1'); assert.equal(git(w.path, 'branch', '--show-current'), '')
  assert.equal(git(w.main, 'rev-parse', 'task'), job.owner.head)
  assert.equal(w.closeCalls, 0)
  const record = loadRegistry(w.ctx).sessions[0]
  assert.equal(record.status, 'closed'); assert.equal(record.nativeSessionId, 'native-id')
  assert.equal(record.note, 'Stopped at verify. Next: tests.'); assert.equal(record.closeReason, 'session-end:other')
})

test('dirty slot keeps files and branch, while a closed conversation remains in recovery history', async () => {
  const w = setup(); await w.start(); writeFileSync(join(w.path, 'a.txt'), 'unfinished\n')
  const { data } = await w.end(); w.chat.live = false
  const job = await w.run(data.resultFile)
  assert.equal(job.status, 'blocked'); assert.match(job.error, /грязный/)
  assert.equal(job.close.status, 'closed'); assert.equal(job.release.status, 'blocked')
  assert.equal(loadRegistry(w.ctx).sessions[0].status, 'closed')
  assert.equal(readFileSync(join(w.path, 'a.txt'), 'utf8'), 'unfinished\n')
  assert.equal(git(w.path, 'branch', '--show-current'), 'task'); assert.equal(w.closeCalls, 0)
})

test('Stop, clear, child, foreign harness and unknown identity never trigger a release', async () => {
  const w = setup()
  for (const [action, patch, opts] of [
    ['session-end', {}, {}], ['session-start', { agent_id: 'child' }, {}],
    ['session-start', { session_id: 'child-native' }, {}], ['session-start', { source: 'fork' }, {}],
    ['session-end', { reason: 'clear' }, {}],
  ]) assert.equal((await w.hook(action, patch, opts)).data.status, 'ignored')
  await w.start(); await w.hook('stop', { last_assistant_message: 'done' })
  w.ctx.env.SUPERSET_AGENT_ID = 'claude'
  assert.equal((await w.end()).data.status, 'ignored')
  assert.equal(w.spawns, 0); assert.equal(w.closeCalls, 0)
})

test('a new assignment or a remaining foreign chat prevents release', async () => {
  for (const change of ['generation', 'branch', 'chat']) {
    const w = setup(); await w.start(); const { data } = await w.end(); w.chat.live = false
    if (change === 'generation') advanceSlotGeneration(w.ctx, findSlot(w.ctx, w.config, w.ws.id))
    if (change === 'branch') git(w.path, 'switch', '-q', '-c', 'foreign')
    if (change === 'chat') w.other.push({ ...w.chat, sessionId: 'other', terminalId: 'other', harnessSessionId: 'other-native', live: true })
    const job = await w.run(data.resultFile)
    assert.equal(job.status, 'blocked', change); assert.equal(job.release.status, 'blocked')
    assert.ok(git(w.path, 'branch', '--show-current')); assert.equal(w.closeCalls, 0)
  }
})

test('still-open conversation times out without closing its transport', async () => {
  const w = setup(); await w.start(); const { data } = await w.end()
  const job = await w.run(data.resultFile)
  assert.equal(job.status, 'blocked'); assert.match(job.error, /не завершились/)
  assert.equal(job.close.status, 'pending'); assert.equal(w.closeCalls, 0)
})

test('a stale end job cannot mark a resumed transport closed or release its slot', async () => {
  const w = setup(); await w.start(); const { data } = await w.end(); w.chat.live = false
  const registry = loadRegistry(w.ctx)
  registry.sessions[0].sessionId = 'resumed-ui'; registry.sessions[0].terminal = 'resumed-terminal'
  writeJson(join(w.ctx.agentHome, 'sessions.json'), registry)
  const job = await w.run(data.resultFile)
  assert.equal(job.status, 'blocked'); assert.match(job.error, /возобновлена/)
  assert.equal(loadRegistry(w.ctx).sessions[0].sessionId, 'resumed-ui')
  assert.equal(loadRegistry(w.ctx).sessions[0].status, 'open')
  assert.equal(git(w.path, 'branch', '--show-current'), 'task')
})

test('same-ID resume between exit observation and ownership lookup cannot be marked closed', async () => {
  const w = setup(); await w.start(); const { data } = await w.end(); w.chat.live = false
  const run = w.ctx.run
  let lists = 0
  w.ctx.run = (cmd, args, opts) => {
    if (args[0] === 'sessions' && args[1] === 'list' && ++lists === 2) {
      w.chat.live = true
      recordSession(w.ctx, loadRegistry(w.ctx).sessions[0], 'resume-requested', {}, { context: false })
      recordSession(w.ctx, loadRegistry(w.ctx).sessions[0], 'resumed', {}, { context: false })
      advanceSlotGeneration(w.ctx, { id: w.ws.id, path: w.path })
    }
    return run(cmd, args, opts)
  }
  const job = await w.run(data.resultFile)
  assert.equal(job.status, 'blocked'); assert.equal(loadRegistry(w.ctx).sessions[0].status, 'open')
  assert.equal(w.chat.live, true); assert.equal(git(w.path, 'branch', '--show-current'), 'task')
})

test('registry rejects an old lifecycle atomically even when every transport ID is unchanged', async () => {
  const w = setup(); await w.start(); const old = loadRegistry(w.ctx).sessions[0]
  recordSession(w.ctx, old, 'resume-requested', {}, { context: false })
  assert.throws(() => recordSession(w.ctx, old, 'closed', {}, { context: false, expected: { lifecycleId: old.lifecycleId } }), /возобновлена/)
  assert.equal(loadRegistry(w.ctx).sessions[0].status, 'open')
})

test('a delayed SessionEnd from the previous runtime cannot consume the new runtime end job', async () => {
  const w = setup(); await w.start()
  w.ctx.env.AGENT_HOOK_RUNTIME_PID = '456'; await w.start()
  w.ctx.env.AGENT_HOOK_RUNTIME_PID = '123'
  await assert.rejects(w.end(), /возобновлена/)
  w.ctx.env.AGENT_HOOK_RUNTIME_PID = '456'
  const { data } = await w.end(); w.chat.live = false
  assert.equal((await w.run(data.resultFile)).status, 'completed')
})

test('post-create/resume enrichment preserves an earlier runtime SessionStart lifecycle', async () => {
  for (const type of ['created', 'resumed']) {
    const w = setup(); await w.start()
    const before = loadRegistry(w.ctx).sessions[0]
    recordSession(w.ctx, before, type)
    recordSession(w.ctx, before, type)
    assert.equal(loadRegistry(w.ctx).sessions[0].lifecycleId, before.lifecycleId)
    const { data } = await w.end(); w.chat.live = false
    assert.equal((await w.run(data.resultFile)).status, 'completed')
  }
})

test('hooks accept a session launched from a subdirectory without confusing it with the repository root', async () => {
  const w = setup(); const cwd = join(w.path, 'nested')
  mkdirSync(cwd)
  await w.hook('session-start', { cwd })
  const { data } = await w.hook('session-end', { cwd, reason: 'other' }); w.chat.live = false
  assert.equal((await w.run(data.resultFile)).status, 'completed')
})

test('explicit close followed by SessionEnd shares the release instead of repeating it', async () => {
  const w = setup(); await w.start(); const { data } = await w.end()
  await closeTarget(w.ctx, w.config, { kind: 'chat', agent: 'codex', sessionId: w.chat.sessionId, nativeSessionId: 'native-id',
    terminal: 'term', workspace: 'ws', cwd: w.path, workspaceName: w.ws.name, project: 'proj', state: 'idle' })
  const job = await w.run(data.resultFile)
  assert.equal(job.status, 'completed', JSON.stringify(job)); assert.equal(job.release.duplicate, true)
  assert.equal(w.closeCalls, 1)
})

test('hook installer preserves Superset hooks/settings, backs up, is idempotent and never writes trust', () => {
  const w = setup(); const path = join(w.ctx.codexHome, 'hooks.json')
  const original = { hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'superset-notify' }] }] }, description: 'existing' }
  writeJson(path, original)
  assert.equal(installHooks(w.ctx, { 'dry-run': true }).data.changed, true)
  assert.deepEqual(readJson(path), original)
  const installed = installHooks(w.ctx).data
  assert.deepEqual(readJson(installed.backup), original)
  assert.equal(readJson(path).hooks.SessionEnd[0].hooks[0].command, 'superset-notify')
  assert.deepEqual(['SessionStart', 'Stop', 'SessionEnd'].map((event) => readJson(path).hooks[event].at(-1).hooks[0].statusMessage),
    ['agent-cli: регистрация сессии', 'agent-cli: сохранение состояния', 'agent-cli: освобождение слота'])
  assert.equal(readJson(path).hooks.SessionEnd.at(-1).hooks[0].timeout, 3)
  // Upgrade definitions written by the earlier installer without adding duplicates.
  const unnamed = readJson(path)
  for (const event of ['SessionStart', 'Stop', 'SessionEnd']) delete unnamed.hooks[event].at(-1).hooks[0].statusMessage
  writeJson(path, unnamed)
  assert.equal(installHooks(w.ctx).data.changed, true)
  assert.equal(readJson(path).hooks.SessionEnd.length, 2)
  assert.equal(installHooks(w.ctx).data.changed, false)
  assert.equal(existsSync(join(w.ctx.codexHome, 'config.toml')), false)
})

test('reinstall updates moved Node/package paths and removes managed duplicates while preserving similarly named foreign commands', () => {
  const w = setup(); const first = installHooks(w.ctx).data
  const settings = readJson(first.path)
  for (const event of ['SessionStart', 'Stop', 'SessionEnd']) {
    const hook = settings.hooks[event][0].hooks[0]
    hook.command = hook.command.replace(/'[^']*' '[^']*\/bin\/agent\.js'/, "'/old/node' '/old/package/bin/agent.js'")
    settings.hooks[event].push(structuredClone(settings.hooks[event][0]))
  }
  settings.hooks.Stop.push({ hooks: [{ type: 'command', command: 'echo keep', statusMessage: 'agent-cli: сохранение состояния' }] })
  writeJson(first.path, settings)
  assert.equal(installHooks(w.ctx).data.changed, true)
  const after = readJson(first.path)
  for (const event of ['SessionStart', 'Stop', 'SessionEnd']) {
    const own = after.hooks[event].flatMap((g) => g.hooks).filter((h) => h.command.includes(' hook '))
    assert.equal(own.length, 1)
    assert.ok(!own[0].command.includes('/old/'))
  }
  assert.ok(after.hooks.Stop.flatMap((g) => g.hooks).some((h) => h.command === 'echo keep'))
  assert.equal(installHooks(w.ctx).data.changed, false)
})
