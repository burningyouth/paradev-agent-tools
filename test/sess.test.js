import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { EXIT } from '../src/exit.js'
import { projectDirName } from '../src/journal.js'
import { sessClose, sessResume } from '../src/sess-registry.js'
import { sessCreate, sessLast, sessLs, sessSend, sessWait } from '../src/sess.js'
import { loadConfig, loadRegistry } from '../src/store.js'
import { fakeContext, jsonl, tempDir } from './helpers.js'

const TERM = 'aaaaaaaa-1111-4111-8111-111111111111'
const OTHER = 'bbbbbbbb-2222-4222-8222-222222222222'
const WS = 'ws-1'
const CWD = '/Users/me/.superset/worktrees/proj/slot-1'
const SID = 'sess-1'

/**
 * Мир для тестов: один процесс Claude в терминале TERM, второй — вне Superset; журнал — файл в claudeHome.
 * `world.state` — состояние агента в snapshot, `world.onSend` — реакция «сессии» на отправку.
 */
const makeWorld = () => {
  const world = { state: 'idle', status: 'idle', sent: [], closed: [], created: [], procs: [[101, TERM], [202, null]] }
  const ctx = fakeContext({
    ps: (args) => {
      if (args[0] === '-axo') return world.procs.map(([pid]) => `${pid} 204800 /opt/homebrew/bin/claude --model opus`).join('\n') + '\n  999 100 /bin/zsh\n'
      // Промпт в аргументах содержит ложный SUPERSET_TERMINAL_ID — брать надо только из окружения
      const command = `claude prompt SUPERSET_TERMINAL_ID=${OTHER}`
      if (args[0] === '-p') return command
      const term = world.procs.find(([pid]) => String(pid) === args[2])?.[1]
      return `${command}${term ? ` HOME=/x SUPERSET_TERMINAL_ID=${term} SUPERSET_WORKSPACE_ID=${WS}` : ' HOME=/x'}`
    },
    superset: (args) => {
      const key = args.slice(0, 2).join(' ')
      if (key === 'snapshot --json') {
        const terminals = world.procs.filter(([, t]) => t).map(([, t]) => ({ id: t, title: '◑ Моя задача', agent: { id: 'claude', state: world.state } }))
        return JSON.stringify({ workspaces: [{ id: WS, name: 'slot-1', project: 'proj', branch: 'b', terminals }] })
      }
      if (key === 'ws list') return JSON.stringify([{ id: WS, name: 'slot-1', projectName: 'proj', worktreePath: CWD }])
      if (key === 'terminals send') {
        world.sent.push(args[args.indexOf('--text') + 1])
        world.onSend?.(args[args.indexOf('--text') + 1])
        return ''
      }
      if (key === 'terminals close') {
        world.closed.push(args[args.indexOf('--terminal') + 1])
        return ''
      }
      if (key === 'agents create') {
        world.created.push(args)
        world.procs.push([303, 'cccccccc-3333-4333-8333-333333333333'])
        writeSessionFile(303, args.includes('--resume-session') ? args[args.indexOf('--resume-session') + 1] : 'sess-new')
        return JSON.stringify({ sessionId: 'cccccccc-3333-4333-8333-333333333333' })
      }
      throw new Error(`superset ${args.join(' ')}`)
    },
  })
  const writeSessionFile = (pid, sessionId) => {
    mkdirSync(join(ctx.claudeHome, 'sessions'), { recursive: true })
    writeFileSync(join(ctx.claudeHome, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: CWD, status: world.status }))
  }
  writeSessionFile(101, SID)
  writeSessionFile(202, 'sess-outside')
  const dir = join(ctx.claudeHome, 'projects', projectDirName(CWD))
  mkdirSync(dir, { recursive: true })
  world.journal = join(dir, `${SID}.jsonl`)
  writeFileSync(world.journal, '')
  world.append = (...records) => appendFileSync(world.journal, jsonl(records))
  world.setStatus = (status) => {
    world.status = status
    writeSessionFile(101, SID)
  }
  return { ctx, config: loadConfig(ctx), world }
}

const at = (ctx, plusSec = 0) => new Date(ctx.now() + plusSec * 1000).toISOString()
const say = (uuid, ts, text) => ({ type: 'assistant', uuid, timestamp: ts, message: { id: uuid, content: [{ type: 'text', text }] } })
const prompt = (uuid, ts, text) => ({ type: 'user', uuid, timestamp: ts, message: { role: 'user', content: text } })
const turnEnd = (uuid, ts) => ({ type: 'system', subtype: 'turn_duration', uuid, timestamp: ts })

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
  assert.deepEqual(world.closed, [TERM])
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
  const { ctx, world } = makeWorld()
  const promptFile = join(tempDir(), 'p.md')
  writeFileSync(promptFile, 'Задача')
  const config = { ...loadConfig(ctx), maxSessions: 1 }
  await assert.rejects(sessCreate(ctx, config, { workspace: 'slot-1', 'prompt-file': promptFile }), (e) => e.code === EXIT.limit)
  const { data } = await sessCreate(ctx, { ...config, maxSessions: 5 }, { workspace: 'slot-1', 'prompt-file': promptFile, alias: 'job', model: 'opus' })
  assert.equal(data.sessionId, 'sess-new')
  assert.ok(world.created[0].includes('Задача'))
  assert.equal(JSON.parse(readFileSync(join(ctx.agentHome, 'sessions.json'), 'utf8')).aliases.job, data.terminal)
})
