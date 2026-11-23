import { execFileSync } from 'node:child_process'
import { accessSync, constants, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { migratePackagedHooks } from '../src/hooks.js'
import { patchJsonc, parseJsonc } from './jsonc.js'
import manifest from './plugin.json' with { type: 'json' }

const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const id = 'multi-agent-mcp'
const pluginId = manifest.name
const home = homedir()
const installed = join(home, '.codex', 'plugins', id)
// The same profile serves the installed launcher and Codex's versioned copies.
const nodeProfile = `${installed}.node-path`
const configHome = process.env.XDG_CONFIG_HOME ?? join(home, '.config')
const configDir = process.env.OPENCODE_CONFIG_DIR ?? join(configHome, 'opencode')
const codexPath = join(home, '.agents', 'plugins', 'marketplace.json')
const repository = 'burningyouth/paradev-agent-tools'
const codexMarketplace = 'burningyouth'
const distribution = 'distribution'
const opencodeSource = `git+https://github.com/${repository}.git#${distribution}`
let client = process.argv[2]
const json = process.argv.includes('--json')
const link = process.argv.includes('--link')
let local = process.argv.includes('--local')
const interactive = !client && !json && process.stdin.isTTY && process.stdout.isTTY
const message = (value) => {
  process.stdout.write((json ? JSON.stringify(value) : value.message ??
    'Укажите --install opencode для OpenCode 2 или --install opencode-v1 для OpenCode 1.') + '\n')
}
let menu
let menuLines
const select = async (question, choices) => {
  if (!menu) {
    menu = createInterface({ input: process.stdin })
    menuLines = menu[Symbol.asyncIterator]()
  }
  process.stdout.write(`${question}\n${choices.map(([label], i) => `  ${i + 1}. ${label}`).join('\n')}\n  0. Выйти\n`)
  for (;;) {
    process.stdout.write('> ')
    const line = await menuLines.next()
    const answer = line.value?.trim()
    if (line.done || answer === '0') return null
    const choice = choices.find((_, index) => String(index + 1) === answer)
    if (choice) return choice[1]
    process.stdout.write('Введите номер из списка.\n')
  }
}
const executables = (fileName, applicationPaths) => {
  const folders = (process.env.PATH ?? '').split(':').filter((folder) => folder.startsWith('/'))
  return [...new Set([...applicationPaths, ...folders.map((folder) => join(folder, fileName))])].filter((path) => {
    try { accessSync(path, constants.X_OK); return true } catch { return false }
  })
}
const runClient = (path, args, timeout = 15_000) =>
  execFileSync(path, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] })

const openCodeExecutables = () => {
  const app = 'OpenCode.app/Contents/Resources/opencode-cli'
  return executables('opencode', process.platform === 'darwin' ? [join(home, 'Applications', app), join('/Applications', app)] : [])
}

const detectOpenCode = () => {
  for (const path of openCodeExecutables()) {
    try {
      const output = runClient(path, ['--version']).trim()
      const match = output.match(/^(?:opencode\s+)?v?(1|2)\.\d+\.\d+(?:[-+][\w.+-]+)?$/im)
      if (match) return { path, client: match[1] === '1' ? 'opencode-v1' : 'opencode' }
    } catch { /* Offer choice if the installed client cannot report its version. */ }
  }
  return null
}

const codexExecutable = () => {
  const binaries = ['ChatGPT.app', 'Codex.app'].flatMap((app) => {
    const bin = join(app, 'Contents', 'Resources', 'codex-cli', 'bin', 'codex')
    return [join(home, 'Applications', bin), join('/Applications', bin)]
  })
  return executables('codex', process.platform === 'darwin' ? binaries : [])[0]
}

const activateCodex = (marketplaceName, displayName) => {
  const path = codexExecutable()
  const fallback = `Перезапустите Codex. Откройте Plugins, выберите локальный каталог «${displayName}» и нажмите Install у Paradev Agent Tools.`
  if (!path) return { message: fallback, activated: false }
  try {
    runClient(path, ['plugin', 'add', `${pluginId}@${marketplaceName}`, '--json'])
    return { message: 'Codex подключён. Перезапустите Codex и откройте новый чат в папке проекта.', activated: true }
  } catch (error) {
    const detail = error.stderr?.trim().split('\n').at(-1)
    return { message: fallback, activated: false, ...(detail ? { detail } : {}) }
  }
}

