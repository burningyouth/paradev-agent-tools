import { readFileSync } from 'node:fs'

import { readChat } from './chat.js'
import { AgentError } from './context.js'
import { canonicalPath } from './current.js'
import { projectRules } from './slot-names.js'
import { analyzeAfter, lastPromptIndex } from './journal.js'
import { assertFinishOwnership, digest, promptFingerprint } from './finish.js'
import { nativeSlotProcesses } from './finish-native.js'
import { gitClient } from './git.js'
import { closeResolvedSession } from './sess-registry.js'
import { findSlot, releaseSlotLocked } from './slot.js'
import { advanceSlotGeneration, withSlotLock } from './slot-lock.js'
import { slotBase } from './slot-names.js'
import { listSessions } from './sessions.js'
import { writeJson } from './store.js'
import { superset } from './superset.js'

const targetChat = (api, job) => {
  const rows = api.chatList(job.target.workspace).filter((s) => s.sessionId === job.target.sessionId)
  if (rows.length !== 1 || !rows[0].live || (rows[0].terminalId ?? rows[0].sessionId) !== job.target.terminal ||
      (rows[0].harnessSessionId ?? null) !== job.target.nativeSessionId) throw new AgentError('Вызывающий chat исчез или сменил идентичность — ничего не закрыто', 9)
  return rows[0]
}
const unchangedPrompt = (chat, job) => {
  if (promptFingerprint(chat.records) !== job.prompts) throw new AgentError('После finish пришло новое сообщение — закрытие отменено', 9)
}

