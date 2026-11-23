import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize } from 'node:path'

import { AgentError } from './context.js'
import { readJson, stamp, writeJson } from './store.js'

/**
 * Локальные файлы слота (`slot.localFiles` в `.agent-cli.json`): исключённые из Git, но нужные в каждом
 * worktree (например `.ai/learnings/local/rules.md`). Переносятся копией, не ссылкой, в обе стороны:
 * `forward` — основная копия → слот, `back` — слот → основная копия.
 *
 * Чтобы не затирать чужие правки, помним «базу» — хеш содержимого (и каждого раздела markdown), на котором
 * слот и основная копия последний раз сошлись (~/.agent-cli/local-files.json). Отличие от базы только в
 * источнике — переносим; только в цели — цель новее, не трогаем; в обоих или базы нет — конфликт: цель
 * не меняется. `.md` сливаются по разделам (заголовкам `#…`); прочие файлы — целиком. Удаления не
 * переносятся. Перед любой записью цель копируется в ~/.agent-cli/backups.
 */

const hash = (data) => createHash('sha256').update(data).digest('hex').slice(0, 16)
const norm = (text) => text.replace(/\s+$/, '')
const isMarkdown = (path) => /\.md$/i.test(path)

const basePath = (ctx) => join(ctx.agentHome, 'local-files.json')

/** Пути из конфига: только относительные внутри репозитория. */
export const localEntries = (rules) => {
  const entries = rules.slot?.localFiles ?? []
  if (!Array.isArray(entries)) throw new AgentError('slot.localFiles в .agent-cli.json — список путей')
  return entries.map((entry) => {
    const clean = typeof entry === 'string' ? normalize(entry).replace(/\/+$/, '') : ''
    if (!clean || clean === '.' || isAbsolute(clean) || clean.split('/').includes('..')) {
      throw new AgentError(`slot.localFiles: «${entry}» — нужен относительный путь внутри репозитория`)
    }
    return clean
  })
}

const walk = (root, rel, out) => {
  const abs = join(root, rel)
  if (!existsSync(abs)) return
  const stat = lstatSync(abs)
  if (stat.isSymbolicLink()) return
  if (!stat.isDirectory()) return out.add(rel)
  for (const name of readdirSync(abs).sort()) walk(root, join(rel, name), out)
}

/** Файлы записи: каталог раскрывается рекурсивно с обеих сторон, ссылки пропускаются. */
const expand = (roots, entry) => {
  const isDir = roots.some((r) => existsSync(join(r, entry)) && lstatSync(join(r, entry)).isDirectory())
  if (!isDir) return [entry]
  const out = new Set()
  for (const root of roots) walk(root, entry, out)
  return [...out].sort()
}

/**
 * Разделы markdown: преамбула (ключ '') и по разделу на заголовок любого уровня до следующего заголовка.
 * Заголовки внутри ``` не считаются; повтор заголовка получает ключ «… #2».
 */
