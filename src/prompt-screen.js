/**
 * Экран Codex/Claude, ждущий человека: вопрос с вариантами или запрос разрешения.
 * Superset знает только «blocked»; вид ожидания и текст берём с экрана терминала.
 */

const RULE = /^\s*[─━═\-_]{8,}\s*$/
const OPTION = /^\s*(?:[❯›>]\s*)?(\d+)[.)]\s+(\S.*?)\s*$/
const PERMISSION = /Do you want to|Would you like to|Yes, and don't ask again|Yes, allow|Claude needs your permission|allow .* to (?:run|use|access)/i
const QUESTION = /Enter to select|Type something|Chat about this|Review your answers|Submit answers/i

const SCREEN_LINES = 60

/** Нижний диалог экрана: от ближайшей линии над первым вариантом до конца, без пустых хвостов. */
const dialogLines = (screen) => {
  const lines = screen.split('\n').map((line) => line.trimEnd())
  while (lines.length && (!lines.at(-1).trim() || RULE.test(lines.at(-1)))) lines.pop()
  const firstOption = lines.findIndex((line, i) => OPTION.test(line) && lines.slice(i).some((l) => OPTION.test(l)))
  const anchor = firstOption < 0 ? lines.length : firstOption
  let start = Math.max(0, anchor - 15)
  for (let i = anchor - 1; i >= Math.max(0, anchor - 15); i--) {
    if (RULE.test(lines[i])) {
      start = i + 1
      break
    }
  }
  return lines.slice(start).filter((line) => !RULE.test(line))
}

/** `{kind: 'question'|'permission'|'unknown', text, options}`; без экрана — null. */
export const parsePromptScreen = (screen) => {
  if (!screen?.trim()) return null
  const lines = dialogLines(screen)
  const text = lines.join('\n').trim()
  if (!text) return null
  const options = lines.flatMap((line) => {
    const m = OPTION.exec(line)
    return m ? [{ n: Number(m[1]), label: m[2], selected: /^\s*[❯›>]/.test(line) }] : []
  })
  const kind = PERMISSION.test(text) ? 'permission' : QUESTION.test(text) || options.length ? 'question' : 'unknown'
  return { kind, text, options }
}

export const readWaiting = (api, session) => {
  try {
    return parsePromptScreen(api.readScreen(session.workspace, session.terminal, SCREEN_LINES))
  } catch {
    return null
  }
}

export const WAITING_LABEL = { question: 'вопрос с вариантами', permission: 'запрос разрешения', unknown: 'ждёт ответа' }