const installFromGit = (client, detectedOpenCode) => {
  const codex = client === 'codex'
  const path = codex ? codexExecutable() : (detectedOpenCode?.path ?? openCodeExecutables()[0])
  const label = codex ? 'Codex' : 'OpenCode 2'
  const fallback = `Для установки из распакованного комплекта запустите установщик с аргументами ${client} --local.`
  if (!path) throw new Error(`Команда ${client} не найдена. ${fallback}`)
  try {
    if (codex) {
      const result = runClient(path, ['plugin', 'marketplace', 'add', repository, '--ref', distribution, '--json'], 120_000)
      const { marketplaceName, alreadyAdded } = JSON.parse(result)
      if (marketplaceName !== codexMarketplace) {
        if (marketplaceName === 'paradev-agent-tools' && alreadyAdded) {
          throw new Error('Удалите старую регистрацию командой codex plugin marketplace remove paradev-agent-tools и повторите установку.')
        }
        throw new Error(`Ожидался маркетплейс ${codexMarketplace}. Codex вернул: ${marketplaceName ?? 'имя отсутствует'}.`)
      }
      runClient(path, ['plugin', 'add', `${pluginId}@${codexMarketplace}`, '--json'], 120_000)
    } else {
      runClient(path, ['plugin', 'add', opencodeSource], 120_000)
    }
  } catch (error) {
    const detail = error.stderr?.trim() || error.stdout?.trim() || error.message
    throw new Error(`Не удалось подключить ${label} через Git.\n${detail}\n${fallback}`)
  }
  const migration = codex
    ? ' Если в Plugins осталась прежняя установка, отключите её после проверки новой версии.'
    : ''
  return { message: `${label} подключён через Git. Перезапустите клиент.${migration}`, activated: true }
}

const file = (path) => {
  const info = lstatSync(path, { throwIfNoEntry: false })
  if (!info) return null
  if (!info.isFile()) throw new Error(`Ожидался обычный файл: ${path}`)
  return readFileSync(path, 'utf8')
}
const write = (path, before, after, linkTarget) => {
  if (before === after && !linkTarget) return null
  mkdirSync(dirname(path), { recursive: true })
  const token = randomUUID()
  const tmp = `${path}.${token}.tmp`
  const backup = before === null ? null : `${path}.${id}-${token}.bak`
  try {
    if (linkTarget) symlinkSync(linkTarget, tmp)
    else writeFileSync(tmp, after, { flag: 'wx', mode: 0o600 })
    if (file(path) !== before) throw new Error(`Конфигурация изменилась во время установки: ${path}`)
    if (backup) writeFileSync(backup, before, { flag: 'wx', mode: 0o600 })
    renameSync(tmp, path)
    return backup
  } finally { rmSync(tmp, { force: true }) }
}
const installedManifest = (destination) => {
  try {
    if (lstatSync(destination).isDirectory()) return JSON.parse(readFileSync(join(destination, 'plugin.json'), 'utf8'))
  } catch { /* A foreign or invalid destination is reported by the installer. */ }
  return null
}

const linkedPackage = () => {
  let root
  try { root = runClient('git', ['-C', packageRoot, 'rev-parse', '--show-toplevel']).trim() } catch {}
  const source = realpathSync(packageRoot)
  if (!root || source !== join(realpathSync(root), 'plugins', 'paradev-agent-tools')) {
    throw new Error('Запустите установку с --link из Git-клона ветки distribution.')
  }
  return source
}

const openCodeSettings = (legacy) => {
  const jsonc = join(configDir, 'opencode.jsonc')
  const json = join(configDir, 'opencode.json')
  const path = existsSync(jsonc) ? jsonc : json
  const before = file(path)
  const source = before ?? '{}\n'
  const keys = legacy ? ['mcp', id] : ['mcp', 'servers', id]
  const previous = keys.reduce((value, key) => value?.[key], parseJsonc(source).value)
  const launch = join(installed, 'launch')
  if (previous !== undefined && previous?.command?.[0] !== launch) throw new Error(`Выбранное имя MCP-сервера уже занято: ${path}`)
  const entry = { type: 'local', ...(legacy ? { timeout: 180000 } : { timeout: { execution: 180000 } }), command: [launch] }
  const updated = previous !== undefined ? source : patchJsonc(source, keys, entry)
  const relativeSkill = join('skills', id, 'SKILL.md')
  const skill = join(configDir, relativeSkill)
  const skillTarget = join(installed, relativeSkill)
  const configChange = [path, before, updated]
  if (lstatSync(skill, { throwIfNoEntry: false })?.isSymbolicLink() && readlinkSync(skill) === skillTarget) {
    return [configChange]
  }
  const skillBefore = file(skill)
  const skillAfter = readFileSync(join(packageRoot, relativeSkill), 'utf8')
  const marker = '<!-- multi-agent-mcp bundled workflow -->'
  if (skillBefore !== null && !skillBefore.includes(marker)) throw new Error(`Личный скилл с таким именем уже существует: ${skill}`)
  // Upgrade the original 0.1.0/0.1.1 workflow even if Codex was connected first.
  const legacyWorkflow = 'e427f765042b966c825c033aaf1600bbae3a3bede8a3b8d5bb272f1111f82227'
  const previousWorkflow = skillBefore !== null && createHash('sha256').update(skillBefore).digest('hex')
  if (skillBefore !== null && skillBefore !== skillAfter && previousWorkflow !== legacyWorkflow) {
    // A colleague may have edited even the originally installed file. Keep it and put updates in the package.
    return [configChange]
  }
  return [configChange, [skill, skillBefore, skillAfter, link ? skillTarget : undefined]]
}

