import { parseArgs } from 'node:util'

import { commitCommand, hunksCommand } from './commit.js'
import { AgentError, createContext } from './context.js'
import { EXIT } from './exit.js'
import { supportsPen } from './features.js'
import { sessCreate, sessLast, sessLs, sessSend, sessWait } from './sess.js'
import { sessGc } from './gc.js'
import { sessAlias, sessClose, sessForget, sessKeep, sessResume } from './sess-registry.js'
import { findCurrentSlot, findSlot, slotLs, slotPrepare, slotSync } from './slot.js'
import { slotCreate, slotTake } from './slot-create.js'
import { loadConfig } from './store.js'
import { skillsCommand } from './skills.js'
import { doctor } from './doctor.js'
import { status } from './status.js'
import { sessLog } from './session-history.js'
import { hookCommand } from './hooks.js'
import { install } from './install.js'

const REFERENCE_HELP = `
  agent install [--directory D] [--dry-run]       установить команду agent (по умолчанию в ~/.local/bin)
  agent status [--json]                              текущий проект, слот, Git-ветка, изменения и сессии
  agent ls                                        Codex/Claude: агент, терминал, состояние, RSS, «N из лимита»
  agent create --workspace W --prompt-file F [--branch B] [--task KEY] [--agent codex|claude] [--cli] [--mode MODE] [--model M] [--effort E] [--alias A]
  agent send <терминал|алиас> --file F | --text T [--timeout 20] [--force]  → якорь записи журнала
  agent wait <терминал|алиас> [--marker NAME] [--after ЯКОРЬ] [--timeout 1800] [--interval 5]
  agent last [<терминал|алиас>]                   последний ответ; без ID — текущая сессия / единственная в слоте
  agent close [<UUID|алиас>] [--workspace W] [--note TEXT] [--summary-file F] [--reason T] [--dry-run]  сохранить, закрыть и проверить освобождение слота
  agent close --result F                          прочитать долговечный результат закрытия
  agent log [--project P] [--task KEY]                история, включая закрытые сессии; без Superset
  agent resume [<UUID|алиас> | --task KEY | --last-closed | --all-open] [--project P] [--workspace W] [--branch B] [--prompt-file F] [--dry-run] [--offline]
  agent alias [<имя> <терминал>] [--rm имя]  ·  agent forget <session-id|алиас>
  agent keep [<терминал|алиас|session-id>] | --rm <…>   gc такую сессию не закрывает
  agent gc [--project P[,P2]] [--idle 30m] [--done REGEX] [--keep-pen] [--apply]
  agent pen ls | save <файл|окно> | save-all | open <файл...> | close <окно> | restart [--open F]... [--dry-run]
  agent pen quit [--force] [--dry-run]                 save-all и выход; отказ (9), если файл нужен живой сессии
  agent pen idle-check [--apply] [--recent 30m]        закрыть Pen, если он не нужен ни одной сессии
  agent commit <план.json> [--apply]                   по умолчанию сухой прогон на временном индексе
  agent commit hunks <путь...>                         пронумерованные ханки для поля include
  agent skills list | path <имя>                      встроенные процессы для агента
  agent skills install [--agent codex|claude|all] [--directory D] [--dry-run] [--force]
  agent doctor                                       проверить зависимости без изменения настроек
  agent hook install [--agent codex|claude] [--dry-run] подключить checkpoint и освобождение по SessionEnd
  agent hook session-start | stop | session-end --agent codex|claude   JSON runtime на stdin
  agent slot ls [--project P]
  agent slot prepare <слот> --branch B [--task T] [--from BASE] [--offline] [--carry] [--allow-unmerged] [--dry-run] [--project P] [--force]
  agent slot create --project P [--name slot-N] [--base BASE] [--offline] [--dry-run]
  agent slot take --project P --branch B [--task T] [--from BASE] [--offline] [--dry-run] [--carry] [--allow-unmerged]
  agent slot sync-back [<слот>] [--apply]              без имени — текущий слот; локальные файлы слот → основная копия
  agent slot sync [<слот>] [--apply]                   то же, затем основная копия → слот; без --apply — план
`

export const HELP = `agent — задачи и сессии в Superset

  agent install                       установить команду agent
  agent status [--json]                где я работаю и что изменено
  agent slot take --project P --branch B   выделить подготовленный слот
  agent create --workspace W --prompt-file F   запустить агента и записать в журнал
  agent close [алиас|UUID]             сохранить, закрыть и освободить слот

  agent ls                            живые сессии и лимит
  agent log                           история, доступная без Superset
  agent resume <алиас|UUID>            продолжить; также --task, --last-closed, --all-open
  agent send / wait / last             передать работу и получить результат
  agent gc                            план уборки; --apply — выполнить
  agent pen / slot / commit / skills --help
  agent doctor                        диагностика установки

  Подробности: agent <команда> --help. Общий флаг: --json.
  Публикации и git push CLI не выполняет.
`

