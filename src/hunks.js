import { AgentError } from './context.js'

/** Разбор `git diff` одного файла: заголовок файла и ханки (нумерация с 1). */
export const parseDiff = (patch) => {
  const lines = patch.split('\n')
  const start = lines.findIndex((line) => line.startsWith('@@'))
  if (start < 0) return { header: patch, hunks: [] }
  const header = lines.slice(0, start).join('\n')
  const hunks = []
  for (const line of lines.slice(start)) {
    if (line.startsWith('@@')) hunks.push({ index: hunks.length + 1, lines: [line] })
    else if (line !== '' || hunks.at(-1).lines.at(-1) !== '') hunks.at(-1).lines.push(line)
  }
  return {
    header,
    hunks: hunks.map((h) => {
      while (h.lines.at(-1) === '') h.lines.pop()
      return { index: h.index, text: h.lines.join('\n') }
    }),
  }
}

/** Ханки по правилу плана: номера, маркер-подстрока или список маркеров. */
export const selectHunks = (hunks, include, path) => {
  if (Array.isArray(include) && include.every((v) => Number.isInteger(v))) {
    const missing = include.filter((n) => !hunks.some((h) => h.index === n))
    if (missing.length) throw new AgentError(`${path}: нет ханков ${missing.join(', ')} (всего ${hunks.length})`)
    return hunks.filter((h) => include.includes(h.index))
  }
  const markers = Array.isArray(include) ? include : [include]
  if (!markers.length || markers.some((m) => typeof m !== 'string' || !m)) {
    throw new AgentError(`${path}: include — номера ханков или непустые строки-маркеры`)
  }
  for (const marker of markers) {
    if (!hunks.some((h) => h.text.includes(marker))) throw new AgentError(`${path}: ни один ханк не содержит «${marker}»`)
  }
  return hunks.filter((h) => markers.some((m) => h.text.includes(m)))
}

/** Патч из выбранных ханков; смещение строк после пропущенных ханков git apply находит по контексту. */
export const buildPatch = (header, hunks) => `${header}\n${hunks.map((h) => h.text).join('\n')}\n`
