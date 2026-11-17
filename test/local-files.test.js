import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { localEntries, mergeSections, sectionHashes, splitSections } from '../src/local-files.js'
import { sessClose } from '../src/sess-registry.js'
import { addOrigin, makeRepo, tempDir, writeFiles } from './helpers.js'
import { TERM, makeWorld } from './world.js'

test('sections: headings of any level, not inside code fences; repeated headings get a suffix', () => {
  const text = 'вступление\n# A\n\n```sh\n# не заголовок\n```\n## B\nb\n## B\nb2\n'
  assert.deepEqual(splitSections(text).map((s) => s.key), ['', '# A', '## B', '## B #2'])
  assert.equal(splitSections(text).map((s) => s.text).join(''), text)
})

test('merge inserts a new section after its predecessor and does not bring back a section deleted in the target', () => {
  const merged = mergeSections('## A\na\n\n## C\nc\n', '## A\na\n\n## B\nb\n\n## C\nc\n')
  assert.equal(merged.text, '## A\na\n\n## B\nb\n\n## C\nc\n')
  assert.deepEqual(merged.added, ['## B'])

  const source = '## A\na\n\n## B\nb\n'
  assert.deepEqual(mergeSections('## A\na\n', source, sectionHashes(source)).added, [], 'B был в базе и не менялся — удалён в цели')
  assert.deepEqual(mergeSections('## A\na\n', source.replace('b\n', 'b2\n'), sectionHashes(source)).added, ['## B'], 'B изменился в источнике')
})

test('localFiles must be relative paths inside the repository', () => {
  assert.deepEqual(localEntries({ slot: { localFiles: ['.ai/learnings/local/', 'x.md'] } }), ['.ai/learnings/local', 'x.md'])
  for (const bad of ['/etc/x', '../x', 'a/../../x', '.']) assert.throws(() => localEntries({ slot: { localFiles: [bad] } }), /относительный путь/)
})

test('sess close of the last session in a slot moves its local files to the main checkout', async () => {
  const main = tempDir('main-')
  writeFiles(main, { '.agent-cli.json': JSON.stringify({ slot: { localFiles: ['.ai/local/rules.md'] } }), '.ai/local/rules.md': '## A\na\n' })
  const repo = makeRepo({ 'a.txt': 'a\n' }); addOrigin(repo)
  writeFileSync(join(repo, '.git/info/exclude'), '.ai/\n')
  writeFiles(repo, { '.ai/local/rules.md': '## A\na\n\n## B\nиз слота\n' })
  const { ctx, config, world } = makeWorld({ cwd: repo, name: 'slot-1 · task-x', main })
  world.procs = world.procs.filter(([pid]) => pid !== 202)
  const { data, text } = await sessClose(ctx, config, TERM, {})
  assert.deepEqual(world.renamed, ['slot-1'])
  assert.equal(readFileSync(join(main, '.ai/local/rules.md'), 'utf8'), '## A\na\n\n## B\nиз слота\n')
  assert.deepEqual(data.localFiles.runs[0].items[0].added, ['## B'])
  assert.match(text, /слот → основная копия:\n.*~ \.ai\/local\/rules\.md — \+ разделы: ## B/)
})