const kiloSettings = () => {
  const dir = join(configHome, 'kilo')
  const keys = ['mcp', 'paradev-agent-tools']
  const launch = join(installed, 'launch')
  const configs = ['kilo.jsonc', 'kilo.json', 'config.json'].map((name) => {
    const path = join(dir, name)
    const before = file(path)
    const previous = before === null ? undefined : parseJsonc(before).value?.mcp?.[keys[1]]
    if (previous !== undefined && (previous?.type !== 'local' || !Array.isArray(previous.command) || previous.command.length !== 1 || previous.command[0] !== launch)) {
      throw new Error(`Выбранное имя MCP-сервера уже занято: ${path}`)
    }
    return { path, before, previous }
  })
  const registered = configs.filter(({ previous }) => previous !== undefined)
  if (registered.length) {
    return registered.filter(({ previous }) => previous.enabled === false)
      .map(({ path, before }) => [path, before, patchJsonc(before, [...keys, 'enabled'], true)])
  }
  const { path, before } = configs.find((config) => config.before !== null) ?? configs[1]
  return [[path, before, patchJsonc(before ?? '{}\n', keys, { type: 'local', command: [launch], enabled: true })]]
}

const codexSettings = () => {
  const before = file(codexPath)
  const marketplace = before === null ? { name: 'multi-agent-private', interface: { displayName: 'Paradev Agent Tools' }, plugins: [] } : JSON.parse(before)
  if (typeof marketplace.name !== 'string' || !marketplace.name || !Array.isArray(marketplace.plugins)) throw new Error(`Ожидался список plugins: ${codexPath}`)
  const path = './.codex/plugins/multi-agent-mcp'
  const usesInstalledPackage = (item) => item.source?.path === path || item.source === path
  const entry = marketplace.plugins.find((item) => item.name === pluginId)
  if (entry && !usesInstalledPackage(entry)) throw new Error(`Выбранное имя плагина уже занято: ${codexPath}`)
  const legacy = marketplace.plugins.find((item) => item.name === id && usesInstalledPackage(item))
  const name = marketplace.name
  const oldDisplay = name === 'multi-agent-private' && marketplace.interface?.displayName === 'Multi Agent · Private'
  if (oldDisplay) marketplace.interface.displayName = 'Paradev Agent Tools'
  const displayName = marketplace.interface?.displayName ?? name
  if (entry && !legacy && !oldDisplay) return { name, displayName, changes: [] }
  if (legacy && entry) marketplace.plugins = marketplace.plugins.filter((item) => item !== legacy)
  else if (legacy) legacy.name = pluginId
  else if (!entry) marketplace.plugins.push({ name: pluginId, source: { source: 'local', path },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' })
  return { name, displayName, changes: [[codexPath, before, JSON.stringify(marketplace, null, 2) + '\n']] }
}

const hookChanges = () => {
  const changes = []
  const profiles = [
    ['codex', join(process.env.CODEX_HOME ?? join(home, '.codex'), 'hooks.json')],
    ['claude', join(process.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), 'settings.json')],
  ]
  for (const [agent, path] of profiles) {
    if (!existsSync(path)) continue
    const before = readFileSync(path, 'utf8')
    if (!before.includes('/runtime/node')) continue
    const settings = JSON.parse(before)
    if (migratePackagedHooks(settings, agent, installed)) changes.push([path, before, JSON.stringify(settings, null, 2) + '\n'])
  }
  return changes
}

try {
  let detectedOpenCode
  if (interactive) {
    client = await select('К какому клиенту подключить Paradev Agent Tools?', [
      ['Codex через Git', 'codex'], ['OpenCode', 'opencode-auto'], ['Kilo Code / Kilo CLI', 'kilo'],
      ['Другой MCP-клиент', 'manual'], ['Codex из распакованного комплекта', 'codex-local'],
      ['OpenCode из распакованного комплекта', 'opencode-local'],
    ])
    if (client === null) process.exit(0)
    if (client === 'codex-local' || client === 'opencode-local') {
      local = true
      client = client === 'codex-local' ? 'codex' : 'opencode-auto'
    }
  }
  if (client === 'opencode-auto') {
    detectedOpenCode = detectOpenCode()
    client = detectedOpenCode?.client ?? null
    if (client === null && interactive) {
      client = await select('Версия OpenCode не определилась. Укажите поколение клиента.', [
        ['OpenCode 2', 'opencode'], ['OpenCode 1', 'opencode-v1'],
      ])
      if (client === null) process.exit(0)
    }
    if (client === null) {
      message({ versionChoice: true })
      process.exit(0)
    }
  }
  menu?.close()
  if (!['codex', 'opencode', 'opencode-v1', 'kilo', 'manual'].includes(client)) {
    throw new Error('Выберите codex, opencode-auto, kilo или manual.')
  }
  const native = !local && (client === 'codex' || client === 'opencode')
  if (link && client !== 'manual' && client !== 'kilo' && client !== 'opencode-v1') {
    throw new Error('Используйте --link с manual, kilo или opencode-v1. Для хуков используйте manual.')
  }
  const sourceLink = link ? linkedPackage() : null
  if (!native && process.env.OPENCODE_CONFIG && client.startsWith('opencode')) throw new Error('OpenCode использует OPENCODE_CONFIG. Уберите переопределение или добавьте конфигурацию из руководства в выбранный файл.')
  const codex = !native && client === 'codex' ? codexSettings() : null
  const settings = codex?.changes ?? (native || client === 'manual' ? [] : client === 'kilo' ? kiloSettings() : openCodeSettings(client === 'opencode-v1'))
  const hooks = hookChanges()
  const previous = lstatSync(installed, { throwIfNoEntry: false })
  const wasLinked = previous?.isSymbolicLink()
  if (wasLinked && !existsSync(installed)) throw new Error(`Git-клон для ${installed} недоступен: ${readlinkSync(installed)}`)
  const present = previous ? installedManifest(wasLinked ? realpathSync(installed) : installed) : null
  if (previous && present?.name !== pluginId && present?.name !== id) throw new Error(`Каталог уже используется: ${installed}`)
  const supplied = installedManifest(packageRoot)
  if (supplied?.name !== pluginId) throw new Error(`В комплекте отсутствует манифест ${pluginId}.`)
  const nodeBefore = file(nodeProfile)
  const sameSource = previous && realpathSync(installed) === realpathSync(packageRoot)
  const currentCopy = sameSource || (present?.name === pluginId && present.version === supplied.version &&
    !lstatSync(join(installed, 'runtime'), { throwIfNoEntry: false }))
  const current = sourceLink ? wasLinked && sameSource : wasLinked || currentCopy
  let previousPackage
  if (!current) {
    mkdirSync(dirname(installed), { recursive: true })
    const staging = `${installed}.${randomUUID()}.tmp`
    try {
      if (sourceLink) symlinkSync(sourceLink, staging, 'dir')
      else cpSync(packageRoot, staging, { recursive: true, errorOnExist: true, force: false,
        filter: (source) => source !== join(packageRoot, 'runtime') })
      if (previous) {
        previousPackage = `${installed}.${randomUUID()}.bak`
        renameSync(installed, previousPackage)
      }
      try { renameSync(staging, installed) } catch (error) {
        if (previousPackage) renameSync(previousPackage, installed)
        throw error
      }
    } finally { rmSync(staging, { force: true, recursive: true }) }
  }
  const backups = [[nodeProfile, nodeBefore, process.execPath + '\n'], ...settings, ...hooks]
    .map(([path, before, after, linkTarget]) => write(path, before, after, linkTarget)).filter(Boolean)
  let info
  if (native) info = installFromGit(client, detectedOpenCode)
  else if (codex) info = activateCodex(codex.name, codex.displayName)
  else if (client === 'manual') {
    info = { message: `Укажите эту команду для локального MCP stdio.\n${join(installed, 'launch')}`, activated: false }
  } else {
    info = { message: `${client === 'kilo' ? 'Kilo' : 'OpenCode'} подключён. Перезапустите клиент и откройте новый чат в папке проекта.`, activated: true }
  }
  if (hooks.length) info.message += '\nЕсли Codex попросит, подтвердите обновлённые хуки в его интерфейсе.'
  message({ ...info, installed, backups: [previousPackage, ...backups].filter(Boolean) })
} catch (error) {
  if (json) message({ message: error.message, activated: false })
  else process.stderr.write(error.message + '\n')
  process.exitCode = 1
} finally { menu?.close() }
