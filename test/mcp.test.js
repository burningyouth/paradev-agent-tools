import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { accessSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { classifyPid } from '../mcp/host.js'
import { parseJsonc, patchJsonc } from '../mcp/jsonc.js'
import { git, tempDir } from './helpers.js'

const repository = fileURLToPath(new URL('../', import.meta.url))
const packageRoot = process.env.TEST_MCP_PACKAGE ?? repository
const callClient = (t, env, cwd, root = packageRoot) => {
  const command = root === packageRoot && process.env.TEST_MCP_PACKAGE
    ? [join(root, 'launch')] : [process.execPath, join(root, 'mcp/server.js')]
  const child = spawn(command[0], command.slice(1), { env, cwd, stdio: ['pipe', 'pipe', 'inherit'] })
  t.after(() => child.stdin.end())
  const replies = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  let id = 0
  const send = (method, params) => child.stdin.write(JSON.stringify({
    jsonrpc: '2.0', method, params, ...(method.startsWith('notifications/') ? {} : { id: ++id }),
  }) + '\n')
  const request = async (method, params) => {
    send(method, params)
    const line = await replies.next()
    assert.equal(line.done, false, 'MCP closed without responding')
    const message = JSON.parse(line.value)
    assert.equal(message.id, id)
    assert.equal(message.error, undefined, line.value)
    return message.result
  }
  const call = async (name, args) => {
    const response = await request('tools/call', { name, arguments: args })
    assert.deepEqual(JSON.parse(response.content[0].text), response.structuredContent)
    return response.structuredContent
  }
  return { send, request, call }
}

test('stdio lifecycle uses the selected project and exact IDs, including uncertain send and verified release', { timeout: 90_000 }, async (t) => {
  const dir = realpathSync(tempDir('agent mcp profile '))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const home = join(dir, 'home')
  const cwd = join(dir, 'project main with spaces')
  const slot = join(dir, 'slot worktree with spaces')
  const stateFile = join(dir, 'host.json')
  const fake = join(dir, 'superset')
  mkdirSync(home)
  const bin = join(home, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'ps'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  const penProbe = join(dir, 'pen-probe')
  for (const command of ['pgrep', 'osascript']) {
    writeFileSync(join(bin, command), '#!/bin/sh\nprintf "%s\\n" "$0" >> "$TEST_PEN_PROBE"\n', { mode: 0o700 })
  }
  mkdirSync(cwd)
  git(cwd, 'init', '-q', '-b', 'main')
  writeFileSync(join(cwd, 'tracked.txt'), 'first\n')
  git(cwd, 'add', 'tracked.txt')
  git(cwd, 'commit', '-qm', 'test base')
  const origin = join(dir, 'origin.git')
  git(cwd, 'clone', '--bare', cwd, origin)
  git(cwd, 'remote', 'add', 'origin', origin)
  git(cwd, 'fetch', 'origin')
  git(cwd, 'worktree', 'add', '--detach', slot, 'HEAD')
  writeFileSync(fake, '#!/bin/sh\nexec "$TEST_NODE_BIN" "$TEST_HOST_FIXTURE" "$@"\n', { mode: 0o700 })
  const read = () => JSON.parse(readFileSync(stateFile, 'utf8'))
  const update = (patch) => writeFileSync(stateFile, JSON.stringify({ ...(patch.main ? {} : read()), ...patch }))
  update({ main: cwd, slot, name: 'slot-1', records: [] })

  const env = {
    HOME: home, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, MULTI_AGENT_NODE: process.execPath,
    TEST_NODE_BIN: process.execPath, TEST_HOST_FIXTURE: join(repository, 'test/fixtures/mcp-host.cjs'),
    SUPERSET_BIN: fake, TEST_HOST_STATE: stateFile, TEST_PEN_PROBE: penProbe, SUPERSET_WORKSPACE_ID: 'unrelated-inherited-id',
  }
  assert.notEqual(spawnSync('/bin/sh', ['-c', 'command -v agent'], { env }).status, 0)
  accessSync(fake)
  const { request, send, call } = callClient(t, env, packageRoot)
  const hello = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {},
    clientInfo: { name: 'test', version: '1' } })
  assert.equal(hello.serverInfo.name, 'multi-agent-mcp')
  send('notifications/initialized')
  const { tools } = await request('tools/list', {})
  assert.equal(new Set(tools.map((tool) => tool.name)).size, 32)
  assert.doesNotMatch(JSON.stringify(tools), /pen_|agent-pen|keepPen/)
  assert.doesNotMatch(JSON.stringify(await call('skills_list')), /agent-pen/)
  const cleanupSkill = await call('skill_read', { skill: 'agent-cleanup' })
  assert.doesNotMatch(cleanupSkill.data.instructions, /agent-pen|--keep-pen|idle-check/)
  assert.ok(tools.every((tool) => tool.inputSchema.type === 'object' && tool.inputSchema.additionalProperties === false))
  const executorPlan = await call('executor_install', { agent: 'codex' })
  assert.equal(executorPlan.data.status, 'planned')
  assert.ok(!existsSync(join(home, '.codex')))
  const executor = await call('executor_install', { agent: 'codex', dryRun: false })
  assert.equal(executor.data.status, 'installed')
  assert.equal(executor.data.hooks[0].names.length, 3)
  assert.ok(existsSync(join(home, '.agents', 'skills', 'agent-cli', 'SKILL.md')))
  assert.ok(!existsSync(join(home, '.local', 'bin', 'agent')))
  assert.match((await call('status', {})).error, /cwd/)
  const projectReply = await call('projects')
  assert.equal(projectReply.code, 0, JSON.stringify(projectReply))
  const projects = projectReply.data
  assert.equal(projects.projects[0].path, cwd)
  assert.equal((await call('status', { cwd })).data.workspace.id, 'main-id')
  assert.equal((await call('status', { cwd, workspaceId: 'slot-id' })).code, 9)
  const diagnostics = await call('diagnose')
  assert.equal(diagnostics.data.host.status, 'reachable')
  assert.doesNotMatch(JSON.stringify(diagnostics), /"pen"|osascript/)
  for (const args of [{ cwd }, { cwd, apply: true }]) {
    const cleanup = await call('cleanup', args)
    assert.equal(cleanup.code, 0, JSON.stringify(cleanup))
    assert.equal(Object.hasOwn(cleanup.data, 'pen'), false)
  }
  assert.equal(existsSync(penProbe), false)
  const commit = { cwd, plan: [{ message: 'test', paths: ['tracked.txt'] }] }
  assert.equal((await call('commit_plan', commit)).code, 9)
  git(cwd, 'config', 'user.name', 'Test')
  git(cwd, 'config', 'user.email', 'test@example.invalid')
  const head = git(cwd, 'rev-parse', 'HEAD')
  writeFileSync(join(cwd, 'tracked.txt'), 'changed\n')
  const commitPreview = await call('commit_plan', commit)
  assert.equal(commitPreview.code, 0, JSON.stringify(commitPreview))
  assert.equal(git(cwd, 'rev-parse', 'HEAD'), head)
  assert.equal(git(cwd, 'diff', '--cached', '--name-only'), '')
  writeFileSync(join(cwd, 'tracked.txt'), 'first\n')

  const taken = await call('slot_take', { cwd, branch: 'task-branch', task: 'TASK', offline: true })
  assert.equal(taken.code, 0, JSON.stringify(taken))
  assert.equal(taken.data.workspace, 'slot-id')
  assert.equal(git(slot, 'branch', '--show-current'), 'task-branch')
  const create = { cwd, workspaceId: 'slot-id', branch: 'task-branch', task: 'TASK', prompt: 'Read project instructions' }
  const created = await call('session_create', create)
  assert.equal(created.status, 'created', JSON.stringify(created))
  assert.ok(read().launchPrompt.includes("'/bin/agent.js'") || read().launchPrompt.includes("/bin/agent.js' status --json"))
  const target = { workspaceId: created.data.workspace, sessionId: created.data.sessionId }
  assert.equal((await call('session_create', create)).code, 9)
  assert.equal((await call('session_last', { ...target, workspaceId: 'main-id' })).code, 6)
  assert.equal((await call('session_last', { ...target, sessionId: target.sessionId.slice(0, -1) })).code, 6)
  const sent = await call('session_send', { ...target, text: '--help is literal text' })
  assert.equal(sent.status, 'accepted', JSON.stringify(sent))
  assert.ok(sent.data.anchor)
  const reply = await call('session_wait', { ...target, after: sent.data.anchor, marker: 'DONE', timeout: 1 })
  assert.equal(reply.data.reason, 'marker')
  assert.equal(reply.data.answer.text, 'Result [[DONE]]')

  update({ queued: true, sendTimeout: true })
  const uncertain = await call('session_send', { ...target, text: 'Could already be delivered', timeout: 1 })
  assert.equal(uncertain.status, 'delivery-unknown', JSON.stringify(uncertain))
  const journal = (await call('session_journal', { ...target, after: sent.data.anchor })).data.entries
  const delivered = journal.find((entry) => entry.text === 'Could already be delivered')
  assert.equal(delivered.queued, true)
  assert.equal(journal.filter((entry) => entry.text === delivered.text).length, 1)
  const wait = { ...target, after: delivered.anchor, marker: 'DONE', timeout: 1 }
  assert.equal((await call('session_wait', wait)).data.reason, 'timeout')
  update({ waiting: true })
  const waiting = await call('session_wait', wait)
  assert.equal(waiting.data.reason, 'waiting')
  assert.equal(waiting.data.waiting.kind, 'question')
  assert.equal((await call('session_close', { cwd, ...target })).code, 3)
  update({ waiting: false, queued: false, sendTimeout: false })
  const followUp = await call('session_send', { ...target, text: 'Finish the task' })
  assert.equal((await call('session_wait', { ...target, after: followUp.data.anchor, marker: 'DONE' })).data.reason, 'marker')
  const selfClose = await call('session_close', { cwd: slot, ...target, afterReply: true, sessionOnly: true, dryRun: true })
  assert.equal(selfClose.code, 0, JSON.stringify(selfClose))
  assert.equal(selfClose.data.afterReply, true)
  assert.equal(selfClose.data.release, false)
  const preview = await call('session_close', { cwd, ...target, dryRun: true })
  assert.equal(preview.data.dryRun, true)
  assert.equal(read().live, true)
  git(cwd, 'remote', 'set-url', 'origin', join(dir, 'unavailable-origin.git'))
  const partial = await call('session_close', { cwd, ...target })
  assert.equal(partial.data.status, 'partial', JSON.stringify(partial))
  assert.equal(partial.data.close.status, 'closed')
  assert.equal(partial.data.release.status, 'unverified')
  git(cwd, 'remote', 'set-url', 'origin', origin)
  const close = await call('session_close', { cwd, workspaceId: target.workspaceId })
  assert.equal(close.data.status, 'completed', JSON.stringify(close))
  assert.equal(close.data.close.status, 'already-closed')
  assert.equal(close.data.release.status, 'released')
  assert.equal(read().name, 'slot-1')
  assert.equal(git(slot, 'branch', '--show-current'), '')
  assert.equal((await call('session_history')).data.sessions[0].status, 'closed')
  await call('session_keep', target)
  assert.deepEqual((await call('kept_sessions')).data, [target.sessionId])

  update({ unavailable: true })
  const hostDir = join(home, '.paradev', 'host', 'test-organization')
  mkdirSync(hostDir, { recursive: true })
  writeFileSync(join(hostDir, 'manifest.json'), '{"pid":2147483647,"authToken":"must-not-appear"}')
  const unavailable = await call('diagnose')
  assert.equal(unavailable.data.host.status, 'unavailable')
  assert.equal(unavailable.data.host.pids[0].process, 'exited')
  assert.doesNotMatch(JSON.stringify(unavailable), /must-not-appear|superset start/)
  assert.equal((await call('status', { cwd })).host.status, 'unavailable')
})

