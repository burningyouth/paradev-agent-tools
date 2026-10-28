import { copyFileSync, existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
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
 * Шаги по умолчанию — когда в `.agent-cli.json` нет `slot.prepare`. По отслеживаемым lock-файлам: клон
 * node_modules из основной копии, установка, если папки нет или lock-файл изменился (вложенный пакет — только
 * если у основной копии есть его node_modules); npm получает путь `.npmrc` основной копии, если своего нет.
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
    const env = install.startsWith('npm ') ? { envFromMain: { npm_config_userconfig: '.npmrc' } } : {}
    return [{ cloneIfMissing: [modules] }, { run: install, cwd: dir, ifMissing: [modules], ifChanged: [lock], ...env }]
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

const cloneFromMain = (ctx, slot, path) => {
  const source = slot.mainCheckout && join(slot.mainCheckout, path)
  const target = join(slot.path, path)
  const flags = CLONE_FLAGS[ctx.platform ?? process.platform]
  if (existsSync(target) || !source || !existsSync(source) || !flags) return false
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
    for (const path of [step.cloneIfMissing ?? []].flat()) {
      if (cloneFromMain(ctx, slot, path)) done.push(`клон ${path}`)
    }
    if (step.run && runStep(ctx, slot, step, previous)) done.push(step.cwd && step.cwd !== '.' ? `${step.run} (${step.cwd})` : step.run)
  }
  return done
}
