import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const id = '@PLUGIN_NAME@'
const root = fileURLToPath(new URL('./plugins/@PLUGIN_NAME@', import.meta.url))
const configPath = join(root, 'mcp.json')
const skillsPath = join(root, 'skills')
const expand = (value) => value.replaceAll('${PLUGIN_ROOT}', () => root)
const expandValues = (values = {}) => Object.fromEntries(
  Object.entries(values).map(([key, value]) => [key, expand(value)]),
)

const openCodeServer = (server) => {
  switch (server.type) {
    case 'stdio': {
      const cwd = server.cwd ? resolve(root, expand(server.cwd)) : root
      const command = server.command.startsWith('./') ? resolve(root, server.command) : server.command
      return {
        type: 'local',
        command: [command, ...(server.args ?? []).map(expand)],
        cwd,
        environment: { ...expandValues(server.env), PLUGIN_ROOT: root },
      }
    }
    case 'streamable-http':
      return { type: 'remote', url: server.url, ...(server.headers && { headers: server.headers }) }
    default:
      throw new Error(`Unsupported MCP transport: ${server.type}`)
  }
}

// OpenCode's Promise plugin loader accepts the definition directly.
export default {
  id,
  async setup(ctx) {
    if (existsSync(configPath)) {
      const { mcpServers } = JSON.parse(readFileSync(configPath, 'utf8'))
      await ctx.mcp.transform((editor) => {
        for (const [name, server] of Object.entries(mcpServers)) {
          if (!editor.get(name)) editor.set(name, openCodeServer(server))
        }
      })
    }

    if (existsSync(skillsPath)) {
      await ctx.skill.transform((editor) => {
        for (const entry of readdirSync(skillsPath, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue
          const path = join(skillsPath, entry.name, 'SKILL.md')
          if (!existsSync(path) || editor.get(entry.name)) continue
          const markdown = readFileSync(path, 'utf8')
          const header = markdown.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
          editor.add({
            id: entry.name,
            name: entry.name,
            description: header?.[1].match(/^description: (.+)$/m)?.[1] ?? '',
            path,
            content: header ? markdown.slice(header[0].length).trimStart() : markdown,
          })
        }
      })
    }
  },
}
