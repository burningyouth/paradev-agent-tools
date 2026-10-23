import { AgentError, mustRun } from './context.js'

/** Тонкая обёртка над `superset`: весь разбор его JSON — здесь, чтобы смена формата правилась в одном месте. */
export const superset = (ctx, config) => {
  const call = (args, what) => {
    const out = mustRun(ctx, config.superset, [...args, '--json'], { what: `superset ${what}` })
    try {
      return JSON.parse(out)
    } catch {
      throw new AgentError(`superset ${what}: ответ не JSON\n${out.slice(0, 500)}`)
    }
  }
  const terminalArgs = (workspace, terminal) => ['--local', '--workspace', workspace, '--terminal', terminal]

  return {
    /** Воркспейсы с терминалами и состоянием агента в каждом. */
    snapshot: () => call(['snapshot'], 'snapshot').workspaces ?? [],
    /** Воркспейсы с проектом и путём worktree. */
    workspaces: () => {
      const data = call(['ws', 'list', '--local'], 'ws list')
      return Array.isArray(data) ? data : (data.workspaces ?? data.items ?? [])
    },
    send: (workspace, terminal, text) =>
      mustRun(ctx, config.superset, ['terminals', 'send', ...terminalArgs(workspace, terminal), '--text', text], {
        what: 'superset terminals send',
      }),
    close: (workspace, terminal) =>
      mustRun(ctx, config.superset, ['terminals', 'close', ...terminalArgs(workspace, terminal)], {
        what: 'superset terminals close',
      }),
    /** Новая сессия агента; возвращает id терминала (Superset называет его sessionId). */
    createAgent: ({ workspace, prompt, model, effort, resumeSession }) => {
      const args = ['agents', 'create', '--local', '--workspace', workspace, '--agent', 'claude']
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
