import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { mustRun } from './context.js'

// Клон файловой системы: копия почти мгновенна и почти не занимает места (APFS, reflink)
const CLONE_FLAGS = { darwin: ['-c', '-R'], linux: ['-R', '--reflink=always'] }

const INSTALLERS = [
  ['package-lock.json', 'npm ci'],
  ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
  ['yarn.lock', 'yarn install --frozen-lockfile'],
]
const HOOK_TOOLS = [
  ['.husky', 'npx husky'],
  ['lefthook.yml', 'npx lefthook install'],
]

/**
 * Папки node_modules по package-lock.json → обязательный пакет-образец: своя и вложенные workspace-пакетов
 * (`libs/x/node_modules`, их ставит корневой `npm ci`). Готовность — по образцу: папка может быть только кэшем
 * сборки (`.cache`). Первый пакет папки — образец: в Map побеждает последний, поэтому список развёрнут.
 */
const npmModules = (slot, lock) => {
  const dir = dirname(lock)
  const own = join(dir, 'node_modules')
  let packages = {}
  try {
    packages = JSON.parse(readFileSync(join(slot.path, lock), 'utf-8')).packages ?? {}
  } catch {
    // lock-файл не JSON (конфликт слияния) — только своя папка, установка разберётся
  }
  const optional = (entry) => entry.optional || entry.devOptional || entry.peer
  const samples = Object.keys(packages)
    .filter((key) => key.includes('node_modules/') && !optional(packages[key]))
    .reverse()
    .map((key) => [join(dir, key.match(/^(.*?node_modules)\//)[1]), join(dir, key)])
  return new Map([[own, own], ...samples])
}

/**
 * Шаги по умолчанию — когда в `.agent-cli.json` нет `slot.prepare`. По отслеживаемым lock-файлам: клон
 * node_modules из основной копии (npm — и вложенных workspace-пакетов из lock-файла; только при одинаковом
 * lock-файле), установка, если папки не готовы или lock-файл изменился (вложенный lock-файл — только если у
 * основной копии есть его node_modules); npm получает путь `.npmrc` основной копии, если своего нет.
 * Хуки (husky, lefthook) — если git не находит каталог хуков.
 */
export const defaultSteps = (ctx, slot) => {
  const patterns = INSTALLERS.map(([lock]) => `*${lock}`)
  const listed = ctx.run('git', ['ls-files', '--', ...patterns], { cwd: slot.path })
  const locks = (listed.status === 0 ? listed.stdout.split('\n').filter(Boolean) : []).sort(
    (a, b) => a.split('/').length - b.split('/').length,
  )
  const deps = locks.flatMap((lock) => {
    const dir = dirname(lock)
    const modules = join(dir, 'node_modules')
    if (dir !== '.' && !(slot.mainCheckout && existsSync(join(slot.mainCheckout, modules)))) return []
    const install = INSTALLERS.find(([name]) => lock.endsWith(name))[1]
    const npm = install.startsWith('npm ')
    const env = npm ? { envFromMain: { npm_config_userconfig: '.npmrc' } } : {}
    const dirs = npm ? npmModules(slot, lock) : new Map([[modules, modules]])
    const clone = { cloneIfMissing: [...dirs.keys()], ready: Object.fromEntries(dirs), ifSame: [lock] }
    return [clone, { run: install, cwd: dir, ifMissing: [...dirs.values()], ifChanged: [lock], ...env }]
  })
  const hooks = HOOK_TOOLS.filter(([marker]) => existsSync(join(slot.path, marker))).map(([, run]) => ({ run, ifNoHooks: true }))
  return [...deps, ...hooks]
}

export const prepareSteps = (ctx, slot, rules) => rules.slot?.prepare ?? defaultSteps(ctx, slot)

const hooksMissing = (ctx, slot) => {
  const path = ctx.run('git', ['rev-parse', '--git-path', 'hooks'], { cwd: slot.path })
  return path.status !== 0 || !existsSync(resolve(slot.path, path.stdout.trim()))
}

/** Окружение из основной копии: путь к её файлу, если в слоте такого файла нет (файл не читается). */
const envFromMain = (slot, map = {}) =>
  Object.fromEntries(
    Object.entries(map).filter(
      ([, file]) => slot.mainCheckout && !existsSync(join(slot.path, file)) && existsSync(join(slot.mainCheckout, file)),
    ).map(([name, file]) => [name, join(slot.mainCheckout, file)]),
  )

/** Команда шага: без условий — всегда; с `ifChanged` / `ifMissing` / `ifNoHooks` — если сработало хотя бы одно. */
const runStep = (ctx, slot, step, previous) => {
  const conditions = [
    step.ifChanged &&
      Boolean(previous) &&
      ctx.run('git', ['diff', '--quiet', previous, 'HEAD', '--', ...step.ifChanged], { cwd: slot.path }).status !== 0,
    step.ifMissing && step.ifMissing.some((path) => !existsSync(join(slot.path, path))),
    step.ifNoHooks && hooksMissing(ctx, slot),
  ]
  const conditional = step.ifChanged || step.ifMissing || step.ifNoHooks
  if (conditional && !conditions.some(Boolean)) return false
  const [cmd, ...args] = step.run.split(/\s+/)
  mustRun(ctx, cmd, args, { cwd: join(slot.path, step.cwd ?? '.'), env: envFromMain(slot, step.envFromMain), what: step.run })
  return true
}

const sameFile = (a, b) => existsSync(a) && existsSync(b) && readFileSync(a).equals(readFileSync(b))

/**
 * Клон папки из основной копии. `ready[path]` — путь, по которому папка считается готовой (иначе — сама папка):
 * неготовая папка (например, только кэш сборки) заменяется клоном. `ifSame` — файлы, которые должны совпадать
 * в слоте и основной копии (lock-файл), иначе клон не делается.
 */
const cloneFromMain = (ctx, slot, path, step) => {
  const source = slot.mainCheckout && join(slot.mainCheckout, path)
  const target = join(slot.path, path)
  const flags = CLONE_FLAGS[ctx.platform ?? process.platform]
  const ready = (root) => existsSync(join(root, step.ready?.[path] ?? path))
  if (ready(slot.path) || !source || !ready(slot.mainCheckout) || !flags) return false
  if ((step.ifSame ?? []).some((file) => !sameFile(join(slot.path, file), join(slot.mainCheckout, file)))) return false
  if (step.ready?.[path]) rmSync(target, { recursive: true, force: true }) // иначе cp вложит копию внутрь
  mkdirSync(dirname(target), { recursive: true })
  if (ctx.run('cp', [...flags, source, target], { cwd: slot.path }).status === 0) return true
  rmSync(target, { recursive: true, force: true })
  return false
}

/** Шаги подготовки: ссылки, копии и клоны из основной копии, команды. Возвращает сделанное. */
export const runSteps = (ctx, slot, steps, previous) => {
  const done = []
  for (const step of steps) {
    if (step.symlinkIfMissing) {
      const target = join(slot.path, step.symlinkIfMissing)
      if (!existsSync(target) && slot.mainCheckout) {
        symlinkSync(join(slot.mainCheckout, step.symlinkIfMissing), target)
        done.push(`ссылка ${step.symlinkIfMissing}`)
      }
    }
    for (const path of step.copyIfMissing ?? []) {
      const source = slot.mainCheckout && join(slot.mainCheckout, path)
      if (!existsSync(join(slot.path, path)) && source && existsSync(source)) {
        mkdirSync(dirname(join(slot.path, path)), { recursive: true })
        copyFileSync(source, join(slot.path, path))
        done.push(`копия ${path}`)
      }
    }
    const cloned = [step.cloneIfMissing ?? []].flat().filter((path) => cloneFromMain(ctx, slot, path, step))
    if (cloned.length) done.push(`клон ${cloned[0]}${cloned.length > 1 ? ` и ещё ${cloned.length - 1}` : ''}`)
    if (step.run && runStep(ctx, slot, step, previous)) done.push(step.cwd && step.cwd !== '.' ? `${step.run} (${step.cwd})` : step.run)
  }
  return done
}
