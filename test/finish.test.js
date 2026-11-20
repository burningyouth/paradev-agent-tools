import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { sessFinish } from '../src/finish.js'
import { runFinishJob } from '../src/finish-runner.js'
import { closeCommand } from '../src/session-close.js'
import { slotPrepare, slotRelease } from '../src/slot.js'
import { advanceSlotGeneration, withSlotLock } from '../src/slot-lock.js'
import { readJson } from '../src/store.js'
import { fakeContext, git, makeRepo, tempDir, writeFiles } from './helpers.js'

const setup = ({ hook = false } = {}) => {
  const rules = { slot: { localFiles: ['.ai/rules.md'], ...(hook ? { release: 'node release.mjs' } : {}) } }
  const main = makeRepo({ 'a.txt': 'a\n', '.gitignore': '.ai/\n', '.agent-cli.json': JSON.stringify(rules) })
  const origin = join(tempDir(), 'origin.git')
  git(main, 'init', '-q', '--bare', origin); git(main, 'remote', 'add', 'origin', origin); git(main, 'push', '-q', 'origin', 'main')
  const path = join(tempDir(), 'slot-1')
  git(main, 'worktree', 'add', '-q', '-b', 'task', path)
  writeFiles(path, { '.ai/rules.md': '# Saved\nlocal rule\n' })
  const ws = { id: 'ws-finish', name: 'slot-1 · task', projectName: 'proj', worktreePath: path }
  const chat = { sessionId: 'chat-self', terminalId: 'terminal-self', harnessSessionId: 'native-self', harness: 'codex-acp', status: 'idle', live: true }
  const w = { main, path, ws, chat, chats: [chat], native: false, events: [], closeCalls: [], spawns: 0, notifications: [], hookCalls: 0 }
  const rollout = join(tempDir(), 'rollout-self.jsonl')
  writeFileSync(rollout, JSON.stringify({ type: 'session_meta', payload: { id: 'native-self', cwd: path, source: 'cli' } }) + '\n')
  const ctx = fakeContext({
    ps: (args) => {
      if (args[0] === '-axo') return w.native ? '123 1 100 /opt/codex app-server\n' : ''
      return '/opt/codex app-server' + (args[0] === '-E' ? ` SUPERSET_WORKSPACE_ID=${ws.id} SUPERSET_TERMINAL_ID=${chat.terminalId}` : '')
    },
    lsof: () => `p123\nn${rollout}\n`,
    node: () => {
      w.hookCalls++
      if (w.hookError) return { status: 1, stderr: 'release failed' }
      if (!w.hookNoop) git(path, 'switch', '-q', '--detach', 'origin/main')
      return '✅ released'
    },
    superset: (args) => {
      const key = args.slice(0, 2).join(' ')
      const flag = (name) => args[args.indexOf(name) + 1]
      if (w.hostError && key !== 'notifications show') return { status: 1, stderr: 'host unavailable' }
      if (key === 'ws list') return JSON.stringify([ws])
      if (key === 'snapshot --json') return JSON.stringify({ workspaces: [] })
      if (key === 'projects list') return JSON.stringify([{ name: 'proj', path: main }])
      if (key === 'sessions list') return JSON.stringify(w.chats)
      if (key === 'sessions read') return JSON.stringify({ ok: true, envelopes: w.events })
      if (key === 'sessions close') {
        w.closeCalls.push(flag('--session')); chat.live = false; chat.status = 'not_loaded'; w.onClose?.()
        return '{}'
      }
      if (key === 'ws update') { ws.name = flag('--name'); return '{}' }
      if (key === 'notifications show') {
        w.notifications.push(args)
        return w.notifyError ? { status: 1, stderr: 'notifications disabled' } : '{}'
      }
      throw new Error(key)
    },
  })
  ctx.cwd = path; ctx.env.SUPERSET_WORKSPACE_ID = ws.id; ctx.env.CODEX_THREAD_ID = 'native-self'; ctx.env.SUPERSET_TERMINAL_ID = chat.terminalId
  ctx.spawn = () => { w.spawns++; const e = new EventEmitter(); e.unref = () => {}; queueMicrotask(() => e.emit('spawn')); return e }
  const sleep = ctx.sleep
  ctx.sleep = async (ms) => { await sleep(ms); w.onSleep?.() }
  const event = (ev) => w.events.push({ ts: ctx.now(), cursor: { epoch: 'test', seq: w.events.length + 1 }, event: ev })
  w.prompt = (text) => event({ type: 'item', item: { id: `prompt-${w.events.length}`, kind: 'user_message', content: [{ type: 'text', text }] } })
  w.prompt('complete this task')
  const summary = join(tempDir(), 'summary.md'); writeFileSync(summary, 'Done. Checks passed. Commit saved. Next: review.\n')
  const config = { superset: 'superset' }
  w.queue = (opts = {}) => sessFinish(ctx, config, [], { 'release-slot': true, 'summary-file': summary, ...opts })
  w.ready = (receipt, { status = 'completed', kind = 'agent_message' } = {}) => {
    event({ type: 'item', item: { id: `answer-${w.events.length}`, kind, text: `Saved outcome. ${receipt}` } })
    event({ type: 'turn', turn: { status } })
  }
  w.run = (job, file, limits = {}) => runFinishJob(ctx, job, file, { deliveryMs: 3000, exitMs: 5000, ...limits })
  return Object.assign(w, { ctx, config, summary, event })
}
const queued = async (w) => {
  const r = await w.queue()
  return { r, job: readJson(r.data.resultFile), file: r.data.resultFile }
}

