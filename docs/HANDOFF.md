# capygen — handoff (2026-09-07, end of Phase 8)

Lead: GPT-6-Astra (Codex), low; hard/medium implementation and review: GPT-5.6-Sol,
medium; easy renderer work: GPT-5.6-Luna, medium. Different-model review was applied
before acceptance. Phases 1–6 remain historical acceptance, preserved below.

## Current checkpoint

Phases 7 and 8 are accepted. The user's latest instruction stops this run here: do not
start Phase 9 without a new request. The accepted version is being promoted to `main`;
future authorized work and verified pushes use `origin/main` (never force-push).

Phase 7 includes native worktree creation/registration/removal, session cwd, selected-file
Diff commits, Claude/Codex inert transcript import, restart/deduplication, and a fresh-session
continuation with a bounded reference. Scoped MCP configuration reaches real tools/widgets
through explicit project/backend snapshots, with safeStorage references for API-owned secrets.

Phase 8 adds cross-session Tasks, durable Inbox/read badges and notification deduplication,
Usage totals with known/unknown prices, and persisted automations. A run selects the agent's
current validated configuration and creates a fresh session through normal dispatch. Runs do
not overlap. Keep capygen or its tray process running; missed occurrences are skipped after a
restart. Pause stops future occurrences; cancel an active run before deleting its automation.

Final gate: all package/test typechecks passed; 144 unit files, 1883 tests passed and four
skipped; renderer/desktop build passed; Playwright 46 passed and 12 skipped in 1.4 minutes.
Native activity acceptance uses an actual minute timer and isolated profiles, with no model
calls. Dedicated authenticated live checks remain skipped and are not counted as passes.
Literal tails are in PROJECT_LOG.md; screenshots are under e2e-out/activity and e2e-out/imports.

Known limits: Claude 2.1.263 has no persistent user/local server disable flag or server cwd;
those edits fail before mutation. Project .mcp.json approval toggles and HTTP headers work.
Packaging/SDK smoke belongs to Phase 12; live benchmark proof belongs to Phase 11. Custom Mode
9C remains specified, not implemented. No future-phase requirement has been silently dropped.
Preserve the unrelated untracked state.lock. AGENTS.md records the new main-branch policy.

## State

| Phase | Status | Proof |
|---|---|---|
| 1 Engine spike (Claude SDK, Codex app-server) | ✅ | `docs/spikes/engine.md`, `corepack pnpm spike` |
| 2 Walking skeleton + brand | ✅ | `tests/e2e/launch.spec.ts`, `skeleton.spec.ts` |
| 3 Harness layer (Claude, Codex, API models, tools, MCP client, MCP Apps widgets, cards) | ✅ | `harnesses.spec.ts`, `widget.spec.ts`, `docs/spikes/mcp-apps.md` |
| 4 Round-table, hop cap, sub-agent routing + delegation, agents pane | ✅ | `roundtable.spec.ts`, ADR-0004 |
| 5 Dockable workspace panes + dev servers | ✅ | `workspace.spec.ts`, ADR-0005 |
| 6 Settings hub, two-way config sync, prerequisites | ✅ | `settings.spec.ts` |
| 7 Projects/worktrees/imports | accepted | `worktrees.spec.ts`, `imports.spec.ts`, scoped MCP fixture |
| 8 Tasks/Inbox/Usage/Automations | accepted | `activity.spec.ts`, scheduler/Inbox/usage suites |
| 9, 9C, 10–12 | open; stopped by user | `PLAN.md` |

