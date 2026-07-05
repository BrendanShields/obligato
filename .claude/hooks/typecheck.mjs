#!/usr/bin/env node
// PostToolUse hook: typecheck after TS edits. No-ops until Phase 0 scaffolds
// the workspace (guarded on package.json), so it's safe to ship now.
//
// Debounced (postmortem 2026-07-05): multi-edit messages used to fire one tsc
// per edit, and every mid-batch run reported a stale, half-applied state
// (~8 false-alarm blocks in one session). Each invocation stamps a token,
// waits a beat, and yields to any newer edit's invocation — so a batch of N
// dependent edits produces one tsc run against the settled tree.
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

const input = JSON.parse(readFileSync(0, 'utf8'))
const edited = input.tool_input?.file_path ?? ''
if (!/\.(ts|tsx|mts)$/.test(edited)) process.exit(0)
const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
if (!existsSync(join(root, 'package.json'))) process.exit(0)

// Debounce token lives in the gitignored telemetry dir.
const tokenDir = join(root, '.kelson', 'telemetry')
const tokenFile = join(tokenDir, 'typecheck-debounce')
const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`
try {
  mkdirSync(tokenDir, { recursive: true })
  writeFileSync(tokenFile, token)
  await new Promise((r) => setTimeout(r, 1500))
  if (readFileSync(tokenFile, 'utf8') !== token) process.exit(0) // newer edit owns the check
} catch {
  // debounce is best-effort; fall through to the check
}

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
