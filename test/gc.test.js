import assert from 'node:assert/strict'
import { utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { isIdleShellScreen } from '../src/cleanup.js'
import { hasQuestion, sessGc } from '../src/gc.js'
import { sessClose, sessKeep } from '../src/sess-registry.js'
import { loadRegistry } from '../src/store.js'
import { addOrigin, git, makeRepo } from './helpers.js'
import { at, makeWorld, say, TERM, turnEnd, WS } from './world.js'

const T = (n) => `${String(n).repeat(8)}-0000-4000-8000-000000000000`

/** Журнал с последним ответом `text`, изменённый `agoMin` минут назад. */
const answered = (ctx, world, path, text, agoMin) => {
  world.appendTo(path, say(`a-${path.length}-${text.length}`, at(ctx, -agoMin * 60), text), turnEnd('e', at(ctx, -agoMin * 60)))
  const time = new Date(ctx.now() - agoMin * 60_000)
  utimesSync(path, time, time)
}

/** Мир со всеми случаями: что gc должен закрыть, а что оставить. */
const busyWorld = () => {
  const w = makeWorld()
  const { ctx, world } = w
  ctx.env.SUPERSET_WORKSPACE_ID = WS
  ctx.env.SUPERSET_TERMINAL_ID = T(8)
  answered(ctx, world, world.journal, 'Готово.\n[[DONE-A]]', 3)
  answered(ctx, world, world.addSession(402, T(2), 's2'), 'Итог. Какой вариант выбрать?', 120)
  world.addSession(403, T(3), 's3', { status: 'busy', state: 'working' })
  world.addSession(404, T(4), 's4', { state: 'blocked' })
  answered(ctx, world, world.addSession(405, T(5), 's5'), 'Сделано', 120)
  answered(ctx, world, world.addSession(406, T(6), 's6'), 'Сделано, жду задачу', 120)
  answered(ctx, world, world.addSession(407, T(7), 's7'), 'Сделано', 5)
  answered(ctx, world, world.addSession(408, T(8), 's8'), 'Готово [[DONE-SELF]]', 60)
  world.addSession(409, T(1), 's-nested', { parent: 101 })
  world.shells = [
    { id: T('a'), title: null, agent: null },
    { id: T('b'), title: null, agent: null },
    { id: T('c'), title: 'vim', agent: null },
    { id: T('d'), title: null, agent: null },
  ]
  world.screens[T('a')] = 'nikita@mac slot-1 % '
  world.screens[T('b')] = '> nx serve web\n  ➜  Local: http://localhost:4200/\n  watching for changes'
  world.exited.add(T('d'))
  world.stalePanes = [{ id: 'pane-dead', kind: 'terminal', terminalId: T('9') }]
  sessKeep(ctx, w.config, 's5', {})
  return w
}

const closing = (data) => data.close.map((c) => `${c.kind}:${(c.pane ?? c.terminal).slice(0, 8)}`).sort()

test('gc dry run: closes finished, long-idle, exited and empty; keeps working, waiting, questions, keep, self', async () => {
  const { ctx, config, world } = busyWorld()
  const { data, text } = await sessGc(ctx, config, {})
  assert.deepEqual(closing(data), ['pane:pane-dea', `session:${TERM.slice(0, 8)}`, `session:${T(6).slice(0, 8)}`, `terminal:${T('a').slice(0, 8)}`, `terminal:${T('d').slice(0, 8)}`].sort())
  const kept = Object.fromEntries(data.keep.map((k) => [k.sessionId, k.skip]))
  assert.equal(kept.s2, 'вопрос в последнем ответе')
  assert.equal(kept.s3, 'работает')
  assert.equal(kept.s4, 'ждёт разрешения или ответа')
  assert.equal(kept.s5, 'keep')
  assert.match(kept.s7, /меньше порога/)
  assert.equal(kept.s8, 'это текущая сессия')
  assert.ok(!('s-nested' in kept), 'вложенный claude — не сессия')
  assert.deepEqual(world.closedPanes, [], 'сухой прогон ничего не закрывает')
  assert.match(text, /Закрыть: paradev-agent gc --apply/)
})

test('gc --apply records sessions in the registry and closes through panes', async () => {
  const { ctx, config, world } = busyWorld()
  await sessGc(ctx, config, { apply: true, idle: '90m' })
  assert.deepEqual(world.closedPanes.sort(), ['pane-dead', `pane-${TERM}`, `pane-${T(6)}`, `pane-${T('a')}`, `pane-${T('d')}`].sort())
  const notes = Object.fromEntries(loadRegistry(ctx).sessions.map((s) => [s.sessionId, s.note]))
  assert.match(notes['sess-1'], /^gc: готово/)
  assert.match(notes.s6, /^gc: простаивает 120 мин/)
  assert.ok(world.procs.some(([, t]) => t === T(3)), 'работающая сессия жива')
})

test('gc touches only the current project unless --project says otherwise', async () => {
  const { ctx, config } = makeWorld({ project: 'sbercrm' })
  ctx.cwd = '/elsewhere'
  await assert.rejects(sessGc(ctx, config, {}), /укажите --project/)
  ctx.env.SUPERSET_WORKSPACE_ID = 'ws-other'
  const { data } = await sessGc(ctx, config, { project: 'sellerai' })
  assert.deepEqual(data.close, [])
  assert.deepEqual(data.projects, ['sellerai'])
  assert.equal((await sessGc(ctx, config, { project: 'sellerai,sbercrm', idle: '1s' })).data.projects.length, 2)
})

test('close also closes empty companion shells and stale panes of the workspace, not busy ones', async () => {
  const { ctx, config, world } = makeWorld()
  world.shells = [
    { id: T('a'), title: null, agent: null },
    { id: T('b'), title: null, agent: null },
  ]
  world.screens[T('b')] = 'npm run dev\nready in 300ms'
  world.stalePanes = [{ id: 'pane-dead', kind: 'terminal', terminalId: T('9') }]
  const { data } = await sessClose(ctx, config, TERM, {})
  assert.deepEqual(world.closedPanes, [`pane-${TERM}`, `pane-${T('a')}`, 'pane-dead'])
  assert.deepEqual(data.tidied.map((t) => t.reason), ['пустой шелл', 'панель без терминала'])
})

test('question and idle-screen heuristics', () => {
  assert.ok(hasQuestion('Готово.\nКакой вариант выбрать?'))
  assert.ok(hasQuestion('**Решить:** оставить так?**'))
  assert.ok(!hasQuestion('Готово [[DONE-X]]'))
  assert.ok(isIdleShellScreen(''))
  assert.ok(isIdleShellScreen('last login\nnikita@mac ~ % '))
  assert.ok(isIdleShellScreen('❯ '))
  assert.ok(!isIdleShellScreen('webpack compiled\nwatching for file changes...'))
})

test('gc releases a clean task slot without probing desktop apps', async () => {
  const repo = makeRepo({ 'a.txt': 'a\n' }); addOrigin(repo)
  git(repo, 'switch', '-q', '-c', 'task-x')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'feat(task-x): не влита')
  const { ctx, config, world } = makeWorld({ cwd: repo, name: 'slot-1 · task-x' })
  ctx.env.SUPERSET_WORKSPACE_ID = WS
  world.procs = world.procs.filter(([pid]) => pid !== 202) // claude вне Superset с cwd в слоте держал бы слот занятым
  answered(ctx, world, world.journal, 'Готово [[DONE-X]]', 1)
  const dry = await sessGc(ctx, config, {})
  assert.equal(dry.data.close.filter((c) => c.kind === 'session').length, 1)
  await sessGc(ctx, config, { apply: true })
  assert.deepEqual(world.renamed, ['slot-1'])
  assert.equal(git(repo, 'branch', '--show-current'), '')
  assert.ok(!ctx.calls.some(({ cmd }) => ['pgrep', 'osascript'].includes(cmd)))
})

test('gc keeps the busy name when the slot copy is dirty', async () => {
  const repo = makeRepo({ 'a.txt': 'a\n' })
  writeFileSync(join(repo, 'a.txt'), 'changed\n')
  const { ctx, config, world } = makeWorld({ cwd: repo, name: 'slot-1 · task-x' })
  ctx.env.SUPERSET_WORKSPACE_ID = WS
  world.procs = world.procs.filter(([pid]) => pid !== 202)
  answered(ctx, world, world.journal, 'Готово [[DONE-X]]', 1)
  const { data } = await sessGc(ctx, config, { apply: true, 'keep-pen': true })
  assert.match(data.keep.find((k) => k.kind === 'session').skip, /грязная/)
  assert.deepEqual(world.renamed, [])
})
