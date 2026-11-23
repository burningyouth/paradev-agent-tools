import { execFile } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import manifest from './plugin.json' with { type: 'json' }
import { hostFailure } from './host.js'
import { tools } from './tools.js'

const VERSION = manifest.version
const PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']
const worker = fileURLToPath(new URL('./invoke.js', import.meta.url))
const definitions = Object.values(tools).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
const instructions = 'Use projects to find local paths and IDs. Pass the absolute selected project cwd to project tools; ask the user if selection is ambiguous. Keep exact workspaceId, latest sessionId and send anchor. After uncertain delivery inspect session_journal before retry. Wait in short calls. Idle means a turn ended. A queued close requires the receipt in your answer and later close_result. Review cleanup and commit plans before applying.'

const validate = (value, schema, path = 'arguments') => {
  if (schema.anyOf) {
    if (schema.anyOf.some((candidate) => !validate(value, candidate, path))) return
    return `${path}: value does not match any supported format`
  }
  if (schema.enum && !schema.enum.includes(value)) return `${path}: expected ${schema.enum.join(', ')}`
  switch (schema.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return `${path}: expected an object`
      for (const field of schema.required) {
        if (!Object.hasOwn(value, field)) return `${path}.${field}: required`
      }
      for (const [field, item] of Object.entries(value)) {
        if (!Object.hasOwn(schema.properties, field)) return `${path}.${field}: unknown field`
        const error = validate(item, schema.properties[field], `${path}.${field}`)
        if (error) return error
      }
      break
    }
    case 'string':
      if (typeof value !== 'string' || value.length < (schema.minLength ?? 0) || value.includes('\0')) return `${path}: expected a nonempty string`
      break
    case 'boolean':
      if (typeof value !== 'boolean') return `${path}: expected a boolean`
      break
    case 'integer':
      if (!Number.isSafeInteger(value) || value < schema.minimum || value > schema.maximum) return `${path}: expected integer ${schema.minimum}–${schema.maximum}`
      break
    case 'array':
      if (!Array.isArray(value) || value.length < schema.minItems) return `${path}: expected a nonempty array`
      for (const [i, item] of value.entries()) {
        const error = validate(item, schema.items, `${path}[${i}]`)
        if (error) return error
      }
      break
  }
}

const cwdFor = (cwd) => {
  if (cwd === undefined) return homedir()
  if (!isAbsolute(cwd) || !statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('Укажите существующий абсолютный путь проекта из projects или из рабочего окна клиента.')
  }
  return cwd
}

const env = { ...process.env }
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX']) delete env[key]

const sameVersion = (path) => {
  try {
    const installed = JSON.parse(readFileSync(path, 'utf8'))
    return installed?.name === manifest.name && installed.version === VERSION
  } catch { return false }
}

const invocationFiles = () => {
  if (!existsSync(process.execPath)) return
  if (existsSync(worker) && sameVersion(fileURLToPath(new URL('./plugin.json', import.meta.url)))) return worker
  // The installer retains previous packages. Use them if Codex prunes a cache
  // or a client still runs the server after the shared installation is updated.
  const plugins = join(homedir(), '.codex', 'plugins')
  const backupPattern = /^multi-agent-mcp\.[0-9a-f-]{36}\.bak$/
  let entries
  try { entries = readdirSync(plugins, { withFileTypes: true }) } catch { return }
  const copies = [manifest.name, ...entries.filter((file) => file.isDirectory() && backupPattern.test(file.name)).map((file) => file.name)]
  for (const copy of copies) {
    const root = join(plugins, copy)
    const entry = join(root, 'mcp', 'invoke.js')
    if (existsSync(entry) && sameVersion(join(root, 'plugin.json'))) return entry
  }
}

