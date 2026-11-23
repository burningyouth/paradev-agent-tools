const string = (description) => ({ type: 'string', minLength: 1, description })
const boolean = (description) => ({ type: 'boolean', description })
const integer = (description, maximum) => ({ type: 'integer', minimum: 1, maximum, description })
const array = (items, description) => ({ type: 'array', minItems: 1, items, description })
const choice = (...values) => ({ type: 'string', enum: values })
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })

const cwd = string('Absolute path of the selected project or worktree. Ask which project if unclear.')
const workspaceId = string('Exact Superset workspace ID, from projects, slot tools, or session records.')
const sessionId = string('Full session ID from create, session_list, or session_history. Keep the latest ID after send or resume.')
const target = { workspaceId, sessionId }
const branch = string('Git task branch per the project instructions.')
const task = string('Task identifier.')
const dryRun = boolean('Preview. Slot previews can fetch refs unless offline is true.')
const apply = boolean('Apply the operation after reviewing its CLI preview. Default is preview.')
const offline = boolean('Use local refs without fetching.')
const force = boolean('Use the CLI override only if explicitly requested and allowed by project rules.')
const agent = choice('codex', 'claude')
const setupAgent = choice('codex', 'claude', 'all')
const text = string('Message text.')
const file = string('File path, relative to cwd when supplied.')
const timeout = integer('Seconds to wait. Use a short timeout and continue from the same anchor.', 1800)
const plan = object({
  message: string('Commit message including any required trailers.'),
  paths: array(file, 'Files to include in full.'),
  hunks: array(object({
    path: file,
    include: { anyOf: [string('Text marker occurring in a hunk.'), array(string('Text marker.'), 'Text markers.'), array(integer('Hunk number.', 1000000), 'Hunk numbers.')] },
  }, ['path', 'include']), 'Partial changes from commit_hunks.'),
  closeChange: task,
})

const tools = {}
const add = (name, description, command, properties = {}, required = [], options = {}) => {
  tools[name] = { name, description, inputSchema: object(properties, required), command, ...options }
}
const project = (name, description, command, properties, required = [], options = {}) =>
  add(name, description, command, { cwd, ...properties }, ['cwd', ...required], { project: true, ...options })
const session = (name, description, command, properties = {}, required = [], options = {}) =>
  add(name, description, command, { ...target, cwd, ...properties }, ['workspaceId', 'sessionId', ...required], { session: true, ...options })

