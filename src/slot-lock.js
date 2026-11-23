import { createHash, randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { AgentError } from './context.js'
import { canonicalPath } from './current.js'
import { readJson, writeJson } from './store.js'

const statePath = (ctx, slot) => join(ctx.agentHome, 'slot-locks', createHash('sha256').update(canonicalPath(slot.path)).digest('hex'))
export const slotGeneration = (ctx, slot) => readJson(`${statePath(ctx, slot)}.json`, {}).generation ?? null
export const advanceSlotGeneration = (ctx, slot) => writeJson(`${statePath(ctx, slot)}.json`, { generation: randomUUID() })

/** Fail closed on contention, including abandoned locks. Never steal a lock by PID/age. */
export const withSlotLock = (ctx, slot, action) => {
  const path = `${statePath(ctx, slot)}.lock`
  mkdirSync(join(ctx.agentHome, 'slot-locks'), { recursive: true, mode: 0o700 })
  let fd
  try { fd = openSync(path, 'wx', 0o600) } catch (error) {
    if (error.code === 'EEXIST') throw new AgentError(`Слот занят другой операцией. Блокировка: ${path}; не удаляйте её, пока операция работает`, 9, { slotLocked: true })
    throw error
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, workspace: slot.id }))
    const result = action()
    if (result?.then) return result.finally(() => { closeSync(fd); unlinkSync(path) })
    closeSync(fd); fd = undefined; unlinkSync(path)
    return result
  } catch (error) {
    if (fd !== undefined) { closeSync(fd); unlinkSync(path) }
    throw error
  }
}