test('finish saves report before queue, is idempotent, and never uses force or fallback identity', async () => {
  const w = setup(); const { r, job } = await queued(w)
  assert.equal(readFileSync(job.summaryFile, 'utf8'), readFileSync(w.summary, 'utf8'))
  assert.equal((await w.queue()).data.resultFile, r.data.resultFile)
  assert.equal(w.spawns, 1); assert.deepEqual(w.closeCalls, [])
  await assert.rejects(w.queue({ force: true }), /force/)
  delete w.ctx.env.CODEX_THREAD_ID; delete w.ctx.env.SUPERSET_TERMINAL_ID
  await assert.rejects(w.queue(), /точный вызывающий/)
})

test('exact chat closes after its completed reply without caller env, preserving dirty slot and neighboring chat', async () => {
  const w = setup({ hook: true })
  delete w.ctx.env.CODEX_THREAD_ID; delete w.ctx.env.SUPERSET_TERMINAL_ID
  w.chat.status = 'running'
  w.chats.push({ ...w.chat, sessionId: 'other', terminalId: 'other-terminal', harnessSessionId: 'other-native' })
  writeFileSync(join(w.path, 'a.txt'), 'unfinished\n')
  const options = { workspace: w.ws.id, 'session-only': true, 'summary-file': w.summary }
  const close = (opts, ref = w.chat.sessionId) => closeCommand(w.ctx, w.config, ref, { ...options, ...opts })
  await assert.rejects(close({ 'dry-run': true }), /Сессия работает/)
  await assert.rejects(close({ 'after-reply': true, force: true }), /несовместим/)
  await assert.rejects(close({ 'after-reply': true }, 'chat-s'), /точный живой чат/)
  const preview = await close({ 'after-reply': true, 'dry-run': true })
  assert.equal(preview.data.afterReply, true); assert.equal(preview.data.release, false); assert.equal(w.spawns, 0)
  const { data } = await close({ 'after-reply': true })
  assert.equal(data.status, 'queued'); assert.deepEqual(w.closeCalls, [])
  w.ready(data.receipt, { status: 'interrupted' })
  w.onSleep = () => {
    w.onSleep = null
    assert.deepEqual(w.closeCalls, [])
    w.ready(data.receipt)
    w.chat.status = 'idle'
  }
  const job = await w.run(readJson(data.resultFile), data.resultFile)
  assert.equal(job.status, 'completed', job.error)
  assert.equal(job.close.status, 'closed'); assert.equal(job.release.status, 'not-applicable')
  assert.equal(w.chats[1].live, true); assert.deepEqual(w.closeCalls, ['chat-self'])
  assert.equal(w.hookCalls, 0); assert.equal(w.ws.name, 'slot-1 · task')
  assert.equal(git(w.path, 'branch', '--show-current'), 'task')
  assert.equal(readFileSync(join(w.path, 'a.txt'), 'utf8'), 'unfinished\n')
})

