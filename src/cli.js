import { parseArgs } from 'node:util'

import { commitCommand, hunksCommand } from './commit.js'
import { AgentError, createContext } from './context.js'
import { EXIT } from './exit.js'
import { penCommand } from './pen.js'
import { penIdleCheck, penQuit } from './pen-quit.js'
import { sessCreate, sessLast, sessLs, sessSend, sessWait } from './sess.js'
import { sessGc } from './gc.js'
import { sessAlias, sessClose, sessForget, sessKeep, sessResume } from './sess-registry.js'
import { slotLs, slotPrepare, slotRelease, slotSync } from './slot.js'
import { slotCreate, slotTake } from './slot-create.js'
import { loadConfig } from './store.js'
import { skillsCommand } from './skills.js'
import { doctor } from './doctor.js'
import { status } from './status.js'

export const HELP = `agent — CLI оркестратора и агентов (подробно — README)

  agent status [--json]                              текущий проект, слот, Git-ветка, изменения и сессии
  agent sess ls                                        Codex/Claude: агент, терминал, состояние, RSS, «N из лимита»
  agent sess create --workspace W --prompt-file F [--agent codex|claude] [--cli] [--mode MODE] [--model M] [--effort E] [--alias A] [--force]
  agent sess send <терминал|алиас> --file F | --text T [--timeout 20] [--force]  → якорь записи журнала
  agent sess wait <терминал|алиас> [--marker NAME] [--after ЯКОРЬ] [--timeout 1800] [--interval 5]
  agent sess last [<терминал|алиас>]                   последний ответ; без ID — текущая сессия / единственная в слоте
  agent sess close [<терминал|алиас>] [--note TEXT] [--force]  без ID — текущая сессия / единственная в слоте
  agent sess resume <session-id|алиас> [--workspace W] [--prompt-file F] [--agent codex|claude]
      create: по умолчанию codex chat; --cli: терминальный режим; resume: агент из реестра (старые записи — claude), иначе codex
  agent sess alias [<имя> <терминал>] [--rm имя]  ·  agent sess forget <session-id|алиас>
  agent sess keep [<терминал|алиас|session-id>] | --rm <…>   gc такую сессию не закрывает
  agent sess gc [--project P[,P2]] [--idle 30m] [--done REGEX] [--keep-pen] [--apply]
      закончившиеся сессии, пустые шеллы, панели, освобождение слотов, Pen без пользователей

  agent pen ls | save <файл|окно> | save-all | open <файл...> | close <окно> | restart [--open F]... [--dry-run]
  agent pen quit [--force] [--dry-run]                 save-all и выход; отказ (9), если файл нужен живой сессии
  agent pen idle-check [--apply] [--recent 30m]        закрыть Pen, если он не нужен ни одной сессии

  agent commit <план.json> [--apply]                   по умолчанию сухой прогон на временном индексе
  agent commit hunks <путь...>                         пронумерованные ханки для поля include

  agent skills list | path <имя>                      встроенные процессы для агента
  agent skills install [--agent codex|claude|all] [--directory D] [--dry-run] [--force]
      подключить короткий роутер; замена существующего — с резервной копией
  agent doctor                                       проверить зависимости без изменения настроек

  agent slot ls [--project P]
  agent slot prepare <слот> --branch B [--task T] [--from BASE] [--offline] [--carry] [--allow-unmerged] [--dry-run] [--project P] [--force]
      взять слот: slot.take проекта или новая ветка от свежего origin/BASE / существующая (fast-forward),
      шаги подготовки (по умолчанию — клон node_modules, установка по lock-файлу, хуки), локальные файлы → «slot-N · T»
  agent slot create --project P [--name slot-N] [--base BASE] [--offline] [--dry-run]
      новый слот, когда свободных нет: воркспейс Superset без агента в папке …/slot-N, без ветки на свежем
      origin/BASE, чистый; имя — следующий свободный slot-N; печатает id воркспейса
  agent slot take --project P --branch B [--task T] [--from BASE] [--offline] [--dry-run] [--carry] [--allow-unmerged]
      свободный слот проекта или create, затем prepare; последняя строка — id воркспейса для sess create
  agent slot release [<слот>] [--from BASE] [--offline]  без имени — текущий слот; отпустить через slot.release проекта или без ветки на origin/BASE;
      локальные файлы → основная копия, «slot-N»
  agent slot sync-back [<слот>] [--apply]              без имени — текущий слот; локальные файлы слот → основная копия
  agent slot sync [<слот>] [--apply]                   то же, затем основная копия → слот; без --apply — план

  Общие флаги: --json (машинный вывод), --help.
  Коды выхода: 0 ок, 1 ошибка, 2 таймаут, 3 ждёт разрешения/ответа, 4 ход закончен без маркера,
  5 ошибка API, 6 сессии нет, 7 сообщение не принято, 8 лимит сессий, 9 проверка не пройдена.
`

const OPTIONS = {
  json: { type: 'boolean' },
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
  from: { type: 'string' },
  base: { type: 'string' },
  name: { type: 'string' },
  directory: { type: 'string' },
}

const SESS = {
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
  // Чтение и установка инструкций не зависят от пользовательского конфига и Superset.
  if (group === 'skills') return skillsCommand(ctx, sub, args, opts)
  if (group === 'doctor') {
    if (sub || args.length) throw new AgentError('Нужно: agent doctor [--json]')
    return doctor(ctx)
  }
  const config = loadConfig(ctx)
  if (group === 'status') {
    if (sub || args.length) throw new AgentError('Нужно: agent status [--json]')
    return status(ctx, config)
  }
  if (group === 'sess') {
    const handler = SESS[sub]
    if (!handler) throw new AgentError(`Неизвестная команда sess ${sub ?? ''}. Есть: ${Object.keys(SESS).join(', ')}`)
    return handler(ctx, config, args, opts)
  }
  if (group === 'pen' && sub === 'quit') return penQuit(ctx, config, opts)
  if (group === 'pen' && sub === 'idle-check') return penIdleCheck(ctx, config, opts)
  if (group === 'pen') return penCommand(ctx, config, sub, args, { ...opts, open: [...(opts.open ?? []), ...(sub === 'restart' ? args : [])] })
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
    if (sub === 'release') return slotRelease(ctx, config, args[0], opts)
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
  const [group, sub, ...args] = positionals
  if (!group || opts.help) {
    out(HELP)
    return EXIT.ok
  }
  try {
    const result = await dispatch(ctx, group, sub, args, opts)
    out(opts.json ? JSON.stringify(result.data, null, 2) : result.text)
    return result.code ?? EXIT.ok
  } catch (error) {
    if (!(error instanceof AgentError)) throw error
    if (opts.json) out(JSON.stringify({ error: error.message, code: error.code }, null, 2))
    else process.stderr.write(`Ошибка: ${error.message}\n`)
    return error.code
  }
}
