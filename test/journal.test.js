import assert from 'node:assert/strict'
import test from 'node:test'

import { analyzeAfter, findAccepted, lastAnswer, lastPromptIndex, projectDirName, promptText } from '../src/journal.js'

// Образцы записей — по реальным журналам Claude Code 2.1 (лишние поля убраны).
const t = (sec) => new Date(Date.parse('2026-10-23T10:00:00Z') + sec * 1000).toISOString()
const user = (uuid, sec, content) => ({ type: 'user', uuid, timestamp: t(sec), message: { role: 'user', content } })
const say = (uuid, sec, text, id = uuid) => ({
  type: 'assistant',
  uuid,
  timestamp: t(sec),
  message: { id, role: 'assistant', content: [{ type: 'text', text }] },
})
const tool = (uuid, sec) => ({ type: 'assistant', uuid, timestamp: t(sec), message: { id: uuid, content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }] } })
const toolResult = (uuid, sec) => user(uuid, sec, [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }])
const turnEnd = (uuid, sec, pending = 0) => ({ type: 'system', subtype: 'turn_duration', uuid, timestamp: t(sec), pendingBackgroundAgentCount: pending })
const queued = (uuid, sec, prompt, commandMode = 'prompt') => ({ type: 'attachment', uuid, timestamp: t(sec), attachment: { type: 'queued_command', prompt, commandMode } })

test('projectDirName encodes cwd like Claude Code', () => {
  assert.equal(
    projectDirName('/Users/nikita/.superset/worktrees/sellerai/design-product-all-variants'),
    '-Users-nikita--superset-worktrees-sellerai-design-product-all-variants',
  )
})

test('promptText: typed and queued prompts count, tool results, interrupts and task notifications do not', () => {
  assert.equal(promptText(user('u', 0, 'привет')), 'привет')
  assert.equal(promptText(user('u', 0, [{ type: 'text', text: 'блоком' }])), 'блоком')
  assert.equal(promptText(toolResult('r', 0)), null)
  assert.equal(promptText(user('i', 0, [{ type: 'text', text: '[Request interrupted by user]' }])), null)
  assert.equal(promptText(queued('q', 0, 'в очередь')), 'в очередь')
  assert.equal(promptText(queued('n', 0, '<task-notification>', 'task-notification')), null)
  assert.equal(promptText({ ...user('s', 0, 'подагент'), isSidechain: true }), null)
})

test('findAccepted matches by text start after send time, typed or queued', () => {
  const records = [user('old', 0, 'Задача A'), user('new', 30, 'Задача  A\nс деталями'), queued('q', 40, 'Ещё одно')]
  assert.deepEqual(findAccepted(records, 'Задача A\nс деталями', Date.parse(t(20))), { anchor: 'new', timestamp: t(30), queued: false })
  assert.equal(findAccepted(records, 'Задача A', Date.parse(t(50))), null)
  assert.equal(findAccepted(records, 'Ещё одно', Date.parse(t(35))).queued, true)
})

test('findAccepted sees through the pasted_content wrapper of long pastes', () => {
  const text = 'UIKIT-1104. Длинная задача\nс абзацами'
  const records = [user('paste', 30, `\n\n\n<pasted_content id="7631">\n${text}\n</pasted_content id="7631">\n`)]
  assert.equal(findAccepted(records, text, Date.parse(t(20))).anchor, 'paste')
})

test('marker counts only in assistant text after the anchor', () => {
  const records = [
    user('p1', 0, 'первая задача'),
    say('a1', 5, 'готово [[DONE-X]]'),
    turnEnd('e1', 6),
    user('p2', 10, 'вторая задача, закончи маркером [[DONE-X]]'),
    tool('a2', 12),
    toolResult('r2', 13),
  ]
  const anchor = records.findIndex((r) => r.uuid === 'p2')
  const running = analyzeAfter(records, anchor, 'DONE-X')
  assert.equal(running.markerFound, false, 'маркер в прошлом ответе и в самом запросе не считается')
  assert.equal(running.turnEnded, false)
  const done = analyzeAfter([...records, say('a3', 20, 'Итог\n[[DONE-X]]'), turnEnd('e2', 21)], anchor, 'DONE-X')
  assert.equal(done.markerFound, true)
  assert.equal(done.answer.text, 'Итог\n[[DONE-X]]')
})

test('turn end without marker; background subagents keep the turn open', () => {
  const base = [user('p', 0, 'задача'), say('a', 5, 'вопрос: какой вариант?')]
  assert.equal(analyzeAfter([...base, turnEnd('e', 6)], 0, 'M').turnEnded, true)
  assert.equal(analyzeAfter([...base, turnEnd('e', 6, 1)], 0, 'M').turnEnded, false)
  assert.equal(analyzeAfter([...base, turnEnd('e', 6), queued('q', 7, 'ещё')], 0, 'M').turnEnded, false)
})

test('API error is the last assistant record', () => {
  const error = { ...say('err', 9, 'API Error: 529 Overloaded'), isApiErrorMessage: true }
  const records = [user('p', 0, 'задача'), say('a', 5, 'начинаю'), error, turnEnd('e', 10)]
  assert.equal(analyzeAfter(records, 0, 'M').apiError, 'API Error: 529 Overloaded')
  assert.equal(analyzeAfter([...records, say('b', 20, 'продолжаю')], 0, 'M').apiError, null)
})

test('lastAnswer joins text blocks of the last assistant message; lastPromptIndex', () => {
  const records = [user('p', 0, 'задача'), say('a1', 1, 'промежуточно', 'm1'), say('a2', 2, 'часть 1', 'm2'), tool('t', 3), say('a3', 4, 'часть 2', 'm2')]
  assert.equal(lastAnswer(records).text, 'часть 1\n\nчасть 2')
  assert.equal(lastPromptIndex(records), 0)
})
