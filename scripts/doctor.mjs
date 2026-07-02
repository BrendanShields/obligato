#!/usr/bin/env node
// Proto-`kelson doctor` (UX §5.5) + environment manifest (EVP §4 shape).
// Fails on toolchain skew: bun below the engines pin, or local bun != CI pin.
// Platform difference from CI is a warning, not a failure.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { execSync } from 'node:child_process'

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
const read = (p) => readFileSync(`${root}/${p}`, 'utf8')

const bun = execSync('bun --version').toString().trim()
const enginesPin = (JSON.parse(read('package.json')).engines?.bun ?? '').replace('>=', '')
const ciPin = read('.github/workflows/ci.yml').match(/bun-version:\s*(\S+)/)?.[1]

const cmp = (a, b) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  return 0
}

const errs = []
const warns = []
if (enginesPin && cmp(bun, enginesPin) < 0)
  errs.push(`bun ${bun} < engines pin ${enginesPin} — run: bun upgrade`)
if (ciPin && ciPin !== 'latest' && bun !== ciPin)
  errs.push(`bun ${bun} != CI pin ${ciPin} — align them (bun upgrade, or update bun-version + engines) so local and CI stay on the same page`)
if (process.platform !== 'linux')
  warns.push(`platform ${process.platform} != CI (linux) — platform-specific behavior (e.g. exit-code quirks) may differ`)

const manifest = {
  checked_at: new Date().toISOString(),
  bun, node: process.version, platform: process.platform, arch: process.arch,
  engines_pin: enginesPin || null, ci_pin: ciPin || null,
}
mkdirSync(`${root}/.kelson`, { recursive: true })
writeFileSync(`${root}/.kelson/env.json`, JSON.stringify(manifest, null, 2) + '\n')

warns.forEach((w) => console.error(`doctor WARN: ${w}`))
if (errs.length) {
  errs.forEach((e) => console.error(`doctor FAIL: ${e}`))
  process.exit(1)
}
console.log(`doctor: ok (bun ${bun}, ${process.platform}/${process.arch})`)
