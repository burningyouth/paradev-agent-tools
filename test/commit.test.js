import assert from 'node:assert/strict'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { commitCommand, hunksCommand } from '../src/commit.js'
import { EXIT } from '../src/exit.js'
import { runCommand } from '../src/context.js'
import { fakeContext as baseContext, git, makeRepo, tempDir, writeFiles } from './helpers.js'

// closeCommand проекта запускается по-настоящему
const fakeContext = () => baseContext({ node: (args, opts) => runCommand('node', args, opts) })

const RULES = {
  commit: {
    forbiddenPaths: ['.env*', 'node_modules/**', '**/*.pem'],
    messagePattern: '^(feat|fix|docs|close)\\([^)]+\\): .+',
    closeCommand: 'node close.mjs {task}',
    closeMessage: 'close(change): {task}',
    closeRequires: ['briefs/{task}.md'],
  },
}

const lines = (n, mark = '') => Array.from({ length: n }, (_, i) => `line ${i + 1}${mark}`).join('\n') + '\n'

const setup = () => {
  const repo = makeRepo({
    '.agent-cli.json': JSON.stringify(RULES),
    'a.txt': 'a\n',
    'big.txt': lines(40),
    'src/x.js': 'x\n',
    'briefs/task.md': 'бриф\n',
    // «Скрипт закрытия» проекта: удаляет бриф и индексирует только его
    'close.mjs': "import { rmSync } from 'node:fs'; import { execFileSync } from 'node:child_process';\nconst p = `briefs/${process.argv[2]}.md`; rmSync(p); execFileSync('git', ['add', '--', p])\n",
  })
  writeFiles(repo, { 'a.txt': 'a2\n', 'src/x.js': 'x2\n', 'src/new.js': 'new\n', '.env.local': 'SECRET=1\n' })
  const big = lines(40).split('\n')
  big[1] = 'line 2 FIRST'
  big[20] = 'line 21 SECOND'
  big[37] = 'line 38 THIRD'
  writeFileSync(join(repo, 'big.txt'), big.join('\n'))
  return repo
}

const plan = (repo, commits) => {
  const file = join(tempDir(), 'plan.json')
  writeFileSync(file, JSON.stringify(commits))
  return file
}

const checkError = (fn, re) => assert.throws(fn, (e) => e.code === EXIT.check && re.test(e.message))

test('dry run simulates commits on a temp index and leaves HEAD and index untouched', () => {
  const repo = setup()
  const ctx = fakeContext()
  const head = git(repo, 'rev-parse', 'HEAD')
  const file = plan(repo, [
    { message: 'feat(x): код', paths: ['src'], hunks: [{ path: 'big.txt', include: [1, 3] }] },
    { message: 'fix(x): a', paths: ['a.txt'], hunks: [{ path: 'big.txt', include: 'SECOND' }], closeChange: 'task' },
  ])
  const { data } = commitCommand(ctx, repo, file, { apply: false })
  assert.equal(data.applied, false)
  assert.deepEqual(data.steps[0].files, ['big.txt', 'src/new.js', 'src/x.js'])
  assert.deepEqual(data.steps[1].files, ['a.txt', 'big.txt'])
  assert.equal(data.steps[2].command, 'node close.mjs task')
  assert.equal(data.steps[2].warning, null)
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head)
  assert.equal(git(repo, 'diff', '--cached', '--name-only'), '')
})

test('apply commits exactly the plan, selected hunks and the close commit', () => {
  const repo = setup()
  const file = plan(repo, [
    { message: 'feat(x): код\n\nтело', paths: ['src/x.js', 'src/new.js'], hunks: [{ path: 'big.txt', include: ['FIRST', 'THIRD'] }] },
    { message: 'fix(x): a', paths: ['a.txt'], closeChange: 'task' },
  ])
  const { data } = commitCommand(fakeContext(), repo, file, { apply: true })
  assert.equal(data.steps.length, 3)
  assert.equal(git(repo, 'log', '--format=%s', '-3'), 'close(change): task\nfix(x): a\nfeat(x): код')
  assert.equal(git(repo, 'show', '--format=', '--name-only', 'HEAD~2'), 'big.txt\nsrc/new.js\nsrc/x.js')
  assert.match(git(repo, 'diff', '--', 'big.txt'), /SECOND/, 'невыбранный ханк остался в рабочей копии')
  assert.doesNotMatch(git(repo, 'diff', '--', 'big.txt'), /FIRST|THIRD/)
  assert.equal(git(repo, 'show', '--format=', '--name-status', 'HEAD'), 'D\tbriefs/task.md')
  assert.ok(existsSync(join(repo, '.env.local')), 'чужое не тронуто')
})

