# Handover — Kelson, Phase 0 in progress (2026-07-02)

Session-continuation notes. Read alongside `CLAUDE.md` (conventions, workflow, source-of-truth table) and `.kelson/tasks.json` (live board). Repo: https://github.com/BrendanShields/kelson (`main`, CI green).

## Where we are

Spec suite complete (8 specs + 3 ADRs, ambiguity-swept). Phase 0 (docs/plans/2026-07-02-phase-0-rails.md) executing:

- **Done:** P0-1 scaffold · P0-2 `@kelson/schemas` · P0-3 storage/migrations · P0-4 artifact store · P0-5 telemetry. 37 tests + 3 todos, all gates green, 11 clause obligations discharged (OSS-6, ART-1/2, TEL-1/2/5/7 partials noted below).
- **Next: P0-6 pack loader + lockfile.** Must include: PACK-1 path→capability mapping with refusal fixtures (`rules/**`→rules, `skills/<stage>/**`→that stage, top-level skill file = layout error), PACK-4 canonical lockfile hashing (RFC 8785, exclude parent_hash), **kernel_compat validated as a semver range — deferred audit finding F-007**, tamper refusal shape (PACK-2 partial; signing keys can stub).
- **Then: P0-7 cc-plugin shell** — closes Phase 0 exit criterion (real session → telemetry rows + traceable artifacts; `/kelson:status`) and discharges 3 recorded todos: TEL-1 emit-on-session-end + transcript parsing, TEL-2 runtime network recorder, (merge_clean window stays post-Phase-0).

## The proven loop (repeat for each task)

1. Flip task `in_progress` in `.kelson/tasks.json` (python one-liner).
2. Implement; spec bugs found by code get fixed **spec-first** (spec-sync skill) in the same commit.
3. `bunx biome check --write .` then `bun run gates` (all 6 must pass).
4. `git add -A`, then launch **clause-auditor** agent on the staged diff with task context + specific questions. It has found real violations every task (see `.kelson/findings.json` — 24 entries, root-cause taxonomy in the file).
5. Fix findings (spec-first for spec_gap/contradiction), add findings rows, flip task `completed` + timestamp.
6. Commit (reference clause IDs + audit outcome), push, `sleep 45 && gh run list --limit 1` to confirm CI.

## Session-critical operational notes

- **Hooks are NOT active this session** (added mid-session; Claude Code can't restart). Manually run: `bun run gates` before every commit; `echo '{"tool_input":{"file_path":"<file>"}}' | node .claude/hooks/spec-lint.mjs` after spec-doc edits; same for kelspec-lint on `*.spec.md`. CI runs the identical `gates` script as backstop.
- **User preferences:** push after committing (often asks); task lists always JSON, marked off live (also in memory + CLAUDE.md); ponytail active (terse, minimal); wants corrections tracked → findings.json discipline is non-negotiable.
- **Gotchas that cost time:** Biome rewraps after every Write — run `biome check --write` before gates, and python string-replacements can miss after rewrap (Read the file first, or Edit tool on fresh read). Bash `cd` persists across calls (caused stray-file finding F-005) — stay at repo root. `bun test` empty-suite exit code differs macOS/Linux (F-003). `it.todo` needs a function arg to typecheck.
- **Model routing emulation:** delegate mechanical work (renames, formatting sweeps) to the `mechanical` agent (Haiku).

## Deferral ledger (nothing else is open)

| What | Where recorded | Discharges |
|---|---|---|
| OSS-6 pt 2: cross-version eval comparison refusal | it.todo in OSS-6.test.ts | Phase 2 |
| TEL-1 emit-on-session-end + real transcript parse | it.todo in TEL-1.test.ts | P0-7 |
| TEL-2 runtime network recorder | it.todo in TEL-2.test.ts | P0-7 |
| merge_clean acceptance (correction window) | thrown error in telemetry.ts + F-020 | post-P0-7 |
| rebuild-from-files (needs kelspec manifest) | plan doc Task 4 note + F-015 | Phase 1 / DSL-6 |
| kernel_compat semver-range validation | P0-6 task notes + F-007 | **P0-6 (now)** |

## Architecture facts you'll need (avoid re-deriving)

- Stack: Bun 1.3.14 (pinned in CI + engines; doctor enforces), `bun:sqlite`, Zod v4 in `packages/schemas` (single source of truth — kernel imports its types), fast-check, Biome, OpenTUI planned for CLI (ADR-0003).
- Storage: sessions born `incomplete` → `complete` on clean end; `degraded` = sticky fault marker; only `complete` sessions gate. Event tables append-only via triggers; drift_event is insert-then-resolve. artifact PK is (repo, logical_id); trace_link/drift_event are repo-scoped (F-013!). Lockfile hash pinned on session start (LOOP-7 shape).
- Task lifecycle: open→in_progress→delivered→{accepted|corrected}; abandoned from any non-terminal; acceptance requires signal; Phase 0 signal = 'approval' only.
- Findings log `.kelson/findings.json`: every auditor violation/warning + surfaced spec bug gets a row in the fix's commit. Headline stats so far: spec-quality root causes (7) > test blindspots (4) = unrecorded deferrals (4) > design bugs (3); zero defects reached main.
