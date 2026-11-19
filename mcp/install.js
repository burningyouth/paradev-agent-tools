import { execFileSync } from 'node:child_process'
import { accessSync, constants, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { patchJsonc, parseJsonc } from './jsonc.js'

const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const id = 'multi-agent-mcp'
const home = homedir()
const installed = join(home, '.codex', 'plugins', id)
const configDir = process.env.OPENCODE_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'opencode')
const codexPath = join(home, '.agents', 'plugins', 'marketplace.json')
let client = process.argv[2]
const json = process.argv.includes('--json')
const message = (value) => {
  process.stdout.write((json ? JSON.stringify(value) : value.message ?? 'Укажите версию OpenCode.') + '\n')
}
const executables = (fileName, applicationPaths) => {
  const folders = (process.env.PATH ?? '').split(':').filter((folder) => folder.startsWith('/'))
  return [...new Set([...applicationPaths, ...folders.map((folder) => join(folder, fileName))])].filter((path) => {
    try { accessSync(path, constants.X_OK); return true } catch { return false }
  })
}
const runClient = (path, args) => execFileSync(path, args, { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] })

const detectOpenCode = () => {
  const app = 'OpenCode.app/Contents/Resources/opencode-cli'
  for (const path of executables('opencode', process.platform === 'darwin' ? [join(home, 'Applications', app), join('/Applications', app)] : [])) {
    try {
      const output = runClient(path, ['--version']).trim()
      const match = output.match(/^(?:opencode\s+)?v?(1|2)\.\d+\.\d+(?:[-+][\w.+-]+)?$/im)
      if (match) return match[1] === '1' ? 'opencode-v1' : 'opencode'
    } catch { /* Offer choice if the installed client cannot report its version. */ }
  }
  return null
}

const activateCodex = (marketplaceName, displayName) => {
  const binaries = ['ChatGPT.app', 'Codex.app'].flatMap((app) => {
    const bin = join(app, 'Contents', 'Resources', 'codex-cli', 'bin', 'codex')
    return [join(home, 'Applications', bin), join('/Applications', bin)]
  })
  const paths = executables('codex', process.platform === 'darwin' ? binaries : [])
  const path = paths[0]
  const fallback = `Перезапустите Codex. Откройте Plugins, выберите локальный каталог «${displayName}» и нажмите Install у Paradev Agent Tools.`
  if (!path) return { message: fallback, activated: false }
  try {
    runClient(path, ['plugin', 'add', `${id}@${marketplaceName}`, '--json'])
    return { message: 'Codex подключён. Перезапустите Codex и откройте новый чат в папке проекта.', activated: true }
  } catch (error) {
    const detail = error.stderr?.trim().split('\n').at(-1)
    return { message: fallback, activated: false, ...(detail ? { detail } : {}) }
  }
}

const file = (path) => {
  if (!existsSync(path)) return null
  const info = lstatSync(path)
  if (!info.isFile()) throw new Error(`Ожидался обычный файл: ${path}`)
  return readFileSync(path, 'utf8')
}
const write = (path, before, after) => {
  if (before === after) return null
  mkdirSync(dirname(path), { recursive: true })
  const token = randomUUID()
  const tmp = `${path}.${token}.tmp`
  const backup = before === null ? null : `${path}.${id}-${token}.bak`
  try {
    writeFileSync(tmp, after, { flag: 'wx', mode: 0o600 })
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
  const skill = join(configDir, 'skills', id, 'SKILL.md')
  const skillBefore = file(skill)
  const skillAfter = readFileSync(join(packageRoot, 'skills', id, 'SKILL.md'), 'utf8')
  const marker = '<!-- multi-agent-mcp bundled workflow -->'
  if (skillBefore !== null && !skillBefore.includes(marker)) throw new Error(`Личный скилл с таким именем уже существует: ${skill}`)
  // Upgrade the original 0.1.0/0.1.1 workflow even if Codex was connected first.
  const legacyWorkflow = 'e427f765042b966c825c033aaf1600bbae3a3bede8a3b8d5bb272f1111f82227'
  const previousWorkflow = skillBefore !== null && createHash('sha256').update(skillBefore).digest('hex')
  if (skillBefore !== null && skillBefore !== skillAfter && previousWorkflow !== legacyWorkflow) {
    // A colleague may have edited even the originally installed file. Keep it and put updates in the package.
    return [[path, before, updated]]
  }
  return [[path, before, updated], [skill, skillBefore, skillAfter]]
}

const codexSettings = () => {
  const before = file(codexPath)
  const marketplace = before === null ? { name: 'multi-agent-private', interface: { displayName: 'Paradev Agent Tools' }, plugins: [] } : JSON.parse(before)
  if (typeof marketplace.name !== 'string' || !marketplace.name || !Array.isArray(marketplace.plugins)) throw new Error(`Ожидался список plugins: ${codexPath}`)
  const path = './.codex/plugins/multi-agent-mcp'
  const entry = marketplace.plugins.find((item) => item.name === id)
  if (entry && entry.source?.path !== path && entry.source !== path) throw new Error(`Выбранное имя плагина уже занято: ${codexPath}`)
  const name = marketplace.name
  const oldDisplay = name === 'multi-agent-private' && marketplace.interface?.displayName === 'Multi Agent · Private'
  if (oldDisplay) marketplace.interface.displayName = 'Paradev Agent Tools'
  const displayName = marketplace.interface?.displayName ?? name
  if (entry && !oldDisplay) return { name, displayName, changes: [] }
  if (!entry) marketplace.plugins.push({ name: id, source: { source: 'local', path },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' })
  return { name, displayName, changes: [[codexPath, before, JSON.stringify(marketplace, null, 2) + '\n']] }
}

try {
  if (client === 'opencode-auto') {
    client = detectOpenCode()
    if (client === null) {
      message({ versionChoice: true })
      process.exit(0)
    }
  }
  if (!['codex', 'opencode', 'opencode-v1'].includes(client)) throw new Error('Выберите Codex или поколение OpenCode.')
  if (process.env.OPENCODE_CONFIG && client.startsWith('opencode')) throw new Error('OpenCode использует OPENCODE_CONFIG. Уберите переопределение или добавьте конфигурацию из руководства в выбранный файл.')
  const codex = client === 'codex' ? codexSettings() : null
  const changes = codex?.changes ?? openCodeSettings(client === 'opencode-v1')
  const previous = existsSync(installed)
  const present = previous ? installedManifest(installed) : null
  if (previous && present?.name !== id) throw new Error(`Каталог уже используется: ${installed}`)
  const supplied = installedManifest(packageRoot)
  if (supplied?.name !== id) throw new Error('В комплекте отсутствует манифест multi-agent-mcp.')
  const current = present?.version === supplied.version && existsSync(join(installed, 'runtime', 'node'))
  let previousPackage
  if (!previous || !current && realpathSync(installed) !== realpathSync(packageRoot)) {
    mkdirSync(dirname(installed), { recursive: true })
    const staging = `${installed}.${randomUUID()}.tmp`
    try {
      cpSync(packageRoot, staging, { recursive: true, errorOnExist: true, force: false })
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
  const backups = changes.map(([path, before, after]) => write(path, before, after)).filter(Boolean)
  const info = codex
    ? activateCodex(codex.name, codex.displayName)
    : { message: 'OpenCode подключён. Перезапустите OpenCode и откройте новый чат в папке проекта.', activated: true }
  message({ ...info, installed, backups: [previousPackage, ...backups].filter(Boolean) })
} catch (error) {
  if (json) message({ message: error.message, activated: false })
  else process.stderr.write(error.message + '\n')
  process.exitCode = 1
}
