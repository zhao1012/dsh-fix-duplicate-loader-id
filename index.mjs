// dsh-fix-duplicate-loader-id - bundle entry.
// Registers the packaged skills/ tree as a custom skill provider,
// reusing the official filesystem provider so skills load exactly
// like user-level skills (frontmatter parsing, watcher, ranks).
//
// Note: @deepseek-ai/dsh-skill-filesystem is NOT declared in
// dependencies - official packages are injected by the profile's
// pnpm closure at install time (declaring them fails on public npm).
import { fileURLToPath } from 'node:url'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'

export const name = 'dsh-fix-duplicate-loader-id'
export const inject = ['skills']

export function apply(ctx) {
  const skillDir = fileURLToPath(new URL('./skills/dsh-fix-duplicate-loader-id', import.meta.url))
  ctx.skills.registerProvider((control) =>
    new FileSystemSkillProvider(ctx, control, {
      providerName: 'dsh-fix-duplicate-loader-id',
      customSkillDirs: [skillDir],
    }),
  )
}