export const splitSections = (text) => {
  const sections = [{ key: '', lines: [] }]
  const seen = new Map()
  let fence = false
  for (const line of text.split(/(?<=\n)/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    const heading = !fence && line.match(/^#{1,6}\s+\S.*$/m)?.[0].trim()
    if (heading) {
      const n = (seen.get(heading) ?? 0) + 1
      seen.set(heading, n)
      sections.push({ key: n > 1 ? `${heading} #${n}` : heading, lines: [line] })
    } else sections.at(-1).lines.push(line)
  }
  return sections.map(({ key, lines }) => ({ key, text: lines.join('') }))
}

const joinSections = (sections) =>
  sections
    .map((s, i) => (i < sections.length - 1 && s.text && !s.text.endsWith('\n\n') ? `${norm(s.text)}\n\n` : s.text))
    .join('')

/**
 * Слияние разделов источника в цель. Раздела нет в цели — добавляется после предыдущего раздела
 * источника (если его не удалили в цели: был в базе, источник с тех пор не менялся); разный текст —
 * обновляется, только если цель не менялась с базы, иначе конфликт (или цель новее). Разделы только
 * в цели остаются.
 */
export const mergeSections = (targetText, sourceText, base = {}) => {
  const result = splitSections(targetText)
  const source = splitSections(sourceText)
  const out = { added: [], updated: [], conflicts: [], ahead: [] }
  let last = ''
  for (const section of source) {
    const at = result.findIndex((s) => s.key === section.key)
    const srcHash = hash(norm(section.text))
    if (at === -1) {
      if (!norm(section.text)) continue
      if (base[section.key] === srcHash) continue // удалён в цели — не возвращаем
      const after = result.findIndex((s) => s.key === last)
      result.splice(after + 1, 0, { key: section.key, text: section.text })
      out.added.push(section.key)
    } else if (norm(result[at].text) !== norm(section.text)) {
      const dstHash = hash(norm(result[at].text))
      if (base[section.key] === dstHash) {
        result[at] = { key: section.key, text: section.text }
        out.updated.push(section.key)
      } else if (base[section.key] === srcHash) out.ahead.push(section.key)
      else out.conflicts.push({ section: section.key || '(текст до первого заголовка)', source: section.text, target: result[at].text })
    }
    last = section.key
  }
  return { ...out, text: joinSections(result) }
}

export const sectionHashes = (text) => Object.fromEntries(splitSections(text).map((s) => [s.key, hash(norm(s.text))]))

/** База после синхронизации: хеши файла и разделов, совпадающих с обеих сторон. */
const agreedBase = (rel, a, b, old = {}) => {
  if (!a || !b) return old
  if (a.equals(b)) return { file: hash(a), sections: isMarkdown(rel) ? sectionHashes(a.toString('utf8')) : undefined }
  if (!isMarkdown(rel)) return old
  const [ha, hb] = [sectionHashes(a.toString('utf8')), sectionHashes(b.toString('utf8'))]
  const sections = { ...old.sections }
  for (const [key, h] of Object.entries(ha)) if (hb[key] === h) sections[key] = h
  return { file: old.file, sections }
}

/** План по одному файлу: что станет с целью. */
const planFile = (rel, source, target, base) => {
  if (!source) return { path: rel, action: 'absent' }
  if (!target) return { path: rel, action: 'copy', content: source }
  if (source.equals(target)) return { path: rel, action: 'same' }
  if (isMarkdown(rel)) {
    const merged = mergeSections(target.toString('utf8'), source.toString('utf8'), base.sections ?? {})
    const changed = merged.added.length || merged.updated.length
    const action = changed ? 'merge' : merged.conflicts.length ? 'conflict' : 'ahead'
    const { text, ...sections } = merged
    return { path: rel, action, ...sections, content: changed ? Buffer.from(text) : undefined }
  }
  if (base.file === hash(target)) return { path: rel, action: 'update', content: source }
  if (base.file === hash(source)) return { path: rel, action: 'ahead' }
  return { path: rel, action: 'conflict', conflicts: [{ section: '(файл целиком)' }] }
}

/**
 * Синхронизация локальных файлов слота. `steps` — направления по порядку ('back', 'forward'); в сухом
 * прогоне второй шаг видит результат первого (правки держатся в памяти), на диск ничего не пишется.
 */
export const syncLocalFiles = (ctx, { slotPath, mainPath, slotName, entries, steps, apply }) => {
  if (!entries.length || !mainPath || mainPath === slotPath) return null
  const overlay = new Map()
  const read = (abs) => {
    if (overlay.has(abs)) return overlay.get(abs)
    if (!existsSync(abs) || lstatSync(abs).isDirectory() || lstatSync(abs).isSymbolicLink()) return null
    return readFileSync(abs)
  }
  const store = readJson(basePath(ctx), {})
  const bases = store[slotPath] ?? {}
  const backupDir = join(ctx.agentHome, 'backups', `${slotName}-local-${stamp(ctx.now())}`)
  let backedUp = false
  const runs = steps.map((direction) => {
    const [from, to, side] = direction === 'back' ? [slotPath, mainPath, 'main'] : [mainPath, slotPath, 'slot']
    const files = entries.flatMap((entry) => expand([from, to], entry))
    const items = files.map((rel) => {
      const target = read(join(to, rel))
      const item = planFile(rel, read(join(from, rel)), target, bases[rel] ?? {})
      if (item.content) {
        if (apply) {
          if (target) {
            mkdirSync(dirname(join(backupDir, side, rel)), { recursive: true })
            writeFileSync(join(backupDir, side, rel), target)
            backedUp = true
            item.backup = join(backupDir, side, rel)
          }
          mkdirSync(dirname(join(to, rel)), { recursive: true })
          writeFileSync(join(to, rel), item.content)
        } else overlay.set(join(to, rel), item.content)
      }
      delete item.content
      return item
    })
    return { direction, items }
  })
  if (apply) {
    const files = new Set(runs.flatMap((r) => r.items.map((i) => i.path)))
    for (const rel of files) bases[rel] = agreedBase(rel, read(join(slotPath, rel)), read(join(mainPath, rel)), bases[rel])
    writeJson(basePath(ctx), { ...readJson(basePath(ctx), {}), [slotPath]: bases })
  }
  const conflicts = runs.flatMap((r) => r.items.filter((i) => i.conflicts?.length).map((i) => ({ direction: r.direction, path: i.path })))
  return { applied: Boolean(apply), slot: slotPath, main: mainPath, runs, conflicts, backup: backedUp ? backupDir : null }
}

const ICON = { copy: '+', merge: '~', update: '~', same: '=', ahead: '·', conflict: '!', absent: '·' }
const sideName = { back: ['слот', 'основная копия'], forward: ['основная копия', 'слот'] }

const describe = (item, [fromName, toName]) => {
  const parts = []
  if (item.action === 'copy') parts.push('скопировано')
  if (item.action === 'update') parts.push(`обновлено (в ${toName === 'слот' ? 'слоте' : 'основной копии'} не менялось с прошлого переноса)`)
  if (item.action === 'same') parts.push('одинаково — пропущено')
  if (item.action === 'absent') parts.push(`нет в источнике (${fromName}) — пропущено`)
  if (item.action === 'ahead' && !item.ahead?.length) parts.push(`в цели (${toName}) новее — пропущено`)
  if (item.added?.length) parts.push(`+ разделы: ${item.added.join(', ')}`)
  if (item.updated?.length) parts.push(`обновлены: ${item.updated.join(', ')}`)
  if (item.ahead?.length) parts.push(`в цели новее: ${item.ahead.join(', ')}`)
  if (item.conflicts?.length) parts.push(`КОНФЛИКТ (не перетираю): ${item.conflicts.map((c) => c.section).join(', ')}`)
  return parts.join('; ')
}

/** Текстовый отчёт синхронизации; пустой массив — нечего сообщать. */
export const formatSync = (result, { indent = '  ' } = {}) => {
  if (!result) return []
  const lines = []
  for (const run of result.runs) {
    const names = sideName[run.direction]
    lines.push(`${indent}Локальные файлы, ${names[0]} → ${names[1]}${result.applied ? '' : ' (сухой прогон)'}:`)
    for (const item of run.items) lines.push(`${indent}  ${item.conflicts?.length ? '!' : ICON[item.action]} ${item.path} — ${describe(item, names)}`)
  }
  if (result.conflicts.length) lines.push(`${indent}  Конфликт: сравните вручную — diff ${result.main}/<путь> ${result.slot}/<путь>`)
  if (result.backup) lines.push(`${indent}  Бэкап перезаписанного: ${result.backup}`)
  return lines
}