test('an already running MCP handles a removed plugin cache through its matching install or backup', async (t) => {
  const dir = realpathSync(tempDir('agent mcp retired cache '))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const home = join(dir, 'home')
  const cache = join(dir, 'cache')
  const installed = join(home, '.codex', 'plugins', 'multi-agent-mcp')
  for (const item of ['mcp', 'src', 'package.json']) cpSync(join(repository, item), join(cache, item), { recursive: true })
  mkdirSync(join(installed, 'runtime'), { recursive: true })
  mkdirSync(join(installed, 'mcp'))
  symlinkSync(process.execPath, join(installed, 'runtime', 'node'))
  writeFileSync(join(installed, 'package.json'), '{"type":"module"}')
  writeFileSync(join(installed, 'mcp/invoke.js'), 'process.stdin.resume(); process.stdout.write(JSON.stringify({ installed: true }))')
  const { request, call } = callClient(t, { ...process.env, HOME: home }, dir, cache)
  const { serverInfo } = await request('initialize', { protocolVersion: '2025-11-25' })
  rmSync(cache, { recursive: true })
  const manifest = join(installed, 'plugin.json')
  writeFileSync(manifest, JSON.stringify({ name: serverInfo.name, version: serverInfo.version }))
  assert.deepEqual(await call('skills_list'), { code: 0, data: { installed: true } })
  const backup = installed + '.d50837f3-d02c-447c-86bb-dd337752146c.bak'
  cpSync(installed, backup, { recursive: true })
  writeFileSync(manifest, JSON.stringify({ name: serverInfo.name, version: '99.0.0' }))
  assert.deepEqual(await call('skills_list'), { code: 0, data: { installed: true } })
  rmSync(backup, { recursive: true })
  const stale = await call('skills_list')
  assert.equal(stale.code, 1)
  assert.match(stale.data.error, /Перезапустите Codex/)
})

test('host PID diagnostic separates inaccessible and dead processes', () => {
  for (const [code, expected] of [['EPERM', 'permission-denied'], ['ESRCH', 'exited']]) {
    assert.equal(classifyPid(42, () => { throw Object.assign(new Error(), { code }) }), expected)
  }
  assert.equal(classifyPid(42, () => {}), 'running')
})

test('OpenCode JSONC settings update only the plugin entry and keep unrelated comments', () => {
  const source = '{\n  // client setting\n  "mcp": {"servers":{"other":{"type":"remote"}, /* keep */}},\n}\n'
  const keys = ['mcp', 'servers', 'multi-agent-mcp']
  const value = { type: 'local', command: ['/with spaces/launch'] }
  const result = patchJsonc(source, keys, value)
  assert.match(result, /\/\/ client setting/)
  assert.match(result, /\/\* keep \*\//)
  assert.deepEqual(parseJsonc(result).value.mcp.servers, { other: { type: 'remote' }, 'multi-agent-mcp': value })
  assert.equal(patchJsonc(result, keys, value), result)
  assert.throws(() => patchJsonc('{"mcp":false}', keys, value), /Expected an object/)
})
