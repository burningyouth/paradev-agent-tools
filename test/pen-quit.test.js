import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { EXIT } from '../src/exit.js'
import { penIdleCheck, penQuit } from '../src/pen-quit.js'
import { tempDir } from './helpers.js'
import { at, makeWorld, say, TERM } from './world.js'

/** Слот (worktree сессии TERM) с .pen-файлом и второй файл вне слотов; Pen открыт с обоими. */
const penWorld = (state = 'idle') => {
  const slot = tempDir('pen-slot-')
  const w = makeWorld({ cwd: slot })
  mkdirSync(join(slot, 'design'))
  const inSlot = join(slot, 'design/screen.pen')
  const outside = join(tempDir('pen-other-'), 'lib.pen')
  writeFileSync(inSlot, '{}')
  writeFileSync(outside, '{}')
  w.world.state = state
  w.world.penRunning = true
  w.world.penFiles = [inSlot, outside]
  return { ...w, inSlot, outside }
}

test('quit refuses while a working session owns a file in its worktree; --force saves and quits', async () => {
  const { ctx, config, world, inSlot } = penWorld('working')
  await assert.rejects(penQuit(ctx, config, {}), (e) => e.code === EXIT.check && e.message.includes(inSlot) && /работающей сессии/.test(e.message))
  assert.equal(world.penRunning, true)
  const { data } = await penQuit(ctx, config, { force: true })
  assert.equal(data.quit, true)
  assert.deepEqual(data.saved.map((s) => s.verified), [true, true])
  assert.equal(world.penRunning, false)
})

test('a recent mention in a live session journal keeps Pen; an old one or the caller own journal does not', async () => {
  const { ctx, config, world, outside } = penWorld()
  world.append(say('m', at(ctx, -10 * 60), `Открой ${outside}`))
  assert.equal((await penIdleCheck(ctx, config, {})).data.action, 'keep')
  assert.equal((await penIdleCheck(ctx, config, { recent: '5m' })).data.action, 'quit', 'упоминание старше окна')
  ctx.env.SUPERSET_TERMINAL_ID = TERM
  assert.equal((await penIdleCheck(ctx, config, {})).data.action, 'quit', 'журнал вызывающей сессии не считается')
})

test('idle-check: idle session in the slot does not hold Pen; dry run keeps it open, --apply quits', async () => {
  const { ctx, config, world } = penWorld('idle')
  const dry = await penIdleCheck(ctx, config, {})
  assert.equal(dry.data.dryRun, true)
  assert.equal(world.penRunning, true)
  await penIdleCheck(ctx, config, { apply: true })
  assert.equal(world.penRunning, false)
  assert.equal((await penIdleCheck(ctx, config, {})).data.action, 'none')
})
