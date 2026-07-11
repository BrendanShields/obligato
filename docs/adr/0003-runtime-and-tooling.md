# ADR-0003: Bun Runtime, OpenTUI, and the Complete Tooling Set

- **Status:** Accepted. Supersedes the runtime (Node ≥ 22), SQLite driver (better-sqlite3), package manager (pnpm), and test runner (vitest) choices in [ADR-0001](./0001-language-and-storage.md); ADR-0001's language (TypeScript), storage tiers, Zod-first schemas, and no-ORM decisions stand.
- **Date:** 2026-07-02
- **Traceability:** shapes [ERD §2, §9](../specs/2026-07-02-agent-harness-erd.md), [UX §7](../specs/2026-07-02-agent-harness-ux.md), [Phase 0 plan](../plans/2026-07-02-phase-0-rails.md)

## Context

The operator prefers OpenTUI for the terminal UI. OpenTUI's native renderer (Zig core) loads via `Bun.dlopen` — it is a Bun-first library; Node support requires experimental FFI on Node 26.3+. Adopting OpenTUI therefore forces a runtime decision, and the runtime decision cascades into the SQLite driver, test runner, package manager, and distribution story. Rather than fight the dependency, we examined whether Bun is independently the better runtime — it is.

## Decision

| Concern | Choice | Why |
|---|---|---|
| Runtime | **Bun ≥ 1.3** (all packages) | OpenTUI requirement; also: native TS execution (no build step in dev), built-in SQLite, workspaces, test runner — fewer moving parts than Node + 4 tools |
| TUI | **OpenTUI `@opentui/core`** | Operator preference; UX §7's component set (panel, table, sparkline, diff, select-list) is small enough that the core imperative API suffices — no react/solid binding layer in v1. *Amended 2026-07-03 (with the §7 amendment): OpenTUI powers the interactive surfaces (launcher, wizards, select-list) only; static print-and-exit output is pure string renderers through the component layer's sink — OpenTUI is a screen renderer, wrong-shaped for that path* |
| SQLite | **`bun:sqlite`** (built-in) | Replaces better-sqlite3: same synchronous API shape, zero native-module install pain, one fewer dependency |
| Package manager / workspaces | **Bun workspaces** | Replaces pnpm; one tool for install/run/test |
| Test runner | **`bun test` + fast-check** | Jest-compatible API; fast-check is runner-agnostic. Obligation-test conventions unchanged except the runner |
| Lint/format | **Biome** | One fast tool replaces eslint + prettier; low config surface |
| CLI arg parsing | ~~commander~~ **hand-rolled `parseArgs` + `COMMANDS` dispatch table** | *Amended 2026-07-03:* the shipped CLI never adopted commander; the shared dispatch table is now load-bearing (UX-8 wizard/typed identity), so commander would add a layer without adding routing. Revisit if subcommand help generation is wanted |
| Typecheck breadth | **`tsc --noEmit` strict, `skipLibCheck: true` (repo-wide)** | *Added 2026-07-03:* OpenTUI's published `.d.ts` fails under our strict flags; skipLibCheck skips third-party declaration checking only — our sources stay fully strict |
| Schema → JSON Schema | **Zod v4 `z.toJSONSchema`** | Native in Zod 4; no extra dependency for the signal contract export |
| Pack signing | **Ed25519 via `node:crypto`** (Bun-compatible), detached signatures | No signing-service dependency; keys distributed through the pack registry repo. Sigstore-style keyless is a Phase 5+ upgrade if the registry grows |
| Sandbox drivers | **Shell out to `git worktree` and `docker`/`podman` binaries** | No SDK dependencies; SEC-1 profiles name the driver used |
| TLA+ in CI | **TLC via Docker image** | No local toolchain requirement for contributors |
| CI | **GitHub Actions** (`oven-sh/setup-bun`) | Matches OSS-1/OSS-5 CI obligations |
| Distribution | **`bun build --compile`** → standalone `obligato` binary per platform, plus `npx obligato` (package name `obligato`, verified available) | End users and Claude Code hooks need no Bun install; the binary embeds the runtime |

## Options Considered

- **Node + Ink** (ADR-0001's implicit path): keeps the more conservative runtime but loses OpenTUI (operator preference) and keeps better-sqlite3's native-build fragility plus a 4-tool chain (node, pnpm, vitest, tsx).
- **Node + OpenTUI portable mode:** OpenTUI without its native renderer defeats the point of choosing it.
- **Split runtimes** (CLI on Bun, kernel on Node): two runtimes to test and document; rejected — kernel code is runtime-agnostic TS anyway, so running everything on Bun costs nothing.

## Consequences

- ERD §9, CLAUDE.md, the obligation-test skill, the Phase 0 plan, and the typecheck hook change from Node/pnpm/vitest/better-sqlite3 vocabulary to Bun equivalents (done in the same commit as this ADR).
- Typechecking still uses `tsc --noEmit` (Bun executes TS but does not typecheck).
- Contributor prerequisite is exactly one tool (Bun); end users need zero (compiled binary).
- Risk accepted: Bun is younger than Node. Mitigation: kernel/schemas code stays runtime-agnostic TS (no `Bun.*` APIs outside a thin adapter for sqlite), so a Node retreat is a driver swap, not a rewrite — same isolation argument as the cc-plugin boundary in ADR-0001.
