import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { chatModel, readChat } from '../src/chat.js'
import { superset } from '../src/superset.js'
import { sessCreate, sessLs, sessLast, sessSend, sessWait } from '../src/sess.js'
import { sessClose, sessResume, sessKeep } from '../src/sess-registry.js'
import { sessGc } from '../src/gc.js'
import { resolveCurrentSession } from '../src/sessions.js'
import { loadRegistry } from '../src/store.js'
import { makeWorld, WS, TERM } from './world.js'
import { tempDir } from './helpers.js'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/chat-read.json', import.meta.url)))
const SID = fixture.envelopes[0].sessionId
const CT = 'chat-terminal-123'
const flag = (args, key) => args[args.indexOf(key) + 1]
const chatWorld = () => {
  const w = makeWorld()
  const { ctx } = w
  const run = ctx.run
  const chat = { sessionId: SID, terminalId: CT, harness: 'codex-acp', harnessSessionId: 'native-chat', status: 'idle', live: true, updatedAt: ctx.now() }
  const events = structuredClone(fixture.envelopes)
  const calls = []
  let onSend = (text) => events.push({ sessionId: SID, ts: ctx.now(), cursor: { epoch: 'new-epoch', seq: events.length + 1 }, event: { type: 'item', item: { id: `sent-${events.length}`, kind: 'user_message', content: [{ type: 'text', text }] } } })
  ctx.run = (cmd, args, opts) => {
    if (args[0] !== 'sessions') return run(cmd, args, opts)
    calls.push({ args, opts })
    const sub = args[1]
    if (sub === 'send' && w.hang) return { status: 124, stderr: 'timeout', stdout: '' }
    let data
    if (sub === 'list') data = w.noChat ? [] : [chat]
    if (sub === 'read') data = { ok: true, envelopes: events, nextBefore: null }
    if (sub === 'create') { chat.live = true; data = { kind: 'chat', sessionId: SID, terminalId: CT } }
    if (sub === 'send') {
      if (!chat.live && w.replaceIds) { chat.sessionId = 'resumed-chat-id'; chat.terminalId = 'resumed-chat-terminal' }
      chat.live = true; onSend?.(flag(args, '--prompt')); data = { ok: true, sessionId: chat.sessionId }
    }
    if (sub === 'close') { chat.live = false; chat.status = 'not_loaded'; data = { sessionId: SID, closed: true } }
    if (sub === 'resume') {
      if (!chat.live && w.replaceIds) { chat.sessionId = 'resumed-chat-id'; chat.terminalId = 'resumed-chat-terminal' }
      chat.live = true; chat.status = 'idle'; data = { sessionId: chat.sessionId, terminalId: chat.terminalId }
    }
    assert.ok(data, `unhandled ${sub}`)
    return { status: 0, stdout: JSON.stringify(data), stderr: '' }
  }
  return Object.assign(w, { chat, events, calls, setOnSend: (fn) => { onSend = fn } })
}
const add = (w, event) => w.events.push({ sessionId: SID, ts: w.ctx.now(), cursor: { epoch: 'test-epoch', seq: w.events.length + 1 }, event })
const answer = (text) => ({ type: 'item', item: { id: 'new-answer', kind: 'agent_message', text } })
const end = (status = 'completed') => ({ type: 'turn', turn: { id: 'turn-new', status, error: status === 'failed' ? { message: 'API failed' } : undefined } })

test('current chat is found by native thread ID, even with another CLI session in the workspace', () => {
  const w = chatWorld()
  w.ctx.env.CODEX_THREAD_ID = w.chat.harnessSessionId
  w.ctx.env.SUPERSET_TERMINAL_ID = TERM
  const session = resolveCurrentSession(w.ctx, w.config)
  assert.equal(session.kind, 'chat')
  assert.equal(session.sessionId, SID)
  assert.equal(sessLast(w.ctx, w.config).text, '[[DONE-chat-test]]')
  w.chat.live = false
  assert.throws(() => resolveCurrentSession(w.ctx, w.config), /нет живой сессии/)
})

