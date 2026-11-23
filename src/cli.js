import { parseArgs } from 'node:util'
import { createInterface } from 'node:readline'

import { commitCommand, hunksCommand } from './commit.js'
import { chatSlotHook, requestTaskCompletion } from './chat-slot-lifecycle.js'
import { AgentError, createContext } from './context.js'
import { EXIT } from './exit.js'
import { fileActivity } from './file-activity.js'
import { sessCreate, sessLast, sessLs, sessSend, sessWait } from './sess.js'
import { sessGc } from './gc.js'
import { sessAlias, sessClose, sessForget, sessKeep, sessResume } from './sess-registry.js'
import { findCurrentSlot, findSlot, slotLs, slotPrepare, slotSync } from './slot.js'
import { slotCreate, slotTake } from './slot-create.js'
import { loadConfig } from './store.js'
import { installSkills, skillsCommand, workflowHelp, workflowTopics } from './skills.js'
import { doctor } from './doctor.js'
import { status } from './status.js'
import { sessLog } from './session-history.js'
import { hookCommand } from './hooks.js'
import { install } from './install.js'

const REFERENCE_HELP = `
  paradev-agent install [--directory D] [--dry-run]       установить команду paradev-agent в ~/.local/bin
  paradev-agent install --agent codex|claude|all [--directory D] [--dry-run] [--force]   подключить подсказку о CLI в чате
  paradev-agent status [--json]                              текущий проект, слот, Git-ветка, изменения и сессии
  paradev-agent activity FILE... [--recent 30m]             активные сессии, связанные с файлами
  paradev-agent ls                                        Codex/Claude: агент, терминал, состояние, RSS, «N из лимита»
  paradev-agent create --workspace W --prompt-file F [--branch B] [--task KEY] [--agent codex|claude] [--cli] [--mode MODE] [--model M] [--effort E] [--alias A]
  paradev-agent create --project P --branch B --prompt-file F [--task KEY] [--from BASE] [--allow-create]   выбрать свободный слот по номеру
  paradev-agent send <терминал|алиас> --file F | --text T [--timeout 20] [--force]  → якорь записи журнала
  paradev-agent wait <терминал|алиас> [--marker NAME] [--after ЯКОРЬ] [--timeout 1800] [--interval 5]
  paradev-agent last [<терминал|алиас>]                   последний ответ; без ID — текущая сессия / единственная в слоте
  paradev-agent close [<UUID|алиас>] [--workspace W] [--session-only] [--after-reply] [--note TEXT] [--summary-file F] [--reason T] [--dry-run]
  paradev-agent close --result F                          прочитать долговечный результат закрытия
  paradev-agent task complete SESSION --workspace W [--dry-run]   явно завершить задачу и оставить чат открытым
  paradev-agent log [--project P] [--task KEY]                история, включая закрытые сессии; без Superset
  paradev-agent resume [<UUID|алиас> | --task KEY | --last-closed | --all-open] [--project P] [--workspace W] [--branch B] [--prompt-file F] [--dry-run] [--offline]
  paradev-agent alias [<имя> <терминал>] [--rm имя]  ·  paradev-agent forget <session-id|алиас>
  paradev-agent keep [<терминал|алиас|session-id>] | --rm <…>   gc такую сессию не закрывает
  paradev-agent gc [--project P[,P2]] [--idle 30m] [--done REGEX] [--apply]
  paradev-agent commit <план.json> [--apply]                   по умолчанию сухой прогон на временном индексе
  paradev-agent commit hunks <путь...>                         пронумерованные ханки для поля include
  paradev-agent doctor                                       проверить зависимости без изменения настроек
  paradev-agent hook install [--agent codex|claude] [--dry-run] подключить checkpoint и освобождение по SessionEnd
  paradev-agent hook session-start | user-prompt-submit | stop | session-end --agent codex|claude   JSON runtime на stdin
  paradev-agent slot ls [--project P]
  paradev-agent slot prepare <слот> --branch B [--task T] [--from BASE] [--offline] [--carry] [--allow-unmerged] [--dry-run] [--project P] [--force]
  paradev-agent slot create --project P [--name slot-N] [--base BASE] [--offline] [--dry-run]
  paradev-agent slot take --project P --branch B [--task T] [--from BASE] [--offline] [--dry-run] [--carry] [--allow-unmerged]
  paradev-agent slot sync-back [<слот>] [--apply]              без имени — текущий слот; локальные файлы слот → основная копия
  paradev-agent slot sync [<слот>] [--apply]                   то же, затем основная копия → слот; без --apply — план
`