/** Details are scoped to the requested group, never the entire command catalogue. */
const helpFor = (group, sub, ctx) => {
  const personal = supportsPen(ctx)
  const help = personal ? HELP : HELP.replace('agent pen / slot', 'agent slot')
  const reference = personal ? REFERENCE_HELP : REFERENCE_HELP
    .replace(/^  agent pen .*\n/gm, '')
    .replace(' [--keep-pen]', '')
  if (!group) return help
  if (group === 'sess') {
    if (!sub) return reference.split('\n').filter((line) => Object.keys(SESS).some((command) => line.startsWith(`  agent ${command} `))).join('\n') + '\n'
    group = sub === 'finish' ? 'close' : sub
    sub = undefined
  }
  const lines = reference.split('\n').filter((line) => line.startsWith(`  agent ${group} `))
  if (!lines.length) return help
  const selected = sub ? lines.filter((line) => line.startsWith(`  agent ${group} ${sub} `)) : []
  return [...(selected.length ? selected : lines), '',
    '  Общие флаги: --json, --help. Подробности и ограничения — docs/cli.md.',
    group === 'slot' && !sub ? '  Обычно нужен take: он сам выбирает слот, создаёт при необходимости и выполняет prepare.' : '',
  ].filter(Boolean).join('\n') + '\n'
}

const OPTIONS = {
  json: { type: 'boolean' },
  'release-slot': { type: 'boolean' },
  'summary-file': { type: 'string' },
  result: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  force: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  apply: { type: 'boolean' },
  carry: { type: 'boolean' },
  offline: { type: 'boolean' },
  'allow-unmerged': { type: 'boolean' },
  workspace: { type: 'string' },
  agent: { type: 'string' },
  'prompt-file': { type: 'string' },
  model: { type: 'string' },
  effort: { type: 'string' },
  cli: { type: 'boolean' },
  mode: { type: 'string' },
  alias: { type: 'string' },
  file: { type: 'string' },
  text: { type: 'string' },
  marker: { type: 'string' },
  after: { type: 'string' },
  timeout: { type: 'string' },
  interval: { type: 'string' },
  note: { type: 'string' },
  rm: { type: 'string' },
  idle: { type: 'string' },
  recent: { type: 'string' },
  'keep-pen': { type: 'boolean' },
  done: { type: 'string' },
  open: { type: 'string', multiple: true },
  project: { type: 'string' },
  branch: { type: 'string' },
  task: { type: 'string' },
  reason: { type: 'string' },
  'last-closed': { type: 'boolean' },
  'all-open': { type: 'boolean' },
  from: { type: 'string' },
  base: { type: 'string' },
  name: { type: 'string' },
  directory: { type: 'string' },
}

const SESS = {
  finish: (ctx, config, args, o) => sessClose(ctx, config, args[0], o),
  log: (ctx, config, args, o) => sessLog(ctx, o),
  ls: (ctx, config) => sessLs(ctx, config),
  create: (ctx, config, args, o) => sessCreate(ctx, config, o),
  send: (ctx, config, args, o) => sessSend(ctx, config, args[0], o),
  wait: (ctx, config, args, o) => sessWait(ctx, config, args[0], o),
  last: (ctx, config, args) => sessLast(ctx, config, args[0]),
  close: (ctx, config, args, o) => sessClose(ctx, config, args[0], o),
  resume: (ctx, config, args, o) => sessResume(ctx, config, args[0], o),
  alias: (ctx, config, args, o) => sessAlias(ctx, args[0], args[1], o),
  forget: (ctx, config, args) => sessForget(ctx, args[0]),
  keep: (ctx, config, args, o) => sessKeep(ctx, config, o.rm ?? args[0], { rm: Boolean(o.rm) }),
  gc: (ctx, config, args, o) => sessGc(ctx, config, o),
}

