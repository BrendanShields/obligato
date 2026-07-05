# Sakana Review: Kelson App Planning Review

Date: 2026-07-03  
Reviewer: Sakana / Fugu  
Scope: repository review only. No product code changes were made; this document is the only intended artifact.

> Note: I intentionally did **not** run the Graphify pipeline even though it is useful for architecture reviews, because it would create `graphify-out/` artifacts and the request was to make no changes except this root planning document.

## 1. Executive Summary

Kelson is unusually strong for a pre-release engineering harness: the core idea is crisp, the package layering is clean, specs and obligations are deeply integrated, and the repository already dogfoods many of its own operating rules. The standout strength is the combination of append-only event streams, executable obligations, statistical eval gating, and a native agent runtime that reuses the kernel instead of becoming a separate product.

The main opportunity is to move from “impressive prototype with many correctness rails” to “boringly reliable operator tool.” The immediate priority should be stabilizing the gates, fixing local test flakiness, and reducing the size/coupling of the native runtime and CLI composition root. After that, the biggest leverage comes from speeding up evals, improving the first-run workflow, and turning the local UI into a stronger evidence/debugging surface.

Highest-priority findings:

1. **Current gates are not green locally.** `bun run typecheck` passes, but `bun run lint` fails on formatting plus unused suppressions, and `bun test` fails in this environment with local `Bun.serve({ port: 0 })` failures that cascade into CLI/native-runtime tests.
2. **The architecture boundaries are directionally right, but some files are becoming orchestration god modules.** `packages/agent/src/loop.ts`, `packages/cli/src/index.ts`, and `packages/kernel/src/evalrun.ts` are the main seams to deepen.
3. **Eval execution is correctness-focused but not yet throughput-focused.** `runEval` is sequential across task × side × repeat, uses synchronous workspace execution for built-in executors, and opens obvious room for bounded parallelism.
4. **The UI is a good read-only start, but it is still mostly a dashboard shell.** It lacks route-level loading/error states, session detail pages, eval drill-downs, and workflow affordances that explain “what should I do next?”
5. **Docs and implementation have started to drift.** README says phases 0–5 are implemented, while the codebase includes substantial phase 6–10 native-runtime work. `CLAUDE.md` still says “pre-code phase” despite a sizable app.
6. **Security posture is thoughtful, but a few practical edges remain.** Static asset path containment should use realpath/segment checks, shell execution should continue moving away from `sh -c`, and permission previews need to become more operator-legible.

## 2. What I Reviewed

### Repository shape

- Monorepo using Bun workspaces.
- Packages:
  - `packages/schemas`: Zod schemas and exported inferred types.
  - `packages/kernel`: storage, telemetry, artifact tracing, kelspec compiler, eval runner, stats, routing, loop, monitoring.
  - `packages/agent`: native agent runtime, model registry/auth, sessions, tools, permissions, spec-native loop.
  - `packages/cli`: command surface, native run/chat/session/auth, TUI launcher, local UI server.
  - `packages/cc-plugin`: Claude Code hooks/status/transcript telemetry.
  - `packages/ui`: Vite/React read-only local dashboard.
- Docs/specs/ADRs under `docs/`, TLA model under `specs/tla`, seed benchmark suite under `suites/seed`.

### Scale snapshot

- Source files: 85 TypeScript/TSX files under package `src` folders.
- Test files: 141.
- Obligation tests: 130.
- Unique spec-like clause IDs found across specs/tests: 196.
- Largest implementation files by line count:
  - `packages/agent/src/loop.ts` — 674 lines.
  - `packages/cli/src/index.ts` — 613 lines.
  - `packages/kernel/src/evalrun.ts` — 580 lines.
  - `packages/kernel/src/loop.ts` — 525 lines.
  - `packages/kernel/src/kelspec.ts` — 444 lines.
  - `packages/agent/src/sessions.ts` — 399 lines.
  - `packages/kernel/src/monitor.ts` — 382 lines.

