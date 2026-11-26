import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Plugin, Skill } from '@opencode/plugin'

const id = 'paradev-agent-tools'
const launcher = fileURLToPath(new URL('./plugins/paradev-agent-tools/launch', import.meta.url))
const skills = [id, 'paradev-agent-update']

export default Plugin.define({
  id,
  async setup(ctx) {
    const archiveLauncher = join(homedir(), '.codex', 'plugins', id, 'launch')
    await ctx.mcp.transform((editor) => {
      const existing = editor.get(id)
      // Reuse the archive's server entry at runtime and keep its user options.
      if (existing && (existing.type !== 'local' || existing.command?.length !== 1 || existing.command[0] !== archiveLauncher)) return
      editor.set(id, {
        type: 'local', timeout: { execution: 180000 }, ...existing,
        command: ['/bin/sh', launcher],
      })
    })

    await ctx.skill.transform((editor) => {
      for (const name of skills) {
        if (editor.get(name)) continue
        const skillPath = fileURLToPath(new URL(`./plugins/paradev-agent-tools/skills/${name}/SKILL.md`, import.meta.url))
        const content = readFileSync(skillPath, 'utf8')
        editor.add({
          id: Skill.ID.make(name),
          name: Skill.Name.make(name),
          description: content.match(/^description: (.+)$/m)[1],
          path: Skill.Info.fields.path.make(skillPath),
          content,
        })
      }
    })
  },
})