Historical gate on parent revision `2222cd6` (2026-09-06; handoff committed as `067a7dc`): typecheck 5/5 packages;
vitest 99 files, 1296 passed, 4 skipped; build ok; Playwright 24 passed, 10 skipped. The skips
are every live-Claude test (Claude Code's OAuth session on this machine is expired — `claude -p
"say ok"` answers "OAuth session expired"; run `claude` in a terminal to sign in, then they run
again) and the API-key case (no key stored). With Claude signed in, the previous runs were
16/16 live tests green.

## How to run

```
corepack pnpm install
corepack pnpm dev                    # Vite + Electron
corepack pnpm build && corepack pnpm start
corepack pnpm typecheck && corepack pnpm test
corepack pnpm exec playwright test   # e2e; live tests spend cents, skip when a backend is not signed in
corepack pnpm spike                  # engine capability proof (regression check on SDK upgrades)
```
Details, env flags and troubleshooting: `docs/RUN.md`. Data: `%APPDATA%\capygen\capygen.db`,
logs in `%APPDATA%\capygen\logs`. Isolated e2e homes: `CAPYGEN_CLAUDE_CONFIG_DIR`,
`CAPYGEN_CODEX_HOME`, `--user-data-dir`.

## How a phase was run (repeat for 7–12)

`.claude/workflows/phase{2..6}-*.js` are the exact orchestration scripts: a contracts task, 3–4
parallel build tasks with strict file ownership, an integration task that writes the phase's
e2e and runs the full gate, then a four-lens review wave (correctness, security, UX parity vs
`reference/omnigent`, efficiency) on a different model, then a fix task. Copy the shape; keep the
"Done when" from `PLAN.md` as the integration target; commit per task by path.

## Revert

Every task is one commit on `main` (52+ commits, linear). `git log --oneline` names them
"Phase N: …". To back out a phase: `git revert <range>` newest-first; migrations are forward-only
numbered SQL. For a schema rollback, close the app and preserve the current database and
its sidecars, then restore a verified compatible pre-migration backup together with the matching
app revision. Do not delete the user's database as a default revert step.
No pushes were made; origin is not configured.

## Open items (carry into Phases 7–12)

- At the Phase 6 handoff Claude sign-in was expired. The user later reauthenticated the
  review worker; isolated app test homes still have no login. API key never stored, so the `api`
  backend has never made a real call — the live e2e unskips when a key is set in Settings ▸ API
  keys. `api` model list is curated; prices `[assumed 2026-09-06]`.
- Codex cannot receive `delegate_task` (app-server takes MCP servers only from `config.toml`);
  cross-backend routing from a Codex lead falls open (ADR-0004). Option: register capygen's MCP
  server in the isolated Codex config at session start.
- Codex cost is estimated (tokens only from app-server); Codex sub-agent blocks carry no cost.
- `harness.list` spawns a Codex probe child every 60 s of use; TTL/refresh button if it shows.
- Dev-server preferences are unimplemented (no `GlobalSettings.devServers` yet); the inactive
  localStorage controls were removed by `2222cd6`;
  `PrereqsSection`/`PrereqPanel` duplicated; `import`/`updates`/`members`/`policies`/`sharing`
  sections are reference-layout placeholders until Phases 7/9/12.
- Live e2e flake: cross-backend delegation depends on the lead choosing `delegate_task`; harden
  or assert on the routed policy.
- Per-harness avatar glyphs (deferred low finding); Codex `collabAgentToolCall` nested activity
  is summarised, not rendered as nested blocks.
- Phase 12 packaging must ship `@openai/codex-sdk` (direct desktop dependency, see
  `packages/engine/src/codex/binary.ts`) and `node-pty` prebuilds (ADR-0005, `asarUnpack`).
- Higgsfield / claude.ai proxy connectors expose no MCP App UI; they render through the rich
  fallback card by design (`docs/spikes/mcp-apps.md`).

## Where things are

`SPEC.md` (R1–R32, P1–P20) · `PLAN.md` (phases, assumptions A1–A14, crew) · `CONTEXT.md` ·
`docs/POLICIES.md` · `docs/adr/0001–0005` · `COMPAT.md` · `docs/RUN.md` · `docs/spikes/*` ·
`PROJECT_LOG.md` (per-task entries with command output) · `e2e-out/*.png` (latest screenshots).

## Astra review addendum — 2026-09-06

See `docs/reviews/phase1-6.md` for recovered session provenance and confirmed open findings.
See `docs/plans/phases7-12.md` for the corrective prerequisite batch and next-phase briefs.
The current crew is Astra low (lead/orchestrator/design/final decisions) / Sol medium
(hard+medium work and core-decision challenge) / Luna medium (easy work); Astra decides core issues.
Initial Claude dispatches failed; after reauthentication Opus reviewed the findings and Fable
debated the plan in two rounds. Four runtime findings remain open corrective tasks.
Phases 7–12 are not implemented or newly accepted by this review.

## Earlier continuation checkpoint — 2026-09-07

On `review/phase7-preparation`, P1-A canonical settings, captured runtime config,
provider/model selection and restart corrections pass the full native gate:
119 unit files, 1734 passed / 4 skipped; build and typecheck clean; Playwright
43 passed / 12 skipped. The latest output tails are in `PROJECT_LOG.md`.
The parser, bounded continuation formatter, utility-process worker, staging client, DB import
store, import IPC and read-only UI are implemented in the current checkout. The native picker
creates an opaque preview handle; commit consumes that handle into an immutable paginated
historical session, and continuation creates a fresh session with a bounded quoted reference.
Worker jobs use owned homes and an inert project directory, and renderer IPC never receives the
transcript during preview.

Scoped MCP runtime resolution is also wired: explicit project scope, backend precedence and
disabled-name shadowing are shared by settings and harness dispatch; API-owned secrets resolve
through main-process safeStorage references. Worktrees were subsequently accepted by the final gate above. Packaged SDK-resolution
verification remains pending. Live benchmark evidence belongs to Phase 11 and awaits dedicated authenticated test homes.

Claude MCP compatibility follows the installed runtime rather than the generic editor shape.
Claude 2.1.263 and its pinned Agent SDK do not support a per-server `cwd` or a persistent disabled
flag for user/local servers, so those mutations are rejected before Claude's remove/add update can
touch the existing row. HTTP/SSE headers use Claude's native `--header` option. Project `.mcp.json`
servers remain switchable through Claude's `enabledMcpjsonServers` / `disabledMcpjsonServers`
approval lists in `.claude/settings.local.json`.

Custom Mode is specified in ADR-0006 and the Phase 9C plan; it is not implemented.
Mascots remain static sharp PNGs. Live app prompts must use Luna low or Sonnet 5
low, with dedicated test homes; the skipped live proofs are not completion.
Opus/Fable hit the Claude session limit at approximately 02:35 Lisbon, with reset
reported at 04:50. Final worker delta review by Fable remains unavailable; Astra
reviewed the worker changes and Luna independently reviewed the small root fixes.
No push had been made at that earlier checkpoint. The final Phase 8 promotion follows the later user instruction. Preserve the unrelated untracked `state.lock`.

## Earlier import/MCP implementation checkpoint — 2026-09-07

Evidence from the current tree:

```text
e2e-out/import-build.log                 renderer + desktop build; importWorker.cjs emitted
e2e-out/import-integrated-typecheck.log  shared/db/engine/desktop/renderer typecheck passed
e2e-out/import-shell-tests.log            3 files, 33 tests passed (renderer import/UI shell)
e2e-out/import-provider-green.log        ImportedTranscript provider guard: 3 tests passed
e2e-out/mcp-root-review.log               5 focused files, 113 tests passed
```

The native import e2e has one verified pass including restart/deduplication, unchanged source hash
and the 380px screenshot. These
checks preceded the final Phase 7–8 acceptance gate above. Packaged SDK smoke remains Phase 12 work, and Phase 11 live benchmark evidence awaits dedicated authenticated homes.
