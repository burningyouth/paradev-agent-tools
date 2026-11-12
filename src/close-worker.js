import { createContext, AgentError } from './context.js'
import { closeResolvedSession } from './sess-registry.js'
import { resolveSession } from './sessions.js'
import { readJson, writeJson } from './store.js'

const resultFile = process.argv[2]
const job = readJson(resultFile, null)
if (!job || job.status !== 'queued') throw new Error('Нет задания на закрытие сессии')
const ctx = createContext(job.context)
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
  writeJson(resultFile, { status: 'closed', ...result })
} catch (error) {
  writeJson(resultFile, { status: 'error', target: job.target, error: error.message, code: error.code ?? 1 })
  process.exitCode = error.code ?? 1
}
