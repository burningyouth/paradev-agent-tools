import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { arch, platform, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { sharedSkillText } from '../src/skills.js'
import manifest from './plugin.json' with { type: 'json' }

const repo = fileURLToPath(new URL('../', import.meta.url))
const { values, positionals } = parseArgs({ options: {
  target: { type: 'string' }, 'node-dir': { type: 'string' },
}, allowPositionals: true })
const localOS = platform() === 'darwin' ? 'macos' : platform()
const native = `${localOS}-${arch()}`
const target = values.target ?? native
if (!['macos-arm64', 'macos-x64', 'linux-arm64', 'linux-x64'].includes(target)) {
  throw new Error(`Цель ${target} недоступна. Paradev поддерживает macOS и Linux.`)
}
const [os, architecture] = target.split('-')
if (os === 'macos' && platform() !== 'darwin') throw new Error('Для сборки .app нужны macOS и Xcode Command Line Tools.')
if (!values['node-dir'] && (target !== native || !process.release.lts || Number(process.versions.node.split('.')[0]) < 22)) {
  throw new Error('Нужен официальный Node.js LTS 22+ для выбранной цели. Передайте распакованный архив через --node-dir.')
}

const nodeRoot = values['node-dir'] ? resolve(values['node-dir']) : join(dirname(process.execPath), '..')
const nodeBin = values['node-dir'] ? join(nodeRoot, 'bin', 'node') : process.execPath
if (values['node-dir']) {
  const binary = execFileSync('file', ['-b', nodeBin], { encoding: 'utf8' })
  const format = os === 'macos' ? /Mach-O/ : /ELF/
  const cpu = architecture === 'x64' ? /x86[-_]64/ : /arm64|aarch64/i
  if (!format.test(binary) || !cpu.test(binary)) throw new Error(`Формат Node.js не соответствует ${target}: ${binary.trim()}`)
}
const extension = os === 'macos' ? 'zip' : 'tar.gz'
const destination = resolve(positionals[0] ?? join(repo, 'dist', `paradev-agent-tools-${manifest.version}-${target}.${extension}`))
if (positionals.length > 1) throw new Error('Укажите только один путь для готового архива.')

const title = manifest.extensions['com.openai'].interface.displayName
const staging = mkdtempSync(join(tmpdir(), 'paradev-agent-tools-build-'))
const distribution = join(staging, title)
const app = join(distribution, `${title}.app`)
const contents = join(app, 'Contents')
const plugin = os === 'macos' ? join(contents, 'Resources', manifest.name) : join(distribution, manifest.name)
const copy = (source, target, filter) => {
  mkdirSync(dirname(target), { recursive: true })
  cpSync(join(repo, source), target, { recursive: true, filter })
}
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' })

try {
  const personal = new Set(['pen.js', 'pen-quit.js', 'agent-pen'])
  for (const path of ['bin', 'src', 'skills', 'examples']) {
    copy(path, join(plugin, path), (source) => !personal.has(basename(source)))
  }
  writeFileSync(join(plugin, 'package.json'), '{"type":"module","private":true}\n')
  for (const path of ['examples/agent-cli/SKILL.md', 'skills/agent-cleanup/SKILL.md']) {
    const file = join(plugin, path)
    writeFileSync(file, sharedSkillText(readFileSync(file, 'utf8')))
  }
  for (const path of ['server.js', 'invoke.js', 'host.js', 'tools.js', 'install.js', 'jsonc.js', 'plugin.json']) {
    copy(`mcp/${path}`, join(plugin, 'mcp', path))
  }
  copy('mcp/plugin.json', join(plugin, 'plugin.json'))
  copy('mcp/mcp.json', join(plugin, 'mcp.json'))
  copy('mcp/SKILL.md', join(plugin, 'skills/multi-agent-mcp/SKILL.md'))
  const launcher = join(plugin, 'launch')
  copy('mcp/launch', launcher)
  chmodSync(launcher, 0o755)

  const runtime = join(plugin, 'runtime')
  mkdirSync(runtime)
  cpSync(nodeBin, join(runtime, 'node'))
  chmodSync(join(runtime, 'node'), 0o755)
  cpSync(join(nodeRoot, 'LICENSE'), join(runtime, 'NODE-LICENSE.txt'))

  const archive = join(staging, `package.${extension}`)
  copy('docs/multi-agent-mcp.md', join(distribution, 'Установка и проверка.md'))
  if (os === 'macos') {
    const executable = join(contents, 'MacOS', 'MultiAgentMCP')
    const cpu = architecture === 'x64' ? 'x86_64' : 'arm64'
    mkdirSync(dirname(executable))
    run('/usr/bin/swiftc', [
      '-O', '-target', `${cpu}-apple-macos13.0`, '-module-cache-path', join(staging, 'swift-cache'),
      join(repo, 'mcp/macos/Setup.swift'), '-o', executable,
    ])
    const plist = join(contents, 'Info.plist')
    copy('mcp/macos/Info.plist', plist)
    for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
      run('/usr/bin/plutil', ['-replace', key, '-string', manifest.version, plist])
    }
    run('/usr/bin/codesign', ['--force', '--sign', '-', app])
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
    run('/usr/bin/ditto', ['-c', '-k', '--norsrc', '--noextattr', '--keepParent', distribution, archive])
  } else {
    const setup = join(distribution, 'Setup.sh')
    copy('mcp/linux/setup', setup)
    chmodSync(setup, 0o755)
    const metadata = platform() === 'darwin' ? ['--no-xattrs', '--no-mac-metadata'] : []
    run('tar', [...metadata, '-czf', archive, '-C', staging, basename(distribution)])
  }
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(archive, destination)
  process.stdout.write(destination + '\n')
} finally { rmSync(staging, { recursive: true, force: true }) }