export const HELP = `paradev-agent — задачи и сессии в Paradev

  paradev-agent install                       установить команду paradev-agent
  paradev-agent status [--json]                где я работаю и что изменено
  paradev-agent slot take --project P --branch B   выделить подготовленный слот
  paradev-agent create --workspace W --prompt-file F   запустить агента и записать в журнал
  paradev-agent close [алиас|UUID]             сохранить, закрыть и освободить слот
    --session-only                   закрыть сессию и сохранить назначение слота
    --after-reply                    закрыть чат после финального ответа с receipt; нужны точные UUID

  paradev-agent ls                            живые сессии и лимит
  paradev-agent log                           история, доступная без Superset
  paradev-agent resume <алиас|UUID>            продолжить; также --task, --last-closed, --all-open
  paradev-agent send / wait / last             передать работу и получить результат
  paradev-agent gc                            план уборки; --apply — выполнить
  paradev-agent task complete --help         освободить слот после завершения задачи
  paradev-agent slot / commit --help
  paradev-agent activity FILE...             активные сессии по файлам
  paradev-agent doctor                        диагностика установки

  Команды: paradev-agent <команда> --help.
  Рабочие процессы: paradev-agent --help <тема> (${workflowTopics.join(', ')}).
  Публикации и git push CLI не выполняет.
`

/** Details are scoped to the requested group, never the entire command catalogue. */
const helpFor = (group, sub) => {
  if (!group) return HELP
  const workflow = !sub && workflowHelp(group)
  if (workflow) return workflow
  if (group === 'sess') {
    if (!sub) return REFERENCE_HELP.split('\n').filter((line) => Object.keys(SESS).some((command) => line.startsWith(`  paradev-agent ${command} `))).join('\n') + '\n'
    group = sub === 'finish' ? 'close' : sub
    sub = undefined
  }
  const lines = REFERENCE_HELP.split('\n').filter((line) => line.startsWith(`  paradev-agent ${group} `))
  if (!lines.length) throw new AgentError(`Неизвестная команда или тема справки «${group}». paradev-agent --help`)
  const selected = sub ? lines.filter((line) => line.startsWith(`  paradev-agent ${group} ${sub} `)) : []
  return [...(selected.length ? selected : lines), '',
    '  Общие флаги: --json, --help. Подробности и ограничения — docs/cli.md.',
    group === 'slot' && !sub ? '  Обычно нужен take: он сам выбирает слот, создаёт при необходимости и выполняет prepare. Подробнее: paradev-agent --help slots.' : '',
  ].filter(Boolean).join('\n') + '\n'
}