test('workspace fallback considers both CLI and chat and never chooses a stopped chat', async () => {
  const w = chatWorld()
  w.ctx.env.SUPERSET_WORKSPACE_ID = WS
  await assert.rejects(sessClose(w.ctx, w.config), /несколько сессий/)
  assert.equal(w.calls.some((c) => c.args[1] === 'close'), false)
  w.chat.live = false
  const result = await sessClose(w.ctx, w.config)
  assert.equal(result.data.terminal, TERM)
})

test('close respects current running chat status even when the journal ends with an older completed turn', async () => {
  for (const ref of [undefined, SID]) {
    const w = chatWorld()
    w.ctx.env.CODEX_THREAD_ID = w.chat.harnessSessionId
    w.chat.status = 'running'
    await assert.rejects(sessClose(w.ctx, w.config, ref), /Сессия работает/)
    assert.equal(w.calls.some((c) => c.args[1] === 'close'), false)
  }
})

test('real chat journal: upserts yield one complete answer, not duplicated partials', () => {
  const parsed = readChat({ chatRead: () => fixture }, { workspace: WS, sessionId: SID })
  assert.equal(parsed.state, 'idle')
  assert.equal(parsed.records.filter((r) => r.type === 'user').length, 1)
  assert.deepEqual(parsed.records.filter((r) => r.type === 'assistant').map((r) => r.message.content), ['[[DONE-chat-test]]'])
})

test('chat journal fetches older pages using opaque cursors and rejects cursor loops', () => {
  const calls = []
  const api = { chatRead: (ws, sid, before) => { calls.push(before); return before ? { ...fixture, envelopes: fixture.envelopes.slice(0, 10) } : { ...fixture, envelopes: fixture.envelopes.slice(10), nextBefore: 'opaque' } } }
  assert.equal(readChat(api, { workspace: WS, sessionId: SID }).state, 'idle')
  assert.deepEqual(calls, [undefined, 'opaque'])
  assert.throws(() => readChat({ chatRead: () => ({ ok: true, envelopes: [], nextBefore: 'loop' }) }, { workspace: WS, sessionId: SID }), /повтор курсора/)
})

test('chat pagination serializes object cursors in argv and preserves string cursors', () => {
  for (const cursor of [{ epoch: 'test-epoch', seq: 42 }, 'opaque']) {
    const w = makeWorld()
    const calls = []
    w.ctx.run = (cmd, args) => {
      calls.push(args)
      assert.equal(args[1], 'read')
      assert.ok(calls.length <= 2)
      if (calls.length === 1) assert.equal(args.includes('--before'), false)
      else assert.equal(flag(args, '--before'), typeof cursor === 'string' ? cursor : JSON.stringify(cursor))
      const page = calls.length === 1
        ? { ...fixture, envelopes: fixture.envelopes.slice(10), nextBefore: cursor }
        : { ...fixture, envelopes: fixture.envelopes.slice(0, 10) }
      return { status: 0, stdout: JSON.stringify(page), stderr: '' }
    }
    const parsed = readChat(superset(w.ctx, w.config), { workspace: WS, sessionId: SID })
    assert.deepEqual(parsed, readChat({ chatRead: () => fixture }, { workspace: WS, sessionId: SID }))
    assert.equal(calls.length, 2)
  }
})

test('chat pagination rejects equal object cursors from separate responses', () => {
  let calls = 0
  const api = { chatRead: () => {
    assert.ok(++calls <= 2, 'repeated cursor must stop pagination')
    return { ok: true, envelopes: [], nextBefore: { epoch: 'test-epoch', seq: 42 } }
  } }
  assert.throws(() => readChat(api, { workspace: WS, sessionId: SID }), /повтор курсора/)
  assert.equal(calls, 2)
})

