import { existsSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AgentError } from './context.js'
import { EXIT } from './exit.js'

/**
 * pen.dev на macOS через System Events. ⌘S в Pen из скрипта не срабатывает — сохраняем пунктом меню
 * File › Save после AXRaise окна. Нужен «Универсальный доступ» для приложения, из которого запущен CLI.
 */
export const PEN_DEFAULTS = { app: 'Pen', fileMenu: 'File', save: 'Save', closeWindow: 'Close Window', quitTimeoutSec: 30 }

const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

const ACCESS_HINT =
  'osascript не получил Универсальный доступ. Системные настройки › Конфиденциальность и безопасность › ' +
  'Универсальный доступ — включите приложение, из которого запущен agent (Superset, Terminal)'

export const osa = (ctx, script) => {
  const result = ctx.run('osascript', ['-'], { input: script })
  if (result.status === 0) return result.stdout
  const err = result.stderr.trim()
  if (/-1719|-1728|-25211|assistive|Упрощенного доступа|Универсальн/.test(err)) throw new AgentError(`${ACCESS_HINT}\n${err}`)
  throw new AgentError(`osascript: ${err}`)
}

export const lsScript = (pen) => `tell application "System Events"
  if not (exists process ${q(pen.app)}) then return ""
  tell process ${q(pen.app)}
    set out to ""
    repeat with w in windows
      set d to ""
      try
        set d to value of attribute "AXDocument" of w
      end try
      set out to out & (name of w) & tab & d & linefeed
    end repeat
    return out
  end tell
end tell`

const menuScript = (pen, title, item) => `tell application "System Events" to tell process ${q(pen.app)}
  set frontmost to true
  perform action "AXRaise" of (first window whose name is ${q(title)})
  delay 0.3
  click menu item ${q(item)} of menu ${q(pen.fileMenu)} of menu bar item ${q(pen.fileMenu)} of menu bar 1
end tell`

const docPath = (doc) => {
  if (!doc || doc === 'missing value') return null
  try {
    return doc.startsWith('file:') ? fileURLToPath(doc) : doc
  } catch {
    return null
  }
}

export const penWindows = (ctx, pen) =>
  osa(ctx, lsScript(pen))
    .split('\n')
    .filter((line) => line.trim())
    .map((line, i) => {
      const [title, doc] = line.split('\t')
      return { index: i + 1, title, file: docPath(doc?.trim()) }
    })

/** Окно по номеру из ls, пути к .pen (по AXDocument или имени файла в заголовке) или части заголовка. */
export const findWindow = (windows, ref) => {
  if (/^\d+$/.test(ref)) return windows.find((w) => w.index === Number(ref))
  const abs = resolve(ref)
  return (
    windows.find((w) => w.file === abs) ??
    windows.find((w) => ref.endsWith('.pen') && w.title.includes(basename(ref))) ??
    windows.find((w) => w.title.includes(ref))
  )
}

const mtime = (path) => (path && existsSync(path) ? statSync(path).mtimeMs : null)

const requireWindow = (windows, ref) => {
  const win = findWindow(windows, ref)
  if (!win) throw new AgentError(`Окно Pen «${ref}» не найдено. Открытые: ${windows.map((w) => w.title).join(', ') || 'нет'}`)
  return win
}

/** Сохранение одного окна и проверка mtime файла; без пути к файлу проверить нечем — так и пишем. */
export const saveWindow = async (ctx, pen, win, file) => {
  const path = file ?? win.file
  const before = mtime(path)
  osa(ctx, menuScript(pen, win.title, pen.save))
  for (let i = 0; i < 20 && path; i++) {
    if (mtime(path) !== before) return { title: win.title, file: path, verified: true }
    await ctx.sleep(250)
  }
  return { title: win.title, file: path, verified: false }
}

export const describe = (r) =>
  `${r.title}: ${r.verified ? 'сохранено (mtime обновился)' : r.file ? 'mtime не изменился — несохранённых правок не было?' : 'файл окна неизвестен, mtime не проверен'}`

