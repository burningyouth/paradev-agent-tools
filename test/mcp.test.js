import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { accessSync, constants, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { classifyPid } from '../mcp/host.js'
import { parseJsonc, patchJsonc } from '../mcp/jsonc.js'
import project from '../package.json' with { type: 'json' }
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
  if (process.env.TEST_MCP_PACKAGE) symlinkSync(process.execPath, join(bin, 'node'))
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

test('a running MCP uses its matching install or backup after cache removal or replacement', async (t) => {
  const dir = realpathSync(tempDir('agent mcp retired cache '))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const home = join(dir, 'home')
  const cache = join(dir, 'cache')
  const installed = join(home, '.codex', 'plugins', 'multi-agent-mcp')
  for (const item of ['mcp', 'src', 'package.json']) cpSync(join(repository, item), join(cache, item), { recursive: true })
  mkdirSync(join(installed, 'mcp'), { recursive: true })
  writeFileSync(join(installed, 'package.json'), '{"type":"module"}')
  writeFileSync(join(installed, 'mcp/invoke.js'), 'process.stdin.resume(); process.stdout.write(JSON.stringify({ installed: true }))')
  const { request, call } = callClient(t, { ...process.env, HOME: home }, dir, cache)
  const { serverInfo } = await request('initialize', { protocolVersion: '2025-11-25' })
  const manifest = join(installed, 'plugin.json')
  writeFileSync(manifest, JSON.stringify({ name: serverInfo.name, version: serverInfo.version }))
  writeFileSync(join(cache, 'mcp/plugin.json'), JSON.stringify({ name: serverInfo.name, version: '99.0.0' }))
  writeFileSync(join(cache, 'mcp/invoke.js'), 'process.stdin.resume(); process.stdout.write("{}")')
  assert.deepEqual(await call('skills_list'), { code: 0, data: { installed: true } })
  rmSync(cache, { recursive: true })
  assert.deepEqual(await call('skills_list'), { code: 0, data: { installed: true } })
  const backup = installed + '.d50837f3-d02c-447c-86bb-dd337752146c.bak'
  cpSync(installed, backup, { recursive: true })
  writeFileSync(manifest, JSON.stringify({ name: serverInfo.name, version: '99.0.0' }))
  assert.deepEqual(await call('skills_list'), { code: 0, data: { installed: true } })
  rmSync(backup, { recursive: true })
  const stale = await call('skills_list')
  assert.equal(stale.code, 1)
  assert.match(stale.data.error, /Перезапустите клиент/)
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

test('Kilo installer preserves JSONC, is idempotent and refuses a conflicting server', (t) => {
  const root = realpathSync(tempDir('paradev kilo profile '))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'package')
  mkdirSync(join(source, 'mcp'), { recursive: true })
  cpSync(join(repository, 'src'), join(source, 'src'), { recursive: true })
  for (const file of ['install.js', 'jsonc.js', 'plugin.json']) cpSync(join(repository, 'mcp', file), join(source, 'mcp', file))
  cpSync(join(repository, 'mcp/plugin.json'), join(source, 'plugin.json'))
  cpSync(join(repository, 'mcp/launch'), join(source, 'launch'))
  writeFileSync(join(source, 'package.json'), '{"type":"module"}')
  const configHome = join(root, 'config')
  const config = join(configHome, 'kilo/kilo.jsonc')
  mkdirSync(join(configHome, 'kilo'), { recursive: true })
  writeFileSync(config, '{\n  // existing setting\n  "mcp": { "other": { "type": "remote" } },\n}\n')
  const install = () => spawnSync(process.execPath, [join(source, 'mcp/install.js'), 'kilo', '--json'], {
    env: { ...process.env, HOME: root, XDG_CONFIG_HOME: configHome }, encoding: 'utf8',
  })
  const result = install()
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const { installed, backups } = JSON.parse(result.stdout)
  assert.equal(backups.length, 1)
  const updated = readFileSync(config, 'utf8')
  assert.match(updated, /\/\/ existing setting/)
  const server = { type: 'local', command: [join(installed, 'launch')], enabled: true }
  assert.deepEqual(parseJsonc(updated).value.mcp, { other: { type: 'remote' }, 'paradev-agent-tools': server })
  assert.deepEqual(JSON.parse(install().stdout).backups, [])
  writeFileSync(config, patchJsonc(updated, ['mcp', 'paradev-agent-tools', 'enabled'], false))
  assert.equal(install().status, 0)
  assert.deepEqual(parseJsonc(readFileSync(config, 'utf8')).value.mcp['paradev-agent-tools'], server)

  const conflicting = '{"mcp":{"paradev-agent-tools":{"type":"local","command":["/other/launch"]}}}'
  const otherConfig = join(configHome, 'kilo/kilo.json')
  writeFileSync(otherConfig, conflicting)
  const refused = install()
  assert.equal(refused.status, 1, refused.stdout + refused.stderr)
  assert.equal(readFileSync(otherConfig, 'utf8'), conflicting)
})

test('archive installer records Node for GUI launches and migrates the 0.1.6 profile',
  { skip: !process.env.TEST_MCP_PACKAGE }, (t) => {
    const root = realpathSync(tempDir('paradev archive profile '))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const entry = join(dirname(packageRoot), process.platform === 'darwin' ? 'Install.command' : 'Install.sh')
    assert.equal(existsSync(join(packageRoot, 'runtime')), false)
    for (const name of ['Install.command', 'Install.sh']) accessSync(join(dirname(packageRoot), name), constants.X_OK)
    const installed = join(root, 'home/.codex/plugins/multi-agent-mcp')
    const nodeProfile = `${installed}.node-path`
    const config = join(root, 'config/kilo/kilo.json')
    const blocked = join(root, 'blocked')
    const compatible = join(root, 'compatible')
    const old = join(root, 'old')
    for (const path of [blocked, compatible, old]) mkdirSync(path)
    for (const command of ['git', 'npm', 'agent', 'sudo']) {
      writeFileSync(join(blocked, command), '#!/bin/sh\nexit 99\n', { mode: 0o755 })
    }
    symlinkSync(process.execPath, join(compatible, 'node'))
    const minimum = Number(project.engines.node.slice(2))
    writeFileSync(join(old, 'node'), `#!/bin/sh
exec "$TEST_NODE_BIN" -e 'Object.defineProperty(process.versions, "node", { value: "${minimum - 1}.0.0" }); eval(process.argv[1])' "$2" "$3"
`, { mode: 0o755 })
    mkdirSync(dirname(config), { recursive: true })
    const configBefore = '{"mcp":{"other":{"type":"remote"}}}\n'
    writeFileSync(config, configBefore)
    const env = { HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'),
      PATH: `${compatible}:${blocked}:/usr/bin:/bin`, TEST_NODE_BIN: process.execPath }
    for (const path of ['', `${old}:${blocked}`]) {
      const refused = spawnSync(entry, ['kilo'], {
        cwd: root, env: { ...env, PATH: path }, encoding: 'utf8', timeout: 15_000,
      })
      assert.equal(refused.status, 1)
      assert.equal(refused.stdout, '')
      assert.ok(refused.stderr.includes(`Node.js LTS версии ${minimum} или новее`))
      assert.match(refused.stderr, /https:\/\/nodejs\.org\/en\/download/)
      assert.match(refused.stderr, /снова запустите Install.command или Install.sh/)
      assert.equal(existsSync(installed), false)
      assert.equal(existsSync(nodeProfile), false)
      assert.equal(readFileSync(config, 'utf8'), configBefore)
    }
    const install = () => {
      const result = spawnSync(entry, ['kilo', '--json'], { cwd: root, env, encoding: 'utf8', timeout: 15_000 })
      assert.equal(result.status, 0, result.stdout + result.stderr)
      const data = JSON.parse(result.stdout)
      assert.equal(data.installed, installed)
      return data
    }

    assert.equal(install().activated, true)
    const execPath = spawnSync(join(compatible, 'node'), ['-p', 'process.execPath'], { encoding: 'utf8' }).stdout
    assert.equal(readFileSync(nodeProfile, 'utf8'), execPath)
    const guiEnv = { ...env, PATH: '' }
    const launch = (packagePath, launchEnv) => spawnSync(join(packagePath, 'launch'), [], {
      cwd: root, env: launchEnv, encoding: 'utf8', timeout: 15_000,
      input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }) + '\n',
    })
    const initializes = (packagePath, launchEnv) => {
      const result = launch(packagePath, launchEnv)
      assert.equal(result.status, 0, result.stdout + result.stderr)
      assert.equal(JSON.parse(result.stdout).result.serverInfo.name, 'multi-agent-mcp')
    }
    const cache = join(root, 'home/.codex/plugins/cache/multi-agent-private/multi-agent-mcp', 'installed version')
    cpSync(packageRoot, cache, { recursive: true })
    initializes(installed, guiEnv)
    initializes(cache, { ...guiEnv, PATH: old })
    const refused = spawnSync(entry, ['kilo'], { cwd: root, env: guiEnv, encoding: 'utf8', timeout: 15_000 })
    assert.equal(refused.status, 1, refused.stdout + refused.stderr)
    assert.equal(readFileSync(nodeProfile, 'utf8'), execPath)
    for (const unusable of [join(root, 'missing-node'), join(old, 'node')]) {
      writeFileSync(nodeProfile, unusable + '\n')
      assert.equal(launch(installed, guiEnv).status, 1)
      initializes(installed, env)
    }
    assert.equal(install().backups.length, 1)
    assert.equal(readFileSync(nodeProfile, 'utf8'), execPath)
    const profile = readFileSync(config, 'utf8')
    assert.equal(parseJsonc(profile).value.mcp['paradev-agent-tools'].command[0], join(installed, 'launch'))
    assert.equal(parseJsonc(profile).value.mcp.other.type, 'remote')
    assert.deepEqual(install().backups, [])
    const manifest = join(installed, 'plugin.json')
    const expected = readFileSync(manifest, 'utf8')
    writeFileSync(manifest, JSON.stringify({ ...JSON.parse(expected), version: '0.1.6' }))
    const legacyNode = join(installed, 'runtime/node')
    mkdirSync(dirname(legacyNode))
    writeFileSync(legacyNode, 'old runtime')
    const originalHook = (agent) => ({
      type: 'command',
      command: `AGENT_HOOK_RUNTIME_PID="$PPID" '${legacyNode}' '${join(installed, 'bin/agent.js')}' hook stop --agent ${agent}`,
      statusMessage: 'agent-cli: сохранение состояния',
    })
    const hookPaths = [
      ['codex', join(env.HOME, '.codex/hooks.json')],
      ['claude', join(env.HOME, '.claude/settings.json')],
    ]
    const otherHook = { type: 'command', command: "'/another/runtime/node' '/another/bin/agent.js' hook stop --agent codex" }
    for (const [agent, path] of hookPaths) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify({ marker: true, hooks: { Stop: [{ hooks: [originalHook(agent), otherHook] }] } }))
    }
    const personal = join(env.HOME, '.agents/skills/agent-cli/references/personal.md')
    mkdirSync(dirname(personal), { recursive: true })
    writeFileSync(personal, 'personal settings\n')

    const updated = install()
    assert.equal(updated.backups.length, 3)
    assert.equal(readFileSync(join(updated.backups[0], 'runtime/node'), 'utf8'), 'old runtime')
    assert.equal(existsSync(legacyNode), false)
    assert.equal(readFileSync(manifest, 'utf8'), expected)
    for (const [agent, path] of hookPaths) {
      const migrated = JSON.parse(readFileSync(path, 'utf8'))
      assert.deepEqual(migrated, {
        marker: true,
        hooks: { Stop: [{ hooks: [{ ...originalHook(agent),
          command: `AGENT_HOOK_RUNTIME_PID="$PPID" '${join(installed, 'launch')}' --agent-cli hook stop --agent ${agent}` }, otherHook] }] },
      })
      const hook = spawnSync('/bin/sh', ['-c', migrated.hooks.Stop[0].hooks[0].command], {
        cwd: root, env: guiEnv, input: '{"hook_event_name":"Stop","agent_id":"test"}', encoding: 'utf8', timeout: 15_000,
      })
      assert.equal(hook.status, 0, hook.stdout + hook.stderr)
    }
    assert.deepEqual(install().backups, [])
    assert.equal(readFileSync(personal, 'utf8'), 'personal settings\n')
    assert.equal(readFileSync(config, 'utf8'), profile)
    assert.equal(existsSync(join(root, 'home/.local/bin/agent')), false)
  })
