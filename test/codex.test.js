import assert from 'node:assert/strict'
import { appendFileSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { codexSession } from '../src/codex.js'
import { createContext } from '../src/context.js'
import { EXIT } from '../src/exit.js'
import { sessGc } from '../src/gc.js'
import { analyzeAfter, findAccepted, lastAnswer, lastPromptIndex, readJournal } from '../src/journal.js'
import { agentProcesses } from '../src/procs.js'
import { sessClose, sessKeep, sessResume } from '../src/sess-registry.js'
import { sessCreate, sessLast, sessLs, sessSend, sessWait } from '../src/sess.js'
import { resolveSession, sessionJournal, setAlias } from '../src/sessions.js'
import { loadRegistry, saveRegistry } from '../src/store.js'
import { fakeContext, git, jsonl, makeRepo, tempDir } from './helpers.js'
import { at, makeWorld, OTHER, TERM, WS } from './world.js'

// Форма записей из Codex rollout (id у response_item в старых версиях отсутствует).
const event = (ctx, type, payload = {}) => ({ timestamp: at(ctx), type: 'event_msg', payload: { type, ...payload } })
const input = (ctx, text) => ({ timestamp: at(ctx), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
const reply = (ctx, text, channel = 'final') => ({ timestamp: at(ctx), type: 'response_item', payload: { type: 'message', role: 'assistant', channel, content: [{ type: 'output_text', text }] } })
const tool = (ctx, type, text) => ({ timestamp: at(ctx), type: 'response_item', payload: { type, output: text, arguments: text } })
const fixture = () => {
  const w = makeWorld()
  w.path = w.world.addSession(401, OTHER, 'codex-one', { agent: 'codex' })
  w.append = (...records) => w.world.appendTo(w.path, ...records)
  return w
}
const flag = (args, name) => args[args.indexOf(name) + 1]

test('Codex journals: stable anchors without UUIDs, partial lines, assistant-only markers and full last answer', () => {
  const { ctx, path, append } = fixture()
  append(input(ctx, 'старое'), reply(ctx, '[[DONE-X]]'), event(ctx, 'task_complete'))
  append(event(ctx, 'task_started'), event(ctx, 'user_message', { message: 'закончи [[DONE-X]]' }))
  const accepted = findAccepted(readJournal(path), 'закончи [[DONE-X]]', ctx.now())
  assert.equal(accepted.anchor, 'codex:codex-one:6')
  append(input(ctx, 'закончи [[DONE-X]]'), tool(ctx, 'function_call', '[[DONE-X]]'), tool(ctx, 'function_call_output', '[[DONE-X]]'), reply(ctx, '[[DONE-X]]', 'analysis'))
  let records = readJournal(path)
  let anchor = records.findIndex((r) => r.uuid === accepted.anchor)
  assert.equal(analyzeAfter(records, anchor, 'DONE-X').markerFound, false)
  appendFileSync(path, '{"type":"response_item"')
  assert.equal(findAccepted(readJournal(path), 'закончи [[DONE-X]]', ctx.now()).anchor, accepted.anchor)
  appendFileSync(path, ',"payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Первая часть"},{"type":"output_text","text":"Вторая [[DONE-X]]"}]}}\n')
  append(event(ctx, 'task_complete'))
  records = readJournal(path)
  anchor = records.findIndex((r) => r.uuid === accepted.anchor)
  const result = analyzeAfter(records, anchor, 'DONE-X')
  assert.equal(result.markerFound, true)
  assert.equal(result.turnEnded, true)
  assert.equal(lastAnswer(records).text, 'Первая часть\nВторая [[DONE-X]]')
  assert.equal(lastPromptIndex(records), records.findLastIndex((r) => r.type === 'user'))
})

test('Codex legacy events, duplicate assistant events and retryable errors', () => {
  const { ctx, path, append } = fixture()
  append(event(ctx, 'user_message', { message: 'задача' }), event(ctx, 'agent_message', { message: 'Итог' }), reply(ctx, 'Итог'), event(ctx, 'task_complete'))
  assert.equal(lastAnswer(readJournal(path)).text, 'Итог')
  assert.equal(analyzeAfter(readJournal(path), -1).turnEnded, true)
  append(event(ctx, 'task_started'), event(ctx, 'error', { message: 'retrying', will_retry: true }))
  assert.equal(analyzeAfter(readJournal(path), -1).turnEnded, false)
  assert.equal(analyzeAfter(readJournal(path), -1).apiError, null)
  append(event(ctx, 'error', { message: 'Quota exceeded' }))
  assert.equal(analyzeAfter(readJournal(path), -1).apiError, 'Quota exceeded')
  append(event(ctx, 'agent_message', { message: 'Восстановился' }), event(ctx, 'turn_aborted'))
  assert.equal(lastAnswer(readJournal(path)).text, 'Восстановился')
  assert.equal(analyzeAfter(readJournal(path), -1).apiError, null)
})

test('Codex discovery binds each PID to its own rollout, not to another session in the same cwd', () => {
  const { ctx, config, world, path } = fixture()
  const another = world.addSession(402, 'dddddddd-4444-4444-8444-444444444444', 'codex-two', { agent: 'codex' })
  world.addSession(403, OTHER, 'codex-nested', { agent: 'codex', parent: 401 })
  world.appendTo(another, reply(ctx, 'другая задача'))
  const data = sessLs(ctx, config).data
  assert.equal(data.count, 3, 'один Claude и два Codex; вложенный Codex не считается')
  assert.deepEqual(data.nestedPids, [403])
  const one = resolveSession(ctx, config, OTHER)
  assert.equal(one.agent, 'codex')
  assert.equal(one.sessionId, 'codex-one')
  assert.equal(sessionJournal(ctx, one), path)
  assert.equal(data.sessions.find((s) => s.sessionId === 'codex-two').journal, another)
  assert.equal(data.sessions.find((s) => s.terminal === TERM).agent, 'claude')
})

test('Codex discovery fails safely for missing/ambiguous rollouts and excludes subagent metadata', async () => {
  const { ctx, config, world, path } = fixture()
  const child = world.addSession(402, null, 'child-file', { agent: 'codex' })
  writeFileSync(child, jsonl([{ type: 'session_meta', payload: { id: 'child', cwd: '/x', source: { subagent: { other: 'guardian' } } } }]))
  const lsofContext = (paths) => ({ ...ctx, run: (cmd, args, opts) => cmd === 'lsof' ? { status: 0, stdout: paths.map((p) => `n${p}`).join('\n') } : ctx.run(cmd, args, opts) })
  assert.equal(codexSession(lsofContext([path, child]), 401).sessionId, 'codex-one')
  assert.equal(codexSession(lsofContext([path, path]), 401).sessionId, 'codex-one')
  assert.equal(codexSession(lsofContext([]), 401).sessionId, null)
  const otherPath = world.addSession(404, null, 'another-root', { agent: 'codex' })
  world.appendTo(otherPath, event(ctx, 'user_message', { message: 'тот же номер строки' }))
  world.appendTo(path, event(ctx, 'user_message', { message: 'тот же номер строки' }))
  assert.notEqual(findAccepted(readJournal(otherPath), 'тот же номер строки', ctx.now()).anchor, findAccepted(readJournal(path), 'тот же номер строки', ctx.now()).anchor)
  assert.equal(codexSession(lsofContext([path, otherPath]), 401).sessionId, null)
  delete world.journals[401]
  await assert.rejects(sessSend(ctx, config, OTHER, { text: 'не туда не посылать' }), /rollout/)
  await assert.rejects(sessClose(ctx, config, OTHER, {}), /Нет UUID/)
  assert.deepEqual(world.sent, [])
  assert.equal(world.closedPanes.length, 0)
  const gc = await sessGc(ctx, config, { project: 'proj', 'keep-pen': true })
  assert.match(gc.data.keep.find((s) => s.terminal === OTHER).skip, /нет журнала/)
})

test('Codex processes: native binary, npm launcher, nested mixed agents, app-server excluded', () => {
  const ctx = fakeContext({ ps: () => [
    '10 1 100 /usr/bin/node /opt/@openai/codex/bin/codex.js --model m',
    '11 10 200 /opt/vendor/codex/codex --model m',
    '12 11 100 /bin/zsh',
    '13 12 200 /opt/bin/claude -p task',
    '14 1 100 /usr/bin/node /opt/@openai/codex/bin/codex.js',
    '15 1 200 /opt/bin/codex app-server',
    '16 1 100 /bin/bash /home/me/.superset/bin/codex',
    '17 1 100 /opt/bin/not-codex',
  ].join('\n') })
  assert.deepEqual(agentProcesses(ctx), [
    { pid: 11, agent: 'codex', rssKb: 200, nested: false },
    { pid: 13, agent: 'claude', rssKb: 200, nested: true },
    { pid: 14, agent: 'codex', rssKb: 100, nested: false },
  ])
  assert.equal(createContext({ env: { HOME: '/home/me', CODEX_HOME: '/custom/codex' } }).codexHome, '/custom/codex')
})

test('terminal create defaults to Codex with --cli, forwards model/effort; explicit Claude still works, invalid agent rejected', async () => {
  for (const agent of [undefined, 'claude']) {
    const repo = makeRepo({ 'a.txt': 'a' }); git(repo, 'switch', '-q', '-c', 'task')
    const { ctx, config, world } = makeWorld({ cwd: repo, name: 'slot-1 · task' }); world.procs = []
    const file = join(tempDir(), 'task.md')
    writeFileSync(file, 'Задача')
    const result = await sessCreate(ctx, config, { workspace: WS, 'prompt-file': file, cli: true, agent, model: 'chosen-model', effort: 'high', alias: 'new-job' })
    assert.equal(flag(world.created[0], '--agent'), agent ?? 'codex')
    assert.equal(flag(world.created[0], '--model'), 'chosen-model')
    assert.equal(flag(world.created[0], '--effort'), 'high')
    assert.equal(result.data.agent, agent ?? 'codex')
    assert.equal(loadRegistry(ctx).aliases['new-job'], result.data.terminal)
    await assert.rejects(sessCreate(ctx, config, { workspace: WS, 'prompt-file': file, agent: 'wrong' }), /codex или claude/)
    assert.equal(world.created.length, 1)
  }
})

test('create counts both providers toward the shared limit', async () => {
  const { ctx, config } = fixture()
  await assert.rejects(sessCreate(ctx, { ...config, maxSessions: 2 }, { workspace: WS, 'prompt-file': '/unused' }), (e) => e.code === EXIT.limit)
})

test('Codex send confirms a new user message and wait uses its anchor across polls', async () => {
  const { ctx, config, world, path, append } = fixture()
  append(event(ctx, 'user_message', { message: 'новая задача' }), reply(ctx, 'Старое [[DONE-X]]'), event(ctx, 'task_complete'))
  const oldAnchor = findAccepted(readJournal(path), 'новая задача', ctx.now()).anchor
  setAlias(ctx, 'cx', OTHER)
  world.onSend = (text) => append(event(ctx, 'task_started'), event(ctx, 'user_message', { message: text }), input(ctx, text))
  const sent = await sessSend(ctx, config, 'cx', { text: 'новая задача\n' })
  assert.notEqual(sent.data.anchor, oldAnchor, 'не принимает старое совпадающее сообщение в ту же секунду')
  assert.deepEqual(world.sent, ['новая задача'])
  assert.equal((await sessWait(ctx, config, 'cx', { marker: 'DONE-X', after: sent.data.anchor, timeout: '0' })).code, EXIT.timeout)
  let polls = 0
  const result = await sessWait({ ...ctx, sleep: async (ms) => {
    ctx.advance(ms)
    if (++polls === 2) append(reply(ctx, 'Новый итог\n[[DONE-X]]'), event(ctx, 'task_complete'))
  } }, config, 'cx', { marker: 'DONE-X', after: sent.data.anchor })
  assert.equal(result.code, EXIT.ok)
  assert.equal(result.data.answer.text, 'Новый итог\n[[DONE-X]]')
  assert.equal(sessLast(ctx, config, OTHER).text, 'Новый итог\n[[DONE-X]]')
})

test('Codex wait: idle, API error, blocked UI, timeout, unknown anchor; send/close guards', async () => {
  const { ctx, config, world, append } = fixture()
  append(event(ctx, 'task_started'), input(ctx, 'задача'))
  assert.equal((await sessWait(ctx, config, OTHER, { timeout: '0' })).code, EXIT.timeout)
  await assert.rejects(sessClose(ctx, config, OTHER, {}), /Сессия работает/)
  world.agentStates[OTHER] = 'blocked'
  world.screens[OTHER] = 'Would you like to run the following command?\n› 1. Yes, proceed (y)\n  2. No, and tell Codex what to do differently (esc)'
  const blocked = await sessWait(ctx, config, OTHER, { timeout: '0' })
  assert.equal(blocked.code, EXIT.waiting)
  assert.equal(blocked.data.waiting.kind, 'permission')
  assert.equal(sessLast(ctx, config, OTHER).data.waiting.kind, 'permission')
  await assert.rejects(sessSend(ctx, config, OTHER, { text: 'y' }), (e) => e.code === EXIT.waiting)
  world.onSend = (text) => append(event(ctx, 'user_message', { message: text }))
  assert.ok((await sessSend(ctx, config, OTHER, { text: 'y', force: true })).data.anchor)
  world.agentStates[OTHER] = 'working'
  append(reply(ctx, 'Закончил без маркера'), event(ctx, 'task_complete'))
  assert.equal((await sessWait(ctx, config, OTHER, { marker: 'M', timeout: '0' })).code, EXIT.timeout, 'working в Superset не перекрывается старым task_complete')
  world.agentStates[OTHER] = 'idle'
  assert.equal((await sessWait(ctx, config, OTHER, { marker: 'M' })).code, EXIT.idle)
  assert.equal((await sessWait(ctx, config, OTHER, {})).code, EXIT.ok)
  append(event(ctx, 'task_started'), input(ctx, 'ещё'), event(ctx, 'error', { message: 'API failed' }))
  assert.equal((await sessWait(ctx, config, OTHER, {})).code, EXIT.apiError)
  await assert.rejects(sessWait(ctx, config, OTHER, { after: 'codex:999' }), /не найден/)
})

test('Codex send timeout does not claim success or resend', async () => {
  const { ctx, config, world } = fixture()
  await assert.rejects(sessSend(ctx, config, OTHER, { text: 'нет подтверждения', timeout: '2' }), (e) => e.code === EXIT.notAccepted)
  assert.equal(world.sent.length, 1)
})

test('Codex close/resume preserve provider, session id, alias, keep; old registry records resume Claude', async () => {
  const { ctx, config, world, append } = fixture()
  append(input(ctx, 'задача'), reply(ctx, 'Готово'), event(ctx, 'task_complete'))
  setAlias(ctx, 'cx', OTHER)
  sessKeep(ctx, config, 'cx', {})
  assert.deepEqual(loadRegistry(ctx).keep, ['codex-one'])
  const closed = await sessClose(ctx, config, 'cx', { note: 'пауза' })
  assert.equal(closed.data.agent, 'codex')
  assert.equal(loadRegistry(ctx).sessions[0].sessionId, 'codex-one')
  assert.ok(world.closedPanes.includes(`pane-${OTHER}`))
  assert.ok(world.procs.some(([pid]) => pid === 101), 'Claude в том же воркспейсе остаётся живым')
  sessKeep(ctx, config, 'cx', { rm: true })
  assert.deepEqual(loadRegistry(ctx).keep, [])
  const resumed = await sessResume(ctx, config, 'cx', {})
  assert.equal(resumed.data.agent, 'codex')
  assert.equal(resumed.data.sessionId, 'codex-one')
  assert.equal(flag(world.created[0], '--agent'), 'codex')
  assert.equal(flag(world.created[0], '--resume-session'), 'codex-one')
  assert.equal(loadRegistry(ctx).aliases.cx, resumed.data.terminal)
  await assert.rejects(sessResume(ctx, config, 'cx', { agent: 'claude' }), /другим агентом невозможен/)

  const old = makeWorld()
  saveRegistry(old.ctx, { aliases: {}, sessions: [{ sessionId: 'legacy', workspace: WS, alias: 'old' }], keep: [] })
  assert.equal((await sessResume(old.ctx, old.config, 'old', {})).data.agent, 'claude')
  assert.equal(flag(old.world.created[0], '--agent'), 'claude')
})

test('resume of an unregistered id defaults to Codex or accepts explicit Claude', async () => {
  for (const agent of [undefined, 'claude']) {
    const repo = makeRepo({ 'a.txt': 'a' }); git(repo, 'switch', '-q', '-c', 'task')
    const { ctx, config, world } = makeWorld({ cwd: repo, name: 'slot-1 · task' }); world.procs = []
    await sessResume(ctx, config, 'old-id', { workspace: WS, agent, branch: 'task' })
    assert.equal(flag(world.created[0], '--agent'), agent ?? 'codex')
    assert.equal(flag(world.created[0], '--resume-session'), 'old-id')
  }
})

test('Codex gc: done/long-idle close, keep/question/working/blocked/current stay, dry run then apply', async () => {
  const { ctx, config, world, path, append } = fixture()
  ctx.env.SUPERSET_WORKSPACE_ID = WS
  const make = (pid, id, text, { busy = false, state = 'idle' } = {}) => {
    const terminal = `${String(pid).repeat(3)}-5555-4555-8555-555555555555`
    const p = world.addSession(pid, terminal, id, { agent: 'codex', state })
    world.appendTo(p, event(ctx, 'task_started'), input(ctx, 'задача'), reply(ctx, text), ...(busy ? [] : [event(ctx, 'task_complete')]))
    const old = new Date(ctx.now() - 120 * 60_000)
    utimesSync(p, old, old)
    return terminal
  }
  append(input(ctx, 'задача'), reply(ctx, 'Готово [[DONE-CX]]'), event(ctx, 'task_complete'))
  make(402, 'idle-cx', 'Закончил')
  make(403, 'keep-cx', 'Готово [[DONE-CX]]')
  make(404, 'question-cx', 'Какой вариант?')
  make(405, 'busy-cx', 'Работаю', { busy: true })
  make(406, 'blocked-cx', 'Уточню', { state: 'blocked' })
  ctx.env.SUPERSET_TERMINAL_ID = make(407, 'self-cx', 'Готово [[DONE-CX]]')
  sessKeep(ctx, config, 'keep-cx', {})
  const dry = await sessGc(ctx, config, { 'keep-pen': true })
  assert.deepEqual(dry.data.close.filter((p) => p.kind === 'session').map((p) => p.sessionId).sort(), ['codex-one', 'idle-cx'])
  assert.equal(world.closedPanes.length, 0)
  const kept = Object.fromEntries(dry.data.keep.map((p) => [p.sessionId, p.skip]))
  assert.equal(kept['keep-cx'], 'keep')
  assert.equal(kept['question-cx'], 'вопрос в последнем ответе')
  assert.equal(kept['busy-cx'], 'работает')
  assert.equal(kept['blocked-cx'], 'ждёт разрешения или ответа')
  assert.equal(kept['self-cx'], 'это текущая сессия')
  await sessGc(ctx, config, { apply: true, 'keep-pen': true })
  assert.equal(loadRegistry(ctx).sessions.filter((s) => s.agent === 'codex').length, 2)
  assert.ok(world.closedPanes.includes(`pane-${OTHER}`))
  assert.ok(readFileSync(path, 'utf8').includes('DONE-CX'))
})
