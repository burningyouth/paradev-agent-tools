import { readFileSync } from 'node:fs'

import { AgentError } from './context.js'
import { EXIT } from './exit.js'

/**
 * План коммитов (JSON Schema — README, «Формат плана»): массив или `{ "commits": [...] }`.
 * Каждый элемент: `message`, `paths[]`, `hunks[]` ({path, include}), `closeChange`.
 */
export const readPlan = (file) => {
  let data
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new AgentError(`План ${file} не читается как JSON: ${error.message}`)
  }
  const commits = Array.isArray(data) ? data : data?.commits
  if (!Array.isArray(commits) || !commits.length) throw new AgentError('План — непустой массив коммитов или { "commits": [...] }')
  return commits.map((entry, i) => validateEntry(entry, i + 1))
}

const isStringArray = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string' && s.length > 0)

const validateEntry = (entry, n) => {
  const fail = (msg) => {
    throw new AgentError(`Коммит ${n}: ${msg}`, EXIT.check)
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('ожидается объект')
  const known = ['message', 'paths', 'hunks', 'closeChange']
  const extra = Object.keys(entry).filter((k) => !known.includes(k))
  if (extra.length) fail(`неизвестные поля ${extra.join(', ')}`)
  const paths = entry.paths ?? []
  const hunks = entry.hunks ?? []
  if (entry.paths !== undefined && !isStringArray(entry.paths)) fail('paths — массив непустых строк')
  if (!Array.isArray(hunks)) fail('hunks — массив')
  for (const h of hunks) {
    if (typeof h?.path !== 'string' || h.include === undefined) fail('каждый элемент hunks — { path, include }')
    if (paths.includes(h.path)) fail(`${h.path} есть и в paths, и в hunks`)
  }
  const hasContent = paths.length > 0 || hunks.length > 0
  if (hasContent && (typeof entry.message !== 'string' || !entry.message.trim())) fail('нужно message')
  if (!hasContent && !entry.closeChange) fail('нет ни paths, ни hunks, ни closeChange')
  if (entry.closeChange !== undefined && (typeof entry.closeChange !== 'string' || !/^[\w./-]+$/.test(entry.closeChange))) {
    fail('closeChange — имя задачи: латиница, цифры, . / _ -')
  }
  return { message: entry.message?.trim() ?? null, paths: [...paths], hunks, closeChange: entry.closeChange ?? null }
}