/** Bounded detached transaction. Every irreversible phase has a durable checkpoint. */
export const runFinishJob = async (baseCtx, job, resultFile, { deliveryMs = 600_000, exitMs = 90_000 } = {}) => {
  const deadline = Date.parse(job.createdAt) + 1_200_000
  const rawRun = baseCtx.run
  const ctx = { ...baseCtx, run: (cmd, args, opts = {}) => {
    if (baseCtx.now() >= deadline) throw new AgentError('Истёк общий срок finish', 2)
    const result = rawRun(cmd, args, { ...opts, timeout: Math.max(1, Math.min(opts.timeout ?? 300_000, deadline - baseCtx.now())) })
    if (cmd === 'ps' && args[0] === '-axo' && result.status !== 0) throw new AgentError('Не удалось проверить native-процессы', 9)
    return result
  } }
  const api = superset(ctx, job.config)
  const save = () => writeJson(resultFile, job)
  const ownedSlot = () => {
    const slot = findSlot(ctx, job.config, job.owner.workspace)
    assertFinishOwnership(ctx, slot, job.owner)
    return slot
  }
  try {
    if (digest(readFileSync(job.summaryFile, 'utf8')) !== job.summaryHash) throw new AgentError('Сохранённый итог изменился — чат оставлен открытым', 9)
    job.status = 'waiting_reply'; save()
    const deliveryDeadline = Math.min(deadline, ctx.now() + deliveryMs)
    while (true) {
      if (ctx.now() >= deliveryDeadline) throw new AgentError('Нет подтверждённого финального ответа с receipt — чат оставлен открытым', 2)
      ownedSlot()
      const current = targetChat(api, job)
      const chat = readChat(api, job.target, { deadline: deliveryDeadline, now: ctx.now })
      unchangedPrompt(chat, job)
      const analysis = analyzeAfter(chat.records, lastPromptIndex(chat.records))
      const completed = chat.records.findLast((r) => r.subtype === 'turn_duration')?.turnStatus === 'completed'
      if (analysis.apiError) throw new AgentError('Ошибка финального ответа — чат оставлен открытым', 5)
      if (chat.waiting || chat.state === 'waiting' || current.status === 'awaiting_input') throw new AgentError('Сессия ждёт решения — закрытие отменено', 3)
      if (completed && analysis.turnEnded && analysis.answer?.text.includes(job.receipt) && chat.state === 'idle' && current.status === 'idle') break
      if (ctx.now() >= deliveryDeadline) throw new AgentError('Нет подтверждённого финального ответа с receipt — чат оставлен открытым', 2)
      await ctx.sleep(1000)
    }
    await withSlotLock(ctx, ownedSlot(), async () => {
      const slot = ownedSlot()
      const current = targetChat(api, job)
      const chat = readChat(api, job.target, { deadline, now: ctx.now })
      unchangedPrompt(chat, job)
      const analysis = analyzeAfter(chat.records, lastPromptIndex(chat.records))
      if (current.status !== 'idle' || chat.state !== 'idle' || chat.waiting || !analysis.turnEnded || !analysis.answer?.text.includes(job.receipt)) {
        throw new AgentError('Сессия снова активна — закрытие отменено', 9)
      }
      if (gitClient(ctx, slot.path).status().length) throw new AgentError('Слот грязный — чат оставлен открытым', 9)
      job.status = 'closing'; job.delivery = { status: 'confirmed', at: new Date(ctx.now()).toISOString(), answer: analysis.answer.text }; save()
      const session = listSessions(ctx, job.config, api).find((s) => s.kind === 'chat' && s.sessionId === job.target.sessionId && s.workspace === job.target.workspace)
      if (!session || session.state !== 'idle' || session.terminal !== job.target.terminal || (session.nativeSessionId ?? null) !== job.target.nativeSessionId) throw new AgentError('Сессия снова активна или исчезла — закрытие отменено', 9)
      job.close = { status: 'requested' }; save()
      await closeResolvedSession(ctx, job.config, session, { finish: true, note: `Итог: ${job.summaryFile}` }, api)
      const exitDeadline = Math.min(deadline, ctx.now() + exitMs)
      while (true) {
        ownedSlot()
        const chats = api.chatList(job.target.workspace)
        const targetLive = chats.some((s) => s.live && s.sessionId === job.target.sessionId)
        const native = nativeSlotProcesses(ctx, slot, job.target)
        if (!targetLive && !native.some((p) => p.own)) break
        if (ctx.now() >= exitDeadline) throw new AgentError('Chat/native-процессы не завершились в срок — слот не освобождён', 2)
        await ctx.sleep(1000)
      }
      job.close = { status: 'closed', at: new Date(ctx.now()).toISOString() }; job.status = 'releasing'; save()
      const fresh = ownedSlot()
      if (fresh.sessions.length || nativeSlotProcesses(ctx, fresh, job.target).length) throw new AgentError('В слоте осталась другая активная сессия — слот не освобождён', 9)
      if (gitClient(ctx, fresh.path).status().length) throw new AgentError('Слот грязный — слот не освобождён', 9)
      advanceSlotGeneration(ctx, fresh)
      job.release = { status: 'requested' }; save()
      // Exactly one release path: project hook OR built-in; never both.
      job.release.result = releaseSlotLocked(ctx, job.config, fresh.id, { finishDetached: !job.owner.branch }).data
      const after = findSlot(ctx, job.config, fresh.id)
      const g = gitClient(ctx, fresh.path)
      if (after.name !== slotBase(job.owner.name) || after.path !== fresh.path || after.project !== fresh.project || canonicalPath(after.mainCheckout) !== job.owner.mainCheckout ||
          canonicalPath(g.git(['rev-parse', '--absolute-git-dir']).trim()) !== job.owner.gitDir || digest(projectRules(after)) !== job.owner.rules || after.sessions.length ||
          nativeSlotProcesses(ctx, after, job.target).length || g.branch() || g.status().length ||
          job.owner.branch && g.git(['rev-parse', `refs/heads/${job.owner.branch}`]).trim() !== job.owner.head) {
        throw new AgentError('Release вернулся, но Git/Superset postconditions не выполнены', 9)
      }
      job.release.status = 'released'
      job.release.verified = { name: after.name, head: g.head(), detached: true, clean: true, sessions: 0 }
      const files = job.release.result.localFiles
      if (files?.error || files?.conflicts?.length) throw new AgentError('Слот освобождён, но перенос локальных файлов требует разбора; см. release.result.localFiles', 9)
      job.status = 'completed'; job.code = 0; save()
    })
  } catch (error) {
    job.status = error.code === 1 ? 'error' : 'blocked'
    job.error = error.message; job.code = error.code ?? 1
    if (job.release.status === 'pending') job.release.status = 'blocked'
    save()
  }
  job.finishedAt = new Date(ctx.now()).toISOString(); save()
  // No task names, paths, raw errors or customer data in system banners.
  const base = slotBase(job.owner.name)
  try {
    const title = job.status === 'completed' ? `Слот ${base} освобождён` : `Не удалось завершить ${base}`
    const reason = /другая активная/.test(job.error) ? 'В слоте осталась другая активная сессия' : /грязный/.test(job.error) ? 'В слоте незакоммиченные файлы' : /Принадлежность|новое сообщение|идентичность/.test(job.error) ? 'Задача или сессия изменилась' : /финального ответа|финальный ответ/.test(job.error) ? 'Финальный ответ не подтверждён' : /native/.test(job.error) ? 'Native-процессы не завершились' : /superset/.test(job.error) ? 'Superset недоступен или вернул ошибку' : 'Подробности в журнале agent-cli'
    const body = job.status === 'completed' ? 'Чат закрыт, слот готов к следующей задаче' :
      `${job.close.status === 'closed' ? 'Чат закрыт. ' : ''}${reason}`
    const sent = rawRun(job.config.superset, ['notifications', 'show', title, '--body', body, '--workspace', job.owner.workspace, '--json'], { timeout: 10_000, env: { SUPERSET_TERMINAL_ID: '' } })
    job.notification = sent.status === 0 ? { status: 'accepted' } : { status: 'error', error: (sent.stderr || sent.stdout).slice(0, 1000) }
  } catch (error) { job.notification = { status: 'error', error: error.message } }
  save()
  return job
}
