import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { slotPromptLabel } from '../src/chat-slot.js'
import { tempDir } from './helpers.js'

test('Paradev relay displays only the slot question in the same chat turn before it completes', () => {
  const real = join(tempDir(), 'fake-codex')
  const matching = { method: 'hook/completed', params: { threadId: 'native', turnId: 'turn', run: {
    eventName: 'userPromptSubmit', source: 'user', statusMessage: slotPromptLabel, status: 'blocked',
    entries: [{ kind: 'feedback', text: 'Слот занят. Где продолжить?' }],
  } } }
  const unrelated = structuredClone(matching)
  unrelated.params.run.statusMessage = 'Foreign hook'
  const events = [unrelated, matching, { method: 'turn/completed', params: { turn: { id: 'turn' } } }]
  writeFileSync(real, `#!${process.execPath}
if (process.argv.includes('--version')) {
  console.log('codex-cli 0.170.0')
} else {
  for (const chunk of require('node:fs').readFileSync(0, 'utf8').trim().split('\\n')) console.log(chunk)
  for (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event))
}
`, { mode: 0o700 })
  const env = { ...process.env, AGENT_REAL_CODEX: real, SUPERSET_WORKSPACE_ID: 'workspace', SUPERSET_TERMINAL_ID: 'terminal' }
  const relay = fileURLToPath(new URL('../bin/codex', import.meta.url))
  const request = { id: 1, method: 'turn/start' }
  const invoke = (args, options) => spawnSync(process.execPath, [relay, ...args], { env, encoding: 'utf8', timeout: 5000, ...options })
  assert.equal(invoke(['--version']).stdout.trim(), 'codex-cli 0.170.0')
  const output = invoke(['app-server', '--stdio'], { input: JSON.stringify(request) + '\n' })
  assert.equal(output.status, 0, output.stderr)
  assert.deepEqual(output.stdout.trim().split('\n').map(JSON.parse), [
    request, unrelated, matching,
    { method: 'warning', params: { threadId: 'native', turnId: 'turn', message: 'Слот занят. Где продолжить?' } },
    events[2],
  ])
})
