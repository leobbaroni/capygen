# capygen — PLAN

One-line goal: see SPEC.md. This file is the build order; SPEC.md is the contract.

UX repair evidence: [`docs/plans/2026-09-08-ux-repair.md`](docs/plans/2026-09-08-ux-repair.md).
The repair is committed at `1a429b3`; the resumed run verifies it before continuing remaining acceptance work.

## Current State

- Phases 1–9 and 9C are accepted. Work and verified pushes use `main`.
- Phase 9C gate: typecheck/build passed; 2815 unit tests passed / 4 skipped;
  54 native Electron tests passed / 12 live tests skipped. See `PROJECT_LOG.md` for evidence.
- Phases 10–12 remain open. Microphone acceptance awaits the user's test result.
  The user reauthorized Phase 11 live benchmark work on 2026-09-08; dedicated test login is pending.
- Packaging and packaged smoke have passed; actual older-build/private-feed, release,
  full CI and final review evidence remain required for Phase 12 acceptance.

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

## Crew (current user instruction, 2026-09-08)

| Role | Model | Responsibility |
|---|---|---|
| Lead / orchestrator / designer / decision maker | **GPT-6-Astra**, low (`gpt-6-astra`) | orchestration, plans, design, hard/medium implementation, core decisions, task briefs, final acceptance |
| Hard and medium tasks | **GPT-6-Astra**, low (`gpt-6-astra`) while Opus is unavailable | implementation and substantive reviews |
| Easy tasks | **GPT-5.6-Luna**, low (`gpt-5.6-luna`) | mechanical work, inventories, established UI plumbing |
| Core decisions | **GPT-6-Astra**, low | owns architecture and policy decisions; no Fable debate |
| Independent review | different model from implementer when available | lighter reviews and new crucial tests; root performs full-gate and phase acceptance |

