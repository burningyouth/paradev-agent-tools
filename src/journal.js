import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Журнал сессии Claude Code — `~/.claude/projects/<cwd>/<sessionId>.jsonl`. Формат не документирован;
 * всё знание о нём — в этом модуле (образцы записей — в test/journal.test.js).
 */

/** Claude кодирует cwd в имя каталога, заменяя всё, кроме латиницы и цифр, на `-`. */
export const projectDirName = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-')

export const journalPath = (ctx, cwd, sessionId) => {
  const direct = join(ctx.claudeHome, 'projects', projectDirName(cwd), `${sessionId}.jsonl`)
  if (existsSync(direct)) return direct
  // Длинные пути Claude укорачивает — тогда ищем файл сессии по всем проектам.
  const root = join(ctx.claudeHome, 'projects')
  if (!existsSync(root)) return direct
  for (const dir of readdirSync(root)) {
    const candidate = join(root, dir, `${sessionId}.jsonl`)
    if (existsSync(candidate)) return candidate
  }
  return direct
}

/** Записи журнала; недописанная последняя строка пропускается. */
export const readJournal = (path) => {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
}

const textBlocks = (content) =>
  typeof content === 'string'
    ? [content]
    : (content ?? []).filter((block) => block?.type === 'text').map((block) => block.text)

/** Текст сообщения человека (набранного или поставленного в очередь) либо null. */
export const promptText = (rec) => {
  if (rec.isSidechain || rec.isMeta) return null
  if (rec.type === 'attachment' && rec.attachment?.type === 'queued_command') {
    return rec.attachment.commandMode === 'prompt' ? rec.attachment.prompt : null
  }
  if (rec.type !== 'user') return null
  const content = rec.message?.content
  if (Array.isArray(content) && content.some((block) => block?.type === 'tool_result')) return null
  const text = textBlocks(content).join('\n')
  if (!text || text.startsWith('[Request interrupted')) return null
  return text
}

const normalize = (text) => text.replace(/\s+/g, ' ').trim()

/** Запись, которой сессия приняла отправленный текст: сравнение по началу текста после `sinceMs`. */
export const findAccepted = (records, text, sinceMs) => {
  const probe = normalize(text).slice(0, 200)
  for (const rec of records) {
    if (Date.parse(rec.timestamp) < sinceMs - 2000) continue
    const prompt = promptText(rec)
    if (prompt && normalize(prompt).startsWith(probe)) {
      return { anchor: rec.uuid, timestamp: rec.timestamp, queued: rec.type === 'attachment' }
    }
  }
  return null
}

export const lastPromptIndex = (records) => records.findLastIndex((rec) => promptText(rec) !== null)

/** Тексты ответов ассистента (без подагентов и синтетических ошибок API) начиная с индекса. */
export const assistantTexts = (records, from = 0) =>
  records.slice(from).flatMap((rec) => {
    if (rec.type !== 'assistant' || rec.isSidechain || rec.isApiErrorMessage) return []
    const text = textBlocks(rec.message?.content).join('\n').trim()
    return text ? [{ uuid: rec.uuid, messageId: rec.message?.id, timestamp: rec.timestamp, text }] : []
  })

/** Последний ответ целиком: все текстовые блоки последнего сообщения ассистента с текстом. */
export const lastAnswer = (records, from = 0) => {
  const texts = assistantTexts(records, from)
  const last = texts.at(-1)
  if (!last) return null
  const parts = texts.filter((t) => t.messageId === last.messageId)
  return { text: parts.map((t) => t.text).join('\n\n'), timestamp: last.timestamp, uuid: last.uuid }
}

/**
 * Что произошло после якоря: маркер в ответе ассистента, конец хода, ошибка API.
 * Конец хода — запись `system/turn_duration` после последнего ответа; ход с фоновыми подагентами
 * (`pendingBackgroundAgentCount > 0`) не считается законченным — сессия проснётся сама.
 */
export const analyzeAfter = (records, anchorIndex, marker) => {
  const from = anchorIndex + 1
  const tail = records.slice(from)
  const needle = marker ? `[[${marker}]]` : null
  const hit = needle ? assistantTexts(records, from).find((t) => t.text.includes(needle)) : undefined
  const lastActivity = tail.findLastIndex(
    (rec) => !rec.isSidechain && (rec.type === 'assistant' || rec.type === 'user' || rec.attachment?.type === 'queued_command'),
  )
  const turnEnd = tail.findLastIndex((rec) => rec.type === 'system' && rec.subtype === 'turn_duration')
  const turnEnded = turnEnd > lastActivity && !(tail[turnEnd]?.pendingBackgroundAgentCount > 0)
  const lastAssistant = tail.findLast((rec) => rec.type === 'assistant' && !rec.isSidechain)
  const apiError = lastAssistant?.isApiErrorMessage
    ? textBlocks(lastAssistant.message?.content).join('\n') || 'ошибка API'
    : null
  return { markerFound: Boolean(hit), markerAt: hit?.timestamp ?? null, turnEnded, apiError, answer: lastAnswer(records, from) }
}
