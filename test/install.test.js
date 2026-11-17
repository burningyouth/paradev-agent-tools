import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { install } from '../src/install.js'
import { installSkills, routerSource } from '../src/skills.js'
import { readJson, writeJson } from '../src/store.js'
import { fakeContext, tempDir } from './helpers.js'

const setup = (agents = ['codex']) => {
  const ctx = fakeContext({ git: () => '', superset: () => '', ps: () => '', lsof: () => '' }, { platform: 'linux' })
  const home = realpathSync(ctx.env.HOME)
  Object.assign(ctx, { cwd: home, agentHome: join(home, '.agent-cli'), codexHome: join(home, '.codex'), claudeHome: join(home, '.claude') })
  ctx.env.HOME = home; ctx.env.PATH = ''
  for (const agent of agents) mkdirSync(agent === 'codex' ? ctx.codexHome : ctx.claudeHome, { recursive: true })
  return ctx
}

test('one install detects both providers, plans without writes, preserves personal settings and is idempotent', () => {
  const ctx = setup(['codex', 'claude'])
  const settings = join(ctx.claudeHome, 'settings.json')
  writeJson(settings, { permissions: { allow: ['Read'] }, hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'superset-notify', statusMessage: 42 }] }] } })
  const plan = install(ctx, { 'dry-run': true })
  assert.deepEqual(plan.data.agents, ['codex', 'claude']); assert.equal(plan.data.status, 'planned')
  assert.ok(!existsSync(join(ctx.env.HOME, '.agents'))); assert.ok(!existsSync(join(ctx.codexHome, 'hooks.json')))
  assert.ok(!existsSync(ctx.agentHome))
  const personal = join(dirname(plan.data.skills[0].path), 'references', 'personal.md')
  mkdirSync(dirname(personal), { recursive: true }); writeFileSync(personal, 'keep my rules')
  const applied = install(ctx)
  assert.equal(applied.code, 0); assert.equal(applied.data.status, 'installed')
  for (const skill of applied.data.skills) assert.equal(readFileSync(skill.path, 'utf8'), routerSource())
  assert.equal(readFileSync(personal, 'utf8'), 'keep my rules')
  assert.deepEqual(readJson(settings).permissions, { allow: ['Read'] })
  assert.equal(readJson(settings).hooks.SessionEnd[0].hooks[0].command, 'superset-notify')
  assert.equal(readJson(settings).hooks.SessionEnd[0].hooks[0].statusMessage, 42)
  assert.ok(applied.data.hooks.every((item) => item.names.length === 3))
  const before = readFileSync(settings, 'utf8')
  const repeated = install(ctx)
  assert.ok(repeated.data.skills.every((item) => item.action === 'unchanged'))
  assert.ok(repeated.data.hooks.every((item) => !item.changed && !item.backup))
  assert.equal(readFileSync(settings, 'utf8'), before)
  assert.ok(!existsSync(join(ctx.codexHome, 'config.toml')))
  assert.ok(ctx.calls.every((call) => ['--version', '-p', '-v'].includes(call.args[0])))
})

test('a conflict in the second router blocks the entire setup; explicit force saves an exact backup', () => {
  const ctx = setup(['codex', 'claude'])
  const paths = installSkills(ctx, { agent: 'all', 'dry-run': true }).data.items
  mkdirSync(dirname(paths[1].path), { recursive: true }); writeFileSync(paths[1].path, 'personal router\n')
  assert.throws(() => install(ctx), (e) => e.code === 9 && /--force/.test(e.message))
  assert.ok(!existsSync(paths[0].path)); assert.ok(!existsSync(join(ctx.codexHome, 'hooks.json')))
  const changed = install(ctx, { force: true })
  assert.equal(readFileSync(changed.data.skills[1].backup, 'utf8'), 'personal router\n')
  assert.equal(readFileSync(paths[1].path, 'utf8'), routerSource())
})