test('refuses when something is already staged', () => {
  const repo = setup()
  git(repo, 'add', 'a.txt')
  checkError(() => commitCommand(fakeContext(), repo, plan(repo, [{ message: 'fix(x): y', paths: ['src/x.js'] }]), {}), /уже есть изменения[\s\S]*\na\.txt/)
})

test('rejects forbidden paths, bad messages, unchanged paths and unknown fields', () => {
  const repo = setup()
  const ctx = fakeContext()
  checkError(() => commitCommand(ctx, repo, plan(repo, [{ message: 'feat(x): y', paths: ['.env.local'] }]), {}), /запрещённые пути.*\.env\.local/)
  checkError(() => commitCommand(ctx, repo, plan(repo, [{ message: 'обновил всё', paths: ['a.txt'] }]), {}), /messagePattern/)
  checkError(() => commitCommand(ctx, repo, plan(repo, [{ message: 'feat(x): y', paths: ['a.txt', 'close.mjs'] }]), {}), /без изменений: close\.mjs/)
  checkError(() => commitCommand(ctx, repo, plan(repo, [{ message: 'feat(x): y', path: ['a.txt'] }]), {}), /неизвестные поля path/)
  assert.throws(() => commitCommand(ctx, repo, plan(repo, [{ message: 'feat(x): y', hunks: [{ path: 'big.txt', include: [9] }] }]), {}), /нет ханков 9/)
  assert.throws(() => commitCommand(ctx, repo, plan(repo, [{ message: 'feat(x): y', hunks: [{ path: 'big.txt', include: 'NOPE' }] }]), {}), /ни один ханк/)
})

test('close step warns in dry run when the brief is missing', () => {
  const repo = setup()
  rmSync(join(repo, 'briefs/task.md'))
  const { data } = commitCommand(fakeContext(), repo, plan(repo, [{ closeChange: 'task' }]), {})
  assert.match(data.steps[0].warning, /briefs\/task\.md/)
})

test('closeMessageFrom takes the close commit message from the close command output', () => {
  const repo = setup()
  const rules = { commit: { ...RULES.commit, closeMessage: undefined, closeMessageFrom: 'Сообщение коммита: (.+)' } }
  writeFiles(repo, {
    '.agent-cli.json': JSON.stringify(rules),
    'close.mjs': "import { rmSync } from 'node:fs'; import { execFileSync } from 'node:child_process';\nconst p = `briefs/${process.argv[2]}.md`; rmSync(p); execFileSync('git', ['add', '--', p]); console.log('✅ Сообщение коммита: close(change): ' + process.argv[2])\n",
  })
  git(repo, 'commit', '-qam', 'rules')
  const dry = commitCommand(fakeContext(), repo, plan(repo, [{ closeChange: 'task' }]), {})
  assert.match(dry.data.steps[0].message, /из вывода: node close\.mjs task/)
  const { data } = commitCommand(fakeContext(), repo, plan(repo, [{ closeChange: 'task' }]), { apply: true })
  assert.equal(data.steps[0].message, 'close(change): task')
  assert.equal(git(repo, 'log', '-1', '--format=%s'), 'close(change): task')
})

test('works in a repository without commits yet', () => {
  const repo = tempDir('agent-unborn-')
  git(repo, 'init', '-q', '-b', 'main')
  writeFiles(repo, { 'a.txt': 'a\n', 'b/c.txt': 'c\n', 'skip.txt': 's\n' })
  const file = plan(repo, [{ message: 'feat: начало', paths: ['a.txt', 'b'] }])
  assert.deepEqual(commitCommand(fakeContext(), repo, file, {}).data.steps[0].files, ['a.txt', 'b/c.txt'])
  commitCommand(fakeContext(), repo, file, { apply: true })
  assert.equal(git(repo, 'show', '--format=%s', '--name-only', 'HEAD'), 'feat: начало\n\na.txt\nb/c.txt')
  assert.equal(git(repo, 'status', '--porcelain'), '?? skip.txt')
})

test('hunks lists numbered hunks', () => {
  const repo = setup()
  const { data, text } = hunksCommand(fakeContext(), repo, ['big.txt', 'close.mjs'])
  assert.equal(data[0].hunks.length, 3)
  assert.match(text, /-- ханк 2\n@@[^\n]*\n[\s\S]*SECOND/)
  assert.match(text, /== close\.mjs\n\(нет изменений\)/)
})
