import { AgentError } from './context.js'

/** Superset 2.0.2 validates plain model IDs; its chat CLI exposes no effort option. */
export const chatModel = ({ model, effort }) => {
  if (effort) throw new AgentError('Superset 2.0.2 sessions create не поддерживает --effort (model[effort] тоже отвергается). Опустите --effort для настройки пресета или используйте --cli')
  return model
}

const anchor = (id, cursor) => `chat:${id}:${cursor.epoch}:${cursor.seq}`

/** Fetch all pages: --before is an opaque Superset cursor. Items are upserts, not text deltas. */
export const readChat = (api, session, { deadline, now = Date.now } = {}) => {
  const envelopes = []
  const seen = new Set()
  let before
  do {
    const timeout = deadline === undefined ? undefined : Math.max(1, deadline - now())
    if (deadline !== undefined && now() >= deadline) throw new AgentError('Истёк срок чтения chat-журнала')
    const page = api.chatRead(session.workspace, session.sessionId, before, timeout)
    if (!page.ok || !Array.isArray(page.envelopes)) throw new AgentError('superset sessions read: некорректный ответ журнала')
    envelopes.unshift(...page.envelopes)
    before = page.nextBefore
    if (before && seen.has(before)) throw new AgentError('superset sessions read: повтор курсора пагинации')
    if (before) seen.add(before)
  } while (before)
  const items = new Map()
  const records = []
  let state = 'unknown'
  let waiting = null
  for (const envelope of envelopes) {
    const { event, cursor, ts } = envelope
    if (!event || !cursor) throw new AgentError('superset sessions read: ожидалось событие с курсором')
    const base = { uuid: anchor(session.sessionId, cursor), timestamp: new Date(ts).toISOString() }
    if (event.type === 'item') {
      const item = event.item
      const prior = items.get(item.id)
      if (prior) { prior.item = item; continue }
      const entry = { ...base, item }
      items.set(item.id, entry)
      records.push(entry)
    } else if (event.type === 'turn') {
      const status = event.turn.status
      if (status === 'running') {
        state = 'working'
        records.push({ ...base, type: 'system', subtype: 'turn_started' })
      } else if (['completed', 'interrupted', 'failed'].includes(status)) {
        state = 'idle'
        if (status === 'failed') records.push({ ...base, type: 'assistant', isApiErrorMessage: true, message: { content: String(event.turn.error?.message ?? event.turn.error ?? 'Chat turn failed') } })
        records.push({ ...base, type: 'system', subtype: 'turn_duration' })
      }
    } else if (event.type === 'session') {
      const status = event.session.status
      if (['idle', 'not_loaded', 'offline', 'dead'].includes(status)) state = 'idle'
      if (['starting', 'running'].includes(status)) state = 'working'
      if (status === 'awaiting_input') state = 'waiting'
      if (event.session.awaitingBackground) state = 'working'
    }
  }
  const normalized = records.flatMap((rec) => {
    if (!rec.item) return [rec]
    const { item, ...base } = rec
    if (item.parentItemId || item.discarded || item.from === 'parent') return []
    if (item.kind === 'user_message') return [{ ...base, type: item.queued ? 'attachment' : 'user', message: { content: item.content }, ...(item.queued ? { attachment: { type: 'queued_command', commandMode: 'prompt', prompt: item.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n') } } : {}) }]
    if (item.kind === 'agent_message') return [{ ...base, type: 'assistant', message: { id: item.id, content: item.text ?? '' } }]
    if (item.kind === 'notice' && item.noticeKind === 'error') return [{ ...base, type: 'assistant', isApiErrorMessage: true, message: { content: item.message ?? item.text ?? 'Chat error' } }]
    if (item.kind === 'approval_request' && item.status === 'pending') {
      state = 'waiting'
      waiting = { kind: item.form ? 'question' : 'permission', text: [item.title, item.form?.message, ...(item.detail ?? []).filter((p) => p.type === 'text').map((p) => p.text)].filter(Boolean).join('\n'), options: item.options ?? [], ...(item.form ? { form: item.form } : {}) }
    }
    return []
  })
  return { records: normalized, state, waiting }
}