test('delayed ACP app-server exit is awaited; actual Git, local files, Superset and task branch verified', async () => {
  const w = setup(); const { r, job, file } = await queued(w)
  w.native = true; w.ready(r.data.receipt)
  let closingTicks = 0
  w.onSleep = () => { if (!w.chat.live && ++closingTicks === 3) w.native = false }
  const result = await w.run(job, file)
  assert.equal(result.status, 'completed', result.error)
  assert.equal(closingTicks, 3)
  assert.equal(result.close.status, 'closed'); assert.equal(result.release.status, 'released')
  assert.equal(git(w.path, 'branch', '--show-current'), '')
  assert.equal(git(w.main, 'rev-parse', 'task'), job.owner.head)
  assert.equal(w.ws.name, 'slot-1')
  assert.equal(readFileSync(join(w.main, '.ai/rules.md'), 'utf8'), '# Saved\nlocal rule\n')
  assert.equal(result.notification.status, 'accepted')
  assert.deepEqual(w.closeCalls, ['chat-self'])
})

test('another chat is left open: own close succeeds, release stays blocked', async () => {
  const w = setup(); const { r, job, file } = await queued(w)
  w.chats.push({ ...w.chat, sessionId: 'other', terminalId: 'other-terminal', harnessSessionId: 'other-native' })
  w.ready(r.data.receipt)
  const result = await w.run(job, file)
  assert.equal(result.close.status, 'closed', result.error)
  assert.equal(result.release.status, 'blocked')
  assert.equal(w.chats[1].live, true); assert.deepEqual(w.closeCalls, ['chat-self'])
  assert.equal(w.ws.name, 'slot-1 · task'); assert.equal(git(w.path, 'branch', '--show-current'), 'task')
})

test('native never exits: no release, bounded wait, no killing or second close', async () => {
  const w = setup(); const { r, job, file } = await queued(w)
  w.ready(r.data.receipt); w.native = true
  const result = await w.run(job, file)
  assert.equal(result.code, 2); assert.equal(result.close.status, 'closed')
  assert.match(result.error, /native/)
  assert.deepEqual(w.closeCalls, ['chat-self']); assert.equal(w.ws.name, 'slot-1 · task')
})

test('missing receipt, tool-only receipt, interrupted/failed turn and new prompt never close the chat', async () => {
  for (const mode of ['missing', 'tool', 'interrupted', 'failed', 'new-prompt']) {
    const w = setup(); const { r, job, file } = await queued(w)
    if (mode !== 'missing') w.ready(r.data.receipt, { kind: mode === 'tool' ? 'tool_call' : 'agent_message', status: ['failed', 'interrupted'].includes(mode) ? mode : 'completed' })
    if (mode === 'new-prompt') w.prompt('wait, do another task')
    const result = await w.run(job, file)
    assert.notEqual(result.status, 'completed', mode); assert.equal(w.chat.live, true, mode); assert.deepEqual(w.closeCalls, [], mode)
  }
})

test('dirty at queue, before close or after close preserves edits and refuses release', async () => {
  const initial = setup(); writeFileSync(join(initial.path, 'a.txt'), 'keep this')
  await assert.rejects(initial.queue(), /грязный/)
  for (const phase of ['before', 'after']) {
    const w = setup(); const { r, job, file } = await queued(w); w.ready(r.data.receipt)
    const dirty = () => writeFileSync(join(w.path, 'a.txt'), 'keep this')
    if (phase === 'before') dirty(); else w.onClose = dirty
    const result = await w.run(job, file)
    assert.equal(result.status, 'blocked'); assert.match(result.error, /грязный/)
    assert.equal(readFileSync(join(w.path, 'a.txt'), 'utf8'), 'keep this')
    assert.equal(w.closeCalls.length, phase === 'before' ? 0 : 1)
  }
})

test('generation change, replaced IDs, branch/HEAD/name/config changes cancel stale jobs', async () => {
  for (const mode of ['generation', 'id', 'terminal', 'branch', 'head', 'name', 'config']) {
    const w = setup(); const { r, job, file } = await queued(w); w.ready(r.data.receipt)
    if (mode === 'generation') advanceSlotGeneration(w.ctx, { path: w.path })
    if (mode === 'id') w.chat.sessionId = 'new-id'
    if (mode === 'terminal') w.chat.terminalId = 'new-terminal'
    if (mode === 'name') w.ws.name = 'slot-1 · new task'
    if (mode === 'branch') git(w.path, 'switch', '-q', '-c', 'new-task')
    if (mode === 'head') git(w.path, 'commit', '-q', '--allow-empty', '-m', 'new task')
    if (mode === 'config') writeFileSync(join(w.main, '.agent-cli.json'), '{}')
    const result = await w.run(job, file)
    assert.notEqual(result.status, 'completed', mode); assert.deepEqual(w.closeCalls, [], mode)
  }
})

