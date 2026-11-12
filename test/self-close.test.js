import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { makeRepo, tempDir, writeFiles } from './helpers.js'

const BIN = fileURLToPath(new URL('../bin/agent.js', import.meta.url))
const WORKER = fileURLToPath(new URL('../src/close-worker.js', import.meta.url))
const read = (path) => JSON.parse(readFileSync(path, 'utf8'))

/** Настоящие CLI и detached worker; внешние ps/Superset заменены временными исполняемыми файлами. */
const setup = (kind) => {
  const root = tempDir('agent-self-close-')
  const repo = makeRepo({ 'a.txt': 'a\n', '.gitignore': '.ai/\n' })
  const main = join(root, 'main')
  const bin = join(root, 'bin')
  const agentHome = join(root, 'agent-home')
  const claudeHome = join(root, 'claude')
  const stateFile = join(root, 'state.json')
  mkdirSync(bin)
  writeFiles(main, {
    '.agent-cli.json': JSON.stringify({ slot: { localFiles: ['.ai/rules.md'] } }),
    '.ai/rules.md': '# A\na\n',
  })
  writeFiles(repo, { '.ai/rules.md': '# A\na\n\n# B\nfrom slot\n' })
  writeFiles(agentHome, { 'sessions.json': JSON.stringify({ aliases: { self: 'self-terminal' } }) })
  writeFiles(claudeHome, { 'sessions/123.json': JSON.stringify({ sessionId: 'self-session', cwd: repo, status: 'idle' }) })
  writeFileSync(stateFile, JSON.stringify({ kind, repo, main, alive: true, calls: [] }))
  const executable = (name, code) => {
    const path = join(bin, name)
    writeFileSync(path, `#!${process.execPath}\n${code}`)
    chmodSync(path, 0o700)
    return path
  }
  executable('ps', `
    const fs = require('node:fs'); const s = JSON.parse(fs.readFileSync(process.env.TEST_STATE));
    const args = process.argv.slice(2);
    if (s.kind === 'cli' && s.alive) {
      if (args[0] === '-axo') console.log('123 1 100 /bin/claude');
      else console.log('/bin/claude' + (args[0] === '-E' ? ' SUPERSET_TERMINAL_ID=self-terminal SUPERSET_WORKSPACE_ID=self-workspace' : ''));
    }
  `)
  const superset = executable('superset', `
    const fs = require('node:fs'); const s = JSON.parse(fs.readFileSync(process.env.TEST_STATE));
    const args = process.argv.slice(2); const key = args.slice(0,2).join(' ');
    s.calls.push(key);
    let out;
    const terminal = { id: 'self-terminal', title: 'task', agent: { id: 'claude', state: 'idle' } };
    const chat = { sessionId: 'self-session', terminalId: 'self-terminal', harness: 'codex-acp', harnessSessionId: 'native-self', status: 'idle', live: s.alive };
    if (key === 'snapshot --json') out = { workspaces: [{ id: 'self-workspace', name: 'slot-1 · task', project: 'proj', terminals: s.kind === 'cli' && s.alive ? [terminal] : [], layout: { tabs: [{ panes: s.kind === 'cli' && s.alive ? [{ id: 'self-pane', terminalId: 'self-terminal' }] : [] }] } }] };
    else if (key === 'ws list') out = [{ id: 'self-workspace', name: 'slot-1 · task', projectName: 'proj', worktreePath: s.repo }];
    else if (key === 'sessions list') out = s.kind === 'chat' ? [chat] : [];
    else if (key === 'sessions read') out = { ok: true, envelopes: [{ ts: Date.now(), cursor: { epoch: 'e', seq: 1 }, event: { type: 'turn', turn: { status: 'completed' } } }] };
    else if (key === 'sessions close' || key === 'panes close') { s.alive = false; out = { closed: true }; }
    else if (key === 'terminals list') out = { sessions: [] };
    else if (key === 'ws update') { s.renamed = args[args.indexOf('--name')+1]; out = {}; }
    else if (key === 'projects list') out = [{ name: 'proj', path: s.main }];
    else throw new Error('unexpected: ' + args.join(' '));
    fs.writeFileSync(process.env.TEST_STATE, JSON.stringify(s)); console.log(JSON.stringify(out));
  `)
  const env = {
    ...process.env, PATH: `${bin}:/usr/bin:/bin`, SUPERSET_BIN: superset, TEST_STATE: stateFile,
    AGENT_CLI_HOME: agentHome, CLAUDE_CONFIG_DIR: claudeHome,
    CODEX_THREAD_ID: kind === 'chat' ? 'native-self' : '',
    SUPERSET_TERMINAL_ID: 'self-terminal', SUPERSET_WORKSPACE_ID: 'self-workspace',
  }
  return { root, repo, main, agentHome, stateFile, env }
}

