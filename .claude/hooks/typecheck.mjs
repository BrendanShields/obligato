#!/usr/bin/env node
// PostToolUse hook: typecheck after TS edits. No-ops until Phase 0 scaffolds
// the workspace (guarded on package.json), so it's safe to ship now.
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

const input = JSON.parse(readFileSync(0, 'utf8'))
const edited = input.tool_input?.file_path ?? ''
if (!/\.(ts|tsx|mts)$/.test(edited)) process.exit(0)
const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
if (!existsSync(join(root, 'package.json'))) process.exit(0)

try {
  // tsc writes diagnostics to STDOUT; stderr only carries bun's script echo
  // (postmortem: stderr-only capture produced empty block messages).
  execSync('bun run typecheck', { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 })
} catch (e) {
  const detail = [e.stdout?.toString(), e.stderr?.toString()]
    .filter(Boolean)
    .join('\n')
    .slice(0, 4000)
  console.error(`typecheck failed after editing ${edited}:\n${detail || e.message}`)
  process.exit(2)
}
process.exit(0)
