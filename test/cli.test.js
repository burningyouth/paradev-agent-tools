import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { runCommand } from '../src/context.js'
import { resolveSuperset } from '../src/store.js'
import { tempDir } from './helpers.js'
import { globToRegExp, matchesAny } from '../src/glob.js'

const BIN = fileURLToPath(new URL('../bin/agent.js', import.meta.url))
const agent = (...args) => spawnSync('node', [BIN, ...args], { encoding: 'utf8', env: { ...process.env, AGENT_CLI_HOME: '/nonexistent' } })

test('help, unknown command and --json errors', () => {
  assert.match(agent('--help').stdout, /agent ls/)
  assert.match(agent('--help').stdout, /agent status \[--json\]/)
  const unknown = agent('nope', 'x')
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /^Ошибка: Неизвестная группа nope/)
  const json = agent('commit', '--json')
  assert.deepEqual(JSON.parse(json.stdout), { error: 'Нужно: paradev-agent commit <план.json> [--apply]', code: 1 })
  assert.match(agent('sess', 'ls', '--bogus').stderr, /Ошибка: Unknown option '--bogus'/)
  assert.deepEqual(JSON.parse(agent('status', 'extra', '--json').stdout), { error: 'Нужно: paradev-agent status [--json]', code: 1 })
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

test('superset is found without PATH to ~/.superset/bin and without a bare-name match', () => {
  const home = tempDir('agent-home-')
  const bin = join(home, '.superset', 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'superset'), '')
  const ctx = (env) => ({ env })
  assert.equal(resolveSuperset(ctx({ HOME: home, PATH: '/usr/bin:/bin' }), 'superset'), join(bin, 'superset'))
  assert.equal(resolveSuperset(ctx({ HOME: home }), '~/.superset/bin/superset'), join(bin, 'superset'))
  assert.equal(resolveSuperset(ctx({ HOME: home }), '/nowhere/superset'), join(bin, 'superset'))
  const other = tempDir('agent-path-')
  writeFileSync(join(other, 'superset'), '')
  assert.equal(resolveSuperset(ctx({ HOME: home, PATH: other }), 'superset'), join(other, 'superset'))
})

test('help starts with the task workflow; group and command help show only their own operations', () => {
  const home = agent('--help').stdout
  assert.ok(home.split('\n').length < 25)
  assert.match(home, /agent close/)
  assert.doesNotMatch(home, /--allow-unmerged|agent forget/)
  const sessions = agent('sess', '--help').stdout
  assert.match(sessions, /agent close/)
  assert.doesNotMatch(sessions, /agent pen|agent slot prepare/)
  const finish = agent('sess', 'finish', '--help').stdout
  assert.match(finish, /--summary-file/)
  assert.doesNotMatch(finish, /agent create|agent slot/)
  const slot = agent('slot', '--help').stdout
  assert.match(slot, /agent slot prepare/)
  assert.match(slot, /Обычно нужен take/)
})


test('topic help serves each complete workflow without loading configuration or contacting Paradev', () => {
  const home = tempDir('paradev-help-')
  writeFileSync(join(home, 'config.json'), '{broken')
  const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: home, encoding: 'utf8',
    env: { ...process.env, AGENT_CLI_HOME: home, SUPERSET_BIN: '/missing/superset' } })
  const help = run('--help')
  assert.equal(help.status, 0)
  assert.match(help.stdout, /^paradev-agent —/)
  assert.doesNotMatch(help.stdout, /skills (list|path|install)/)
  for (const topic of ['sessions', 'slots', 'orchestration', 'commit-plan', 'cleanup', 'setup']) {
    const result = run('--help', topic)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^# /)
    assert.equal(result.stdout, run(topic, '--help').stdout)
  }
  assert.match(run('--help', 'slots').stdout, /paradev-agent slot prepare/)
  assert.match(run('--help', 'commit-plan').stdout, /paradev-agent commit hunks/)
  assert.equal(run('--help', '../skills').status, 1)
})
