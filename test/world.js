import { appendFileSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { projectDirName } from '../src/journal.js'
import { loadConfig } from '../src/store.js'
import { fakeContext, jsonl } from './helpers.js'

export const TERM = 'aaaaaaaa-1111-4111-8111-111111111111'
export const OTHER = 'bbbbbbbb-2222-4222-8222-222222222222'
export const WS = 'ws-1'
export const CWD = '/Users/me/.superset/worktrees/proj/slot-1'
export const SID = 'sess-1'

/**
 * Мир для тестов sess/gc: процессы Codex/Claude (`procs`: [pid, терминал, session id]), шеллы без агента,
 * панели приложения (у каждого терминала своя `pane-<id>`, плюс `stalePanes` без терминала), экраны.
 * Закрытие панели или терминала убирает терминал и его процесс — как в Superset.
 */
export const makeWorld = ({ project = 'proj', cwd = CWD, name = 'slot-1', main = '/main/checkout' } = {}) => {
  const world = {
    state: 'idle',
    agentStates: {},
    agents: {},
    journals: {},
    status: 'idle',
    sent: [],
    closed: [],
    closedPanes: [],
    created: [],
    procs: [[101, TERM, SID], [202, null, 'sess-outside']],
    parents: {},
    shells: [],
    exited: new Set(),
    screens: {},
    stalePanes: [],
    renamed: [],
    penRunning: false,
    penFiles: [],
  }
  const terminals = () => [
    ...world.procs
      .filter(([pid, t]) => t && !world.parents[pid])
      .map(([pid, t]) => ({ id: t, title: '◑ Моя задача', agent: { id: world.agents[pid] ?? 'claude', state: world.agentStates[t] ?? world.state } })),
    ...world.shells,
  ]
  const endTerminal = (terminal) => {
    world.procs = world.procs.filter(([, t]) => t !== terminal)
    world.shells = world.shells.filter((s) => s.id !== terminal)
  }
  const flag = (args, name) => args[args.indexOf(name) + 1]
  const ctx = fakeContext({
    pgrep: () => ({ status: world.penRunning ? 0 : 1 }),
    // Pen: окна — world.penFiles; File › Save трогает файл окна, quit завершает приложение
    osascript: (args, { input }) => {
      if (input.includes('repeat with w in windows')) return world.penFiles.map((f) => `${basename(f)}\t${pathToFileURL(f)}`).join('\n')
      const saved = world.penFiles.find((f) => input.includes(`click menu item "Save"`) && input.includes(basename(f)))
      if (saved) utimesSync(saved, new Date(), new Date(Date.now() + 5000 + Math.random() * 1000))
      if (input.includes('to quit')) world.penRunning = false
      return ''
    },
    ps: (args) => {
      if (args[0] === '-axo') {
        const lines = world.procs.map(([pid]) => `${pid} ${world.parents[pid] ?? 50} 204800 /opt/homebrew/bin/${world.agents[pid] ?? 'claude'} --model test`)
        return `${lines.join('\n')}\n  999 1 100 /bin/zsh\n`
      }
      // Промпт в аргументах содержит ложный SUPERSET_TERMINAL_ID — брать надо только из окружения
      const command = `claude prompt SUPERSET_TERMINAL_ID=${OTHER}`
      if (args[0] === '-p') return command
      const term = world.procs.find(([pid]) => String(pid) === args[2])?.[1]
      return `${command}${term ? ` HOME=/x SUPERSET_TERMINAL_ID=${term} SUPERSET_WORKSPACE_ID=${WS}` : ' HOME=/x'}`
    },
    lsof: (args) => {
      const path = world.journals[Number(flag(args, '-p'))]
      return path ? `p${flag(args, '-p')}\nfcwd\nn${cwd}\nf12\nn${path}\n` : ''
    },
    superset: (args) => {
      const key = args.slice(0, 2).join(' ')
      if (key === 'snapshot --json') {
        const list = terminals()
        const panes = [...list.map((t) => ({ id: `pane-${t.id}`, kind: 'terminal', terminalId: t.id })), ...world.stalePanes]
        return JSON.stringify({ workspaces: [{ id: WS, name, project, branch: 'b', terminals: list, layout: { tabs: [{ id: 'tab-1', panes }] } }] })
      }
      if (key === 'ws list') return JSON.stringify([{ id: WS, name, projectName: project, worktreePath: cwd }])
      if (key === 'ws update') {
        world.renamed.push(flag(args, '--name'))
        return ''
      }
      if (key === 'projects list') return JSON.stringify([{ name: project, path: main }])
      if (key === 'terminals list') {
        return JSON.stringify({ sessions: terminals().map((t) => ({ terminalId: t.id, exited: world.exited.has(t.id) })) })
      }
      if (key === 'terminals read') return JSON.stringify({ text: world.screens[flag(args, '--terminal')] ?? '' })
      if (key === 'terminals send') {
        if (world.sendHangs) return { status: 124, stderr: 'не завершилась за 20 с', timedOut: true }
        world.sent.push(flag(args, '--text'))
        world.onSend?.(flag(args, '--text'))
        return ''
      }
      if (key === 'terminals close') {
        world.closed.push(flag(args, '--terminal'))
        endTerminal(flag(args, '--terminal'))
        return ''
      }
      if (key === 'panes close') {
        const pane = flag(args, '--pane')
        world.closedPanes.push(pane)
        world.stalePanes = world.stalePanes.filter((p) => p.id !== pane)
        endTerminal(pane.replace(/^pane-/, ''))
        return ''
      }
      if (key === 'agents create') {
        world.created.push(args)
        const sessionId = args.includes('--resume-session') ? flag(args, '--resume-session') : 'sess-new'
        world.procs.push([303, 'cccccccc-3333-4333-8333-333333333333', sessionId])
        const agent = flag(args, '--agent')
        world.agents[303] = agent
        if (agent === 'codex') writeCodex(303, sessionId)
        else writeSessionFile(303, sessionId)
        return JSON.stringify({ sessionId: 'cccccccc-3333-4333-8333-333333333333' })
      }
      throw new Error(`superset ${args.join(' ')}`)
    },
  })
  const dir = join(ctx.claudeHome, 'projects', projectDirName(cwd))
  mkdirSync(dir, { recursive: true })
  const writeSessionFile = (pid, sessionId, status = world.status) => {
    mkdirSync(join(ctx.claudeHome, 'sessions'), { recursive: true })
    writeFileSync(join(ctx.claudeHome, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, cwd, status }))
  }
  const writeCodex = (pid, sessionId) => {
    const root = join(ctx.codexHome, 'sessions', '2026', '10', '23')
    mkdirSync(root, { recursive: true })
    const path = join(root, `rollout-2026-10-23T10-00-00-${sessionId}.jsonl`)
    writeFileSync(path, jsonl([{ type: 'session_meta', payload: { id: sessionId, cwd, source: 'cli' } }]))
    world.journals[pid] = path
    return path
  }
  /** Ещё одна сессия в своём терминале; возвращает путь журнала. */
  world.addSession = (pid, terminal, sessionId, { status = 'idle', state = 'idle', parent, agent = 'claude' } = {}) => {
    world.procs.push([pid, terminal, sessionId])
    world.agents[pid] = agent
    world.agentStates[terminal] = state
    if (parent) world.parents[pid] = parent
    if (agent === 'codex') return writeCodex(pid, sessionId)
    writeSessionFile(pid, sessionId, status)
    const path = join(dir, `${sessionId}.jsonl`)
    writeFileSync(path, '')
    return path
  }
  writeSessionFile(101, SID)
  writeSessionFile(202, 'sess-outside')
  world.journal = join(dir, `${SID}.jsonl`)
  writeFileSync(world.journal, '')
  world.append = (...records) => appendFileSync(world.journal, jsonl(records))
  world.appendTo = (path, ...records) => appendFileSync(path, jsonl(records))
  return { ctx, config: loadConfig(ctx), world }
}

export const at = (ctx, plusSec = 0) => new Date(ctx.now() + plusSec * 1000).toISOString()
export const say = (uuid, ts, text) => ({ type: 'assistant', uuid, timestamp: ts, message: { id: uuid, content: [{ type: 'text', text }] } })
export const prompt = (uuid, ts, text) => ({ type: 'user', uuid, timestamp: ts, message: { role: 'user', content: text } })
export const turnEnd = (uuid, ts) => ({ type: 'system', subtype: 'turn_duration', uuid, timestamp: ts })