### Safe diagnostics run

- `bun run typecheck`: **passed**.
- `bun run lint`: **failed**.
  - 2 formatter errors:
    - `packages/agent/src/tools.ts`
    - `packages/kernel/src/kelspec.ts`
  - 6 unused Biome suppressions:
    - `packages/agent/test/helpers.ts`
    - `packages/cli/src/components/render.ts`
    - `packages/cli/src/components/sink.ts`
    - `packages/cli/test/obligations/UX-4.test.ts`
    - `packages/kernel/src/predicate.ts`
- `bun test`: **failed in this local environment**.
  - 409 pass, 2 todo, 21 fail, 4 errors.
  - The earliest root symptom is `Bun.serve({ port: 0 })` failing with `EADDRINUSE` in local capture/mock servers, then CLI/native-runtime tests that rely on those servers cascade.
  - The two todos reported are expected/deferred items:
    - `DSL-5` failing model check via TLC.
    - `OSS-6` historical cross-version eval comparison todo, despite a later phase-5 test covering the behavior.
- Package import layering check: **no package-level direction violations** found.
  - `schemas <- kernel <- agent <- cli`
  - `kernel <- cc-plugin`
  - `schemas <- ui`

## 3. What Is Already Strong

### 3.1 Product concept

Kelson’s core thesis is compelling: coding-agent value is lost through vague specs, wrong model/context choices, and nonexistent learning across sessions. The product gives each of those a structural answer:

- Kelspec and obligations attack vagueness.
- Routing/evals attack model/context waste.
- The loop, ledger, and monitoring attack “did this help?” amnesia.

That is a stronger product spine than a generic agent wrapper.

### 3.2 Spec-first discipline

The docs are not ornamental. They define clause families, obligations, storage semantics, and even model-checked loop state. The test suite reflects this with many clause-named obligation tests. This is a real differentiator and should remain the project’s main quality bar.

### 3.3 Package layering

The package dependency graph is clean. The kernel does not import the agent; `runEval` accepts injected executors; schemas are the leaf dependency; UI consumes schemas rather than duplicating contracts. This is the right foundation.

### 3.4 Append-only event design

Session, step, eval, routing, budget, loop, and session-event records are mostly append-only, with explicit exceptions. This makes replay, auditability, and promotion-to-eval plausible.

### 3.5 Local-first privacy posture

The code and docs repeatedly enforce local-first telemetry. The shared payload schemas strip text/path/code, and there are static no-network scans in tests. This should be kept as a brand-level advantage.

### 3.6 Native runtime direction

The native runtime has good instincts:

- One model call per step.
- Explicit tool registry.
- Permission decisions as durable events.
- Chain-derived session model switches.
- Spec-native done gate.
- Budget monitor reused from kernel.
- Eval executor injected from CLI rather than imported by kernel.

This keeps the runtime testable and auditable instead of becoming prompt magic.

## 4. Immediate Stabilization Plan

These should happen before feature work.

### P0.1 Make gates green again

**Problem:** The current local gate path is red.

**Plan:**

1. Run formatting and remove unused Biome suppressions.
2. Standardize capture/mock server creation behind one test helper.
3. Replace direct `Bun.serve({ port: 0 })` in tests with a helper that:
   - binds explicitly to `127.0.0.1`,
   - allocates/retries a concrete free port,
   - always calls `server.stop(true)` in cleanup,
   - produces a clear diagnostic if the platform cannot bind.
4. Re-run `bun run lint`, `bun test`, and then `bun run gates`.
5. Update CI step names: the CI label says “doctor, spec-lint, kelspec-lint, typecheck, biome, test” but `scripts/gates.mjs` also includes `ui-build`.

**Success criteria:**

- `bun run lint` passes.
- `bun test` passes on macOS and Linux.
- CI gate label matches actual gates.
- Port-binding helper is used by every local HTTP capture test.

### P0.2 Add a “fast green” workflow

