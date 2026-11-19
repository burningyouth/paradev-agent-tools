import { existsSync } from 'node:fs'

import { EXIT } from './exit.js'
import { supportsPen } from './features.js'
import { agentHomes, skillsFor, skillPath } from './skills.js'
import { DEFAULT_CONFIG, loadConfig, resolveSuperset } from './store.js'

export const doctor = (ctx, config) => {
  const checks = []
  const add = (name, ok, detail, required = true) => checks.push({ name, status: ok ? 'ok' : required ? 'missing' : 'warning', detail })
  if (!config) {
    try {
      config = loadConfig(ctx)
      add('config', true, 'Пользовательский конфиг читается (или используются значения по умолчанию)')
    } catch (error) {
      add('config', false, error.message)
      config = { ...DEFAULT_CONFIG, superset: resolveSuperset(ctx, ctx.env.SUPERSET_BIN ?? DEFAULT_CONFIG.superset) }
    }
  }
  add('node', Number(process.versions.node.split('.')[0]) >= 22, process.version)
  const personal = supportsPen(ctx)
  const platform = ctx.platform ?? process.platform
  const platformDetail = platform === 'linux'
    ? 'Paradev для Linux: нужен запущенный локальный хост.'
    : 'Paradev для macOS: нужен запущенный локальный хост.'
  add('platform', ['darwin', 'linux'].includes(platform), `${platform}: ${platformDetail}`, false)
  const probe = (name, command, args, required = true) => {
    try {
      const result = ctx.run(command, args, { timeout: 5000 })
      add(name, result.status === 0, result.status === 0 ? command : `${command}: код ${result.status}${result.timedOut ? ' (таймаут)' : ''}`, required)
    } catch (error) { add(name, false, error.message, required) }
  }
  probe('git', 'git', ['--version'])
  probe('superset', config.superset, ['--version'])
  probe('ps', 'ps', ['-p', String(process.pid), '-o', 'pid='])
  probe('lsof', 'lsof', ['-v'])
  if (platform === 'darwin' && personal) probe('osascript', 'osascript', ['-e', 'return 1'], false)
  add('bundled-skills', skillsFor(ctx).every((name) => existsSync(skillPath(name, ctx))), 'Встроенные SKILL.md')
  // Наличие файла не доказывает, что уже работающий агент загрузил его.
  for (const item of agentHomes(ctx)) {
    const path = `${item.directory}/agent-cli/SKILL.md`
    add(`router-${item.agent}`, existsSync(path), path, false)
  }
  const ok = checks.every((check) => check.status !== 'missing')
  return {
    code: ok ? EXIT.ok : EXIT.check,
    data: { ok, checks, limitations: [personal
      ? 'Не проверяет вход в Superset, пресеты агентов, доступ к журналам и разрешение Универсального доступа.'
      : 'Не проверяет вход в Superset, пресеты агентов и доступ к журналам.'] },
    text: [...checks.map((check) => `${check.status}: ${check.name} — ${check.detail}`),
      personal
        ? 'Вход в Superset, пресеты, доступ к журналам и Универсальный доступ проверяются при работе с конкретной командой.'
        : 'Вход в Superset, пресеты и доступ к журналам проверяются при работе с конкретной командой.'].join('\n'),
  }
}