export const penCommand = async (ctx, config, sub, args, opts) => {
  const pen = { ...PEN_DEFAULTS, ...config.pen }
  const dry = Boolean(opts['dry-run'])
  const windowsOrRef = (ref) => {
    try {
      return requireWindow(penWindows(ctx, pen), ref)
    } catch (error) {
      if (dry) return { index: null, title: ref, file: ref.endsWith('.pen') ? resolve(ref) : null }
      throw error
    }
  }
  if (sub === 'ls') {
    const windows = penWindows(ctx, pen)
    return { data: windows, text: windows.map((w) => `${w.index}. ${w.title}${w.file ? `  ${w.file}` : ''}`).join('\n') || 'Окон Pen нет' }
  }
  if (sub === 'open') {
    if (!args.length) throw new AgentError('Нужен путь к .pen')
    const files = args.map((f) => resolve(f))
    if (!dry) for (const f of files) ctx.run('open', ['-a', pen.app, f])
    return { data: { opened: files, dryRun: dry }, text: files.map((f) => `${dry ? '[dry-run] ' : ''}open -a ${pen.app} ${f}`).join('\n') }
  }
  if (sub === 'save' || sub === 'close') {
    if (!args[0]) throw new AgentError(`Нужно: agent pen ${sub} <файл|окно>`)
    const win = windowsOrRef(args[0])
    if (dry) return { data: { dryRun: true, window: win }, text: `[dry-run]\n${menuScript(pen, win.title, sub === 'save' ? pen.save : pen.closeWindow)}` }
    if (sub === 'close') {
      osa(ctx, menuScript(pen, win.title, pen.closeWindow))
      return { data: { closed: win.title }, text: `Закрыто: ${win.title}` }
    }
    const result = await saveWindow(ctx, pen, win, args[0].endsWith('.pen') ? resolve(args[0]) : null)
    return { data: result, text: describe(result) }
  }
  if (sub === 'save-all') {
    const windows = penWindows(ctx, pen)
    if (dry) return { data: { dryRun: true, windows }, text: windows.map((w) => `[dry-run] File › ${pen.save}: ${w.title}`).join('\n') || 'Окон Pen нет' }
    const results = []
    for (const win of windows) results.push(await saveWindow(ctx, pen, win))
    return { data: results, text: results.map(describe).join('\n') || 'Окон Pen нет' }
  }
  if (sub === 'restart') return penRestart(ctx, pen, opts, dry)
  throw new AgentError(`Неизвестная команда pen ${sub ?? ''}. Есть: ls, save, save-all, open, close, restart`)
}

/** Pen кэширует импорт библиотеки на всё приложение — после правки ui-kit.lib.pen нужен полный перезапуск. */
const penRestart = async (ctx, pen, opts, dry) => {
  const windows = penWindows(ctx, pen)
  const files = opts.open?.length ? opts.open.map((f) => resolve(f)) : windows.map((w) => w.file).filter(Boolean)
  const plan = [...windows.map((w) => `File › ${pen.save}: ${w.title}`), `quit ${pen.app}`, ...files.map((f) => `open -a ${pen.app} ${f}`)]
  if (dry) return { data: { dryRun: true, plan }, text: plan.map((s) => `[dry-run] ${s}`).join('\n') }
  const saved = []
  for (const win of windows) saved.push(await saveWindow(ctx, pen, win))
  await quitPen(ctx, pen)
  for (const f of files) ctx.run('open', ['-a', pen.app, f])
  return { data: { saved, reopened: files }, text: [...saved.map(describe), `Перезапущен, открыто: ${files.length}`].join('\n') }
}

export const penRunning = (ctx, pen) => ctx.run('pgrep', ['-x', pen.app]).status === 0

/** quit и ожидание выхода: висящий диалог сохранения — таймаут, а не вечное ожидание. */
export const quitPen = async (ctx, pen) => {
  osa(ctx, `tell application ${q(pen.app)} to quit`)
  const deadline = ctx.now() + pen.quitTimeoutSec * 1000
  while (penRunning(ctx, pen)) {
    if (ctx.now() > deadline) throw new AgentError(`${pen.app} не завершился за ${pen.quitTimeoutSec} с — возможно, висит диалог сохранения`, EXIT.timeout)
    await ctx.sleep(500)
  }
}
