import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'

import { AgentError } from './context.js'
import { EXIT } from './exit.js'
import { describe, PEN_DEFAULTS, penRunning, penWindows, quitPen, saveWindow } from './pen.js'
import { listSessions, sessionJournal } from './sessions.js'

/**
 * Выход из Pen (держит ~400 МБ) только когда его файлы никому не нужны. Файл занят живой сессией, если
 * он лежит в её worktree, а сессия работает или ждёт ответа, или если журнал сессии упоминал его
 * за последние `--recent` (по умолчанию 30 мин). `gc` вызывает `penIdleCheck`.
 */

const RECENT_MS = 30 * 60_000

const inside = (file, dir) => Boolean(dir) && (file === dir || file.startsWith(`${dir}/`))

/** Упоминал ли журнал имя файла после `since` (по сырым строкам — без разбора всего JSON). */
const mentionedSince = (path, name, since) => {
  if (!existsSync(path)) return false
  return readFileSync(path, 'utf8')
    .split('\n')
    .some((line) => line.includes(name) && Date.parse(line.match(/"timestamp":"([^"]+)"/)?.[1] ?? '') >= since)
}

/** Открытые в Pen файлы, с которыми работает живая сессия: [{ file, terminal, why }]. */
export const filesInUse = (ctx, config, files, recentMs = RECENT_MS) => {
  // Сессия, которая вызвала CLI, сама просит закрыть Pen; её журнал упоминает файлы из вывода pen ls
  const sessions = listSessions(ctx, config).filter((s) => !s.terminal || s.terminal !== ctx.env.SUPERSET_TERMINAL_ID)
  const since = ctx.now() - recentMs
  return files.flatMap((file) =>
    sessions.flatMap((s) => {
      const who = s.terminal ?? `pid ${s.pid}`
      if (inside(file, s.cwd) && s.state !== 'idle') return [{ file, terminal: who, why: 'в worktree работающей сессии' }]
      let journal
      try {
        journal = sessionJournal(ctx, s)
      } catch {
        return []
      }
      return mentionedSince(journal, basename(file), since) ? [{ file, terminal: who, why: 'упомянут в журнале недавно' }] : []
    }),
  )
}

const recentOf = (opts) => (opts.recent ? Number(String(opts.recent).replace(/m$/, '')) * 60_000 : RECENT_MS)

/** save-all с проверкой mtime, затем выход. Занятые файлы — отказ (код 9), если нет --force. */
export const penQuit = async (ctx, config, opts) => {
  const pen = { ...PEN_DEFAULTS, ...config.pen }
  if (!penRunning(ctx, pen)) return { data: { running: false }, text: `${pen.app} не запущен` }
  const windows = penWindows(ctx, pen)
  const busy = filesInUse(ctx, config, windows.map((w) => w.file).filter(Boolean), recentOf(opts))
  if (busy.length && !opts.force) {
    const list = busy.map((b) => `  ${b.file} — ${b.terminal.slice(0, 8)}: ${b.why}`).join('\n')
    throw new AgentError(`Pen нужен живой сессии — не закрываю (--force, если всё же надо):\n${list}`, EXIT.check)
  }
  if (opts['dry-run']) {
    return { data: { dryRun: true, windows, busy }, text: windows.map((w) => `[dry-run] File › Save: ${w.title}`).concat(`[dry-run] quit ${pen.app}`).join('\n') }
  }
  const saved = []
  for (const win of windows) saved.push(await saveWindow(ctx, pen, win))
  await quitPen(ctx, pen)
  return { data: { saved, quit: true, forced: busy.length > 0 }, text: [...saved.map(describe), `${pen.app} закрыт`].join('\n') }
}

/** Для gc: Pen запущен и не нужен ни одной живой сессии → закрыть (с --apply) или сказать, что закрыл бы. */
export const penIdleCheck = async (ctx, config, opts) => {
  const pen = { ...PEN_DEFAULTS, ...config.pen }
  if (!penRunning(ctx, pen)) return { data: { running: false, action: 'none' }, text: `${pen.app} не запущен` }
  const windows = penWindows(ctx, pen)
  const busy = filesInUse(ctx, config, windows.map((w) => w.file).filter(Boolean), recentOf(opts))
  if (busy.length) {
    return { data: { running: true, action: 'keep', busy }, text: `${pen.app} нужен: ${busy.map((b) => `${basename(b.file)} (${b.why})`).join(', ')}` }
  }
  if (!opts.apply) return { data: { running: true, action: 'quit', dryRun: true, windows }, text: `${pen.app} никому не нужен — закрою (--apply)` }
  const result = await penQuit(ctx, config, { recent: opts.recent })
  return { data: { running: true, action: 'quit', ...result.data }, text: result.text }
}
