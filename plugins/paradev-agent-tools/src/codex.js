import { closeSync, openSync, readSync } from 'node:fs'
import { basename } from 'node:path'

const readMeta = (fd) => {
  const chunks = []
  for (;;) {
    const buffer = Buffer.alloc(64 * 1024)
    const size = readSync(fd, buffer, 0, buffer.length, null)
    const newline = buffer.subarray(0, size).indexOf(10)
    chunks.push(buffer.subarray(0, newline < 0 ? size : newline))
    if (newline >= 0 || !size) return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
}

/** Codex не пишет sessions/<pid>.json. Открытый rollout связывает PID с сессией без
 * эвристики «последний файл в cwd», которая путает одновременные сессии. lsof — системный macOS. */
export const codexSession = (ctx, pid) => {
  const result = ctx.run('lsof', ['-a', '-p', String(pid), '-Fn'])
  const files = [...new Set(result.stdout.split('\n').filter((s) => s.startsWith('n')).map((s) => s.slice(1)))]
  const sessions = files.filter((path) => /^rollout-.*\.jsonl$/.test(basename(path))).flatMap((path) => {
    let fd
    try {
      fd = openSync(path, 'r')
      const rec = readMeta(fd)
      const meta = rec.payload
      if (rec.type !== 'session_meta' || !meta?.id || !meta.cwd || meta.source?.subagent) return []
      return [{ sessionId: meta.id, cwd: meta.cwd, journal: path }]
    } catch {
      // Процесс мог закрыть/сменить файл между ps, lsof и чтением.
      return []
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  })
  return sessions.length === 1 ? sessions[0] : { sessionId: null, cwd: null, journal: null }
}

const contentText = (content) => (content ?? [])
  .filter((b) => b.type === 'input_text' || b.type === 'output_text' || b.type === 'text')
  .map((b) => b.text).join('\n')

/** Нормализуем rollout в общий формат журнала. Якорь — физический номер строки:
 * у старых rollout нет uuid/id, timestamp может совпадать у нескольких записей. */
export const normalizeCodex = (records) => {
  const out = []
  const sessionId = records.find(({ rec }) => rec.type === 'session_meta')?.rec.payload?.id
  for (const { rec, line } of records) {
    const p = rec.payload ?? {}
    const uuid = `codex:${sessionId}:${line}`
    const base = { uuid, timestamp: rec.timestamp }
    const message = (role, text, extra = {}) => ({ ...base, type: role, message: { id: uuid, content: text }, ...extra })
    if (rec.type === 'response_item' && p.type === 'message') {
      if (p.role !== 'user' && p.role !== 'assistant') continue
      if (p.role === 'assistant' && p.channel === 'analysis') continue
      const text = contentText(p.content)
      // В event_msg и response_item бывает один и тот же ответ; оставляем полноценный response_item.
      if (p.role === 'assistant' && out.at(-1)?.codexEvent && out.at(-1)?.message.content === text) out.pop()
      out.push(message(p.role, text))
    } else if (rec.type === 'event_msg') {
      if (p.type === 'user_message') out.push(message('user', p.message ?? ''))
      else if (p.type === 'agent_message') out.push(message('assistant', p.message ?? '', { codexEvent: true }))
      else if (['task_complete', 'turn_complete', 'turn_aborted'].includes(p.type)) {
        out.push({ ...base, type: 'system', subtype: 'turn_duration' })
      } else if (['task_started', 'turn_started'].includes(p.type)) {
        out.push({ ...base, type: 'system', subtype: 'turn_started' })
      } else if (p.type === 'error' && !p.will_retry) {
        out.push(message('assistant', p.message ?? p.error?.message ?? 'ошибка API', { isApiErrorMessage: true }))
      }
    } else if (rec.type === 'response_item' && /(?:tool|function)_call(?:_output)?$/.test(p.type ?? '')) {
      out.push(message('assistant', '')) // активность инструмента, но не текст ответа
    }
  }
  return out
}