**Problem:** `bun run gates` is comprehensive, but local iteration needs tiers.

**Plan:** Add documented scripts such as:

- `bun run check:fast`: typecheck + biome + focused non-network/non-container tests.
- `bun run check:unit`: all Bun tests except known slow/container/TLC groups.
- `bun run gates`: everything, unchanged.

Do this without weakening CI. The point is faster local loops, not fewer gates.

### P0.3 Clean up docs drift

**Problem:** Public docs understate current implementation status.

**Plan:**

- Update README status from “Phases 0–5 implemented” to a phase matrix showing phases 0–10 and maturity.
- Fix `CLAUDE.md` “pre-code phase” language.
- Mark current native runtime, UI, and session promotion as implemented/pre-release where appropriate.
- Add one “current happy path” section that names exactly what works today.

## 5. Architecture Recommendations

### A1. Split orchestration god modules into deep modules

The biggest architectural risk is not package layering; it is intra-package orchestration growth.

#### `packages/agent/src/loop.ts`

Current responsibilities include:

- event-to-model-message projection,
- pending tool resolution,
- permission request handling,
- write gate enforcement,
- obligation execution and caching,
- route/budget/model selection,
- AI SDK streaming,
- telemetry ingestion,
- done-gate and verification report emission,
- run/resume loop control.

Recommended split:

- `message-projection.ts`: session chain → AI SDK messages.
- `tool-runner.ts`: pending tool calls → permission decisions → tool results.
- `obligation-runner.ts`: touched clauses, hash cache, obligation checks.
- `step-router.ts`: fixed/routed/escalated model choice and budget seed.
- `model-step.ts`: one `streamText` call → assistant event payload.
- `turn-driver.ts`: step loop, pause/done semantics.

Target interface: `runTurn` remains the main exported API, but each internal unit can be read and tested independently.

#### `packages/cli/src/index.ts`

Current responsibilities include root dispatch, argument parsing, rendering, eval subcommands, route explanation, loop lifecycle commands, init, pack lint, help, and dynamic imports.

Recommended split:

- `commands/eval.ts`
- `commands/route.ts`
- `commands/loop.ts`
- `commands/init.ts`
- `commands/pack.ts`
- `args.ts`
- `help.ts`

Keep `COMMANDS` as the single dispatch table; just move command bodies out.

#### `packages/kernel/src/evalrun.ts`

Current responsibilities include suite loading, manifest creation, routing integration, workspace creation, task execution loops, DB writes, flakiness/quarantine, gate math, and ledger writing.

Recommended split:

- `suite-loader.ts`
- `run-manifest.ts`
- `side-materialization.ts`
- `eval-scheduler.ts`
- `eval-persistence.ts`
- `ledger.ts`

This will also make bounded parallelism easier.

### A2. Introduce explicit ports/adapters around side effects

The code already does this in places (`ToolContext`, injected `ExecutorFn`), but the pattern should be made consistent.

Recommended ports:

- `Clock` for timestamps.
- `IdGenerator` for ULIDs.
- `ProcessRunner` for shell/process execution.
- `HttpServerFactory` for tests and UI.
- `FileSystem` or smaller file adapters for snapshot/auth/model overlays where determinism matters.

Benefits:

- Tests stop depending on global time/process/network behavior.
- Bugs like port-0 failures become isolated in one adapter.
- Replay and eval determinism become easier to audit.

### A3. Consolidate argument parsing

There are multiple custom parsers in CLI files. They are small, but their behavior can diverge around booleans, repeated flags, missing values, and `--` separators.

Plan:

- Create one tiny internal parser in `packages/cli/src/args.ts`.
- Define typed parse helpers per command.
- Add obligation tests for:
  - boolean flags,
  - value flags,
  - missing value diagnostics,
  - unknown flags where relevant,
  - `--json` behavior.

No heavy CLI dependency is necessary unless you want richer help generation.

### A4. Normalize realpath handling at all containment boundaries