const dispatch = async (ctx, group, sub, args, opts) => {
  if (group === 'install') {
    if (sub || args.length) throw new AgentError('Нужно: agent install [--directory D] [--dry-run] [--json]')
    return install(ctx, opts)
  }
  // Чтение и установка инструкций не зависят от пользовательского конфига и Superset.
  if (group === 'skills') return skillsCommand(ctx, sub, args, opts)
  if (group === 'sess' && sub === 'log') {
    if (args.length) throw new AgentError('Нужно: agent log [--project P] [--task KEY] [--json]')
    return sessLog(ctx, opts)
  }
  if (group === 'doctor') {
    if (sub || args.length) throw new AgentError('Нужно: agent doctor [--json]')
    return doctor(ctx)
  }
  const config = loadConfig(ctx)
  if (group === 'hook') {
    if (args.length) throw new AgentError('Лишние аргументы. Справка: agent hook --help')
    return hookCommand(ctx, config, sub, opts)
  }
  if (group === 'status') {
    if (sub || args.length) throw new AgentError('Нужно: agent status [--json]')
    return status(ctx, config)
  }
  if (group === 'sess') {
    const handler = SESS[sub]
    if (!handler) throw new AgentError(`Неизвестная команда sess ${sub ?? ''}. Есть: ${Object.keys(SESS).join(', ')}`)
    const maxArgs = { ls: 0, create: 0, send: 1, wait: 1, last: 1, close: 1, finish: 1, resume: 1, alias: 2, keep: 1, forget: 1, gc: 0 }[sub]
    if (args.length > maxArgs) throw new AgentError(`Лишние аргументы. Справка: agent ${sub === 'finish' ? 'close' : sub} --help`)
    return handler(ctx, config, args, opts)
  }
  if (group === 'pen' && supportsPen(ctx)) {
    if (sub === 'quit' || sub === 'idle-check') {
      const { penIdleCheck, penQuit } = await import('./pen-quit.js')
      return (sub === 'quit' ? penQuit : penIdleCheck)(ctx, config, opts)
    }
    const { penCommand } = await import('./pen.js')
    return penCommand(ctx, config, sub, args, { ...opts, open: [...(opts.open ?? []), ...(sub === 'restart' ? args : [])] })
  }
  if (group === 'commit') {
    if (sub === 'hunks') return hunksCommand(ctx, ctx.cwd, args)
    if (!sub) throw new AgentError('Нужно: agent commit <план.json> [--apply]')
    return commitCommand(ctx, ctx.cwd, sub, { apply: Boolean(opts.apply) })
  }
  if (group === 'slot') {
    if (sub === 'ls') return slotLs(ctx, config, opts)
    if (sub === 'prepare') return slotPrepare(ctx, config, args[0], opts)
    if (sub === 'create') return slotCreate(ctx, config, opts)
    if (sub === 'take') return slotTake(ctx, config, opts)
    if (sub === 'release') {
      const slot = args[0] ? findSlot(ctx, config, args[0], opts.project) : findCurrentSlot(ctx, config, opts.project)
      return sessClose(ctx, config, undefined, { ...opts, workspace: slot.id })
    }
    if (sub === 'sync-back') return slotSync(ctx, config, args[0], opts, ['back'])
    if (sub === 'sync') return slotSync(ctx, config, args[0], opts, ['back', 'forward'])
    throw new AgentError('Нужно: agent slot ls | create --project P | take --project P --branch B | prepare <слот> --branch B | release <слот> | sync-back <слот> | sync <слот>')
  }
  throw new AgentError(`Неизвестная группа ${group}. agent --help`)
}

export const main = async (argv, ctx = createContext()) => {
  const out = (s) => process.stdout.write(s.endsWith('\n') ? s : `${s}\n`)
  let parsed
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true })
  } catch (error) {
    process.stderr.write(`Ошибка: ${error.message}\n`)
    return EXIT.error
  }
  const { values: opts, positionals } = parsed
  let [group, sub, ...args] = positionals
  if (group && Object.hasOwn(SESS, group)) {
    args = [sub, ...args].filter((arg) => arg !== undefined)
    sub = group
    group = 'sess'
  }
  if (!group || opts.help) {
    out(helpFor(group, sub, ctx))
    return EXIT.ok
  }
  try {
    const result = await dispatch(ctx, group, sub, args, opts)
    out(group === 'hook' && sub !== 'install' && !opts.json ? '{}' : opts.json ? JSON.stringify(result.data, null, 2) : result.text)
    return result.code ?? EXIT.ok
  } catch (error) {
    if (!(error instanceof AgentError)) throw error
    if (opts.json) out(JSON.stringify({ error: error.message, code: error.code, ...(ctx.includeErrorDetails ? error.details : undefined) }, null, 2))
    else process.stderr.write(`Ошибка: ${error.message}\n`)
    return error.code
  }
}
