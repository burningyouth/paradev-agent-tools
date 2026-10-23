import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { runCommand } from '../src/context.js'
import { globToRegExp, matchesAny } from '../src/glob.js'

const BIN = fileURLToPath(new URL('../bin/agent.js', import.meta.url))
const agent = (...args) => spawnSync('node', [BIN, ...args], { encoding: 'utf8', env: { ...process.env, AGENT_CLI_HOME: '/nonexistent' } })

test('help, unknown command and --json errors', () => {
  assert.match(agent('--help').stdout, /agent sess ls/)
  const unknown = agent('nope', 'x')
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /^Ошибка: Неизвестная группа nope/)
  const json = agent('commit', '--json')
  assert.deepEqual(JSON.parse(json.stdout), { error: 'Нужно: agent commit <план.json> [--apply]', code: 1 })
  assert.match(agent('sess', 'ls', '--bogus').stderr, /Ошибка: Unknown option '--bogus'/)
})

test('globs: ** spans directories, * stays in a segment, bare names match anywhere', () => {
  assert.ok(matchesAny('node_modules/a/b.js', ['node_modules/**']))
  assert.ok(matchesAny('.env.local', ['.env*']))
  assert.ok(matchesAny('apps/web/.env.local', ['.env*']))
  assert.ok(matchesAny('a/b/c/key.pem', ['**/*.pem']))
  assert.ok(matchesAny('key.pem', ['**/*.pem']))
  assert.ok(!matchesAny('src/env.ts', ['.env*']))
  assert.ok(!globToRegExp('design/*.pen').test('design/sub/x.pen'))
  assert.ok(globToRegExp('design/**/*.pen').test('design/sub/x.pen'))
})

test('runCommand stops a hung child at the timeout with status 124', () => {
  const started = Date.now()
  const result = runCommand('sleep', ['5'], { timeout: 300 })
  assert.equal(result.status, 124)
  assert.equal(result.timedOut, true)
  assert.ok(Date.now() - started < 3000)
})
