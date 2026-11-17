import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { AgentError } from './context.js'
import { writeJson } from './store.js'

/** Один detached worker для close и finish; жизненный цикл задания задаёт вызывающая команда. */
export const spawnSessionWorker = async (ctx, resultFile) => {
  const child = ctx.spawn(process.execPath, [fileURLToPath(new URL('./session-worker.js', import.meta.url)), resultFile], {
    cwd: ctx.agentHome, env: ctx.env, detached: true, stdio: 'ignore',
  })
  await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('spawn', resolve)
  })
  child.unref()
}

/** Отдельная process group и закрытые stdio позволяют дожить до конца после закрытия панели. */
export const queueSelfClose = async (ctx, config, session, opts) => {
  const resultFile = join(ctx.agentHome, 'close-jobs', `${randomUUID()}.json`)
  const target = { kind: session.kind, sessionId: session.sessionId, terminal: session.terminal, workspace: session.workspace }
  const job = {
    status: 'queued', callerPid: process.pid, target, config, options: { note: opts.note, reason: opts.reason, force: Boolean(opts.force), offline: opts.offline },
    context: { cwd: ctx.cwd, agentHome: ctx.agentHome, codexHome: ctx.codexHome, claudeHome: ctx.claudeHome },
  }
  writeJson(resultFile, job)
  try {
    await spawnSessionWorker(ctx, resultFile)
  } catch (error) {
    writeJson(resultFile, { status: 'error', target, error: error.message, code: 1 })
    throw new AgentError(`Не удалось запустить закрытие: ${error.message}. Результат: ${resultFile}`)
  }
  return {
    data: { ...target, status: 'queued', resultFile },
    text: `Закрытие сессии ${session.sessionId} запущено отдельным процессом. Результат: ${resultFile}`,
  }
}