`packages/agent/src/tools.ts` has a thoughtful realpath containment function. Apply the same discipline everywhere paths can escape.

Targets:

- `packages/cli/src/ui/server.ts` static asset serving.
- Snapshot store/restore paths.
- SpecContext repo/path resolution.
- Changelog and lockfile paths passed by CLI flags.

For static assets specifically, the current string prefix check can be fooled by sibling prefixes such as `dist2` if an asset path normalizes there. Use `realpathSync` plus `path.relative`/separator checks.

### A5. Build domain repositories for SQLite access

Direct SQL is fine and matches the ADR, but domain-specific repository modules would improve clarity.

Possible modules:

- `session-store.ts`
- `eval-store.ts`
- `routing-store.ts`
- `loop-store.ts`
- `artifact-store.ts`
- `ui-view-store.ts`

These should not become ORMs. They should be thin, tested query boundaries with parsed row mapping.

## 6. Performance Recommendations

### P1. Add bounded parallelism to eval runs

`runEval` currently executes `tasks × sides × repeats` sequentially. This is correct and deterministic, but it will become too slow as suites grow.

Plan:

- Introduce an `EvalScheduler` with configurable concurrency.
- Preserve deterministic seeds and manifest ordering.
- Persist results as they complete, but compute the final paired results by sorted task/side/repeat keys.
- Default concurrency should be conservative locally and configurable in CI.
- Keep container/image pull behavior in mind; concurrency should not stampede Docker/Podman.

Success metric: wall-clock reduction on `suites/seed` and a larger synthetic suite without changing verdicts for a fixed seed.

### P2. Cache governed file hashes more aggressively

`governedFilesHash` reads entire governed files for each checked clause. That is fine at current scale but can become expensive when governed areas grow.

Plan:

- Maintain a per-session hash memo keyed by `(clause_id, file mtimes/sizes or content hash manifest)`.
- On bash calls, still conservatively scan all governed clauses, but reuse file hashes where unchanged.
- Record hash computation cost in debug telemetry if it becomes non-trivial.

### P3. Add SQLite indexes for scaling query paths

Existing indexes cover some event lookups, but UI and loop/eval queries will scan as data grows.

Candidates:

- `session(status, rowid)` or `session(status, started_at)` for monitor baselines.
- `eval_run(suite_id, suite_version, rowid)`.
- `verdict(run_id)`.
- `proposal(state, rowid)` and `proposal(diff_hash, state)`.
- `monitor_record(status, rowid)`.
- `drift_event(artifact_id, resolution)` for trace UI.
- `routing_weight(policy_hash, arm)` if bandit state grows.

Add indexes only with `EXPLAIN QUERY PLAN` checks and targeted tests.

### P4. Reduce UI polling and payload size

The UI polls every endpoint every 5 seconds and returns whole view payloads.

Plan:

- Keep polling for v1, but add `since` or `etag`-like lightweight checks.
- Limit time series windows and make session/eval lists paginated.
- Add route-level loading/error states so failed polls are visible.
- Consider Server-Sent Events later for local-only live updates, but only after the simple polling contract is solid.

### P5. Clean up snapshot temporary bundles

`storeSnapshot` writes a temporary bundle under the OS temp dir and copies it into the store. It should remove the temp bundle in a `finally` block. This is not urgent, but repeated session promotion/eval workflows will otherwise leak temp files.

### P6. Avoid repeated registry/policy loads during long sessions

Model registry and routing context loading are fine for CLI startup, but model switches and repeated setup paths can re-read overlays. Cache within a command invocation while preserving the rule that config defaults are not re-read mid-session.

## 7. Workflow and Developer Experience Recommendations

### W1. Make `kelson doctor` a first-class CLI command

There is a useful `scripts/doctor.mjs`, but operator-facing UX should have `kelson doctor`.

It should report:

- Bun version vs engines/CI pin.
- Platform warnings.
- DB path resolution.
- Config/auth presence without echoing secrets.
- Model registry entries and default model.
- Routing pack validity.
- UI assets built/not built.
- Docker/Podman availability for container profiles.
- Java/TLC availability.

### W2. Add a guided “first useful run”

The quickstart is good, but the product needs a short happy path that proves value.

Candidate flow:

```bash
bun packages/cli/src/index.ts init
kelson doctor
kelson auth login ollama --base-url http://127.0.0.1:11434
kelson run -p "inspect this repo and summarize the highest-risk files" --json
kelson ui
```

For users without a local model, provide a no-model demo using command executor / seeded suite so the app still shows evidence.

### W3. Make gate failures actionable

`bun run gates` runs the right checks, but failures can be noisy. Add a small summary wrapper that groups failures by gate and suggests the next command.

Example:

- Biome format: “run `bunx biome check --write .`.”
- Port/mock server failure: “run focused test `bun test packages/agent/test/obligations/PROV-5.test.ts`.”
- UI build: “run `bun run --cwd packages/ui build`.”

### W4. Track deferred items in one machine-readable place

Deferred items are spread across comments, `it.todo`, docs, and phase plans. Create a `docs/plans/deferred-items.md` or JSON task list that records:

- item,
- source clause,
- reason deferred,
- trigger to revisit,
- current test marker,
- owner area.

This fits Kelson’s evidence culture and prevents stale todos.

### W5. Add “golden path” integration tests

The project has many obligation tests, but a few product-level golden paths would catch composition drift:

1. Init → auth/configure mock model → run prompt → session recorded → UI endpoint shows session.
2. Eval ablate on seed suite → verdict → loop proposal/gate flow.
3. Spec-native run with governed file → obligation fail → repair → verification report.
4. Session fork → compare → promote → replay.

## 8. UI / Product Feature Recommendations

### U1. Strengthen loading and error states

`usePoll` captures errors, but views mostly render `null` while loading and do not consistently display API failures.

Plan:

- Shared `<Loading />` and `<ErrorState />` components.
- Show stale data with an error badge when refresh fails.
- Add “last updated” timestamps.
- Make empty states distinguish “no DB”, “empty DB”, and “API failed validation.”

### U2. Add session detail pages

Telemetry lists recent sessions, but operators will want to inspect one session.

Session detail should show:

- prompt/task,
- model steps,
- token/cost breakdown,
- tool calls and permission decisions,
- obligation checks,
- budget events,
- verification report,
- links to fork/compare/promote CLI commands.

This is likely the highest-value UI feature.

### U3. Add eval drill-downs

Eval summary cards are useful, but users need to understand why a verdict happened.

Add:

- per-task paired outcomes,
- quarantine reasons,
- cost outliers,
- confidence interval explanation,
- manifest hash and reproducibility info,
- “publish to ledger” command copy block when eligible.

### U4. Add loop proposal detail pages

For each proposal, show:

- diff summary,
- evidence links and whether they resolve,
- gate basis,
- replay/counterfactual result,
- monitor status,
- changelog entries,
- exact CLI next actions.

### U5. Make trace useful as a repair tool

The trace DAG is visually promising but should become actionable:

- Filter by open drift.
- Click a stale artifact and show upstream/downstream context.
- Show “repair spec” vs “repair code” suggested commands.
- Show obligation file path and last check status.

### U6. Keep browser read-only for now

The read-only browser stance is wise. Approvals/reverts should remain CLI/TUI until auth, CSRF, and remote access are intentionally designed. The UI should copy commands, not execute them.

## 9. Security and Safety Recommendations

### S1. Replace string-prefix containment checks with realpath checks

Apply the `tools.ts` containment mindset to the UI server and any path derived from flags or HTTP URLs.

### S2. Reduce `sh -c` exposure over time

Some shell execution is inherent to a coding harness, but internal commands should prefer argv arrays where practical. For model-controlled bash, keep it explicit and permission-gated. For harness-owned commands, avoid shell interpolation unless necessary.