test('self-close worker outlives its CLI and completes close, registry, rename and sync-back for CLI and chat', async () => {
  for (const kind of ['cli', 'chat']) {
    const w = setup(kind)
    const caller = spawnSync(process.execPath, [BIN, 'sess', 'close', '--note', 'done', '--json'], {
      cwd: w.repo, env: w.env, encoding: 'utf8', timeout: 10_000,
    })
    assert.equal(caller.status, 0, caller.stderr)
    const queued = JSON.parse(caller.stdout)
    assert.equal(queued.status, 'queued')
    const deadline = Date.now() + 10_000
    let result
    do {
      result = read(queued.resultFile)
      if (['closed', 'error'].includes(result.status)) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    } while (Date.now() < deadline)
    assert.equal(result.status, 'closed', JSON.stringify(result))
    assert.equal(read(w.stateFile).alive, false)
    assert.equal(read(w.stateFile).renamed, 'slot-1')
    assert.equal(result.data.kind, kind)
    const record = read(join(w.agentHome, 'sessions.json')).sessions[0]
    assert.equal(record.alias, 'self')
    assert.equal(record.note, 'done')
    assert.equal(record.sessionId, 'self-session')
    assert.equal(readFileSync(join(w.main, '.ai/rules.md'), 'utf8'), '# A\na\n\n# B\nfrom slot\n')
    const calls = read(w.stateFile).calls
    assert.ok(calls.includes(kind === 'chat' ? 'sessions close' : 'panes close'))
    if (kind === 'chat') assert.ok(!calls.includes('panes close'))
  }
})

test('worker refuses a replaced session and records an error without closing anything', () => {
  const w = setup('chat')
  const file = join(w.root, 'job.json')
  writeFileSync(file, JSON.stringify({
    status: 'queued', callerPid: 2147483647,
    target: { kind: 'chat', terminal: 'old-terminal', sessionId: 'self-session', workspace: 'self-workspace' },
    config: { superset: w.env.SUPERSET_BIN },
    context: { cwd: w.repo, agentHome: w.agentHome }, options: {},
  }))
  const child = spawnSync(process.execPath, [WORKER, file], { env: w.env, encoding: 'utf8', timeout: 10_000 })
  assert.equal(child.status, 9, child.stderr)
  assert.match(read(file).error, /Сессия изменилась/)
  assert.equal(read(w.stateFile).alive, true)
  assert.ok(!read(w.stateFile).calls.includes('sessions close'))
  assert.deepEqual(read(join(w.agentHome, 'sessions.json')).sessions, undefined)
})

test('status is wired to the CLI in text and JSON formats without changing workspace state', () => {
  const w = setup('chat')
  for (const args of [['status', '--json'], ['status']]) {
    const caller = spawnSync(process.execPath, [BIN, ...args], { cwd: w.repo, env: w.env, encoding: 'utf8', timeout: 10_000 })
    assert.equal(caller.status, 0, caller.stderr)
    if (args.includes('--json')) {
      const result = JSON.parse(caller.stdout)
      assert.equal(result.workspace.id, 'self-workspace')
      assert.equal(result.git.branch, 'main')
      assert.equal(result.session.sessionId, 'self-session')
    } else {
      assert.match(caller.stdout, /Проект: proj/)
      assert.match(caller.stdout, /Ветка: main/)
    }
    assert.equal(read(w.stateFile).alive, true)
    assert.equal(read(w.stateFile).renamed, undefined)
    assert.equal(readFileSync(join(w.main, '.ai/rules.md'), 'utf8'), '# A\na\n')
  }
})