test('Codex defaults to chat, forwards model/mode, persists kind and alias; unsupported effort fails before launch', async () => {
  const w = chatWorld(); w.noChat = true
  const file = join(tempDir(), 'prompt.md'); writeFileSync(file, 'задача')
  const result = await sessCreate(w.ctx, w.config, { workspace: WS, 'prompt-file': file, model: 'gpt-6.1-sol', mode: 'read-only', alias: 'cx' })
  assert.equal(result.data.kind, 'chat')
  const call = w.calls.find((c) => c.args[1] === 'create')
  assert.equal(flag(call.args, '--model'), 'gpt-6.1-sol')
  assert.equal(flag(call.args, '--mode'), 'read-only')
  assert.equal(loadRegistry(w.ctx).sessions[0].kind, 'chat')
  assert.equal(loadRegistry(w.ctx).aliases.cx, CT)
  assert.throws(() => chatModel({ model: 'gpt-6.1-sol', effort: 'high' }), /не поддерживает --effort/)
  await assert.rejects(sessCreate(w.ctx, w.config, { workspace: WS, 'prompt-file': file, effort: 'high' }), /не поддерживает --effort/)
  assert.equal(w.calls.filter((c) => c.args[1] === 'create').length, 1)
})

test('chat counts toward shared limit, is discoverable without registry, stopped chat is not counted', async () => {
  const w = chatWorld()
  assert.equal(sessLs(w.ctx, w.config).data.count, 2)
  const file = join(tempDir(), 'prompt.md'); writeFileSync(file, 'задача')
  await assert.rejects(sessCreate(w.ctx, { ...w.config, maxSessions: 2 }, { workspace: WS, 'prompt-file': file }), (e) => e.code === 8)
  w.chat.live = false
  assert.equal(sessLs(w.ctx, w.config).data.count, 1)
  assert.equal(sessLast(w.ctx, w.config, SID).text, '[[DONE-chat-test]]')
})

test('chat last/wait/send use stable anchor; old markers ignored and errors retain exit codes', async () => {
  const w = chatWorld()
  assert.equal(sessLast(w.ctx, w.config, SID).text, '[[DONE-chat-test]]')
  assert.equal((await sessWait(w.ctx, w.config, SID, { marker: 'DONE-chat-test' })).code, 0)
  const sent = await sessSend(w.ctx, w.config, SID, { text: 'другая задача' })
  assert.match(sent.data.anchor, /^chat:/)
  add(w, answer('другой ответ')); add(w, end())
  add(w, { type: 'session', session: { status: 'idle' } })
  assert.equal((await sessWait(w.ctx, w.config, SID, { after: sent.data.anchor, marker: 'DONE-chat-test' })).code, 4)
  assert.equal((await sessWait(w.ctx, w.config, SID, { after: sent.data.anchor })).code, 0)
  await assert.rejects(sessWait(w.ctx, w.config, SID, { after: 'unknown' }), /Якорь/)
  add(w, end('failed'))
  assert.equal((await sessWait(w.ctx, w.config, SID, {})).code, 5)
})

test('chat send timeout is code 7, missing confirmation is code 7, pending approvals are code 3', async () => {
  const w = chatWorld(); w.hang = true
  await assert.rejects(sessSend(w.ctx, w.config, SID, { text: 'задача', timeout: '2' }), (e) => e.code === 7)
  assert.equal(w.calls.findLast((c) => c.args[1] === 'send').opts.timeout, 2000)
  w.hang = false; w.setOnSend(null)
  await assert.rejects(sessSend(w.ctx, w.config, SID, { text: 'задача', timeout: '2' }), (e) => e.code === 7)
  add(w, { type: 'session', session: { status: 'awaiting_input' } })
  add(w, { type: 'item', item: { id: 'approval', kind: 'approval_request', title: 'Choose', form: { message: 'Which?', fields: [] }, status: 'pending' } })
  assert.equal((await sessWait(w.ctx, w.config, SID, { marker: 'NEW' })).code, 3)
  assert.equal(sessLast(w.ctx, w.config, SID).data.waiting.kind, 'question')
  await assert.rejects(sessSend(w.ctx, w.config, SID, { text: 'да' }), (e) => e.code === 3)
})

