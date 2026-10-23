import { cleanTitle, workspacePanes } from './superset.js'

/**
 * Уборка воркспейса Superset. `terminals close` завершает терминал на хосте, но панель в приложении
 * остаётся и показывает мёртвую сессию, поэтому терминал с панелью закрываем через `panes close`,
 * а панели без живого терминала — отдельно.
 */

// Строка приглашения шелла: zsh %, bash $, root #, starship/oh-my-zsh ❯ ➜, fish >
const PROMPT = /[%$#❯➜>»]\s*$/

/** Экран свободного шелла: пусто или последняя строка — приглашение (запущенная команда пишет вывод). */
export const isIdleShellScreen = (text) => {
  const last = (text ?? '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .at(-1)
  return !last || PROMPT.test(last)
}

/** Закрывает терминал через его панель, если она есть; возвращает, что именно закрыто. */
export const closeTerminal = (api, ws, terminal) => {
  const pane = workspacePanes(ws).find((p) => p.terminal === terminal)
  if (pane) api.closePane(ws.id, pane.pane)
  else api.close(ws.id, terminal)
  return pane ? { pane: pane.pane, terminal } : { terminal }
}

/** Панели, чей терминал уже не живёт в воркспейсе. */
export const stalePanes = (ws) => {
  const live = new Set((ws.terminals ?? []).map((t) => t.id))
  return workspacePanes(ws).filter((p) => !live.has(p.terminal))
}

/**
 * Терминалы воркспейса, которые можно закрыть: завершившиеся (`exited`) и пустые шеллы — без агента,
 * без живого claude, без заголовка (его ставит запущенная программа) и с экраном-приглашением.
 */
export const idleTerminals = (api, ws, { liveClaude, self }) => {
  const exited = new Set(api.terminalsList(ws.id).filter((t) => t.exited).map((t) => t.terminalId))
  return (ws.terminals ?? []).flatMap((t) => {
    if (t.id === self || liveClaude.has(t.id)) return []
    if (exited.has(t.id)) return [{ terminal: t.id, reason: 'терминал завершился' }]
    // Агент — только если Superset сам видит его завершённым: claude, запущенный не как `claude`, ps не найдёт
    if (t.agent) return t.agent.state === 'exited' ? [{ terminal: t.id, reason: 'агент завершился' }] : []
    if (cleanTitle(t.title)) return []
    return isIdleShellScreen(api.readScreen(ws.id, t.id)) ? [{ terminal: t.id, reason: 'пустой шелл' }] : []
  })
}

/** После закрытия сессии: пустые сопутствующие шеллы и осиротевшие панели того же воркспейса. */
export const tidyWorkspace = (api, workspaceId, { liveClaude, self }) => {
  const find = () => api.snapshot().find((w) => w.id === workspaceId)
  const ws = find()
  if (!ws) return []
  const closed = idleTerminals(api, ws, { liveClaude, self }).map((t) => ({ ...closeTerminal(api, ws, t.terminal), reason: t.reason }))
  const after = find()
  const panes = after ? stalePanes(after) : []
  for (const p of panes) api.closePane(workspaceId, p.pane)
  return [...closed, ...panes.map((p) => ({ ...p, reason: 'панель без терминала' }))]
}
