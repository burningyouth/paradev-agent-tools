import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { platform, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import project from '../package.json' with { type: 'json' }
import manifest from './plugin.json' with { type: 'json' }

const repo = fileURLToPath(new URL('../', import.meta.url))
const { values, positionals } = parseArgs({ allowPositionals: true, options: { clients: { type: 'string' } } })
if (positionals.length > 1) throw new Error('Укажите только один путь для готового архива.')
const minimumNode = project.engines.node.match(/^>=(\d+)$/)?.[1]
if (!minimumNode) throw new Error('Укажите минимальную версию Node.js в package.json в формате >=N.')
const product = 'paradev-agent-tools'
const marketplace = 'burningyouth'
const dist = join(repo, 'dist')
const destination = resolve(positionals[0] ?? join(dist, `${product}-${manifest.version}.tar.gz`))
const clientsDestination = values.clients && resolve(values.clients)
if (clientsDestination === destination) throw new Error('Укажите разные пути для архивов.')

const title = manifest.extensions['com.openai'].interface.displayName
const staging = mkdtempSync(join(tmpdir(), 'paradev-agent-tools-build-'))
const distribution = join(staging, title)
const plugin = join(distribution, product)
const copy = (source, target) => {
  mkdirSync(dirname(target), { recursive: true })
  cpSync(join(repo, source), target, { recursive: true })
}
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' })
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
const metadata = platform() === 'darwin' ? ['--no-xattrs', '--no-mac-metadata'] : []
const pack = (root, files, output) => {
  const archive = join(staging, 'package.tar.gz')
  run('tar', [...metadata, '-czf', archive, '-C', root, ...files])
  mkdirSync(dirname(output), { recursive: true })
  cpSync(archive, output)
}

const packClients = () => {
  const clients = join(staging, 'clients')
  const pluginPath = `plugins/${product}`
  mkdirSync(join(clients, '.agents', 'plugins'), { recursive: true })
  mkdirSync(join(clients, 'plugins'))
  cpSync(plugin, join(clients, pluginPath), { recursive: true })
  copy('LICENSE', join(clients, 'LICENSE'))
  copy('mcp/opencode.js', join(clients, 'opencode.js'))
  writeJson(join(clients, 'package.json'), {
    name: `${product}-opencode`, version: manifest.version, private: true, type: 'module',
    description: manifest.description, license: project.license, exports: { '.': './opencode.js' },
    files: ['opencode.js', 'plugins'], dependencies: { '@opencode/plugin': '~2.3.1' },
  })
  writeJson(join(clients, '.agents', 'plugins', 'marketplace.json'), {
    name: marketplace, interface: { displayName: marketplace },
    plugins: [{
      name: manifest.name, source: { source: 'local', path: `./${pluginPath}` },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity',
    }],
  })
  pack(clients, ['.agents', 'LICENSE', 'opencode.js', 'package.json', 'plugins'], clientsDestination)
}

try {
  for (const path of ['bin', 'src', 'skills', 'examples', 'LICENSE']) copy(path, join(plugin, path))
  writeJson(join(plugin, 'package.json'), { type: 'module', private: true, license: project.license })
  for (const path of ['server.js', 'invoke.js', 'host.js', 'tools.js', 'install.js', 'jsonc.js', 'plugin.json']) {
    copy(`mcp/${path}`, join(plugin, 'mcp', path))
  }
  copy('mcp/plugin.json', join(plugin, 'plugin.json'))
  copy('mcp/mcp.json', join(plugin, 'mcp.json'))
  copy('mcp/assets', join(plugin, 'assets'))
  copy('mcp/SKILL.md', join(plugin, 'skills/multi-agent-mcp/SKILL.md'))
  const launcher = readFileSync(join(repo, 'mcp/launch'), 'utf8').replace('@MINIMUM_NODE_MAJOR@', minimumNode)
  writeFileSync(join(plugin, 'launch'), launcher, { mode: 0o755 })

  for (const name of ['Install.command', 'Install.sh']) {
    const entry = join(distribution, name)
    copy('mcp/install-entry.sh', entry)
    chmodSync(entry, 0o755)
  }
  copy('LICENSE', join(distribution, 'LICENSE'))
  copy('docs/multi-agent-mcp.md', join(distribution, 'Установка и проверка.md'))
  if (clientsDestination) packClients()
  pack(staging, [basename(distribution)], destination)
  if (dirname(destination) === dist && lstatSync(dist).isDirectory()) {
    const releaseArchive = /^paradev-agent-tools-\d+\.\d+\.\d+(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?\.(?:zip|tar\.gz)$/
    for (const entry of readdirSync(dist, { withFileTypes: true })) {
      const path = join(dist, entry.name)
      if (entry.isFile() && releaseArchive.test(entry.name) && path !== destination && path !== clientsDestination) {
        rmSync(path, { force: true })
      }
    }
  }
  process.stdout.write([destination, clientsDestination].filter(Boolean).join('\n') + '\n')
} finally { rmSync(staging, { recursive: true, force: true }) }
