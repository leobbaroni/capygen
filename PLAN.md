# capygen — PLAN

One-line goal: see SPEC.md. This file is the build order; SPEC.md is the contract.

## Current State

- Phases 1–2 done (verified 2026-09-06): the monorepo builds, the app launches on the New Session
  landing, a live Claude turn streams into the transcript with a usage/cost line, and the session
  survives a relaunch out of SQLite. `pnpm typecheck` clean · `pnpm test` 142 passed ·
  `pnpm build` clean · `pnpm e2e` 7 passed (5 offline + 2 live). How to run any of it:
  `docs/RUN.md`.
- Not built yet: everything from Phase 3 on — Codex and API harnesses, panes, settings hub,
  round-table, packaging. Machine facts: SPEC.md §Current State.

## Approach

Walking skeleton through the riskiest unknown: **prove the SDK/headless engine first** (Phase 1),
then stand up the smallest end-to-end app (Phase 2: launch → prompt → Claude reply → persisted),
then widen backend by backend, pane by pane, page by page, keeping the app runnable after every
phase. Omnigent's SPA is copied *by style and layout*, not by code: read the reference page,
rebuild it on our store/IPC, reuse its CSS tokens verbatim.

Layout (executor's choice inside these boundaries):

```
capygen/
  package.json            pnpm workspace root (corepack pnpm 11)
  apps/desktop/           Electron main + preload (TypeScript, esbuild)
  apps/renderer/          Vite + React 18 + Tailwind 4 + shadcn/ui (the SPA)
  packages/shared/        IPC contracts (zod), domain types, constants
  packages/engine/        harness interface, Claude/Codex/API harnesses, tool runtime, MCP client,
                          round-table dispatcher, routing policy, compaction, usage accounting
  packages/db/            SQLite schema, migrations, repositories (node:sqlite — docs/adr/0003)
  assets/                 fonts, mascot sprite sheets, icons
  reference/omnigent/     read-only design/API reference (never imported at runtime)
  docs/adr/  docs/spikes/ decisions, spike logs
  scripts/                dev/e2e/screenshot helpers
```

Run: `corepack pnpm i` · `pnpm dev` (Vite + Electron) · `pnpm test` (vitest) · `pnpm e2e`
(Playwright Electron) · `pnpm build:win` (electron-builder NSIS + portable).

## Crew (user rule, 2026-09-05: "orchestrate between Opus 5 and Sonnet to save tokens; Fable is the orchestrator and task setter")

| Role | Model | Used for |
|---|---|---|
| Lead / task setter | session model (Claude Fable 5.1) — never a subagent | decomposition, task briefs, acceptance, final judgment |
| Hard | Opus 5 (`model: "opus"`) | engine, dispatcher, routing, packaging, anything that failed once |
| Mechanical | Sonnet 5 (`model: "sonnet"`) | page ports from the reference, boilerplate, docs, fixtures, consolidation |
| Review | the other one: Sonnet reviews Opus work, Opus reviews Sonnet work | adversarial verify waves |

Every workflow `agent()` call sets `model` explicitly; Fable does no subagent work itself.

## Build Phases

- [x] Phase 1: Engine spike — prove the headless capabilities on this machine
      Done when: `pnpm spike` prints PASS for: Claude SDK stream text; `/context` built-in
      handled; a plugin command (`/cockpit:pilot what's next`) executed; `AskUserQuestion`
      surfaced via `canUseTool` and answered; a PreToolUse hook fired on `Task`; Codex
      app-server thread+turn streamed; a Codex approval request answered. Results and the
      real request/response shapes written to `docs/spikes/engine.md`.
      Steps: init pnpm workspace; add `@anthropic-ai/claude-agent-sdk` + `@openai/codex-sdk`;
      read their `.d.ts` from `node_modules` and record shapes; write `scripts/spike-engine.ts`;
      run against the signed-in CLIs; record token usage per call; if any capability is missing,
      record the ConPTY fallback plan for exactly that piece.
      Covers: R7, R8, R14 basis; checks: A2, A3, A4.
- [x] Phase 2: Walking skeleton app + brand
      Done when: `pnpm e2e` launches the packaged-dir build, lands on the New Session page
      (capybara mascot, "What should we build?", composer, dir picker), sends "reply with the
      word pong", and the transcript shows the Claude reply; relaunch restores the session.
      Steps: Electron main (seamless chrome, tray, single instance, logger with redaction, SQLite
      open + migrations); preload IPC (zod contracts); renderer with Omnigent tokens/theme +
      shadcn; landing + chat page skeleton; Claude harness via SDK; sessions/turns persistence;
      mascot sprite sheet (generate 8 states, 96 px, pixel style; fall back to code-drawn pixel
      art if generation is unavailable) + reactive state hook; wordmark font-face.
      Covers: R1, R2, R5, R6 (text/tool blocks), R15; checks: A1, A5, A6, A8.
      Done 2026-09-06: `tests/e2e/skeleton.spec.ts` (live) — landing (mascot + heading + composer
      + pre-selected folder) → "Reply with exactly the word pong." → text block "pong" and a usage
      line (`2 in · 4 out · 37,211 cached · $0.0075 (claude-sonnet-5)`) → app close → relaunch on
      the same profile → the session in the sidebar and the same transcript
      (`e2e-out/chat-pong.png`, `e2e-out/restored.png`); a second test answers a live
      `AskUserQuestion` card and the model echoes the choice (`e2e-out/chat-question.png`).
      `tests/e2e/launch.spec.ts` keeps the same path green offline (`CAPYGEN_ENGINE=stub`).
      A6 (Omnigent tokens copy verbatim) and A8 (8-state mascot) hold; A11 (font may be bundled)
      is still unverified but now regression-checked (`document.fonts.check`).
      Not covered by an e2e: R2's tray / close-to-tray path is unit-tested only
      (`apps/desktop/test/win.test.ts` "tray / close-to-tray") — Playwright cannot drive the
      Windows tray. Permission cards round-trip in unit tests (harness + runner + handlers), not
      live; a live proof needs a tool the user's own `~/.claude` allowlist does not pre-approve,
      which would make the spec machine-dependent.
- [ ] Phase 3: Harness layer complete
      Done when: fixture tests pass for all three harnesses (Claude, Codex, API model with a
      mocked API) rendering every block type; live smoke: Codex answers; slash menu lists
      built-ins + Claude skills/plugins; permission and AskUserQuestion cards round-trip;
      usage meter updates per turn.
      Steps: `Harness` interface (start, send, interrupt, resume, listCommands, capabilities);
      Codex app-server client; API-model agent loop + local tool runtime + MCP client;
      permission modes; block renderer parity with reference `components/`; usage accounting;
      **MCP Apps widget host** (spike first: how the widget's `ui://` HTML is obtained for
      servers the CLI hosts — own MCP client connection to the same server config, or the
      backend's resource read — then the sandboxed iframe host with the ext-apps bridge;
      fixture = ext-apps basic example; live = user's Higgsfield connector); structured
      interaction cards for AskUserQuestion / permission / elicitation / Codex approvals.
      Covers: R6, R7, R8, R9, R14, R23, R27, R31, R32; checks: A4, A13.
- [ ] Phase 4: Round-table and orchestration
      Done when: e2e: a session with Claude + Codex, "@codex review what @claude wrote" produces
      two turns in order; hop cap stops a ping-pong at 3; agent tree shows a routed sub-agent;
      Agent info card shows description/tools/model/cost and the other agents.
      Steps: session modes + mode switch; dispatcher (mentions, lead fallback, hop cap, queue);
      sub-agent routing policy (PreToolUse hook for Claude `Task`, Codex spawn hook) fail-open;
      agents pane; agent info/hover cards; orchestrator usage descriptions.
      Covers: R10, R11, R12, R13; checks: A7.
- [ ] Phase 5: Workspace panes and dev servers
      Done when: e2e drags Terminal under Browser, restarts, layout restored; fixture project with
      `dev` script is detected, Start shows logs and the Browser pane loads the URL; files/editor/
      diff/tasks panes render fixtures.
      Steps: dockview layout + persistence; Files (chokidar), Editor (CodeMirror 6 + Shiki),
      Diff, Browser (webview + URL bar + devtools), Terminal (node-pty + xterm), Tasks, Servers
      (detectors: launch.json, package.json, pyproject/manage.py, docker-compose; port probe).
      Covers: R16, R17, R18; checks: A5.
- [ ] Phase 6: Settings hub and prerequisites
      Done when: nav test lists every section id; MCP/skills/plugins edits round-trip on temp
      homes for Claude and Codex; API key stored via safeStorage, absent from files/logs;
      setup panel shows steps with confirm + visible console (unit-tested gate).
      Steps: port Omnigent settings sections; add Harnesses/MCP/Skills/Plugins/Tools/API keys/
      Dev servers/Diagnostics; Claude plugin management via headless `claude` commands + file
      edits; Codex config.toml editor; **two-way sync** (chokidar watchers on `~/.claude`,
      `.claude/`, `~/.codex`, plus the backends' live lists; app edits write the backends' own
      files); global settings hub separate from per-backend config with per-agent overrides;
      bootstrap panel (reuse the Omnigent-windows pattern).
      Covers: R3, R19, R20, R21, R28, R29, R30; checks: A9, A14.
- [ ] Phase 7: Projects, worktrees, git, imports (M2)
      Done when: create a worktree from the composer chip, session runs in it, diff pane shows
      changes, commit from the UI; import a Claude Code and a Codex transcript into sessions.
      Steps: projects store; worktree ops (simple-git); git status/commit UI; import parsers.
      Covers: P8, P9.
- [ ] Phase 8: Tasks, Inbox, Usage, Automations (M3–M4)
      Done when: Tasks page lists agent todos across sessions; Inbox shows needs-input/finished
      items with toasts + badge; Usage page aggregates fixture events; an automation scheduled
      "every minute" runs a prompt and appears in Inbox.
      Steps: port pages from reference; scheduler (node-cron-style, persisted); notifications.
      Covers: P10–P13, R23.
- [ ] Phase 9: MCP catalogue, sharing, members, policies, approvals (M5–M6)
      Done when: session MCP servers page adds a stdio server and its tools appear in the slash
      menu; Sharing exports a session bundle (HTML/JSON) and re-imports; Members/Policies/Approve
      pages render and gate tool permissions locally.
      Steps: port pages; local policy engine (allow/deny/ask per tool pattern); share bundles.
      Covers: P14–P17.
- [ ] Phase 10: Dictation, hosts (local), terminal attach, extensions (M7)
      Done when: mic button dictates into the composer (Windows Speech or whisper.cpp local);
      Hosts page shows this machine's harness statuses; Terminal attach opens the raw `claude` /
      `codex` CLI in a pane; a sample extension page loads.
      Covers: P18–P20.
- [ ] Phase 11: Efficiency pass
      Done when: request-capture tests prove cache_control on system+tools; compaction triggers
      at threshold on a fixture; tool outputs >64 KB truncated with stub; benchmark script
      reports ≤110 % of the CLI baseline for the 20-turn session, numbers in `docs/benchmarks.md`.
      Steps: baseline measurement first (CLI via SDK vs our app on identical prompts); then
      caching, compaction, lazy MCP schemas, IPC noise audit.
      Covers: R24, R25, R26, G9.
- [ ] Phase 12: Packaging, updater, CI, docs, parity audit, release
      Done when: `pnpm build:win` yields installer + portable + latest.yml; release workflow
      publishes on tag; updater finds the release from an older build; README/ARCHITECTURE/
      COMPAT written; adversarial review wave (correctness, security, UX, parity) two clean rounds.
      Covers: R4, G8, G10; checks: A10.

## Verification

- `pnpm test` — vitest unit/UI tests (engine, dispatcher, db, renderer components).
- `pnpm e2e` — Playwright Electron: launch, landing, prompt→reply, drag pane, restart persistence.
- `pnpm spike` — Phase 1 capability proof (kept as a regression check against SDK upgrades).
- `pnpm bench` — Phase 11 token benchmark.
- Manual: the user launches `capygen.exe`, types a task, sees the capybara react and the reply.

## Risks, Landmines & Adaptations

- Claude Agent SDK stream may not expose the slash menu list → Phase 1 records it; fallback:
  build the list from `~/.claude` + `.claude` + plugin manifests ourselves (files are readable).
- `codex app-server` is experimental (verified: help text) → pin the Codex CLI version in
  COMPAT.md; fallback `@openai/codex-sdk` (thread API) for the same operations.
- Omnigent tokens/CSS reuse — Tailwind 4 `@theme` tokens copy cleanly [assumed] → Phase 2 step 3
  verifies the landing renders with the copied `index.css`.
- Mascot generation may be unavailable/paid → code-drawn pixel art fallback in Phase 2.
- Font license unverified → wordmark shipped as SVG if bundling is not allowed (SPEC).
- node-pty / better-sqlite3 native builds under Electron 44 → `electron-rebuild` in postinstall;
  verify in Phase 2 before anything depends on them.
- Round-table loops and token blow-ups → hop cap + per-session budget alert (R11, R23).

## Assumptions Ledger

| ID | Assumption | Basis | Blast radius if wrong | Check |
|----|-----------|-------|----------------------|-------|
| A1 | Repo at `GITHUB\capygen`, product name capygen, updater repo `leobbaroni/capygen` | user name; mirrors prior project | publish block + docs | Phase 12 |
| A2 | Claude Agent SDK gives text/tool/permission/AskUserQuestion/hook events headless on Windows | SDK description (npm) | engine design | Phase 1 |
| A3 | `codex app-server` JSON-RPC covers threads, turns, approvals, usage | help text shows it exists | Codex harness | Phase 1 |
| A4 | API models need our own tool runtime (no harness) | nature of raw APIs | engine size | Phase 3 |
| A5 | dockview 8 handles dock/stack/float/persist | npm version | pane layer | Phase 5 |
| A6 | Omnigent Tailwind 4 tokens copy verbatim | same stack (verified) | look parity | Phase 2 |
| A7 | Round-table rules: mentions, lead fallback, 3-hop cap | stated in interview, unvetoed | dispatcher | Phase 4 |
| A8 | Mascot: 8 states, 96 px sprite, CSS steps; generated image or code-drawn | user brief | landing only | Phase 2 |
| A9 | Plugin/skill management via headless `claude` CLI + file edits is sufficient | CLI exposes `/plugin`; files readable | settings hub | Phase 6 |
| A10 | Unsigned builds acceptable (SmartScreen warns) | prior project | install UX | Phase 12 |
| A11 | Font may be bundled | no license found | wordmark | Phase 2 (SVG fallback) |
| A12 | Local-only members/policies/sharing satisfy parity | scope: no cloud | M6 depth | Phase 9 |
| A13 | MCP App widget HTML can be fetched by capygen's own MCP client for CLI-hosted servers (or via the backend's resource read) | ext-apps host model (verified: npm readme); SDK exposes resource_links only | widget rendering (R31) | Phase 3 spike |
| A14 | Backend config files are the source of truth for plugins/skills/MCP; watchers + live lists keep the app in sync | user rule (R29) | settings hub design | Phase 6 |

## Open Items (none blocking)

- OpenCode / Gemini / other CLIs as backends — proceed without; harness interface leaves room.
- Code signing certificate — proceed unsigned.

## Interview Ledger

- Q1 build strategy → clean TypeScript rewrite (user; changed Approach, Scope, Phases).
- Q2 backends → Claude + Codex + API models (user; changed R7–R9, Phase 3).
- Q3 collaboration → round-table first + solo, both route (user; changed R10–R12, Phase 4).
- Q4 finish line → full parity (user; changed Scope, P-table, Phases 7–10).
- Q5 checkpoint → SDK-first holds (user; confirmed Phase 1 shape).
- Q6 approval → approved with name/mascot/font/efficiency amendments (user; changed Design
  Reference, R23–R26, Phase 2/11).
Count: 6; none failed the necessity test.