test('malformed second-provider hook settings are rejected before the first router or hook is written', () => {
  for (const value of ['{broken', JSON.stringify({ hooks: { Stop: {} } })]) {
    const ctx = setup(['codex', 'claude'])
    writeFileSync(join(ctx.claudeHome, 'settings.json'), value)
    assert.throws(() => install(ctx), /JSON|формат/)
    assert.ok(!existsSync(join(ctx.env.HOME, '.agents')))
    assert.ok(!existsSync(join(ctx.codexHome, 'hooks.json')))
    assert.equal(readFileSync(join(ctx.claudeHome, 'settings.json'), 'utf8'), value)
  }
})

test('explicit provider selection works before profile creation and rejects unrelated flags', () => {
  const ctx = setup([])
  assert.throws(() => install(ctx), /Не найдены/)
  assert.throws(() => install(ctx, { agent: 'qwen' }), /выберите/)
  assert.throws(() => install(ctx, { directory: 'elsewhere' }), /не принимает/)
  assert.deepEqual(install(ctx, { agent: 'codex' }).data.agents, ['codex'])
  assert.ok(!existsSync(ctx.claudeHome))
})

test('dependency failures remain visible after file setup and a broken CLI config is preserved', () => {
  const ctx = setup()
  writeJson(join(ctx.agentHome, 'config.json'), { superset: 'superset', maxSessions: 3 })
  const run = ctx.run
  ctx.run = (cmd, args, opts) => cmd.endsWith('superset') ? { status: 1, stdout: '', stderr: 'missing' } : run(cmd, args, opts)
  const result = install(ctx)
  assert.equal(result.code, 9); assert.equal(result.data.status, 'installed')
  assert.equal(result.data.diagnostics.ok, false)
  assert.ok(existsSync(join(ctx.codexHome, 'hooks.json')))
  assert.equal(readJson(join(ctx.agentHome, 'config.json')).maxSessions, 3)
  writeFileSync(join(ctx.agentHome, 'config.json'), '{broken')
  const broken = install(ctx)
  assert.equal(broken.code, 9); assert.match(broken.text, /config/)
  assert.equal(readFileSync(join(ctx.agentHome, 'config.json'), 'utf8'), '{broken')
})

test('linked hook files, including dangling links, are not replaced by unified setup', () => {
  for (const dangling of [false, true]) {
    const ctx = setup(); const target = join(ctx.cwd, 'target.json')
    if (!dangling) writeFileSync(target, '{}')
    symlinkSync(target, join(ctx.codexHome, 'hooks.json'))
    assert.throws(() => install(ctx), (e) => e.code === 9)
    assert.ok(!existsSync(join(ctx.env.HOME, '.agents')))
    if (!dangling) assert.equal(readFileSync(target, 'utf8'), '{}')
  }
})

test('actual unified CLI works from a foreign cwd, exposes scoped help, and reports partial readiness as JSON', () => {
  const home = realpathSync(tempDir('agent-install-cli-'))
  mkdirSync(join(home, '.codex'))
  const env = { ...process.env, HOME: home, AGENT_CLI_HOME: join(home, '.agent-cli'), CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'), PATH: '/usr/bin:/bin', SUPERSET_BIN: '/missing/superset' }
  const bin = fileURLToPath(new URL('../bin/agent.js', import.meta.url))
  const run = (...args) => spawnSync(process.execPath, [bin, ...args], { cwd: home, env, encoding: 'utf8' })
  const plan = run('install', '--dry-run', '--json')
  assert.equal(plan.status, 9); assert.equal(JSON.parse(plan.stdout).status, 'planned')
  assert.ok(!existsSync(join(home, '.agents')))
  const applied = run('install', '--json')
  assert.equal(applied.status, 9, applied.stderr)
  const data = JSON.parse(applied.stdout)
  assert.equal(data.status, 'installed'); assert.deepEqual(data.agents, ['codex'])
  assert.equal(readFileSync(data.skills[0].path, 'utf8'), routerSource())
  assert.equal(run('install', 'extra').status, 1)
  assert.match(run('install', '--help').stdout, /--agent codex\|claude\|all/)
})
