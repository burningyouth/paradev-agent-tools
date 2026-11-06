import { AgentError, mustRun } from './context.js'

/** Тонкая обёртка над `superset`: весь разбор его JSON — здесь, чтобы смена формата правилась в одном месте. */
export const superset = (ctx, config) => {
  const call = (args, what, options = {}) => {
    const out = mustRun(ctx, config.superset, [...args, '--json'], { what: `superset ${what}`, ...options })
    try {
      return JSON.parse(out)
    } catch {
      throw new AgentError(`superset ${what}: ответ не JSON\n${out.slice(0, 500)}`)
    }
  }
  const terminalArgs = (workspace, terminal) => ['--local', '--workspace', workspace, '--terminal', terminal]

  return {
    chatList: (workspace) => call(['sessions', 'list', '--local', '--workspace', workspace, '--limit', '200'], 'sessions list'),
    chatRead: (workspace, session, before, timeout) => call(['sessions', 'read', ...chatArgs(workspace, session), '--limit', '500', ...(before ? ['--before', typeof before === 'string' ? before : JSON.stringify(before)] : [])], 'sessions read', { timeout }),
    chatCreate: ({ workspace, agent, prompt, model, mode }) => call(['sessions', 'create', '--local', '--workspace', workspace, '--agent', agent,
      ...(prompt ? ['--prompt', prompt] : []), ...(model ? ['--model', model] : []), ...(mode ? ['--mode', mode] : [])], 'sessions create'),
    chatSend: (workspace, session, prompt, timeout) => call(['sessions', 'send', ...chatArgs(workspace, session), '--prompt', prompt], 'sessions send', { timeout }),
    chatClose: (workspace, session) => call(['sessions', 'close', ...chatArgs(workspace, session)], 'sessions close'),
    chatResume: (workspace, session) => call(['sessions', 'resume', ...chatArgs(workspace, session)], 'sessions resume'),
    /** Воркспейсы с терминалами и состоянием агента в каждом. */
    snapshot: () => call(['snapshot'], 'snapshot').workspaces ?? [],
    /** Воркспейсы с проектом и путём worktree. */
    workspaces: () => {
      const data = call(['ws', 'list', '--local'], 'ws list')
      return Array.isArray(data) ? data : (data.workspaces ?? data.items ?? [])
    },
    /** Воркспейс-worktree без агента: папку Superset выводит из ветки; ответ — как есть (id ищем в нём или по имени). */
    createWorkspace: ({ project, name, branch, baseBranch }) =>
      call(['ws', 'create', ...createWorkspaceArgs({ project, name, branch, baseBranch })], 'ws create'),
    /** Без --wait superset возвращается сразу; timeoutMs — страховка от зависшего вызова. */
    send: (workspace, terminal, text, timeoutMs) =>
      mustRun(ctx, config.superset, ['terminals', 'send', ...terminalArgs(workspace, terminal), '--text', text], {
        what: 'superset terminals send',
        timeout: timeoutMs,
      }),
    close: (workspace, terminal) =>
      mustRun(ctx, config.superset, ['terminals', 'close', ...terminalArgs(workspace, terminal)], {
        what: 'superset terminals close',
      }),
    /** Терминалы воркспейса на хосте: `exited` — процесс терминала завершился. */
    terminalsList: (workspace) => call(['terminals', 'list', '--local', '--workspace', workspace], 'terminals list').sessions ?? [],
    readScreen: (workspace, terminal, maxLines = 5) =>
      call(['terminals', 'read', ...terminalArgs(workspace, terminal), '--max-lines', String(maxLines)], 'terminals read').text ?? '',
    /** Панель приложения; закрытие панели завершает и её терминал. */
    closePane: (workspace, pane) =>
      mustRun(ctx, config.superset, ['panes', 'close', '--workspace', workspace, '--pane', pane], { what: 'superset panes close' }),
    /** Новая сессия агента; возвращает id терминала (Superset называет его sessionId). */
    createAgent: ({ workspace, prompt, model, effort, resumeSession, agent = 'codex' }) => {
      const args = ['agents', 'create', '--local', '--workspace', workspace, '--agent', agent]
      if (prompt) args.push('--prompt', prompt)
      if (model) args.push('--model', model)
      if (effort) args.push('--effort', effort)
      if (resumeSession) args.push('--resume-session', resumeSession)
      const data = call(args, 'agents create')
      const terminal = data.sessionId ?? data.terminalId ?? data.terminal?.id ?? data.id
      if (!terminal) throw new AgentError(`superset agents create: в ответе нет id терминала\n${JSON.stringify(data)}`)
      return { terminal, raw: data }
    },
  }
}

/** Аргументы `superset ws create` после `ws create`: ветка ровно как задана, без префикса проекта. */
export const createWorkspaceArgs = ({ project, name, branch, baseBranch }) => [
  '--local', '--project', project, '--name', name, '--branch', branch, '--skip-branch-prefix', '--base-branch', baseBranch,
]

/** Плоский список терминалов из snapshot: воркспейс, проект, заголовок, состояние агента. */
export const flattenTerminals = (snapshot) =>
  snapshot.flatMap((ws) =>
    (ws.terminals ?? []).map((t) => ({
      terminal: t.id,
      workspace: ws.id,
      workspaceName: ws.name,
      project: ws.project,
      branch: ws.branch,
      title: cleanTitle(t.title),
      agent: t.agent?.id ?? null,
      agentState: t.agent?.state ?? null,
    })),
  )

/** Claude ставит в заголовок терминала значок-спиннер: «◑ Задача» → «Задача». */
export const cleanTitle = (title) => (title ? title.replace(/^[^\p{L}\p{N}]+/u, '').trim() || null : null)

/** Панели воркспейса из snapshot: layout.tabs[].panes[] с terminalId. */
export const workspacePanes = (ws) =>
  (ws.layout?.tabs ?? []).flatMap((tab) => (tab.panes ?? []).filter((p) => p.terminalId).map((p) => ({ pane: p.id, terminal: p.terminalId })))

const chatArgs = (workspace, session) => ['--local', '--workspace', workspace, '--session', session]