### S3. Make permission decisions previewable

Before running mutating tools, the operator should be able to see:

- tool name,
- primary arg,
- matched rule,
- why it allowed/asked/denied,
- whether the target is governed/stale,
- whether it touches T1/T2 artifacts.

This will make the permission model feel trustworthy rather than surprising.

### S4. Continue separating subscription auth from ledger evidence

The code correctly treats subscription-token runs as useful but not ledger-grade evidence. Keep that line bright in docs and UI.

### S5. Add credential leak regression tests around every override path

There are already good tests for dummy keys and credential withholding. Extend the same fixture to:

- native `run`,
- `eval --executor api`,
- model switch,
- routing-provided model endpoint,
- any future provider.

## 10. Testing Strategy Recommendations

### T1. Centralize local HTTP test servers

This is the immediate flake fix. Every test server should use one helper that handles port allocation, hostname, cleanup, and diagnostics.

### T2. Separate slow/container tests without excluding them from CI

Mark or group:

- container isolation tests,
- eval-run statistical tests,
- UI build tests,
- TLC/model checking,
- live/quarantine-only tests.

Then offer local script tiers while CI still runs the full suite.

### T3. Add macOS test coverage beyond quickstart

CI currently has a macOS clean install job, but not the full unit/obligation suite. Because local macOS behavior exposed `Bun.serve` issues, add at least a nightly or PR-optional macOS test job for targeted native-runtime/CLI tests.

### T4. Make test summaries less truncation-prone

`bun test` output is large. Add a script that captures full logs to a file and prints:

- failing test names,
- first error per file,
- pass/fail/todo counts,
- command to re-run failed files.

### T5. Resolve stale todos

There are only two `it.todo` items, which is good. One appears superseded by later OSS-6 coverage. Either remove/replace the stale todo or explain why both historical and phase-5 tests remain necessary.

## 11. Data Model and Storage Recommendations

### D1. Add query-plan tests for UI/monitor/eval views

As data grows, the local UI and monitor loop will become the first places where scans hurt. Add fixture databases with thousands of rows and assert query plans use intended indexes.

### D2. Consider typed row mappers

Many queries cast raw records directly. Add small row mapping helpers that parse JSON columns and coerce SQLite booleans consistently. This keeps direct SQL while reducing repetitive mapping bugs.

### D3. Version API views explicitly

The UI server validates responses, which is good. Consider adding `schema_version` to UI view payloads so stale SPA/API mismatches become obvious.

### D4. Add DB maintenance commands

Local-first apps need maintenance affordances:

- `kelson db path`
- `kelson db stats`
- `kelson db backup`
- `kelson db vacuum`
- `kelson db doctor`

Keep them read-only or explicitly confirmed where destructive.

## 12. Product Roadmap Options

### Option A — Stabilize and polish the operator loop first (recommended)

Focus:

- green gates,
- first-run flow,
- session detail UI,
- eval drill-downs,
- docs/status cleanup,
- faster local checks.

Why: This makes the current product credible and dogfoodable without expanding scope.

Trade-off: Less exciting than new self-improvement features, but likely highest leverage before external users.

### Option B — Deepen self-improvement and pack marketplace first

Focus:

- pack signing,
- contribution workflow,
- community ledger UX,
- proposal/monitor automation,
- shared telemetry aggregation when trigger conditions are met.

Why: This leans into the unique product differentiation.

Trade-off: Risky if the base operator experience still feels fragile.

### Option C — Push native agent capabilities first

Focus:

- stronger model/provider support,
- richer tools,
- context compiler integration,
- multi-agent divergence/build flows,
- session compaction and replay UI.

Why: Improves the day-to-day agent utility.

Trade-off: Adds complexity to the already-largest module area before stabilization.

**Recommendation:** Start with Option A for one cycle, then selectively pull from B/C once gates and first-run UX are solid.

## 13. Proposed Implementation Sequence

### Week 1: Reliability baseline

