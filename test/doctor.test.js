import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { doctor } from '../src/doctor.js'
import { fakeContext } from './helpers.js'

test('doctor probes dependencies without account access or writes and reports optional router warnings', () => {
  const ctx = fakeContext({ git: () => '', superset: () => '', ps: () => '', lsof: () => '' }, { platform: 'darwin' })
  const result = doctor(ctx, { superset: 'superset' })
  assert.equal(result.code, 0)
  assert.equal(result.data.ok, true)
  assert.ok(result.data.checks.filter((item) => item.name.startsWith('router-')).every((item) => item.status === 'warning'))
  assert.deepEqual(ctx.calls.map((call) => [call.cmd, call.args]), [
    ['git', ['--version']], ['superset', ['--version']], ['ps', ['-p', String(process.pid), '-o', 'pid=']], ['lsof', ['-v']],
  ])
  assert.ok(ctx.calls.every((call) => call.opts.timeout === 5000))
})

test('doctor returns check failure for a missing required dependency, tolerates optional failures and timeouts', () => {
  const ctx = fakeContext({
    git: () => '', superset: () => ({ status: 124, timedOut: true }), ps: () => '',
    lsof: () => { throw new Error('not found') },
  }, { platform: 'darwin' })
  const result = doctor(ctx, { superset: 'superset' })
  assert.equal(result.code, 9)
  assert.equal(result.data.ok, false)
  assert.equal(result.data.checks.find((item) => item.name === 'lsof').status, 'missing')
  assert.match(result.data.checks.find((item) => item.name === 'superset').detail, /таймаут/)
})

test('doctor reports broken config and continues checking other dependencies without changing it', () => {
  const ctx = fakeContext({ git: () => '', superset: () => '', ps: () => '', lsof: () => '' }, { platform: 'linux' })
  mkdirSync(ctx.agentHome, { recursive: true })
  writeFileSync(join(ctx.agentHome, 'config.json'), '{broken')
  const result = doctor(ctx)
  assert.equal(result.code, 9)
  assert.equal(result.data.checks.find((item) => item.name === 'config').status, 'missing')
  assert.ok(result.data.checks.some((item) => item.name === 'git' && item.status === 'ok'))
  assert.ok(!ctx.calls.some((call) => call.cmd === 'osascript'))
  assert.equal(readFileSync(join(ctx.agentHome, 'config.json'), 'utf8'), '{broken')
})