const OPTIONS = {
  json: { type: 'boolean' },
  'release-slot': { type: 'boolean' },
  'session-only': { type: 'boolean' },
  'after-reply': { type: 'boolean' },
  'summary-file': { type: 'string' },
  result: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  force: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  apply: { type: 'boolean' },
  carry: { type: 'boolean' },
  offline: { type: 'boolean' },
  'allow-unmerged': { type: 'boolean' },
  'allow-create': { type: 'boolean' },
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
  create: (ctx, config, args, o) => sessCreate(ctx, config, o, !o.json && process.stdin.isTTY && process.stdout.isTTY ? confirmSlotCreation : undefined),
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

const confirmSlotCreation = (question) => new Promise((resolve) => {
  const input = createInterface({ input: process.stdin, output: process.stdout })
  input.once('close', () => resolve(false))
  input.question(`${question} [да/НЕТ] `, (answer) => {
    resolve(/^(да|yes|y)$/iu.test(answer.trim()))
    input.close()
  })
})

const dispatch = async (ctx, group, sub, args, opts) => {
  if (group === 'install') {
    if (sub || args.length) throw new AgentError('Нужно: paradev-agent install [--directory D] [--dry-run] [--json]')
    if (opts.agent) return installSkills(ctx, opts)
    return install(ctx, opts)
  }
  // Чтение и установка инструкций не зависят от пользовательского конфига и Superset.
  if (group === 'skills') return skillsCommand(ctx, sub, args, opts)
  if (group === 'sess' && sub === 'log') {
    if (args.length) throw new AgentError('Нужно: paradev-agent log [--project P] [--task KEY] [--json]')
    return sessLog(ctx, opts)
  }
  if (group === 'doctor') {
    if (sub || args.length) throw new AgentError('Нужно: paradev-agent doctor [--json]')
    return doctor(ctx)
  }
  const config = loadConfig(ctx)
  if (group === 'chat-slot-hook') {
    if (args.length) throw new AgentError('Лишние аргументы chat-slot-hook')
    return chatSlotHook(ctx, config, sub)
  }
  if (group === 'task' && sub === 'complete' && args.length === 1) return requestTaskCompletion(ctx, config, args[0], opts)
  if (group === 'hook') {
    if (args.length) throw new AgentError('Лишние аргументы. Справка: paradev-agent hook --help')
    return hookCommand(ctx, config, sub, opts)
  }
  if (group === 'status') {
    if (sub || args.length) throw new AgentError('Нужно: paradev-agent status [--json]')
    return status(ctx, config)
  }
  if (group === 'sess') {
    const handler = SESS[sub]
    if (!handler) throw new AgentError(`Неизвестная команда sess ${sub ?? ''}. Есть: ${Object.keys(SESS).join(', ')}`)
    const maxArgs = { ls: 0, create: 0, send: 1, wait: 1, last: 1, close: 1, finish: 1, resume: 1, alias: 2, keep: 1, forget: 1, gc: 0 }[sub]
    if (args.length > maxArgs) throw new AgentError(`Лишние аргументы. Справка: agent ${sub === 'finish' ? 'close' : sub} --help`)
    return handler(ctx, config, args, opts)
  }
  if (group === 'activity') {
    const names = [sub, ...args].filter(Boolean)
    return fileActivity(ctx, config, names, opts)
  }
  if (group === 'commit') {
    if (sub === 'hunks') return hunksCommand(ctx, ctx.cwd, args)
    if (!sub) throw new AgentError('Нужно: paradev-agent commit <план.json> [--apply]')
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
    throw new AgentError('Нужно: paradev-agent slot ls | create --project P | take --project P --branch B | prepare <слот> --branch B | release <слот> | sync-back <слот> | sync <слот>')
  }
  throw new AgentError(`Неизвестная группа ${group}. paradev-agent --help`)
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
  try {
    if (!group || opts.help) {
      out(helpFor(group, sub))
      return EXIT.ok
    }
    const result = await dispatch(ctx, group, sub, args, opts)
    out(group === 'hook' && sub !== 'install' && !opts.json ? JSON.stringify(result.runtimeOutput ?? {}) : opts.json ? JSON.stringify(result.data, null, 2) : result.text)
    return result.code ?? EXIT.ok
  } catch (error) {
    if (!(error instanceof AgentError)) throw error
    if (opts.json) out(JSON.stringify({ error: error.message, code: error.code, ...(ctx.includeErrorDetails ? error.details : undefined) }, null, 2))
    else process.stderr.write(`Ошибка: ${error.message}\n`)
    return error.code
  }
}
