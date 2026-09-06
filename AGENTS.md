# capygen — AGENTS.md (project lead: GPT Astra medium via Codex)

You lead this project from Phase 7 onward. Opus 5 handles hard/medium tasks; GPT Luna handles simple tasks. Fable 5.1 (medium) debates
core decisions with Astra; Astra owns design and final decisions. A different model from
the implementer always reviews. Read in this order:
`SPEC.md` (the contract: goals, numbered requirements R1–R32, parity inventory P1–P20),
`PLAN.md` (build phases 7–12 with Done-when checks, assumptions ledger, crew),
`docs/HANDOFF.md` (current state, how to run/verify/revert, how a phase was run),
`docs/POLICIES.md` (app policies: routing, permissions, round-table, config, safety),
`CONTEXT.md` (terms), `COMPAT.md` (every CLI/SDK contract we depend on), `docs/adr/*`.

## Non-negotiable rules

1. **Push policy:** commit locally as you go (one commit per task, `git add` by path, never
   `-A`); push only when the user asks; never force-push.
2. **Never install anything silently** on the user's machine from the app. Every install/upgrade/
   sign-in step shows a confirm dialog quoting the exact command and runs in a visible console
   (`apps/desktop/src/prereqs/runGate.ts` is the gate; keep it unit-tested).
3. **Never touch the real user config** (`~/.claude/**`, `~/.codex/**`, `%APPDATA%/capygen`) from
   tests, spikes or probes. Isolated homes: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`; the app maps
   `CAPYGEN_CLAUDE_CONFIG_DIR` / `CAPYGEN_CODEX_HOME` to them for e2e.
4. **Secrets** live only in Electron `safeStorage` (`apps/desktop/src/ipc/secrets.ts`); never in
   files, logs, IPC results or the renderer. Docs refer to `${ANTHROPIC_API_KEY}` etc.
5. **Backend files are the source of truth** for plugins/skills/MCP/tool policies (SPEC R29):
   the app reads them, writes them the way the CLIs do, and watches them. Never keep a shadow copy
   that can drift.
6. **Efficiency is a requirement** (R23–R26): session-stable prompts, `cache_control` on
   system+tools for Anthropic API calls, lazy MCP schemas, tool outputs capped at 64 KB with an
   `outputRef`, per-model usage accounting. No settings/pane/IPC data ever enters a model context.
7. **Reference is read-only:** `reference/omnigent/` (Apache-2.0, NOTICE kept) is for layout,
   behaviour and API shapes; never import it. Reuse its CSS tokens verbatim.
8. **Windows-first:** children spawn with `windowsHide` and the cleaned env
   (`packages/engine/src/env.ts`: strips nested-session vars, sets `PYTHONUTF8=1`); paths may have
   spaces, non-ASCII and be long.
9. **Done is a check you ran.** Every phase ticks only when its `Done when:` in `PLAN.md` holds
   under the full gate: `corepack pnpm typecheck && corepack pnpm test && corepack pnpm build &&
   corepack pnpm exec playwright test`. Paste output tails in `PROJECT_LOG.md`.
10. Keep `COMPAT.md` in sync with any CLI command, SDK member, file format or protocol message the
    app starts to rely on; keep `docs/RUN.md` runnable.

## Repo map

```
apps/desktop/    Electron main + preload (esbuild). engine/ (SessionRunner, RoundTable, history),
                 ipc/ (typed handlers per area), workspace/ (fs, git, terminal, dev servers,
                 tasks, browser views), integrations/ (config sync, diagnostics), prereqs/, win/
apps/renderer/   Vite + React 18 + Tailwind 4 + shadcn. pages/, components/ (blocks, cards,
                 composer), panes/ (dockview panes), workspace/ (dockview host, registry),
                 pages/settings/ (hub), brand/ (mascot, wordmark), widgets/ (MCP Apps host)
packages/shared/ zod domain + typed IPC contract (defineIpc) + blockParity + constants
packages/engine/ Harness interface; claude/ (Agent SDK), codex/ (app-server JSON-RPC), api/
                 (Anthropic/OpenAI/OpenRouter loop) + tools/ (local tool runtime) + mcp/ (client
                 + apps host bridge) + roundtable/ + routing/ + config/ (Claude/Codex stores)
packages/db/     node:sqlite driver, migrations 0001–0005, repos
tests/e2e/       Playwright Electron specs (launch, skeleton, harnesses, widget, roundtable,
                 workspace, settings) + tests/fixtures/
.claude/workflows/  the orchestration scripts that built Phases 2–6 (task briefs + review waves)
```

## How to work a phase (what produced Phases 2–6)

1. Contracts first (shared types + IPC + migration) so parallel tasks do not collide.
2. Parallel build tasks with strict file ownership; each commits only its own files.
3. Integrate: wire, write the e2e that proves the phase's Done-when, run the full gate.
4. Review wave on the other model (correctness, security, UX parity vs the reference,
   efficiency); fix every high/medium; re-run the gate; commit "Phase N: review fixes".
5. Tick the phase in `PLAN.md`, log in `PROJECT_LOG.md`, update `COMPAT.md`/`docs/RUN.md`.

Open items and known limitations are listed in `docs/HANDOFF.md`; do not silently drop them.