const invoke = (name, args, cwd, signal) => new Promise((resolve) => {
  const entry = invocationFiles()
  if (!entry) return resolve({ code: 1, data: { error: 'Версия Paradev Agent Tools для этой сессии недоступна. Перезапустите клиент и откройте новый чат, чтобы загрузить установленную версию.', code: 1 } })
  const child = execFile(process.execPath, [entry, name], {
    cwd, env, signal, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8',
  }, (error, stdout, stderr) => {
    const code = error ? (Number.isInteger(error.code) ? error.code : 1) : 0
    let data
    try { data = JSON.parse(stdout) } catch {
      data = { error: stderr.trim() || error?.message || 'CLI returned no JSON', code }
    }
    resolve({ code, data })
  })
  child.stdin.on('error', () => {}) // The worker may exit before reading stdin on startup failure.
  child.stdin.end(JSON.stringify(args))
})

const inFlight = new Map()
let initialized = false
const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
const rpcError = (id, code, message) => write({ id, error: { code, message } })
const result = (id, result) => write({ id, result })
const toolReply = (id, payload, isError = false) => result(id, {
  content: [{ type: 'text', text: JSON.stringify(payload) }],
  structuredContent: payload,
  ...(isError ? { isError: true } : {}),
})

const handle = async (message) => {
  const { id, method, params } = message ?? {}
  if (message?.jsonrpc !== '2.0' || typeof method !== 'string') return rpcError(id ?? null, -32600, 'Invalid Request')
  if (id === undefined) {
    if (method === 'notifications/cancelled') {
      const job = inFlight.get(params?.requestId)
      if (job) {
        job.cancelled = true
        job.controller?.abort()
      }
    }
    return
  }

  if (method === 'initialize') {
    const version = params?.protocolVersion
    if (typeof version !== 'string') return rpcError(id, -32602, 'protocolVersion is required')
    initialized = true
    return result(id, { protocolVersion: PROTOCOLS.includes(version) ? version : PROTOCOLS.at(-1),
      capabilities: { tools: {} }, serverInfo: { name: 'multi-agent-mcp', version: VERSION }, instructions })
  }
  if (method === 'ping') return result(id, {})
  if (!initialized) return rpcError(id, -32002, 'Server not initialized')
  if (method === 'tools/list') return result(id, { tools: definitions })
  if (method !== 'tools/call') return rpcError(id, -32601, 'Method not found')

  const name = params?.name
  if (!Object.hasOwn(tools, name)) return rpcError(id, -32602, 'Unknown tool')
  const args = params.arguments ?? {}
  const validation = validate(args, tools[name].inputSchema)
  if (validation) return toolReply(id, { error: validation }, true)

  const job = { cancelled: false, controller: name === 'session_wait' ? new AbortController() : null }
  inFlight.set(id, job)
  const startedAt = new Date().toISOString()
  try {
    const { code, data } = await invoke(name, args, cwdFor(args.cwd), job.controller?.signal)
    if (job.cancelled) return
    const payload = { code, data }
    if (name === 'session_create' && !code && data.sessionId) payload.status = 'created'
    if (name === 'session_send' && !code) payload.status = data.queued ? 'queued' : 'accepted'
    if (name === 'session_send' && code === 7) {
      payload.status = 'delivery-unknown'
      payload.startedAt = startedAt
      payload.next = 'Проверьте session_journal. Если chat сменил ID, найдите новый через session_list или session_history. Сравните время и полный текст; отсутствие записи пока не подтверждает недоставку.'
    }
    if (/manifest is stale|host service manifest|(?:host|daemon).*not running|ECONNREFUSED/i.test(data?.error ?? '')) {
      payload.host = hostFailure(data.error, { ...process.env, HOME: homedir() })
      data.error = payload.host.pids.some((host) => host.process === 'permission-denied')
        ? 'Paradev недоступен; права на проверку PID отсутствуют.' : payload.host.error
    }
    const expectedState = (name === 'session_wait' && data.reason) || (name === 'session_send' && code === 7)
    toolReply(id, payload, Boolean(code && !expectedState))
  } catch (error) {
    if (!job.cancelled) toolReply(id, { error: error.message }, true)
  } finally { inFlight.delete(id) }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', (line) => {
  let message
  try { message = JSON.parse(line) } catch { return rpcError(null, -32700, 'Parse error') }
  void handle(message)
})
lines.on('close', () => {
  for (const job of inFlight.values()) job.controller?.abort()
})