test('chat wait times out while running and ignores subagent/tool/reasoning markers', async () => {
  const w = chatWorld()
  await sessSend(w.ctx, w.config, SID, { text: 'задача' })
  add(w, { type: 'session', session: { status: 'running' } })
  add(w, { type: 'item', item: { id: 'sub', kind: 'agent_message', parentItemId: 'tool', text: '[[NEW]]' } })
  add(w, { type: 'item', item: { id: 'reason', kind: 'reasoning', text: '[[NEW]]' } })
  assert.equal((await sessWait(w.ctx, w.config, SID, { marker: 'NEW', timeout: '2', interval: '1' })).code, 2)
})

test('chat close/resume preserve transport and alias without touching terminal panes', async () => {
  const w = chatWorld()
  await sessKeep(w.ctx, w.config, SID, {})
  const { setAlias } = await import('../src/sessions.js'); setAlias(w.ctx, 'cx', CT)
  await sessClose(w.ctx, w.config, 'cx', {})
  assert.equal(loadRegistry(w.ctx).sessions[0].kind, 'chat')
  assert.deepEqual(w.world.closedPanes, [])
  const resumed = await sessResume(w.ctx, w.config, 'cx', {})
  assert.equal(resumed.data.sessionId, SID)
  assert.ok(w.calls.some((c) => c.args[1] === 'resume'))
  assert.equal(w.world.created.length, 0)
  assert.equal(loadRegistry(w.ctx).aliases.cx, CT)
})

test('chat gc obeys done/keep/questions and closes only through sessions close', async () => {
  const w = chatWorld(); w.ctx.env.SUPERSET_WORKSPACE_ID = WS
  const options = { 'keep-pen': true }
  const dry = await sessGc(w.ctx, w.config, options)
  assert.ok(dry.data.close.some((c) => c.sessionId === SID))
  assert.equal(w.chat.live, true)
  sessKeep(w.ctx, w.config, SID, {})
  assert.ok((await sessGc(w.ctx, w.config, options)).data.keep.some((c) => c.sessionId === SID && c.skip === 'keep'))
  sessKeep(w.ctx, w.config, SID, { rm: true })
  add(w, answer('Что выбрать?')); add(w, end())
  assert.ok((await sessGc(w.ctx, w.config, options)).data.keep.some((c) => c.sessionId === SID && c.skip === 'вопрос в последнем ответе'))
  add(w, { type: 'item', item: { id: 'new-answer', kind: 'agent_message', text: '[[DONE-GC]]' } })
  await sessGc(w.ctx, w.config, { ...options, apply: true })
  assert.equal(w.chat.live, false)
  assert.equal(loadRegistry(w.ctx).sessions.find((s) => s.sessionId === SID).kind, 'chat')
  assert.ok(w.world.procs.some(([, t]) => t === TERM))
})

test('stopped chat send and resume enforce shared limit; working close refuses', async () => {
  const w = chatWorld(); w.chat.live = false
  await assert.rejects(sessSend(w.ctx, { ...w.config, maxSessions: 1 }, SID, { text: 'задача' }), (e) => e.code === 8)
  await assert.rejects(sessResume(w.ctx, { ...w.config, maxSessions: 1 }, SID, { workspace: WS }), (e) => e.code === 8)
  w.chat.live = true
  add(w, { type: 'session', session: { status: 'running' } })
  await assert.rejects(sessClose(w.ctx, w.config, SID, {}), /Сессия работает/)
  assert.equal(w.calls.some((c) => c.args[1] === 'close'), false)
})

test('live chat and native CLI process are counted once; stopped history does not hide CLI', () => {
  const w = chatWorld()
  w.chat.harnessSessionId = 'native-chat'
  w.world.addSession(404, 'native-terminal-123', 'native-chat', { agent: 'codex' })
  assert.equal(sessLs(w.ctx, w.config).data.count, 2)
  w.chat.live = false
  assert.equal(sessLs(w.ctx, w.config).data.count, 2)
})

