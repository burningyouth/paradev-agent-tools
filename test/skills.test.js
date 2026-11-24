import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import test from 'node:test'

import { createContext } from '../src/context.js'
import { PACKAGE_ROOT, SKILLS, agentHomes, installSkills, routerSource, skillPath, skillsCommand } from '../src/skills.js'
import { tempDir } from './helpers.js'

const homeContext = () => {
  const home = realpathSync(tempDir('agent-skills-'))
  return createContext({ env: { HOME: home, CLAUDE_CONFIG_DIR: join(home, 'custom-claude') }, cwd: home })
}

test('install supports both agents, is idempotent, and preserves personal references', () => {
  const ctx = homeContext()
  try {
    assert.deepEqual(agentHomes(ctx).map((item) => item.directory), [join(ctx.cwd, '.agents', 'skills'), join(ctx.cwd, 'custom-claude', 'skills')])
    const planned = installSkills(ctx, { agent: 'all', 'dry-run': true })
    assert.equal(planned.data.items.length, 2)
    assert.ok(planned.data.items.every((item) => item.action === 'create' && !existsSync(item.path)))
    assert.ok(!existsSync(ctx.agentHome))
    const installed = installSkills(ctx, { agent: 'all' })
    for (const item of installed.data.items) assert.equal(readFileSync(item.path, 'utf8'), routerSource())
    const personal = join(dirname(installed.data.items[0].path), 'references', 'personal.md')
    mkdirSync(dirname(personal), { recursive: true })
    writeFileSync(personal, 'personal rules')
    assert.ok(installSkills(ctx, { agent: 'all' }).data.items.every((item) => item.action === 'unchanged'))
    assert.equal(readFileSync(personal, 'utf8'), 'personal rules')
    assert.ok(!existsSync(join(ctx.agentHome, 'backups')))
  } finally { rmSync(ctx.cwd, { recursive: true, force: true }) }
})

test('conflicts are preflighted across agents, replacement backs up exact content and keeps references', () => {
  const ctx = homeContext()
  try {
    const targets = installSkills(ctx, { agent: 'all', 'dry-run': true }).data.items
    const target = targets[1].path
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, 'existing personal skill\n')
    const personal = join(dirname(target), 'references', 'personal.md')
    mkdirSync(dirname(personal), { recursive: true })
    writeFileSync(personal, 'keep me')
    assert.throws(() => installSkills(ctx, { agent: 'all' }), (error) => error.code === 9)
    assert.ok(!existsSync(targets[0].path))
    assert.equal(readFileSync(target, 'utf8'), 'existing personal skill\n')
    const plan = installSkills(ctx, { agent: 'all', 'dry-run': true })
    assert.equal(plan.data.items[1].action, 'replace')
    assert.ok(!existsSync(join(ctx.agentHome, 'backups')))
    const result = installSkills(ctx, { agent: 'all', force: true })
    assert.equal(readFileSync(result.data.items[1].backup, 'utf8'), 'existing personal skill\n')
    assert.equal(readFileSync(personal, 'utf8'), 'keep me')
  } finally { rmSync(ctx.cwd, { recursive: true, force: true }) }
})

test('custom directory is relative to caller cwd; invalid targets and symlinks do not get written', () => {
  const ctx = homeContext()
  try {
    assert.throws(() => installSkills(ctx, {}), /--agent/)
    assert.throws(() => installSkills(ctx, { agent: 'all', directory: 'skills' }), /одного/)
    const custom = installSkills(ctx, { agent: 'codex', directory: 'local skills' }).data.items[0].path
    assert.equal(custom, join(ctx.cwd, 'local skills', 'agent-cli', 'SKILL.md'))
    const victim = join(ctx.cwd, 'victim')
    writeFileSync(victim, 'do not replace')
    rmSync(custom)
    symlinkSync(victim, custom)
    assert.throws(() => installSkills(ctx, { agent: 'codex', directory: 'local skills', force: true }), /обычным файлом/)
    assert.equal(readFileSync(victim, 'utf8'), 'do not replace')
    symlinkSync(dirname(custom), join(ctx.cwd, 'linked-parent'))
    assert.throws(() => installSkills(ctx, { agent: 'codex', directory: 'linked-parent', force: true }), /обычной папкой/)
    mkdirSync(join(ctx.cwd, 'bad', 'agent-cli', 'SKILL.md'), { recursive: true })
    assert.throws(() => installSkills(ctx, { agent: 'codex', directory: 'bad' }), /обычным файлом/)
    assert.throws(() => skillPath('../secrets'), /Неизвестный/)
  } finally { rmSync(ctx.cwd, { recursive: true, force: true }) }
})

test('skills I/O errors are reported through the normal CLI error contract', async () => {
  const ctx = homeContext()
  try {
    writeFileSync(join(ctx.cwd, 'file'), 'not a directory')
    await assert.rejects(skillsCommand(ctx, 'install', [], { agent: 'codex', directory: 'file' }), (error) => error.code === 9)
    await assert.rejects(skillsCommand(ctx, 'install', ['extra'], { agent: 'codex' }), /paradev-agent --help/)
  } finally { rmSync(ctx.cwd, { recursive: true, force: true }) }
})

test('workflows and relative references are usable without config from foreign cwd', () => {
  const dir = realpathSync(tempDir('agent-package-'))
  try {
    const native = process.env.TEST_MCP_PACKAGE
    const root = realpathSync(native ?? PACKAGE_ROOT)
    mkdirSync(join(dir, 'broken-config'))
    writeFileSync(join(dir, 'broken-config', 'config.json'), '{broken')
    const env = { ...process.env, HOME: dir, AGENT_CLI_HOME: join(dir, 'broken-config') }
    const run = (...args) => spawnSync(
      native ? join(root, 'launch') : process.execPath,
      native ? ['--agent-cli', ...args] : [join(root, 'bin', 'agent.js'), ...args],
      { cwd: dir, env, encoding: 'utf8' })
    const help = run('--help', 'slots')
    assert.equal(help.status, 0, help.stderr)
    assert.match(help.stdout, /paradev-agent slot prepare/)
    const listed = run('skills', 'list', '--json')
    assert.equal(listed.status, 0, listed.stderr)
    assert.deepEqual(JSON.parse(listed.stdout).map((item) => item.name), SKILLS)
    for (const name of SKILLS) {
      const result = run('skills', 'path', name)
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout.trim(), join(root, 'skills', name, 'SKILL.md'))
      const content = readFileSync(result.stdout.trim(), 'utf8')
      for (const [, link] of content.matchAll(/\]\(([^)]+)\)/g)) {
        if (/^https?:/.test(link)) continue
        assert.ok(existsSync(join(dirname(result.stdout.trim()), link.split('#')[0])), link)
      }
    }
    const unknown = run('skills', 'path', '../secret', '--json')
    assert.equal(unknown.status, 1)
    assert.match(JSON.parse(unknown.stdout).error, /Неизвестный/)
    const installed = run('skills', 'install', '--agent', 'codex', '--json')
    assert.equal(installed.status, 0, installed.stderr)
    const target = JSON.parse(installed.stdout).items[0].path
    assert.equal(readFileSync(target, 'utf8'), routerSource())
    assert.deepEqual(readdirSync(dirname(target)), ['SKILL.md'])
    const missingAgent = run('skills', 'install', '--json')
    assert.equal(missingAgent.status, 1)
    assert.match(JSON.parse(missingAgent.stdout).error, /--agent/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
