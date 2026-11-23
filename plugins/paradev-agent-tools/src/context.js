import { spawn, spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Ошибка, понятная человеку: печатается без стека, `code` — код выхода процесса. */
export class AgentError extends Error {
  constructor(message, code = 1, details = undefined) {
    super(message)
    this.code = code
    this.details = details
  }
}

/** Запуск внешней команды без оболочки: аргументы не интерпретируются shell. */
export const runCommand = (cmd, args = [], opts = {}) => {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    input: opts.input,
    timeout: opts.timeout,
  })
  if (result.error && result.error.code === 'ENOENT') {
    throw new AgentError(`Команда не найдена: ${cmd}`)
  }
  if (result.error?.code === 'ETIMEDOUT') {
    return { status: 124, stdout: result.stdout ?? '', stderr: `не завершилась за ${opts.timeout / 1000} с`, timedOut: true }
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/**
 * Всё, что команды берут из окружения, — через контекст: тесты подменяют запуск команд, время и пути.
 */
export const createContext = (overrides = {}) => {
  const env = overrides.env ?? process.env
  const home = env.HOME ?? homedir()
  return {
    env,
    run: runCommand,
    spawn,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    agentHome: env.AGENT_CLI_HOME ?? join(home, '.agent-cli'),
    claudeHome: env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'),
    codexHome: env.CODEX_HOME ?? join(home, '.codex'),
    cwd: process.cwd(),
    log: (line) => process.stderr.write(`${line}\n`),
    ...overrides,
  }
}

/** Запуск с проверкой кода выхода: ненулевой код → AgentError с выводом команды. */
export const mustRun = (ctx, cmd, args, opts = {}) => {
  const result = ctx.run(cmd, args, opts)
  if (result.status !== 0) {
    const output = (result.stderr || result.stdout).trim()
    throw new AgentError(`${opts.what ?? `${cmd} ${args.join(' ')}`}: код ${result.status}${output ? `\n${output}` : ''}`)
  }
  return result.stdout
}
