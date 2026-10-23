import assert from 'node:assert/strict'
import { utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { findWindow, penCommand } from '../src/pen.js'
import { fakeContext, tempDir } from './helpers.js'

const dir = tempDir('pen-')
const FILE = join(dir, 'store-settings.pen')
const LIB = join(dir, 'ui-kit.lib.pen')
writeFileSync(FILE, '{}')
writeFileSync(LIB, '{}')

/** osascript-заглушка: ls отдаёт окна, клик «Save» трогает файл окна (как настоящий Pen). */
const penWorld = ({ denied = false, touch = true } = {}) => {
  const world = { scripts: [], opened: [], running: true }
  const ctx = fakeContext({
    osascript: (args, { input }) => {
      if (denied) return { status: 1, stderr: 'execution error: Функции Упрощенного доступа для «osascript» не разрешены. (-1719)' }
      world.scripts.push(input)
      if (input.includes('repeat with w in windows')) {
        return `store-settings.pen\t${pathToFileURL(FILE)}\nui-kit.lib.pen\tmissing value\n`
      }
      if (input.includes('click menu item "Save"') && touch) {
        const target = input.includes('store-settings') ? FILE : LIB
        utimesSync(target, new Date(), new Date(Date.now() + 5000 + Math.random() * 1000))
      }
      if (input.includes('to quit')) world.running = false
      return ''
    },
    open: (args) => {
      world.opened.push(args.at(-1))
      return ''
    },
    pgrep: () => ({ status: world.running ? 0 : 1 }),
  })
  return { ctx, world }
}

test('ls parses titles and AXDocument paths', async () => {
  const { ctx } = penWorld()
  const { data } = await penCommand(ctx, {}, 'ls', [], {})
  assert.deepEqual(data, [
    { index: 1, title: 'store-settings.pen', file: FILE },
    { index: 2, title: 'ui-kit.lib.pen', file: null },
  ])
})

test('findWindow by number, by path and by title', () => {
  const windows = [
    { index: 1, title: 'store-settings.pen', file: FILE },
    { index: 2, title: 'ui-kit.lib.pen', file: null },
  ]
  assert.equal(findWindow(windows, '2').title, 'ui-kit.lib.pen')
  assert.equal(findWindow(windows, FILE).index, 1)
  assert.equal(findWindow(windows, '/elsewhere/ui-kit.lib.pen').index, 2)
  assert.equal(findWindow(windows, 'store').index, 1)
  assert.equal(findWindow(windows, 'nope'), undefined)
})

test('save raises the window, clicks File › Save and verifies mtime', async () => {
  const { ctx, world } = penWorld()
  const { data } = await penCommand(ctx, {}, 'save', [FILE], {})
  assert.equal(data.verified, true)
  const script = world.scripts.at(-1)
  assert.match(script, /perform action "AXRaise" of \(first window whose name is "store-settings\.pen"\)/)
  assert.match(script, /click menu item "Save" of menu "File"/)
  assert.doesNotMatch(script, /keystroke/)
})

test('save reports unchanged mtime instead of claiming success', async () => {
  const { ctx } = penWorld({ touch: false })
  const { data, text } = await penCommand(ctx, {}, 'save', ['store-settings'], {})
  assert.equal(data.verified, false)
  assert.match(text, /mtime не изменился/)
})

test('dry run prints the script and clicks nothing; close uses Close Window', async () => {
  const { ctx, world } = penWorld()
  const { text } = await penCommand(ctx, {}, 'close', ['2'], { 'dry-run': true })
  assert.match(text, /click menu item "Close Window"/)
  assert.ok(world.scripts.every((s) => !s.includes('click menu item')))
})

test('missing Accessibility gives a hint, not a raw osascript error', async () => {
  const { ctx } = penWorld({ denied: true })
  await assert.rejects(penCommand(ctx, {}, 'ls', [], {}), /Универсальный доступ.*\n.*-1719/s)
})

test('restart saves every window, quits, waits and reopens the files', async () => {
  const { ctx, world } = penWorld()
  const dry = await penCommand(ctx, {}, 'restart', [], { 'dry-run': true, open: [] })
  assert.deepEqual(dry.data.plan, ['File › Save: store-settings.pen', 'File › Save: ui-kit.lib.pen', 'quit Pen', `open -a Pen ${FILE}`])
  assert.equal(world.running, true)
  const { data } = await penCommand(ctx, {}, 'restart', [], { open: [FILE, LIB] })
  assert.equal(data.saved.length, 2)
  assert.equal(world.running, false)
  assert.deepEqual(world.opened, [FILE, LIB])
  const quitAt = world.scripts.findIndex((s) => s.includes('to quit'))
  assert.equal(world.scripts.filter((s, i) => s.includes('click menu item "Save"') && i < quitAt).length, 2)
})