1. Fix Biome failures.
2. Centralize HTTP test server helper.
3. Get `bun test` green locally.
4. Run `bun run gates` and fix remaining gate issues.
5. Update README/CLAUDE phase/status drift.
6. Add `check:fast` and `check:unit` scripts if desired.

### Week 2: Architecture seams

1. Split `packages/cli/src/index.ts` command bodies into command modules.
2. Split `packages/agent/src/loop.ts` into projection/tool/obligation/router/model-step units.
3. Add focused tests around the extracted seams.
4. Keep public exports stable.

### Week 3: Performance and storage

1. Add bounded eval scheduler.
2. Add SQLite indexes with query-plan tests.
3. Add snapshot temp cleanup.
4. Add governed hash memoization.
5. Add eval benchmark comparing sequential vs bounded execution.

### Week 4: Operator UX

1. Add `kelson doctor` CLI command.
2. Add UI loading/error/stale states.
3. Add session detail endpoint and page.
4. Add eval drill-down endpoint and page.
5. Add “copy next command” blocks across UI.

### Later: Differentiating features

- Spec excavation guided workflow.
- Pack evidence browser.
- Session-to-eval promotion UI.
- Proposal details and monitor timeline.
- Local context compiler explorer.
- Optional external dashboard only after explicit demand.

## 14. Suggested Feature Backlog

### High value, low/medium complexity

- `kelson doctor` command.
- Session detail UI.
- Eval run detail UI.
- Copyable next-step commands in UI empty/detail states.
- Focused `check:fast`/`check:unit` scripts.
- Test server helper.
- DB stats command.
- Docs phase matrix.

### High value, higher complexity

- Bounded parallel eval scheduler.
- Context compiler integrated into native runtime.
- Spec excavation wizard.
- Pack contribution/evidence browser.
- Session promotion workflow from UI read-only detail page.
- Query-plan/index hardening.

### Nice-to-have

- Playwright smoke tests for the SPA.
- Theme polish / responsive UI pass.
- Export UI views as static reports.
- Import/export benchmark suites from a template.
- Local-only notification when monitor detects regression.

## 15. Risk Register

| Risk | Why it matters | Mitigation |
|---|---|---|
| Gates stay red | Users will not trust a correctness-first harness whose own checks fail | Fix lint/test first; make gate summary actionable |
| Native runtime module keeps growing | Harder to audit safety and pause/done semantics | Split by deep internal interfaces |
| Eval runs are too slow | Statistical gating becomes too expensive to use | Bounded parallelism and better summaries |
| UI remains shallow | Operators cannot understand evidence or failures | Add session/eval/proposal detail views |
| Docs drift | Product trust drops; contributors target wrong phase | Phase matrix and “works today” docs |
| Path containment inconsistency | Local-first tool still has local security expectations | Realpath containment everywhere |
| Test server flakes | CI/local divergence wastes time | Centralized HTTP server helper and macOS test coverage |
| Too many deferred comments | Scope gets fuzzy | Central deferred item registry |

## 16. Concrete Acceptance Criteria For The Next Review

A follow-up review should expect:

- `bun run typecheck` passes.
- `bun run lint` passes.
- `bun test` passes locally on macOS and in Linux CI.
- `bun run gates` passes.
- README and CLAUDE status accurately describe implemented phases.
- `packages/agent/src/loop.ts` is smaller or split into clear submodules.
- `packages/cli/src/index.ts` is mostly dispatch/help rather than command bodies.
- UI shows loading/error states and at least one detail page.
- Eval scheduler has a documented concurrency story, even if default remains `1`.

## 17. Final Take

Kelson’s foundation is strong: the project has a real point of view, a rigorous spec/test culture, and a clean high-level package architecture. The next step is not to add more cleverness; it is to make the current cleverness easier to operate, easier to trust, and easier to maintain.

The best near-term strategy is: **green the gates, deepen the largest modules, improve the first-run/operator feedback loop, then accelerate eval throughput.**