test('project release runs once; no built-in fallback on failed or false-success hook', async () => {
  for (const mode of ['success', 'error', 'noop']) {
    const w = setup({ hook: true }); const { r, job, file } = await queued(w); w.ready(r.data.receipt)
    w.hookError = mode === 'error'; w.hookNoop = mode === 'noop'
    const result = await w.run(job, file)
    assert.equal(w.hookCalls, 1)
    assert.equal(result.status === 'completed', mode === 'success', result.error)
    if (mode !== 'success') assert.equal(git(w.path, 'branch', '--show-current'), 'task')
  }
})

test('host errors leave chat alone; notification failure preserves completed release', async () => {
  for (const mode of ['host', 'notification']) {
    const w = setup(); const { r, job, file } = await queued(w); w.ready(r.data.receipt)
    w.hostError = mode === 'host'; w.notifyError = mode === 'notification'
    const result = await w.run(job, file)
    if (mode === 'host') { assert.notEqual(result.status, 'completed'); assert.deepEqual(w.closeCalls, []) }
    else { assert.equal(result.status, 'completed', result.error); assert.equal(result.notification.status, 'error') }
    assert.equal(readJson(file).status, result.status)
  }
})

test('finish/prepare/release share the same lock; attempted new prepare invalidates queued finish', async () => {
  const w = setup(); const { r, job, file } = await queued(w)
  withSlotLock(w.ctx, { path: w.path, id: w.ws.id }, () => {
    assert.throws(() => slotRelease(w.ctx, w.config, w.ws.id), /Блокировка/)
    assert.throws(() => slotPrepare(w.ctx, w.config, w.ws.id, { branch: 'new' }), /Блокировка/)
  })
  assert.throws(() => slotPrepare(w.ctx, w.config, w.ws.id, { branch: 'new' }), /живая сессия/)
  w.ready(r.data.receipt)
  const result = await w.run(job, file)
  assert.match(result.error, /Принадлежность/); assert.deepEqual(w.closeCalls, [])
})

test('already detached Git completes Superset release without repeating the project release hook', async () => {
  const w = setup({ hook: true }); git(w.path, 'switch', '-q', '--detach', 'origin/main')
  const { r, job, file } = await queued(w); w.ready(r.data.receipt)
  const result = await w.run(job, file)
  assert.equal(result.status, 'completed', result.error)
  assert.equal(w.hookCalls, 0); assert.equal(w.ws.name, 'slot-1')
})

test('own chat replaces its IDs after close: replacement is never closed and blocks release', async () => {
  const w = setup(); const { r, job, file } = await queued(w); w.ready(r.data.receipt)
  w.onClose = () => w.chats.push({ ...w.chat, live: true, status: 'idle', sessionId: 'resumed-self' })
  const result = await w.run(job, file)
  assert.equal(result.close.status, 'closed'); assert.equal(result.release.status, 'blocked')
  assert.deepEqual(w.closeCalls, ['chat-self']); assert.equal(w.chats[1].live, true)
})

test('same-ID chat started again before close is not interrupted', async () => {
  const w = setup(); const { r, job, file } = await queued(w); w.ready(r.data.receipt)
  w.chat.status = 'running'
  const result = await w.run(job, file)
  assert.equal(result.status, 'blocked'); assert.deepEqual(w.closeCalls, [])
})

test('changed stored summary and pending approval refuse close', async () => {
  for (const mode of ['summary', 'approval']) {
    const w = setup(); const { r, job, file } = await queued(w); w.ready(r.data.receipt)
    if (mode === 'summary') writeFileSync(job.summaryFile, 'changed')
    else w.event({ type: 'item', item: { id: 'approval', kind: 'approval_request', status: 'pending', title: 'Allow?' } })
    const result = await w.run(job, file)
    assert.notEqual(result.status, 'completed'); assert.deepEqual(w.closeCalls, [])
  }
})

test('spawn failure preserves summary and durable error without closing chat', async () => {
  const w = setup(); w.ctx.spawn = () => { throw new Error('spawn failed') }
  await assert.rejects(w.queue(), /Worker не запущен.*Итог сохранён/)
  assert.equal(w.chat.live, true); assert.deepEqual(w.closeCalls, [])
})
