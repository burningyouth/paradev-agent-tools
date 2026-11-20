import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { readChat } from './chat.js'
import { AgentError } from './context.js'
import { canonicalPath, containsPath } from './current.js'
import { gitClient } from './git.js'
import { lastAnswer, promptText } from './journal.js'
import { findCurrentSlot } from './slot.js'
import { projectRules } from './slot-names.js'
import { slotGeneration, withSlotLock } from './slot-lock.js'
import { listSessions } from './sessions.js'
import { readJson, writeJson } from './store.js'
import { superset } from './superset.js'
import { spawnSessionWorker } from './session-jobs.js'
import { recordSession } from './session-history.js'

export const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const promptFingerprint = (records) => digest(records.flatMap((rec) => {
  const text = promptText(rec)
  return text === null ? [] : [[rec.uuid, text]]
}))
export const finishOwnership = (ctx, slot) => {
  const g = gitClient(ctx, slot.path)
  return { workspace: slot.id, name: slot.name, project: slot.project,
    path: canonicalPath(slot.path), mainCheckout: canonicalPath(slot.mainCheckout),
    gitDir: canonicalPath(g.git(['rev-parse', '--absolute-git-dir']).trim()),
    branch: g.branch(), head: g.head(), generation: slotGeneration(ctx, slot), rules: digest(projectRules(slot)) }
}
export const assertFinishOwnership = (ctx, slot, owner) => {
  if (digest(finishOwnership(ctx, slot)) !== digest(owner)) throw new AgentError('Принадлежность слота изменилась — старая операция отменена', 9)
}

const queuedResult = (job, resultFile) => ({ data: { status: job.status, resultFile, summaryFile: job.summaryFile, receipt: job.receipt,
  close: job.close, release: job.release }, text: `Close: ${job.status}. Итог: ${job.summaryFile}\nРезультат: ${resultFile}\nДобавьте в финальный ответ: ${job.receipt}` })

/** Queue an exact chat. The worker requires a receipt in the target chat before stopping it. */
export const sessFinish = async (baseCtx, config, args, opts, selection) => {
  const deadline = baseCtx.now() + 120_000
  const ctx = { ...baseCtx, run: (cmd, argv, options = {}) => {
    if (baseCtx.now() >= deadline) throw new AgentError('Истёк срок постановки finish в очередь', 2)
    return baseCtx.run(cmd, argv, { ...options, timeout: Math.max(1, Math.min(options.timeout ?? 120_000, deadline - baseCtx.now())) })
  } }
  if (opts.result) {
    if (args.length || Object.keys(opts).some((k) => !['result', 'json'].includes(k))) throw new AgentError('Нужно: agent finish --result F [--json]')
    const file = resolve(ctx.cwd, opts.result)
    const job = readJson(file, null)
    if (!job?.receipt || !job.owner) throw new AgentError('Нет результата finish')
    return { data: job, text: JSON.stringify(job, null, 2) }
  }
  if (args.length || Object.keys(opts).some((k) => !['release-slot', 'summary-file', 'json', 'note', 'reason'].includes(k))) {
    throw new AgentError('Нужно: agent close [--summary-file F] [--json]; --force не поддерживается для собственного chat')
  }
  const slot = selection ? selection.slot : findCurrentSlot(ctx, config)
  const workspacePath = canonicalPath(selection?.ws.worktreePath ?? slot.path)
  if (!containsPath(workspacePath, ctx.cwd) || slot && !slot.mainCheckout) throw new AgentError('Нужен cwd выбранного workspace и известная основная копия для освобождения слота', 9)
  const api = superset(ctx, config)
  let session = selection?.session
  if (!selection) {
    const own = listSessions(ctx, config, api, false, slot.id).filter((s) => s.kind === 'chat' && s.workspace === slot.id && (ctx.env.CODEX_THREAD_ID
      ? s.agent === 'codex' && s.nativeSessionId === ctx.env.CODEX_THREAD_ID
      : ctx.env.SUPERSET_TERMINAL_ID && s.terminal === ctx.env.SUPERSET_TERMINAL_ID))
    if (own.length !== 1) throw new AgentError('Не найден единственный точный вызывающий chat; finish поддерживает только собственный Superset chat', 9)
    session = own[0]
  }
  const chat = readChat(api, session)
  if (session.state === 'waiting' || chat.state === 'waiting' || chat.waiting) throw new AgentError('Сессия ждёт решения — задача не закрыта', 3)
  let summary
  try { summary = opts['summary-file'] ? readFileSync(resolve(ctx.cwd, opts['summary-file']), 'utf8') : opts.note ?? lastAnswer(chat.records)?.text ?? 'Работа приостановлена. Перед продолжением проверь Git и инструкции проекта.' } catch (error) { throw new AgentError(`Не читается итог: ${error.message}`) }
  if (!summary.trim()) throw new AgentError('Итог пуст')
  return withSlotLock(ctx, { id: session.workspace, path: workspacePath }, async () => {
    if (slot && gitClient(ctx, slot.path).status().length) throw new AgentError('Слот грязный — finish оставляет чат открытым', 9)
    const owner = slot ? finishOwnership(ctx, slot) : null
    const target = { kind: 'chat', agent: session.agent, sessionId: session.sessionId, terminal: session.terminal,
      workspace: session.workspace, nativeSessionId: session.nativeSessionId ?? null }
    const prompts = promptFingerprint(chat.records)
    const dir = join(ctx.agentHome, 'finish-jobs', digest(owner ? { owner, target, prompts } : { workspacePath, target, prompts }))
    const resultFile = join(dir, 'result.json')
    const existing = readJson(resultFile, null)
    if (existing) {
      if (existing.summaryHash !== digest(summary)) throw new AgentError(`Finish уже существует с другим итогом: ${resultFile}`, 9)
      return queuedResult(existing, resultFile)
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const summaryFile = join(dir, 'summary.md')
    writeFileSync(summaryFile, summary, { mode: 0o600 })
    recordSession(ctx, session, 'checkpoint', { note: summary.slice(0, 4000), summaryFile, closeReason: opts.reason ?? 'close' })
    const job = { operation: 'finish', status: 'queued', createdAt: new Date(ctx.now()).toISOString(), owner, workspacePath, target, prompts, reason: opts.reason ?? 'close',
      receipt: `[[FINISH-${randomUUID()}]]`, summaryFile, summaryHash: digest(summary), config,
      close: { status: 'pending' }, release: { status: slot ? 'pending' : 'not-applicable' },
      context: { cwd: ctx.cwd, agentHome: ctx.agentHome, codexHome: ctx.codexHome, claudeHome: ctx.claudeHome } }
    writeJson(resultFile, job)
    try {
      await spawnSessionWorker(ctx, resultFile)
    } catch (error) {
      writeJson(resultFile, { ...job, status: 'error', error: error.message, code: 1 })
      throw new AgentError(`Worker не запущен: ${error.message}. Итог сохранён: ${resultFile}`)
    }
    return queuedResult(job, resultFile)
  })
}
