const fs = require('node:fs')
const path = process.env.TEST_HOST_STATE
const state = JSON.parse(fs.readFileSync(path, 'utf8'))
const args = process.argv.slice(2)
const command = args.slice(0, 2).join(' ')
const flag = (name) => args[args.indexOf(name) + 1]
const save = () => fs.writeFileSync(path, JSON.stringify(state))

if (state.unavailable && command !== '--version') {
  console.error('Error: Host service manifest is stale (recorded PID is dead)\nHint: Run: superset start')
  process.exit(1)
}
const { main, slot } = state
const project = { id: 'project-one', name: 'test project', path: main }
const workspace = (id, name, worktreePath) => ({ id, name, projectId: project.id, projectName: project.name, worktreePath })
const chat = () => ({ sessionId: 'session-one', terminalId: 'terminal-one', harness: 'codex-acp', status: state.waiting ? 'awaiting_input' : 'idle', live: state.live })
const envelope = (event) => ({ ts: Date.now(), cursor: { epoch: 'test', seq: state.records.length + 1 }, event })
const add = (event) => state.records.push(envelope(event))

let result
switch (command) {
  case '--version': result = 'Fixture'; break
  case 'projects list': result = [project]; break
  case 'ws list': result = [workspace('main-id', 'Main', main), workspace('slot-id', state.name, slot)]; break
  case 'ws update':
    state.name = flag('--name')
    save()
    result = {}
    break
  case 'snapshot --json': result = { workspaces: [] }; break
  case 'sessions list': result = state.created && flag('--workspace') === 'slot-id' ? [chat()] : []; break
  case 'sessions create':
    state.created = state.live = true
    state.launchPrompt = args.includes('--prompt') ? flag('--prompt') : undefined
    save()
    result = chat()
    break
  case 'sessions send': {
    if (!state.launchPrompt) state.launchPrompt = flag('--prompt')
    const seq = state.records.length
    add({ type: 'item', item: { id: `prompt-${seq}`, kind: 'user_message', queued: Boolean(state.queued),
      content: [{ type: 'text', text: flag('--prompt') }] } })
    if (!state.queued) {
      add({ type: 'item', item: { id: `answer-${seq}`, kind: 'agent_message', text: 'Result [[DONE]]' } })
      add({ type: 'turn', turn: { status: 'completed' } })
    }
    save()
    if (state.sendTimeout) setTimeout(() => {}, 10_000)
    else result = chat()
    break
  }
  case 'sessions read': {
    const envelopes = [...state.records]
    if (state.waiting) envelopes.push(envelope({ type: 'item', item: { id: 'approval', kind: 'approval_request',
      title: 'Choose an option', form: { message: 'Which one?' }, options: ['A', 'B'], status: 'pending' } }))
    result = { ok: true, envelopes }
    break
  }
  case 'sessions close': state.live = false; save(); result = { closed: true }; break
  default: throw new Error('Test fixture received unexpected command: ' + args.join(' '))
}
if (result !== undefined) console.log(JSON.stringify(result))
