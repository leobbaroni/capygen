# capygen — handoff (2026-09-06, end of Phase 6)

Lead from here: **GPT Astra (Codex)** — see `AGENTS.md`. Reviewers for dev: Claude Fable 5.1 /
Opus 5 (`CLAUDE.md`). Phases 1–6 were built by Claude Fable 5.1 orchestrating Opus 5 / Sonnet 5
subagents with cross-model review waves.

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

Last gate run by the orchestrator (2026-09-06, commit `2222cd6`): typecheck 5/5 packages;
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
numbered SQL — reverting a phase that added a migration requires deleting
`%APPDATA%\capygen\capygen.db` (the migrator writes a backup next to it before each migration).
No pushes were made; origin is not configured.

## Open items (carry into Phases 7–12)

- Claude sign-in expired on this machine (user action); API key never stored, so the `api`
  backend has never made a real call — the live e2e unskips when a key is set in Settings ▸ API
  keys. `api` model list is curated; prices `[assumed 2026-09-06]`.
- Codex cannot receive `delegate_task` (app-server takes MCP servers only from `config.toml`);
  cross-backend routing from a Codex lead falls open (ADR-0004). Option: register capygen's MCP
  server in the isolated Codex config at session start.
- Codex cost is estimated (tokens only from app-server); Codex sub-agent blocks carry no cost.
- `harness.list` spawns a Codex probe child every 60 s of use; TTL/refresh button if it shows.
- Dev-servers settings section writes `localStorage` (no `GlobalSettings.devServers` yet);
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
