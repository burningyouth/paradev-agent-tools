import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { readJson, writeJson } from './store.js'

const file = (ctx, workspace) => join(ctx.agentHome, 'chat-slots',
  createHash('sha256').update(workspace).digest('hex') + '.json')

export const chatSlotState = (ctx, workspace) => readJson(file(ctx, workspace), { active: null, parked: {} })
export const saveChatSlotState = (ctx, workspace, state) => writeJson(file(ctx, workspace), state)

export const sameChat = (owner, row) => Boolean(owner && row &&
  owner.sessionId === row.sessionId && owner.terminal === (row.terminalId ?? row.terminal ?? row.sessionId))
