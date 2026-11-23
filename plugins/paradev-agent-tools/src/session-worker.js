import { closeSync, openSync } from 'node:fs'
import { createContext, AgentError } from './context.js'
import { closeResolvedSession } from './sess-registry.js'
import { resolveSession } from './sessions.js'
import { runFinishJob } from './finish-runner.js'
import { runSessionEndJob } from './hooks.js'
import { readJson, writeJson } from './store.js'

const resultFile = process.argv[2]
const job = readJson(resultFile, null)
if (!job || job.status !== 'queued') process.exit(0)
try { closeSync(openSync(`${resultFile}.worker`, 'wx', 0o600)) } catch (error) {
  if (error.code === 'EEXIST') process.exit(0)
  throw error
}
const ctx = createContext(job.context)
if (job.operation === 'session-end') {
  const result = await runSessionEndJob(ctx, job, resultFile)
  process.exitCode = result.code ?? 1
} else if (job.operation === 'finish') {
  const result = await runFinishJob(ctx, job, resultFile)
  process.exitCode = result.code ?? 1
} else {
  try {
    writeJson(resultFile, { status: 'running', target: job.target })
    // Superset может завершать всё дерево потомков терминала, включая detached-процессы.
    // Сначала вызывающий CLI должен выйти: worker перестанет быть потомком сессии.
    const deadline = Date.now() + 10_000
    while (true) {
      try { process.kill(job.callerPid, 0) } catch (error) {
        if (error.code === 'ESRCH') break
        throw error
      }
      if (Date.now() >= deadline) throw new AgentError('Вызывающий CLI не завершился за 10 с — сессия оставлена открытой', 2)
      await ctx.sleep(50)
    }
    const session = resolveSession(ctx, job.config, job.target.sessionId ?? job.target.terminal)
    if (Object.entries(job.target).some(([key, value]) => session[key] !== value)) {
      throw new AgentError('Сессия изменилась после запуска закрытия — ничего не закрыто', 9)
    }
    const result = await closeResolvedSession(ctx, job.config, session, job.options)
    writeJson(resultFile, { status: 'completed', ...result })
  } catch (error) {
    writeJson(resultFile, { ...error.details, status: 'error', target: job.target, error: error.message, code: error.code ?? 1 })
    process.exitCode = error.code ?? 1
  }
}