The original Fable/Opus/Sonnet crew built Phases 1–6. Its workflow scripts remain historical
records, not a current model-routing configuration. Preflight actual availability and never
silently substitute models. Review status and failed Claude attempts are recorded in
`docs/reviews/phase1-6.md`; the next-phase execution sequence is in `docs/plans/phases7-12.md`.

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
- [x] Phase 3: Harness layer complete
      Done when: fixture tests pass for all three harnesses (Claude, Codex, API model with a
      mocked API) rendering every block type; live smoke: Codex answers; slash menu lists
      built-ins + Claude skills/plugins; permission and AskUserQuestion cards round-trip;
      usage meter updates per turn.
      **Done (2026-09-06).** `createHarnessForBackend` is the registry `SessionRunner` builds
      every agent through, so the composer's backend/model choice is what decides which backend
      runs. Block parity is a table in `@capygen/shared` (`BACKEND_BLOCK_PARITY`) that two suites
      read: `apps/desktop/test/blockParity.test.ts` (recorded stream -> real runner -> persisted
      rows, per backend) and `apps/renderer/src/components/blocks/blockParity.test.tsx` (RTL, one
      card per kind). Live: `tests/e2e/harnesses.spec.ts` -- Codex picked in the composer answers
      "pong" with a usage line (`e2e-out/codex-pong.png`), a Codex shell approval renders a
      permission card whose Allow runs the command (`e2e-out/codex-permission.png`,
      `e2e-out/codex-allowed.png`), and `/` lists Built-ins plus this machine's real
      `/cockpit:*` plugin commands (`e2e-out/slash-menu.png`). Gate: typecheck clean,
      `pnpm test` 494/494, `pnpm build` clean, `pnpm e2e` 11 passed + 1 skipped.
      Deviations, all recorded rather than hidden:
      * **API backend is not live-proven.** This machine has no Anthropic/OpenAI/OpenRouter key,
        so the fourth e2e skips with the reason. It is covered by mocked-provider tests
        (`packages/engine/test/api*.test.ts`) and by a desktop test that drives the *default*
        harness factory and asserts an `api` turn fails at "No API key for anthropic" -- i.e. it
        reached capygen's own loop, not Claude.
      * **Elicitation now round-trips** (Codex `mcpServer/elicitation/request`). That needed an
        `elicitation` variant on `EngineEvent` and an optional `Harness.answerElicitation`, which
        the Phase 3 sub-tasks had each recorded as blocked; the previous auto-decline is gone.
      * **Sub-agent blocks are Claude-only** and Codex/API say so in the parity table
        (`capabilities().subagents === false`); Phase 4 owns them.
      * `harness.list` probes for real -- `claude --version` + a login file, Codex
        `account/read {refreshToken:true}` (the only check a dead token fails), a stored/env API
        key -- and is deliberately **not** awaited by the renderer's bootstrap, so the G1 3 s
        landing budget survives the Codex child spawn.
      Steps: `Harness` interface (start, send, interrupt, resume, listCommands, capabilities);
      Codex app-server client; API-model agent loop + local tool runtime + MCP client;
      permission modes; block renderer parity with reference `components/`; usage accounting;
      **MCP Apps widget host** (spike first: how the widget's `ui://` HTML is obtained for
      servers the CLI hosts — own MCP client connection to the same server config, or the
      backend's resource read — then the sandboxed iframe host with the ext-apps bridge;
      fixture = ext-apps basic example; live = user's Higgsfield connector); structured
      interaction cards for AskUserQuestion / permission / elicitation / Codex approvals.
      Covers: R6, R7, R8, R9, R14, R23, R27, R31, R32; checks: A4, A13.
- [x] Phase 4: Round-table and orchestration
      Done when: e2e: a session with Claude + Codex, "@codex review what @claude wrote" produces
      two turns in order; hop cap stops a ping-pong at 3; agent tree shows a routed sub-agent;
      Agent info card shows description/tools/model/cost and the other agents.
      Steps: session modes + mode switch; dispatcher (mentions, lead fallback, hop cap, queue);
      sub-agent routing policy (PreToolUse hook for Claude `Task`, Codex spawn hook) fail-open;
      agents pane; agent info/hover cards; orchestrator usage descriptions.
      Covers: R10, R11, R12, R13; checks: A7.
      **Accepted 2026-09-06** — all four Done-when clauses hold live in
      `tests/e2e/roundtable.spec.ts` (5/5); gate: typecheck, 696 unit tests, build, 16/17
      Playwright (1 skipped: the API-key case, which has no key on this machine). Deviations:
      * The **hop cap** is proved offline (`CAPYGEN_ENGINE=stub-roundtable`, an echo double whose
        every reply @-mentions the next agent) rather than with live models. A loop bound must not
        be proved with something that may choose to stop by itself; the dispatcher under test is
        the shipping one, only the models are fake.
      * The **Codex spawn hook** in the Steps line does not exist and cannot: `codex app-server`
        takes MCP servers from the user's `~/.codex/config.toml`, and capygen will not write one
        behind their back. A Codex agent with a cross-backend routing rule fails open onto its own
        model (R12's own promise). Recorded in ADR-0004; the opt-in config write is Phase 6.
      * Codex sub-agent blocks carry **no cost**: a sub-agent's `thread/tokenUsage/updated` frames
        are filtered out upstream, and R23 forbids a guess. Claude's do (`delegate_task` bills the
        delegated turn to the parent's usage).
      * `agents.describe`'s `capabilities`/`tools` need a **running** harness, so an agent that has
        not taken a turn shows "Not reported yet" instead of a config-derived list.
      * Landed here rather than in Phase 6: `agent.config.<backend>.permissionMode` now outranks the
        global setting (it was dead — `HarnessAgent.permissionMode` is the higher priority).
- [x] Phase 5: Workspace panes and dev servers
      Done when: e2e drags Terminal under Browser, restarts, layout restored; fixture project with
      `dev` script is detected, Start shows logs and the Browser pane loads the URL; files/editor/
      diff/tasks panes render fixtures.
      Steps: dockview layout + persistence; Files (chokidar), Editor (CodeMirror 6 + Shiki),
      Diff, Browser (webview + URL bar + devtools), Terminal (node-pty + xterm), Tasks, Servers
      (detectors: launch.json, package.json, pyproject/manage.py, docker-compose; port probe).
      Covers: R16, R17, R18; checks: A5.
      **Accepted 2026-09-06** — every Done-when clause holds in `tests/e2e/workspace.spec.ts`
      (7/7, entirely offline on `CAPYGEN_ENGINE=stub`): (a) Files -> Editor -> Ctrl+S changes the
      bytes on disk, (b) Diff shows that file, (c) a recorded `TodoWrite` becomes Tasks rows,
      (d) `echo capy` comes back out of a real ConPTY, (e) the Terminal tab is dragged under the
      Browser group with the mouse and the group tree survives an app restart, (f) the fixture's
      `dev` script is detected, Start streams its log and the Browser pane's native view loads the
      URL it printed, (g) the native view's bounds track the placeholder to 2px through a maximise
      and a window resize. Gate: typecheck (6 projects), 952 unit tests, build, 22/23 Playwright
      (1 skipped: the API-key case, no key on this machine). Deviations:
      * **Editor uses CodeMirror 6 only — no Shiki.** The Steps line said "CodeMirror 6 + Shiki";
        the pane highlights through `@codemirror/lang-*` + `@lezer/highlight` tags mapped onto
        capygen's own tokens. A second highlighter would be a second grammar set for the same
        text with nothing to gain, and Shiki's WASM is a big renderer dependency.
      * **Browser is a native `WebContentsView`, not a "webview".** `<webview>` is deprecated;
        Omnigent's own pane does the same thing. Consequence: the view floats above the DOM, so
        the pane must ship its bounds on every move — (g) is the assertion that it does.
        Consequence two: **a hidden tab detaches the view**, so switching to another tab in the
        Browser's group and back re-navigates to the same URL and loses the back/forward history.
        Keeping it alive needs a "park it off-screen" mode the contract does not have.
      * **Terminals are not persisted.** A `node-pty` handle cannot outlive the app, so
        `TerminalInfo` is in-memory only and a restart restores the *pane*, not the shell
        (migration 0004 has no `terminals` table, deliberately).
      * **Float has no menu affordance.** Dockview's tab context menu (float/popout) needs the
        paid `dockview-enterprise` ContextMenu module; drag-out still floats a tab. A5 is held on
        dock/stack/reorder/maximise/persist, all of which are proved.
      * **Tasks are derived, never asked for.** `TodoWrite` and Codex plan blocks are read off the
        transcript by a broadcast tap; no model is prompted for a plan (R26). `TaskSource` still
        has no `"subagent"` value, so a delegated sub-agent can only *close* a matching task, not
        create one — noted for whoever next owns the shared contract.
      * **The Codex plan path is unit-tested, not live**: `CodexHarness` does not yet map
        `turn/plan/updated` to a block, so `readPlan` has nothing to observe from a real backend.
- [x] Phase 6: Settings hub and prerequisites
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
      **Accepted 2026-09-06.** All four Done-when clauses hold:
      * *nav test lists every section id* — `tests/e2e/settings.spec.ts` (a): the 22 ids in
        `apps/renderer/src/shell/settingsNav.tsx`, restated in the spec rather than imported from
        it, and each one routed to a non-empty body.
      * *MCP/skills/plugins edits round-trip on temp homes for Claude and Codex* —
        `packages/engine/test/configStores.test.ts` (38) covers every write on temp homes for both
        backends (`.claude.json` via the CLI, `.mcp.json` directly, `skillOverrides`, plugin
        enable/disable, and the TOML patcher); e2e (b) then adds a server **in the UI** and has
        `claude mcp list` — the CLI, pointed at the same temp home — print it back, and (d) does
        the Codex half with every pre-existing comment intact.
      * *API key stored via safeStorage, absent from files/logs* — e2e (e): every file in the
        profile and both backend homes is read byte-for-byte, and the log too; `secrets.has`
        answers `{has:true, source:"stored"}`.
      * *setup panel shows steps with confirm + visible console (unit-tested gate)* —
        `apps/desktop/test/prereqsRunGate.test.ts` (10) + `prereqsIpc.test.ts` (13); e2e (f)
        prunes every `codex`-bearing directory off `PATH`, sees the step, clicks **Run…** and
        proves from the app's own log that the dialog was built for that exact command and that
        the console launcher was never reached.
      Two-way sync (R29) is proved in both directions e2e: (c) an outside edit to the isolated
      `settings.json` reaches the Tools table inside 3 s, and (d) an outside `[mcp_servers.…]`
      block reaches the MCP page. A9 holds (plugins/skills/MCP through the headless `claude` CLI
      plus file edits — no gap found); A14 holds (files are the source of truth; watchers plus the
      CLIs' live lists keep up).
      Isolation, which every one of those depends on: `CAPYGEN_CLAUDE_CONFIG_DIR` /
      `CAPYGEN_CODEX_HOME` (`apps/desktop/src/win/configHomes.ts`) are applied to `process.env` in
      `main.ts` before anything reads it, so the config stores, the watchers and **every child
      process** (`cleanEnv`) see the temp homes. The app logs the mapping once and (a) asserts on
      that line, so a run that quietly used the real `~/.claude` cannot pass as an isolated one.
      Deviations, recorded rather than hidden:
      * **At Phase 6 acceptance, the live Claude case skipped on this machine.** e2e (b2) — "a new Claude session's
        tool list contains the server's tools" — needs a signed-in Claude, and a sign-in cannot be
        isolated: `CLAUDE_CONFIG_DIR` relocates `.credentials.json` too. Copying the real one into
        a temp home is *worse* than a config write — the SDK refreshes it there, the refresh
        rotates the token server-side, and the new one lands in a directory the test deletes,
        logging the real Claude Code out. So (b2) runs against the real home with the server at
        **project** scope (`<tempProject>/.mcp.json`, plus `enableAllProjectMcpServers` in that
        project's own `.claude/settings.json`) and re-checks the real home's mtimes at the end —
        and skips when the machine's OAuth session is unusable, which it is here: this machine's
        `~/.claude/.credentials.json` holds **empty** token strings (a Claude Code host refreshes
        auth out of process), and `claude -p` outside that host answers `Failed to authenticate`.
        The half that does *not* need a model is proved instead and never skips: (b3) has
        capygen's own MCP client connect to the server it just registered and read its two tools.
      * That same discovery fixed a real bug rather than only a test:
        `claudeSignInSignal` treated the *existence* of `.credentials.json` as a login, so the New
        Session picker offered a backend whose every turn 401s. It now reads three fields (never
        returning or logging any token): both token strings must be non-empty and
        `refreshTokenExpiresAt` must not be past; `expiresAt` is ignored, because an expired
        access token is the normal state between refreshes; and an unparseable or unrecognised
        credential shape still counts as a login, so a working machine cannot be locked out.
        Consequence for the suite: the Claude-dependent tests in `harnesses`/`roundtable` and (new
        here) `skeleton`/`widget` now **skip in seconds with the reason** instead of failing after
        a 150 s timeout — `tests/e2e/claudeAvailability.ts`.
      * **Dev servers has no `GlobalSettings.devServers` field**; review commit `2222cd6`
        removed its inactive localStorage controls. The section now names the future phase.
      * **Codex/API local per-tool policy rows are not enforced yet.** Review commit
        `2222cd6` replaced their editors with a Phase 9 note. Native permission modes still
        apply; do not describe persisted local policy rows as an enforcement mechanism.
      * **`integrations.list` takes no `projectId`**, so project-scope rows are read for the
        most-recently-touched project (`projects.list()` is `updated_at DESC`); the watchers
        re-point when it changes.
      * **Plugin install/uninstall is Claude-only** (A9); the other backends refuse by name.
      * `PrereqsSection.tsx` and `PrereqPanel.tsx` were built in parallel and are **not**
        de-duplicated: the section keeps its own inline step list, the panel is what the landing
        `SetupBanner` renders.
      * `import`/`updates`/`members`/`policies`/`sharing` render placeholders naming the phase
        that fills them (7, 12, 9) — R19 asks for the ids, and inventing behaviour those phases
        own would be worse than saying so.
- [x] Phase 7: Projects, worktrees, git, imports (M2)
      Prerequisite: corrective batch R-A–R-E in `docs/plans/phases7-12.md`; close runtime
      settings/MCP and project-scope gaps before widening project/worktree operations.
      Done when: create a worktree from the composer chip, session runs in it, diff pane shows
      changes, commit from the UI; import a Claude Code and a Codex transcript into sessions.
      Steps: projects store; worktree ops (simple-git); git status/commit UI; import parsers.
      Covers: P8, P9.
      Accepted 2026-09-07: native worktree composer → session cwd → Diff → selected-file
      commit and both native transcript imports/restart are proved by worktrees.spec.ts and
      imports.spec.ts. Scoped MCP fixture coverage verifies real tools/widgets; unsupported
      Claude user/local cwd/disable writes are refused before mutation (COMPAT.md).
      Final shared gate with Phase 8: 1883 unit tests passed, 4 skipped; 46 Playwright passed,
      12 skipped; typecheck and build passed. Packaged SDK smoke remains Phase 12 work.
- [x] Phase 8: Tasks, Inbox, Usage, Automations (M3–M4)
      Done when: Tasks page lists agent todos across sessions; Inbox shows needs-input/finished
      items with toasts + badge; Usage page aggregates fixture events; an automation scheduled
      "every minute" runs a prompt and appears in Inbox.
      Steps: port pages from reference; scheduler (node-cron-style, persisted); notifications.
      Covers: P10–P13, R23.
      Accepted 2026-09-07: activity.spec.ts runs the real every-minute timer through normal
      dispatch with an offline engine, verifies cross-session todos, fixture usage, Inbox and
      badge, then restarts to prove persistence/no duplicate completion. Inbox requests and
      native toast rules have focused tests. Recurrence covers DST/month ends, durable claims
      prevent overlap, and unknown costs remain explicit. Full gate: typecheck/build passed;
      144 unit files, 1883 passed/4 skipped; 46 Playwright passed/12 skipped.
      Historical stop point completed; the user has now authorized Phase 9 onward.
- [x] Phase 9: MCP catalogue, sharing, members, policies, approvals (M5–M6)
      Done when: session MCP servers page adds a stdio server and its tools appear in the slash
      menu; Sharing exports a session bundle (HTML/JSON) and re-imports; Members/Policies/Approve
      pages render and gate tool permissions locally.
      Steps: port pages; local policy engine (allow/deny/ask per tool pattern); share bundles.
      Covers: P14–P17.
- [x] Phase 9C: Custom Mode (user addition, R33–R34)
      Done when: a selected agent generates a reviewable mode from a prompt; visual and JSON
      editors round-trip the same complete policy; validation rejects malformed/unavailable
      assignments; Apply persists the mode; task/difficulty routes and conditional same-chat
      round-table debate execute under existing permission/hop/budget limits; restart preserves
      mode and history. Offline fixtures exercise the exact example from the user's diagram.
      Steps: Astra contract review; versioned declarative policy schema; generator draft
      and preview; visual/text editors; route/debate runtime; persistence and e2e.
      Dependencies: Phase 9 permissions and cross-backend delegation proof.
      Accepted 2026-09-08: native isolated draft generation → visual edit → Apply → restart
      preserves policy/history; classified diagram routes and bounded same-chat debate pass
      focused runtime fixtures. Full gate: typecheck/build pass, 2815 unit tests passed / 4
      skipped, 54 native Electron tests passed / 12 live skipped (2.3m).
- [ ] Phase 10: Dictation, hosts (local), terminal attach, extensions (M7)
      Done when: mic button dictates into the composer (Windows Speech or whisper.cpp local);
      Hosts page shows this machine's harness statuses; Terminal attach opens the raw `claude` /
      `codex` CLI in a pane; a sample extension page loads.
      Covers: P18–P20.
      Implementation: native extension test and packaged raw Codex terminal/speech metadata
      smoke pass (2026-09-08); user-observed microphone transcription remains pending.
- [ ] Phase 11: Efficiency pass
      Done when: request-capture tests prove cache_control on system+tools; compaction triggers
      at threshold on a fixture; tool outputs >64 KB truncated with stub; benchmark script
      reports ≤110 % of the CLI baseline for the 20-turn session, numbers in `docs/benchmarks.md`.
      Steps: baseline measurement first (CLI via SDK vs our app on identical prompts); then
      caching, compaction, lazy MCP schemas, IPC noise audit.
      Covers: R24, R25, R26, G9.
      Implementation: bounded API summarizer and SQL text projection fixtures pass; paired
      benchmark runner is ready, real dedicated-auth measurements remain unavailable.
- [ ] Phase 12: Packaging, updater, CI, docs, parity audit, release
      Done when: `pnpm build:win` yields installer + portable + latest.yml; release workflow
      publishes on tag; updater finds the release from an older build; README/ARCHITECTURE/
      COMPAT written; adversarial review wave (correctness, security, UX, parity) two clean rounds.
      Covers: R4, G8, G10; checks: A10.
      Implementation: integrated Windows installer/portable/feed audit and packaged smoke pass;
      private updater + tag CI written. Actual older-build/private-feed/release proof pending.

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
| A5 | dockview 8 handles dock/stack/float/persist | npm version | pane layer | Phase 5 — **held, with one asterisk**: dock/stack/reorder/maximise/persist all proved e2e on dockview-react 8.2.0; *float* works only by dragging a tab out, because the context-menu affordance for it lives in the paid `dockview-enterprise` module |
| A6 | Omnigent Tailwind 4 tokens copy verbatim | same stack (verified) | look parity | Phase 2 |
| A7 | Round-table rules: mentions, lead fallback, 3-hop cap | stated in interview, unvetoed | dispatcher | Phase 4 — **held**: shipped and proved e2e; the cap is per-session (`settings.hopCap`) |
| A8 | Mascot: 8 states, 96 px sprite, CSS steps; generated image or code-drawn | user brief | landing only | Phase 2 |
| A9 | Plugin/skill management via headless `claude` CLI + file edits is sufficient | CLI exposes `/plugin`; files readable | settings hub | Phase 6 — **held**: `claude mcp add/remove`, `claude plugin list/install/uninstall/enable/disable --json`, `claude plugin marketplace list --json` all verified live against 2.1.261, with `.mcp.json`, `settings.json` `permissions`/`skillOverrides` and `config.toml` edited as files. Two gaps recorded, neither fatal: `claude mcp list` has **no `--json`** (text-parsed, enrich-only) and there is no `mcp update` (remove-then-add) |
| A10 | Unsigned builds acceptable (SmartScreen warns) | prior project | install UX | Phase 12 |
| A11 | Font may be bundled | no license found | wordmark | Phase 2 (SVG fallback) |
| A12 | Local-only members/policies/sharing satisfy parity | scope: no cloud | M6 depth | Phase 9 |
| A13 | MCP App widget HTML can be fetched by capygen's own MCP client for CLI-hosted servers (or via the backend's resource read) | ext-apps host model (verified: npm readme); SDK exposes resource_links only | widget rendering (R31) | Phase 3 spike |
| A14 | Backend config files are the source of truth for plugins/skills/MCP; watchers + live lists keep the app in sync | user rule (R29) | settings hub design | Phase 6 — **held**, both directions proved e2e (an outside `settings.json` edit reaches the Tools table in <3 s; an outside `config.toml` block reaches the MCP page; a UI add is printed back by `claude mcp list`). One asterisk: `chokidar.watch()` returns **before** its initial scan, so with `ignoreInitial: true` an edit inside that window is silently dropped — the watcher must be awaited to `ready` |

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

## Execution amendment — 2026-09-07 (latest)

The user resumes all remaining phases after accepted Phase 8: 9, 9C and 10–12.
Work on main; commit by task and push verified updates to origin/main, never force-push.
Astra low leads and decides; Opus 5 medium implements hard/medium tasks; Luna low handles
simple tasks. Different-model review remains required; no Fable debate. Root alone stages
and commits during parallel work. Historical acceptance and decision records remain evidence.
Live test prompts use only GPT Luna low / Sonnet 5 low, with dedicated test homes and
resolved model/effort recorded. Fixture tests remain model-free; no silent substitutions.