test('resolved approval upsert clears waiting; queued prompts return their stable anchor', async () => {
  const w = chatWorld()
  add(w, { type: 'item', item: { id: 'approval', kind: 'approval_request', title: 'Permission', status: 'pending' } })
  assert.equal(sessLast(w.ctx, w.config, SID).data.waiting.kind, 'permission')
  add(w, { type: 'item', item: { id: 'approval', kind: 'approval_request', title: 'Permission', status: 'answered' } })
  assert.equal(sessLast(w.ctx, w.config, SID).data.waiting, null)
  w.setOnSend((text) => add(w, { type: 'item', item: { id: 'queued', kind: 'user_message', queued: true, content: [{ type: 'text', text }] } }))
  const sent = await sessSend(w.ctx, w.config, SID, { text: 'queued task' })
  assert.equal(sent.data.queued, true)
  add(w, { type: 'item', item: { id: 'queued', kind: 'user_message', content: [{ type: 'text', text: 'queued task' }] } })
  add(w, answer('[[NEW]]')); add(w, end())
  assert.equal((await sessWait(w.ctx, w.config, SID, { after: sent.data.anchor, marker: 'NEW' })).code, 0)
})

test('gc checks journal state before closing idle-listed chat and keeps unreadable journals', async () => {
  const w = chatWorld(); w.ctx.env.SUPERSET_WORKSPACE_ID = WS
  add(w, { type: 'session', session: { status: 'idle', awaitingBackground: true } })
  assert.ok((await sessGc(w.ctx, w.config, { 'keep-pen': true })).data.keep.some((s) => s.sessionId === SID && s.skip === 'работает'))
  const run = w.ctx.run
  w.ctx.run = (cmd, args, opts) => args[0] === 'sessions' && args[1] === 'read' ? { status: 1, stdout: '', stderr: 'missing journal' } : run(cmd, args, opts)
  assert.ok((await sessGc(w.ctx, w.config, { 'keep-pen': true })).data.keep.some((s) => s.sessionId === SID && /нет журнала/.test(s.skip)))
})


test('resume and stopped send adopt new Superset IDs, preserve aliases/keep, and read new journal', async () => {
  for (const operation of ['resume', 'send']) {
    const w = chatWorld(); w.replaceIds = true
    const { setAlias } = await import('../src/sessions.js'); setAlias(w.ctx, 'cx', CT)
    sessKeep(w.ctx, w.config, SID, {})
    await sessClose(w.ctx, w.config, 'cx', {})
    const result = operation === 'resume'
      ? await sessResume(w.ctx, w.config, 'cx', {})
      : await sessSend(w.ctx, w.config, 'cx', { text: 'new task' })
    assert.equal(result.data.sessionId, 'resumed-chat-id')
    assert.equal(result.data.terminal, 'resumed-chat-terminal')
    assert.equal(loadRegistry(w.ctx).aliases.cx, 'resumed-chat-terminal')
    assert.ok(loadRegistry(w.ctx).keep.includes('resumed-chat-id'))
    if (operation === 'send') {
      assert.match(result.data.anchor, /^chat:resumed-chat-id:/)
      add(w, answer('[[NEW]]')); add(w, end())
      assert.equal((await sessWait(w.ctx, w.config, 'cx', { after: result.data.anchor, marker: 'NEW' })).code, 0)
    } else assert.equal(sessLast(w.ctx, w.config, 'cx').text, '[[DONE-chat-test]]')
  }
})

test('a current terminal alias overrides a historical chat alias', async () => {
  const w = chatWorld()
  const { setAlias } = await import('../src/sessions.js')
  setAlias(w.ctx, 'cx', CT)
  await sessClose(w.ctx, w.config, 'cx', {})
  setAlias(w.ctx, 'cx', TERM)
  w.world.append({ type: 'assistant', uuid: 'terminal-answer', timestamp: new Date(w.ctx.now()).toISOString(), message: { id: 'answer', content: 'terminal answer' } })
  assert.equal(sessLast(w.ctx, w.config, 'cx').text, 'terminal answer')
})
