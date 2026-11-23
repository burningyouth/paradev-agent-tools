import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Plugin, Skill } from '@opencode/plugin'

const id = 'multi-agent-mcp'
const launcher = fileURLToPath(new URL('./plugins/paradev-agent-tools/launch', import.meta.url))
const skillPath = fileURLToPath(new URL('./plugins/paradev-agent-tools/skills/multi-agent-mcp/SKILL.md', import.meta.url))

export default Plugin.define({
  id: 'paradev-agent-tools',
  async setup(ctx) {
    const legacyLauncher = join(homedir(), '.codex', 'plugins', id, 'launch')
    await ctx.mcp.transform((editor) => {
      const existing = editor.get(id)
      // Reuse the archive's server entry at runtime and keep its user options.
      if (existing && (existing.type !== 'local' || existing.command?.length !== 1 || existing.command[0] !== legacyLauncher)) return
      editor.set(id, {
        type: 'local', timeout: { execution: 180000 }, ...existing,
        command: ['/bin/sh', launcher],
      })
    })

    const content = readFileSync(skillPath, 'utf8')
    await ctx.skill.transform((editor) => {
      if (editor.get(id)) return
      editor.add({
        id: Skill.ID.make(id),
        name: Skill.Name.make(id),
        description: content.match(/^description: (.+)$/m)[1],
        path: Skill.Info.fields.path.make(skillPath),
        content,
      })
    })
  },
})