add('projects', 'List registered local projects and workspaces with IDs and paths for project selection.', null)
add('status', 'Show the selected worktree, Git changes and session state.', ['status'], { cwd, workspaceId }, ['cwd'])
add('diagnose', 'Check CLI dependencies, Paradev host reachability and PID visibility.', ['doctor'])
add('session_list', 'List live Codex and Claude sessions and capacity. States include working, idle and waiting.', ['ls'])
add('session_history', 'Read durable session history (including closed sessions, IDs, checkpoints and events). Works offline.', ['log'], { project: string('Project name from projects or a session record.'), task })
project('session_create', 'Start Codex chat by default, or terminal Codex/Claude in an explicitly selected workspace. Prepare a separate slot for delegated work.', ['create'], {
  workspaceId, prompt: string('Full assignment for the executor.'), promptFile: file, branch, task, agent,
  cli: boolean('Use terminal Codex.'), model: string('Executor model.'), mode: string('Codex chat mode.'),
  effort: string('Terminal executor reasoning effort.'), alias: string('Session alias.'),
}, ['workspaceId'], { workspace: true, prompt: true })
session('session_send', 'Send a follow-up once. Code 7 means delivery is uncertain. Check session_journal before any resend.', ['send'], { text, file, timeout, force }, [], { io: true })
session('session_journal', 'Read recent normalized user and assistant journal records. After uncertain send, identify the exact text and anchor here before considering a resend.', null, {
  limit: integer('Maximum recent visible entries (default 20).', 200),
  after: string('Optional opaque anchor. Only return records after it.'),
})
session('session_wait', 'Wait after an opaque journal anchor. Returns timeout, waiting (question or permission), idle, marker or API error. Idle ends a turn.', ['wait'], {
  after: string('Opaque anchor from send or journal.'), marker: string('Marker name without brackets.'),
  timeout, interval: integer('Polling interval in seconds.', 30),
})
session('session_last', 'Read the latest assistant reply and any current waiting question or permission.', ['last'])
project('session_resume', 'Resume a session by exact ID or select one from history by task/lastClosed, or resume all open records in the selected project. Review ambiguous results before retrying.', ['resume'], {
  workspaceId, sessionId, task, lastClosed: boolean('Select the latest closed record.'),
  allOpen: boolean('Resume all open records in this project.'), branch, agent, prompt: text, promptFile: file, dryRun, offline,
  model: string('Terminal executor model.'), effort: string('Terminal executor reasoning effort.'), alias: string('Session alias.'),
}, [], { prompt: true })
project('session_close', 'To close just the chat on request, set sessionOnly. For your own chat set afterReply, preview, then queue and include the exact receipt in your final reply. Check close_result from another session. Omit sessionId only to release an empty slot.', ['close'], {
  ...target, note: text, summaryFile: file, reason: string('Reason for closing.'), dryRun, force,
  sessionOnly: boolean('Preserve the assigned branch and skip workspace release.'),
  afterReply: boolean('Queue an exact chat until its completed reply includes the receipt. Works without caller identity from the harness.'),
}, ['workspaceId'], { workspace: true, optionalSession: true })
add('close_result', 'Check a queued close worker result. Read close and release status independently.', ['close'], { result: file }, ['result'])
project('task_complete', 'Explicitly close the task after its project workflow is complete. The host frees its slot after the turn and keeps the chat history open. A commit, push, or merge alone is not a completion signal.', ['task', 'complete'], {
  ...target, dryRun,
}, ['workspaceId', 'sessionId'], { workspace: true })
session('session_keep', 'Protect a session from cleanup, or remove its keep mark.', ['keep'], { remove: boolean('Remove the mark.') }, [], { historical: true })
session('session_forget', 'Remove a durable record from the registry. Use only on explicit request.', ['forget'], {}, [], { historical: true })
add('kept_sessions', 'List session IDs protected from cleanup.', ['keep'])
add('aliases', 'List registered session aliases.', ['alias'])
session('session_alias', 'Set an alias for a session, or remove an alias of that exact session.', ['alias'], {
  alias: string('Alias to set or remove.'), remove: boolean('Remove the alias.'),
}, ['alias'])
project('cleanup', 'Preview cleanup of the selected project; apply only within user-authorized scope after review.', ['gc'], {
  idle: string('Idle threshold, e.g. 30m.'), done: string('Completion marker regular expression.'), apply,
})
project('slot_list', 'List slots and check Git state and live sessions in the selected project.', ['slot', 'ls'], {})
project('slot_take', 'Select a free slot or create one and prepare it; returns exact workspace ID to use in session_create.', ['slot', 'take'], {
  branch, task, from: string('Base branch.'), dryRun, offline, carry: boolean('Carry existing changes if permitted.'),
  allowUnmerged: boolean('Allow an unmerged branch if permitted.'),
}, ['branch'])
project('slot_create', 'Create a detached slot without launching an agent.', ['slot', 'create'], {
  name: string('Slot name in slot-N format.'), base: string('Base branch.'), dryRun, offline,
})
project('slot_prepare', 'Prepare an exact existing slot and verify branch, project hooks and occupancy.', ['slot', 'prepare'], {
  workspaceId, branch, task, from: string('Base branch.'), dryRun, offline, force,
  carry: boolean('Carry existing changes if permitted.'), allowUnmerged: boolean('Allow an unmerged branch if permitted.'),
}, ['workspaceId', 'branch'], { workspace: true })
for (const [name, direction] of [['sync', 'both directions'], ['sync-back', 'from slot to main']]) {
  project(`slot_${name.replace('-', '_')}`, `Preview or synchronize project-local files ${direction}.`,
    ['slot', name], { workspaceId, apply }, ['workspaceId'], { workspace: true })
}
add('commit_hunks', 'List numbered unstaged hunks in the selected worktree.', ['commit', 'hunks'], { cwd, paths: array(file, 'Paths to inspect.') }, ['cwd', 'paths'])
add('commit_plan', 'Preview or apply exact commits in the selected worktree, respecting project rules and the existing index.', ['commit'], {
  cwd, plan: array(plan, 'Ordered commit or closeChange steps.'), planFile: file, apply,
}, ['cwd'])

const skill = choice('agent-sessions', 'agent-slots', 'agent-orchestrate', 'agent-commit', 'agent-cleanup', 'agent-setup')
add('skills_list', 'List bundled agent-cli workflows.', ['skills', 'list'])
add('skill_read', 'Read the bundled workflow for a particular operation.', ['skills', 'path'], { skill }, ['skill'])
add('executor_install', 'Install existing Codex/Claude executor routers and named lifecycle hooks. Always preview first. The Codex runtime requires trust for its hooks.', null, { agent: setupAgent, dryRun, force })
add('executor_install_skills', 'Install the existing executor router, optionally in a custom directory. Preview by default.', ['skills', 'install'], { agent: setupAgent, cwd, directory: file, dryRun, force }, ['agent'])
add('executor_install_hooks', 'Install named hooks for a Codex or Claude executor. Preview by default.', ['hook', 'install'], { agent, dryRun }, ['agent'])

export { tools }
