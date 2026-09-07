# capygen — handoff (2026-09-06, end of Phase 6)

Lead from here: **GPT Astra (Codex)** — see `AGENTS.md`. Reviewers for dev: Claude Fable 5.1 /
Opus 5 (`CLAUDE.md`). Phases 1–6 were built by Claude Fable 5.1 orchestrating Opus 5 / Sonnet 5
subagents with cross-model review waves.

## Current continuation — 2026-09-07

Astra is continuing on `review/phase7-preparation`; phases 7–12 and Custom Mode 9C remain open.
Custom Mode is specified in SPEC R33–R34 and ADR-0006. Mascots use static pixel PNGs only.
Accepted corrections: complete MCP connection identity, Claude/API effort propagation,
explicit integration project scope, safeStorage MCP references, and isolated pinned test paths.
The remaining runtime-default/resolver work is `docs/plans/phase7-runtime-config.md`.

Latest offline gate: typecheck/build passed; 104 unit files, 1,388 passed and four skipped;
Playwright 43 passed and 12 skipped. The e2e suite now uses disposable backend homes by default
and synthetic plugin fixtures, with no personal configuration content reads. Six UI-created
live paths are explicitly gated until P1 proves effective effort before dispatch; other live
proofs need dedicated test identities. Only Sonnet 5 low and GPT Luna low may be used for live
prompts. See `docs/RUN.md` and PROJECT_LOG for commands, limitations and literal result tails.
Historical phase claims below are preserved as history, not re-proved by these skips.

## State

| Phase | Status | Proof |
|---|---|---|
| 1 Engine spike (Claude SDK, Codex app-server) | ✅ | `docs/spikes/engine.md`, `corepack pnpm spike` |
| 2 Walking skeleton + brand | ✅ | `tests/e2e/launch.spec.ts`, `skeleton.spec.ts` |
| 3 Harness layer (Claude, Codex, API models, tools, MCP client, MCP Apps widgets, cards) | ✅ | `harnesses.spec.ts`, `widget.spec.ts`, `docs/spikes/mcp-apps.md` |
| 4 Round-table, hop cap, sub-agent routing + delegation, agents pane | ✅ | `roundtable.spec.ts`, ADR-0004 |
| 5 Dockable workspace panes + dev servers | ✅ | `workspace.spec.ts`, ADR-0005 |
| 6 Settings hub, two-way config sync, prerequisites | ✅ | `settings.spec.ts` |
| 7–12 | open | `PLAN.md` |

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
The latest crew is Astra medium / Opus hard+medium / Luna simple / Fable medium core debate.
Initial Claude dispatches failed; after reauthentication Opus reviewed the findings and Fable
debated the plan in two rounds. Four runtime findings remain open corrective tasks.
Phases 7–12 are not implemented or newly accepted by this review.

## Verified continuation checkpoint — 2026-09-07

On `review/phase7-preparation`, P1-A canonical settings, captured runtime config,
provider/model selection and restart corrections pass the full native gate:
119 unit files, 1734 passed / 4 skipped; build and typecheck clean; Playwright
43 passed / 12 skipped. The latest output tails are in `PROJECT_LOG.md`.
The parser, bounded continuation formatter and window-owned staging are committed
prerequisites. The tested parser worker is built separately, but import client,
DB, IPC and UI wiring are still pending. P1-B scoped MCP discovery and widget
identity, worktrees and the remaining phases are also pending.

Custom Mode is specified in ADR-0006 and the Phase 9C plan; it is not implemented.
Mascots remain static sharp PNGs. Live app prompts must use Luna low or Sonnet 5
low, with dedicated test homes; the skipped live proofs are not completion.
Opus/Fable hit the Claude session limit at approximately 02:35 Lisbon, with reset
reported at 04:50. Final worker delta review by Fable remains unavailable; Astra
reviewed the worker changes and Luna independently reviewed the small root fixes.
No push was made. Preserve the unrelated untracked `state.lock`.
