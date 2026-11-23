import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { AgentError } from './context.js'
import { doctor } from './doctor.js'
import { installHooks } from './hooks.js'
import { installSkills } from './skills.js'

const agentsFor = (ctx, choice) => {
  if (choice) {
    if (!['codex', 'claude', 'all'].includes(choice)) throw new AgentError('--agent: выберите codex, claude или all')
    return choice === 'all' ? ['codex', 'claude'] : [choice]
  }
  const agents = ['codex', 'claude'].filter((agent) => existsSync(agent === 'codex' ? ctx.codexHome : ctx.claudeHome) ||
    (ctx.env.PATH ?? '').split(':').filter(Boolean).some((dir) => existsSync(join(dir, agent))))
  if (!agents.length) throw new AgentError('Не найдены Codex/Claude. Укажите --agent codex|claude|all для предварительной настройки')
  return agents
}

/** One entry point; reuse the component installers without invoking another CLI process. */
export const installExecutor = (ctx, opts = {}) => {
  try {
    for (const key of Object.keys(opts)) if (!['agent', 'json', 'dry-run', 'force'].includes(key)) {
      throw new AgentError(`Настройка исполнителя не принимает --${key}.`)
    }
    const agents = agentsFor(ctx, opts.agent)
    const selection = agents.length === 2 ? 'all' : agents[0]
    // Validate every destination before any write, including the second provider's settings.
    const skillsPlan = installSkills(ctx, { agent: selection, 'dry-run': true })
    const hookPlans = agents.map((agent) => installHooks(ctx, { agent, 'dry-run': true }).data)
    const conflicts = skillsPlan.data.items.filter((item) => item.action === 'replace')
    if (conflicts.length && !opts.force && !opts['dry-run']) throw new AgentError(
      `Роутер отличается: ${conflicts.map((item) => item.path).join(', ')}. Сначала выполните предпросмотр. При подтверждённой замене передайте force=true. Роутер сохранится в резервной копии, references/ останется на месте.`, 9)
    const skills = opts['dry-run'] ? skillsPlan.data : installSkills(ctx, { agent: selection, force: opts.force }).data
    const hooks = hookPlans.map((plan, i) => {
      const installed = opts['dry-run'] ? plan : installHooks(ctx, { agent: agents[i] }).data
      return { agent: agents[i], path: installed.path, changed: installed.changed, backup: installed.backup,
        names: ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'].flatMap((event) => (installed.hooks[event] ?? [])
          .flatMap((group) => group.hooks).filter((hook) => typeof hook.statusMessage === 'string' && hook.statusMessage.startsWith('agent-cli:')).map((hook) => hook.statusMessage)) }
    })
    const diagnostics = doctor(ctx)
    const next = [
      ...(agents.includes('codex') ? ['Запустите codex в терминале. Если появится Hooks need review, подтвердите именованные хуки agent-cli. В чате Superset команды /hooks нет.'] : []),
      'Откройте новую сессию агента, чтобы загрузить роутер и хуки.',
    ]
    const dryRun = Boolean(opts['dry-run'])
    return {
      code: diagnostics.code,
      data: { status: dryRun ? 'planned' : 'installed', dryRun, agents, skills: skills.items, hooks, diagnostics: diagnostics.data, next },
      text: [dryRun ? `План настройки: ${agents.join(', ')}` : `Настроены: ${agents.join(', ')}`,
        ...skills.items.map((item) => `Роутер: ${item.action} — ${item.path}${item.backup ? `; бэкап ${item.backup}` : ''}`),
        ...hooks.map((item) => `Хуки: ${item.changed ? dryRun ? 'обновить' : 'обновлены' : 'без изменений'} — ${item.path}${item.backup ? `; бэкап ${item.backup}` : ''}`),
        `Зависимости: ${diagnostics.data.ok ? 'проверки пройдены' : 'требуют исправления (код 9)'}`,
        ...diagnostics.data.checks.filter((check) => check.status === 'missing').map((check) => `  ${check.name}: ${check.detail}`),
        ...(dryRun ? ['Сухой прогон: файлы не изменены.'] : next),
      ].join('\n'),
    }
  } catch (error) {
    if (error instanceof AgentError) throw error
    throw new AgentError(`Не удалось завершить установку: ${error.message}`)
  }
}
