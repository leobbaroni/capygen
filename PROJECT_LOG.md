# PROJECT_LOG.md

## 2026-09-05 — Kickoff (plan)
- Grilling interview (6 questions): TypeScript rewrite; Claude + Codex + API models; round-table
  + solo modes with routed sub-agents; full Omnigent parity as v1 (staged M1–M7); SDK-first
  engine; name capygen, pixel capybara mascot, CheGuevaraBarry-Brown wordmark; efficiency
  requirement. See PLAN.md §Interview Ledger.
- Wrote SPEC.md, PLAN.md, CONTEXT.md, ADR-0001/0002, CLAUDE.md. Vendored Omnigent
  `main@44378d6` SPA sources + server routes + openapi + docs under `reference/omnigent/`
  (Apache-2.0, NOTICE kept). Copied the wordmark font to `assets/fonts/`.
- Machine: Claude Code 2.1.261 and Codex CLI 0.139.0 signed in natively; no API keys in env.

- Phase 1 / Codex spike: `packages/engine/scripts/spike-codex.ts` + `docs/spikes/codex-shapes.md` (SDK 0.153.4 `.d.ts`, app-server JSON-RPC bindings generated under `docs/spikes/codex-app-server-schema/`). app-server handshake/thread/turn/discovery proven on the wire; every model call fails with `codexErrorInfo:"unauthorized"` because the ChatGPT refresh token in `~/.codex/auth.json` is invalid (failing since 2026-09-03 per the Codex log DB) — user must run `codex logout` + `codex login`, then re-run `corepack pnpm --dir packages/engine exec tsx scripts/spike-codex.ts`. SDK has no approval hook (PARTIAL by design); codex 0.153.4 `exec` rejects `approval_policy="untrusted"`.
- Phase 1 consolidation: `packages/engine/scripts/spike-engine.ts` runs both probes as tsx children behind `corepack pnpm spike` (root script now `corepack pnpm --filter …` — bare `pnpm` is not on PATH under corepack) and printed `SPIKE 8 PASS, 1 PARTIAL, 4 FAIL` (Claude 7/7 PASS in 89 s; Codex: discovery PASS, SDK approval PARTIAL by design, auth/turn/approval FAIL on the dead ChatGPT sign-in). Table, shapes index, usage and per-capability fallbacks: `docs/spikes/engine.md`. PLAN.md Phase 1 stays unchecked until `codex login` + `corepack pnpm spike --only codex`.

## 2026-09-05 — Phase 1: engine spike
- Phase 1 (Claude half): `packages/engine/scripts/spike-claude.ts` proves, headless against the signed-in Claude Code 2.1.261 via `@anthropic-ai/claude-agent-sdk` 0.3.261: stream text, system init (92 slash commands incl. `cockpit:pilot`, 3 plugins, 56 skills), `/context` (structured `context_usage`), `/cockpit:pilot` executed, AskUserQuestion answered through `canUseTool.updatedInput.answers`, PreToolUse hook on the subagent tool (fires as `tool_name: 'Agent'`), usage/cost on every result. All 7 CAP lines PASS. Shapes + citations: `docs/spikes/claude-sdk-shapes.md`; raw stream: `docs/spikes/claude.raw.json` (gitignored).
- Adversarial verify (Opus): all 7 Claude capabilities reproduced live; Codex blocked only by the dead ChatGPT refresh token. Refuted gates to tighten: plugin_command PASS predicate (matches "phase|plan" text, not the expansion), usage gate accepts all-zero, PreToolUse routing lever (updatedInput/permissionDecision) unproven; ~24 `.d.ts` line citations off; raw evidence gitignored/overwritten. Follow-ups tracked in Phase 2 workflow (spike-fixes task).
- Mascot v2 (real capybara face, yuzu, pink hoodie) replaced the visor version at the user's request; crew rule recorded (Fable orchestrates; Opus 5 hard / Sonnet 5 mechanical).
- Kept only `docs/spikes/codex-app-server-schema/v0.153.4-ts` (1.8 MB); JSON bundles and 0.139.0 bindings gitignored/removed.

## 2026-09-05 — Phase 2 / A1: foundation (monorepo, shell, contracts, db, renderer skeleton)
- Monorepo stood up: root scripts (`dev` `build` `start` `test` `typecheck` `e2e`, `spike` kept),
  `tsconfig.base.json`, `vitest.config.ts` (projects: shared/db/desktop), Playwright via
  `_electron` (no browser download). `apps/desktop` (esbuild → `dist/main.cjs` + `preload.cjs`),
  `apps/renderer` (Vite 8 + React 18 + Tailwind 4 + shadcn/ui), `packages/shared`, `packages/db`.
- SQLite driver decision (ADR-0003): **`node:sqlite` (`DatabaseSync`)**, not better-sqlite3 —
  measured available in Electron 44.2.0 / Node 24.20.0 and in the Node 22.16 test runner, so no
  `@electron/rebuild`, no asarUnpack, no native toolchain anywhere. `electron -e "…"` does NOT
  evaluate (Electron treats argv[1] as an app path); the probe is a real app dir.
- `packages/shared`: zod domain model (Project/Session/Agent/Turn/Block union/UsageEvent/Settings)
  + the IPC contract as two typed maps (15 invoke channels, 6 events) + `defineIpc`, used by the
  preload and the renderer. `z.config({ jitless: true })` is mandatory: the renderer's CSP
  (`script-src 'self'`) blocks zod's JIT `new Function`, which failed every parse on both sides of
  the bridge ("Code generation from strings disallowed for this context"). Regression test added.
- `packages/db`: `0001_init.sql` covering SPEC §Data (blocks table generalises `tool_calls`, which
  survives as a VIEW); migrator copies the DB file before applying anything, read-only peek so the
  backup is untouched. Repositories + 21 tests on a real temp file. Bug found and fixed by test:
  turn/block ordering tie-broke on a random UUID within the same millisecond — now `rowid`.
- `apps/desktop`: single instance, seamless chrome ported from Omnigent-windows `chrome.js`
  (hidden title bar + caption buttons blended to the sampled page colour), tray with
  Open/New Window/Quit + close-to-tray, rotating redacting logger, window-state persistence,
  `--project=<dir>` / `CAPYGEN_PROJECT_DIR`, and all 15 IPC handlers over a 300 ms echo stub engine.
- `apps/renderer`: Omnigent tokens copied verbatim with the Apache-2.0 attribution, AppShell +
  sidebar, landing (capybara + "What should we build?" + composer), chat page with a per-kind
  block renderer, settings nav listing all 20 R19 section ids, zustand store, hash router.
  Brand assets are staged from `assets/` by `scripts/sync-assets.ts`; `public/` is gitignored.
- Checks: install ok · typecheck ok (6 projects + e2e specs) · `pnpm test` 73 passed ·
  `pnpm build` ok · `pnpm e2e` 4 passed, `e2e-out/landing.png` + `chat.png` saved.

## 2026-09-05 — Spec corrections (user)
- R28–R32 added: manage plugins/skills/MCP servers (ComfyUI, Higgsfield, connectors)/tools from the app for every backend; two-way sync with Claude/Codex config files (backend files are the source of truth); one global Settings hub separate from per-backend config; MCP App widgets (ext-apps `ui://` resources) rendered in the transcript like Claude Code desktop; structured interaction cards (AskUserQuestion, permissions, elicitation, Codex approvals). PLAN Phases 3 and 6 extended; A13/A14 added.
- User completed `codex login`; Codex spike re-run: codex-auth, sdk-runStreamed-pong, sdk-resumeThread, appserver-thread-turn-stream, appserver-thread-resume, appserver-command-approval (item/commandExecution/requestApproval → accept), appserver-discovery all PASS; sdk-command-approval PARTIAL by design. Phase 1 ✅ (engine.md table to be refreshed by the next spike run; Sonnet owns that file in the running Phase 2 workflow).

## 2026-09-06 — Phase 3 / D: review fixes

Fixed the verified findings from the Phase 3 adversarial review wave. Gate after:
`pnpm typecheck` clean · `pnpm test` **537 passed** · `pnpm build` clean ·
`pnpm e2e` **11 passed + 1 skipped** (the api-key one).

Correctness
- `CodexHarness.settle()` now cancels every outstanding server request before it closes the
  turn. A `turn/completed` that arrived while an approval was open used to leave the promise
  dangling: the card span forever, the runner forgot the request id, and codex app-server
  waited for a `{decision}` that could never come.
- `SessionRunner` learned who owns a widget. A harness that emits its own `widget` block
  (Codex, `api`) has its `ui://` document fetched by `resolveHarnessWidget` — previously only
  `maybeOpenWidget` called `widgets.open()`, gated on a tool name starting with `mcp__`, which
  no Codex tool_call ever is, so every Codex MCP App stayed on a loading spinner. The runner no
  longer runs a second detection (or a second MCP connection) for a call the harness claimed,
  and never deletes a slot a persisted row is sitting in.
- `history.ts` replays a `denied` tool call as its denial, not as "the turn ended before this
  tool finished" — which read to the model as an interruption worth retrying.

Security
- `web_fetch` follows redirects by hand (`redirect: "manual"`) and re-validates every hop.
  `redirect: "follow"` let an https URL 302 to `http://169.254.169.254/…` and hand the body to
  the model. Loopback/private/link-local literals are refused on every hop, first included.
- `resolvePath` confines the `api` backend's file tools to the project directory. `read` is an
  `allow` class in every permission mode, plan included, so an absolute path was unprompted
  full-disk read access; the boundary is what makes the ungated read safe.

UX parity (R32/R14/R31)
- A cancelled `AskUserQuestion` is `status: "cancelled"` with `answers: null` and denies the
  tool. It used to resolve with `{}`, which is truthy, so interrupting a question showed a green
  "Submitted" with an empty list.
- `QuestionCard`: radios vs. checkboxes off `multiSelect`, a Decline button (the only exit from
  an `allowOther: false` card with no acceptable option), and state keyed by index rather than
  by the question's own text.
- `PermissionCard`: one card at a time owns the Enter/Escape shortcut (`pendingInteractionBlock`)
  — every pending card used to arm its own window listener, so one Enter approved them all — and
  the body is per tool (command + cwd, the file list) instead of the transport JSON. Claude and
  Codex now stamp `title`/`description` on the block.
- The slash menu reads `Query.supportedCommands()` and `system/commands_changed`, so commands
  carry their real descriptions **and** `argumentHint` (without one the composer fired
  `/cockpit:pilot` immediately with no argument).
- `chat.listCommands` offers a backend only the built-ins it can run
  (`BACKEND_BUILTIN_SLASH_COMMANDS`); `/cost` in a Codex or `api` session used to be posted to
  the model as literal text and spend a turn.
- The landing seeds its lead agent from the first *available* harness, and the picker no longer
  locks to one backend before a session exists (`lockBackend`). Unavailable backends stay in the
  menu as disabled rows carrying `HarnessInfo.reason`.
- `pendingInteractionBlock` counts elicitation and skips `staleRequests`; one stale card used to
  pin the mascot to "waiting" for the rest of the session.
- A tool_call whose widget rendered is flagged `hasWidget` and its card is skipped, so an MCP App
  result is not shown twice (`e2e-out/widget.png`).

Efficiency
- Anthropic requests now use all four cache breakpoints: the last content block of each of the
  final two messages joins system + tools, so the growing `messages` array is not re-billed on
  every tool-loop round trip.
- `McpToolInfo.annotations` is captured and read where the MCP spec puts it (a sibling of
  `inputSchema`), so `readOnlyHint` finally fires and a read-only server tool stops raising a card.
- One reference-counted `McpClientPool` per resolved server list, shared by the `api` harness and
  the widget host (`apps/desktop/src/ipc/mcpPools.ts`) — they used to spawn every stdio server twice.

Not fixed, on purpose
- `sessions.create`'s `agents: []` fallback still names `claude`. The renderer now always supplies
  the lead agent when any backend is available, so the path is unreachable from the UI; making the
  main process probe harnesses inside a synchronous handler would put a `codex app-server` spawn
  in front of session creation.

## 2026-09-06 — Phase 3 accepted by the orchestrator
- Re-ran the full gate independently: typecheck 5/5, vitest 537/537, build ok, Playwright 11 passed / 1 skipped (API key). Screens checked: widget card (fixture MCP App), Codex permission card, slash menu with plugin commands. Key findings kept: Higgsfield/claude.ai proxy connectors carry no ui:// resource (fallback rich card is the normal path); Claude SDK strips tool _meta, so widget HTML comes from capygen's own MCP client; Codex app-server exposes appContext.resourceUri + mcpServer/resource/read.

## 2026-09-06 — Phase 4 accepted by the orchestrator
- Re-ran the full gate independently: typecheck 5/5, vitest 731/731, build ok, Playwright 16 passed / 1 skipped (API key). Round-table (Claude → Codex quoting Claude's line), hop cap + Continue, haiku-routed Task sub-agent, Claude→Codex delegate_task, agent info drawer all proven live. Review fixes in f7110a6 (19 fixed, 1 deferred: per-harness avatar glyphs).

## 2026-09-06 — Phase 5 accepted by the orchestrator
- Re-ran the full gate independently: typecheck 5/5, vitest 967/967, build ok, Playwright 22 passed / 1 skipped (API key) / 1 failed — the live cross-backend delegation test (roundtable.spec.ts "Claude lead delegates to Codex") failed once and passed on an isolated re-run (1.1 m): model-choice flake, not a regression; tracked below. Workspace proven: files→editor→save, diff, TodoWrite→tasks, terminal echo, drag-restore layout, dev server detect→start→Browser pane, overlay tracking. Review fixes in b958927 (junction-escape write, permission handlers on browser views, git `--`, ref-counted watchers, zero-panel layout, per-window browser views, editor dirty guard/stale file, terminal orphan ptys, and more).
- A separate user-started session is adding a `tasks.create` IPC channel in this worktree (8 uncommitted files); left untouched.

## 2026-09-06 — Phase 6 accepted; handoff to GPT Astra
- Orchestrator gate re-run: typecheck 5/5, vitest 1296 passed / 4 skipped, build ok, Playwright 24 passed / 10 skipped (all live-Claude tests skip: Claude Code OAuth session expired on this machine — user must run `claude` to sign in; plus the API-key case). Review fixes in 2222cd6 (skill.open path check, createSkill traversal, CLI positional guard, stale project cache, plugin ops behind the confirm gate, MCP dialog scope/args/env fixes, and more).
- User decision: development stops here on Fable. Lead from Phase 7 = GPT Astra (Codex); Fable 5.1 / Opus 5 review for dev. Written: AGENTS.md (lead instructions), docs/POLICIES.md (routing, permissions/approvals, round-table, config source of truth, safety, efficiency), docs/HANDOFF.md (state, run, revert, open items), PLAN.md §Crew and CLAUDE.md updated.

## Open / next
- Flaky live e2e: cross-backend delegation depends on the lead choosing delegate_task; harden the prompt or assert on the routed policy instead of the model's choice (Phase 11/12 hygiene). (superseded — see the entry for Task B1 below)
- ~~Phase 2: A1 foundation landed (echo stub engine). Next: the real Claude harness behind the
  same `Engine` interface (`apps/desktop/src/engine/stub.ts`), block streaming, permission and
  AskUserQuestion cards.~~ Done in Task B1.

## 2026-09-05 — Task B3: mascot component, wordmark, app icons
- `apps/renderer/src/brand/{Mascot,Wordmark,BrandLogo}.tsx` + `brand.css`: cross-fading,
  per-state-animated mascot (`{state, size}`); `Wordmark`; a `BrandLogo` drop-in for
  `reference/…/components/BrandLogo.tsx`'s `{className, variant}` props. Kept self-contained
  (own font-face, no import from `components/Mascot.tsx`) since other Phase 2 tasks were
  editing that file and `pages/ChatPage.tsx` concurrently.
- `scripts/make-icons.py` (Pillow, nearest-neighbour resizes from
  `assets/mascot/states/idle.png`) → `assets/icons/{icon.png 512, icon.ico 256/128/64/48/32/16,
  tray.png 32, favicon.ico 32/16}`, copied into `apps/desktop/build/icons/` (electron-builder,
  unwired — Phase 12) and `apps/renderer/public/favicon.ico` (gitignored like the rest of
  `public/`; `apps/renderer/scripts/sync-assets.ts` should add it to its copy job list so a
  fresh clone regenerates it). The tray already had a runtime hook
  (`apps/desktop/src/main.ts` `TRAY_ICON`) copying `idle.png` directly — left as is.
- `scripts/brand-preview.html`: all 8 states + wordmark + BrandLogo sizes, opens from disk with
  no build step. Checked with Playwright chromium (one-off script, not committed): 11/11 images
  loaded, `CheGuevaraBarry` font loaded, 0 console errors; screenshot at `e2e-out/brand-preview.png`.
- Added a `renderer-brand` vitest project (`environment: "node"`, `esbuild.jsx: "automatic"`) to
  the root `vitest.config.ts` so `brand/*.test.tsx` can run via `react-dom/server` SSR strings —
  no jsdom/@testing-library dependency added. 10 new tests, 83/83 passing repo-wide.
- Commit `1712802` (17 files, mine only — `git add` named paths, not `-A`, since Phase 2's other
  concurrent tasks had unstaged/untracked edits in the same tree at commit time).

## 2026-09-05 — Task B2: landing + chat UI ported from the reference
- Landing (P1): composer grew attach/dictate buttons, an "agent picker + gear" pill (Claude Code
  only for now; gear opens Settings ▸ Harnesses), and a footer tray of chips — host ("This
  machine", green dot; no host/sandbox picker exists per SPEC's local-only scope), working
  directory (existing `project-chip`, unchanged), and a worktree placeholder chip (Phase 7/P8
  does real worktrees). Slash menu (R14): typing `/` filters `chat.listCommands` as you type,
  Up/Down highlight, Enter or a click sends the command straight through.
- Chat (P2): per-kind block cards under `components/blocks/` — text (`react-markdown` +
  `remark-gfm`, no shiki: not installed, fenced code renders as plain monospace, noted as a
  deviation from the reference's shiki stack), thinking (collapsed), tool_call (collapsible
  trigger row + Parameters/Output panel, ported from `ToolCard.tsx`'s look), diff (simple
  unified view, +/− counts), permission (`Alert`-based Allow/Deny → `permission.answer`, ported
  from `ApprovalCard.tsx`), question (options-as-buttons + multiSelect → `question.answer`;
  multi-select answers join with ", " since the contract's `answers` map is `string`, not
  `string[]`), subagent (collapsible status card), error, usage line. Added `TurnRail` (a dot per
  turn, click-to-scroll) and a queued-messages strip: `appStore.send` now queues text typed while
  a turn is streaming and drains it on the next `chat.turnStatus` done/error/interrupted.
- `hooks/useMascotState.ts` + the pure `lib/mascotState.ts` table: listening (mic) > pending
  permission/question > session error > session waiting > running (thinking until the streaming
  turn has a block, then working) > just-finished (`success`, 4s window) > 5-minutes-idle
  (`sleeping`) > idle. 11 unit tests on the pure function.
- Sidebar (P3): search box, project-name grouping (a session whose project isn't loaded falls
  into "Loose sessions"), a per-row archive/unarchive button (`sessions.archive`, already in the
  contract), and a "Show archived" toggle (`sessions.list({includeArchived})`, already in the
  contract) — no `packages/shared` additions needed.
- New shadcn ports (no Radix): `ui/alert.tsx`, `ui/badge.tsx`, `ui/collapsible.tsx` (hand-rolled
  trigger/content/context — Radix would be one new dependency for one component).
- Added `react-markdown` + `remark-gfm` (runtime) and `@testing-library/react` +
  `@testing-library/jest-dom` + `@testing-library/user-event` + `jsdom` (dev) to
  `apps/renderer/package.json`; a new `renderer` vitest project (jsdom, `src/test/setup.ts`,
  excludes `src/brand/**` so it never double-runs Task B3's SSR tests) — that project entry in
  `vitest.config.ts` is already on `main` (commit `1712802` swept it up; see that entry above),
  so this task's diff to that file is empty.
- 33 new tests (Composer submit: Enter/Shift+Enter/empty-guard/slash-menu; all 9 block kinds;
  Sidebar search/grouping/archive; mascot-state table) — 114 passing repo-wide. Typecheck and
  `pnpm build` both green. `pnpm e2e` still passes its first two tests (landing, seamless chrome);
  the send/persist pair now fails on an unrelated 15s timeout because a concurrent task swapped
  the echo stub for the real Claude harness mid-session (`apps/desktop/src/ipc/handlers.ts`,
  `SessionRunner.ts` — not mine to fix). Verified the UI is not the cause with a throwaway
  Playwright script (not committed): the real harness answered "reply with the word pong" with
  "pong" and a usage line after ~20s; screenshots retaken against it —
  `e2e-out/{landing,chat}.png`.
- Files owned: `apps/renderer/src/**` except `brand/**` and `public/fonts` (untouched), per the
  task boundary. Did not touch `apps/desktop`, `packages/engine`, or `packages/shared` (no
  contract gaps found). `pnpm-lock.yaml` is left uncommitted: it now also reflects a concurrent
  task's in-progress dependency additions (`@anthropic-ai/claude-agent-sdk` in `apps/desktop`,
  `@capygen/shared` in `packages/engine`) that aren't mine to commit ahead of their own commit.

## 2026-09-06 — Phase 2 / B1: Claude harness + session runner
- `packages/engine`: the `Harness` contract (`src/harness.ts`) — `start / send → AsyncIterable<EngineEvent> /
  interrupt / listCommands / capabilities / answerPermission / answerQuestion / backendSessionId / dispose`.
  `EngineEvent` maps 1:1 onto what the app already models: `block` (a `BlockPatch`, which is the shared
  `Block` union minus the envelope the store owns, so a new block kind widens it automatically), `turn`,
  `permission`, `question`, `usage`, `session`.
- `ClaudeHarness` (`src/claude/ClaudeHarness.ts`) drives `@anthropic-ai/claude-agent-sdk` 0.3.261:
  **one streaming-input `query()` per agent, reused across turns** — each `query()` is a fresh process
  with a cold ~20 k-token prefix (spike §8.7), so reuse is what keeps `cache_read` high and injects no
  per-turn system text (SPEC R24; no `systemPrompt` is ever set). `stream_event` text/thinking deltas and
  the settled `assistant` message share one block key per content block (`msg:<message id>:<index>`), so a
  growing reply upserts one row. `tool_use`/`tool_result` → `tool_call` blocks keyed `tool:<toolUseId>`,
  output stubbed past 64 KB (R25). `canUseTool` → `question` events for AskUserQuestion (answers ride back
  on `updatedInput.answers`, the proven shape) and `permission` events for everything else; with no turn
  open it **denies** rather than auto-approving (R27). `PreToolUse` on matcher `'Task|Agent'` (the wire
  name is `Agent`) emits sub-agent blocks and carries the routing-policy lever — stubbed, fail-open,
  returns `{}` (R12). `result` closes the turn and produces the usage event; **`modelUsage` is cumulative
  in a streaming session, so per-turn usage is the delta** (`deltaUsage`, clamped at zero when a new
  process resets the counters). `interrupt()` calls `Query.interrupt()` and settles the turn after a 5 s
  grace. Resume via `options.resume`. `cleanEnv()` (`src/env.ts`) builds the complete child env the SDK
  requires: nested-session markers dropped, UTF-8 forced.
- `apps/desktop/src/engine/SessionRunner.ts` replaces the echo stub as the default engine: one harness per
  `(session, agent)`, blocks persisted as they arrive (block key → a fixed row id/index/created-at slot),
  `usage_events` per usage event, permission/question answers routed back to the waiting harness, and the
  backend session id stored under `engine.backendSession.<agentId>` so the first send after a relaunch
  resumes instead of starting a new conversation. A turn that ends without a status is closed loudly
  rather than left `streaming`.
- `stub.ts` is now the offline echo *double* over the same `Engine` interface; `CAPYGEN_ENGINE=stub`
  selects it (the e2e suite sets it, so the walking-skeleton run stays deterministic and spends no
  tokens). Blocks and turn closure moved to `engine/persist.ts` so the double and the real runner cannot
  drift.
- The SDK is **external** to the esbuild bundle (`apps/desktop/scripts/build.ts`): it resolves its own
  `claude.exe` through `createRequire(import.meta.url)`, which an inlined copy could not. Verified inside
  Electron 44 (`electron=44.2.0 node=24.20.0 query=function`) and from the built `dist/` directory.
- Checks: `pnpm test` 141 passed (16 new engine tests against a fake SDK, 11 new runner tests against a
  fake harness + a real temp database); `pnpm typecheck` clean; `pnpm build` clean; `pnpm e2e` 4 passed;
  `corepack pnpm --dir packages/engine live:claude` → `LIVE PASS - text="pong" cost=0.0074862` (second run,
  warm cache: `cacheRead=37211`); the real app answered "pong" in the transcript in 18.6 s (throwaway
  Playwright run, not committed).
- `COMPAT.md` written: every SDK member the app now relies on, with its `.d.ts`/spike citation and a
  fallback.

## 2026-09-06 — Phase 2 / C: integration + live proof

- Phase 2 is **done**: the built app lands on the New Session page, a live Claude turn streams into
  the transcript with a usage/cost line, and the session comes back out of SQLite after a relaunch —
  proved by `tests/e2e/skeleton.spec.ts` against the real harness, not a double
  (`e2e-out/chat-pong.png`, `e2e-out/restored.png`, `e2e-out/chat-question.png`).
- Wiring: the brand components (`brand/Mascot`, `brand/Wordmark`, `brand/BrandLogo`) are now the
  only mascot/wordmark in the app — `components/Mascot.tsx` and the duplicate `@font-face` /
  `.wordmark` / `.mascot-img` rules in `index.css` are gone, and `brand/Mascot`'s second
  session→state table went with them (`lib/mascotState.ts` is the one decision table). The sidebar
  carries the brand lockup; `assets/icons/{tray,icon}.png` are copied into the desktop bundle and
  used for the tray and the window; `favicon.ico` is staged into the renderer's `public/`.
- Two rendering defects the live run exposed and fixed: every solo agent turn was badged "hop 1"
  (the chip now only shows for real agent→agent hops), and an answered `AskUserQuestion` rendered
  twice — once as the question card, once as a raw tool-call card, because the same call also comes
  down the stream as `tool_use`/`tool_result`. `ClaudeHarness` now folds those frames into the
  question block (`INTERACTION_TOOLS`), with a regression test and a `COMPAT.md` row.
- Checks: `pnpm typecheck` clean · `pnpm test` 142 passed (13 files) · `pnpm build` clean ·
  `pnpm e2e` 7 passed (5 offline + 2 live, 1.0 min, ~$0.02). `docs/RUN.md` written.

## 2026-09-06 — Phase 2 / D: review fixes

- The Phase 2 adversarial review's verified findings are fixed. Correctness: the runner's `active`
  map is keyed `sessionId:agentId` like `harnesses` (a second `send` no longer evicts the turn
  `interrupt` needs) and a send to a busy agent is refused before it reaches the harness; a failure
  inside `consume()` now interrupts the harness, so a permission nobody can answer cannot wedge the
  agent for the rest of the run; `Engine.dispose()` is async and `will-quit` awaits it before
  closing SQLite, so a turn's final status is written instead of thrown away; usage rows are split
  by `event.byModel`, so a sub-agent on another model is not billed to the lead.
- Security: every window guards `will-navigate`/`will-redirect` (`win/navigation.ts`, unit-tested) —
  a link in model output could otherwise replace the SPA and be handed the preload's IPC client —
  `sandbox: true` (the preload only requires `electron`, verified in the bundle), the IPC handlers
  check the sender frame, and the log redactor now also matches the JSON form `fmt()` actually
  writes (`"token":"…"` was going to disk in the clear).
- UX parity: the slash menu is out of the `overflow-hidden` wrapper (it was clipped to nothing while
  Enter still picked an invisible command), picking a command inserts it instead of sending it (so
  `/model opus` is reachable), filtering is substring, Escape dismisses; the turn rail's dots are
  buttons (an `#turn-…` anchor navigated out of the session under HashRouter); a failed send
  restores the draft and shows the error; the transcript only follows a stream while it is pinned to
  the bottom and offers a jump-to-bottom button; `AskUserQuestion` cards take free text (R32) and
  render option descriptions; permission/question answers report whether the backend actually took
  them and say so on the card when it did not; the settings nav clears the drag strip (its first
  link was unclickable). A turn left `streaming` by a crash is reconciled when the store opens, and
  `chat.interrupt` flips a stale row even with nothing to stop — that pair was a permanently locked
  composer after any quit mid-turn.
- R25: `clampOutput` keeps the whole value on the block (`fullOutput`) instead of discarding it, and
  the tool card's stub expands. Also from the low-severity list: the harness evicts per-turn tool
  bookkeeping on settle, `.sidebar-row` and the reference's sidebar edge treatment are in `index.css`,
  the mascot cross-fade animates (a transition could never run on a layer mounted at opacity 0), and
  the attach button is disabled rather than accepting files it drops.
- Fell out of the shutdown fix: the caption-blend timers outlived the window and read a closed
  database (`uncaughtException: database is not open`), which stopped the app exiting at all —
  `win/chrome.ts` now clears its one-shot timer, `isDark()` tolerates a closed store, and the
  deferred quit ends in `app.exit(0)` (a re-`quit()` after a prevented one never terminated).
- Checks: `pnpm typecheck` clean · `pnpm test` 166 passed (14 files) · `pnpm build` clean ·
  `pnpm e2e` 7 passed (5 offline + 2 live, 58.6 s). Deferred: an AskUserQuestion reject path (no
  deny route exists through IPC → engine → `canUseTool` yet — Phase 3) and `remark-breaks` for
  multi-line user messages (needs a new dependency).

## 2026-09-06 — Phase 3 / P0: shared contracts for codex/api backends, widget/elicitation blocks
- `packages/shared/src/domain.ts`: two new block kinds (`widget` — R31 MCP Apps, `elicitation` —
  R32 structured input); `tool_call` gains `family`/`serverName`/`outputRef`; `permission` gains
  `title`/`displayName`/`description`/`suggestions`/`reason`, and its `decision.behavior` widens to
  `allow_always` (R28/R32); `question` gains `allowOther`/`otherText`. Per-backend `Agent.config` is
  now validated (`ClaudeAgentConfigSchema`/`CodexAgentConfigSchema`/`ApiAgentConfigSchema`, all
  `.passthrough()`) instead of `unknown` — it already had this `{claude:{...}}` shape in practice
  (`ClaudeHarness.readClaudeConfig`), just untyped. New `HarnessInfoSchema` (`harness.list`) and
  `ToolOutputSchema` (the `tool_outputs` table).
- `packages/shared/src/ipc.ts`: `permission.answer`'s `behavior` renamed `decision`
  (`'allow'|'allow_always'|'deny'`); added `harness.list`, `secrets.{set,has,delete}`,
  `mcp.readResource`, `widget.callTool`, `widget.event`, `elicitation.answer` (invoke) and
  `elicitation.request` (event) — `widget.update` is explicitly *not* a new event, block state
  rides the existing `chat.block` upsert.
- `packages/db/migrations/0002_widgets_elicitations_tool_outputs.sql`: discovered `blocks.kind` had
  a CHECK enumerating the 0001 kinds — inserting `widget`/`elicitation` would have violated it.
  SQLite has no `ALTER ... DROP CONSTRAINT`, so the table is recreated; the CHECK is dropped rather
  than re-enumerated (`BlockSchema` is the one source of truth for valid kinds now). Added
  `tool_outputs` table + `ToolOutputsRepo.put/get` for `ToolCallBlock.outputRef`.
  Caveat recorded in the migration's own comment: that `DROP TABLE blocks` cascades to
  `approvals.block_id` under `foreign_keys=ON` — harmless today (Phase 9/`approvals` has no writer
  yet), but the next blocks-table migration needs `PRAGMA foreign_keys=OFF` outside any transaction
  first if that has changed.
- Downstream compatibility fixes (the widened union and the `permission.answer` rename touch code
  outside `packages/shared`/`packages/db`): `apps/desktop/src/ipc/handlers.ts` gained stub handlers
  for every new channel (`harness.list` returns a static claude/codex/api list; `secrets.*` backs
  onto a new in-memory `SecretsStore` — never touches disk, so R21 cannot be violated by it, but it
  forgets keys on restart until Phase 6 wires `safeStorage`; `mcp.readResource`/`widget.callTool`
  throw "not wired yet"; `widget.event` logs and acks; `elicitation.answer` persists the block and
  reports `ok:false`) and updated `permission.answer` to collapse `decision:"allow_always"` to
  `{behavior:"allow"}` for the harness while keeping the full value on the stored decision.
  `apps/renderer/src/store/appStore.ts` follows the rename. `BlockRenderer.tsx`'s switch was not
  actually exhaustive (no `default`/`never` check, despite its header comment) — a widget or
  elicitation block would have silently rendered nothing; added `WidgetCard`/`ElicitationCard`
  placeholders (Phase 3 builds the real iframe host and elicitation form) and a `never` assertion so
  the next new block kind is a compile error for real.
- Checks: `pnpm typecheck` clean (all 5 packages) · `pnpm test` 177 passed (14 files, +11 from the
  166 baseline: 3 shared, 4 db, 1 sessionRunner, plus the widget/elicitation samples folded into
  existing round-trip tests) · `pnpm build` clean.

## 2026-09-06 — Phase 3 / B1: Codex harness over `codex app-server`

- `packages/engine/src/codex/*`: JSON-RPC client over newline-delimited stdio (the framing the
  Phase 1 spike proved), `CodexHarness` implementing `Harness`, binary resolution, an `[assumed]`
  price table. Registry hook `createHarnessForBackend` in `packages/engine/src/index.ts`.
- Notifications map to blocks: `agentMessage` → text, `reasoning` → thinking, `commandExecution`
  → tool_call/bash, `fileChange` → tool_call/edit|write + one diff per change, `mcpToolCall` →
  tool_call/mcp (+ a `widget` block for a `ui://` app result), `webSearch` → tool_call/web.
  Approvals and `item/tool/requestUserInput` become permission and question cards.
- 30 tests in `packages/engine/test/codexHarness.test.ts`, driven by a fake app-server; the text
  turn and the approval round trip replay real recorded frames
  (`test/fixtures/codex-frames.json`, lifted from `docs/spikes/codex.raw.json`).
- Live proof: `corepack pnpm --dir packages/engine live:codex` → `LIVE PASS` (a "pong" turn and an
  accepted command approval whose command really ran).
- Two bugs the live run caught that no unit test could have: `require.resolve("@openai/codex-sdk")`
  throws (`exports` has only an `import` condition), so the harness was silently spawning the
  machine's *installed* Codex 0.139.0 instead of the bundled 0.153.4 — now a directory walk with a
  regression test; and Codex's Windows sandbox rejects an 8.3 short path, so the live script
  `realpathSync.native`s its temp cwd.
- Not done: elicitation answers can't round-trip (`EngineEvent`/`Harness` have no elicitation
  variant — `CodexHarness.answerElicitation` is the seam, requests are declined meanwhile), and
  Codex sub-agent items (`collabAgentToolCall`, `subAgentActivity`) are unmapped (Phase 4).

## 2026-09-06 — Phase 3 / B2: API-model harness, local tool runtime, MCP client

- `packages/engine/src/api/*`: `ApiHarness` implements `Harness` with capygen's **own** agent loop
  (there is no CLI to adapt). One system prompt per session, built in `start()` and never rebuilt
  (R24); a stable tool array; tool loop to `end_turn` or a hard 24-round cap; `AbortController`
  interrupt; per-response usage through an `[assumed 2026-09-06]` price table (`PRICES_ASSUMED_ON`).
- Providers behind one neutral vocabulary (`api/providers/types.ts`): Anthropic Messages
  (streaming, tools, `cache_control` on the system block **and the last tool** — one breakpoint
  covers the whole prefix — plus `thinking`), OpenAI **Responses** (streaming, function tools,
  `reasoning.effort`, `store:false`), OpenRouter = the same SDK at `openrouter.ai/api/v1` with
  `HTTP-Referer`/`X-Title`. Both SDKs load with a runtime `import()`.
- `packages/engine/src/tools/*`: nine tools with a declared permission class each —
  read_file/list_dir/glob/grep (read), write_file/edit_file (write), bash (execute, PowerShell on
  Windows), web_fetch (network, https-only + size cap), ask_user_question (interaction, never
  gated). The gate is one pure table, `gateFor(mode, class)`; `plan` denies rather than asks.
- `packages/engine/src/mcp/client/*`: lazy pool over the MCP SDK (stdio + streamable HTTP), servers
  read **read-only** from the agent config, `<project>/.mcp.json`, `~/.claude/settings.json` and
  `~/.codex/config.toml` (tiny hand-rolled TOML reader). `tools/list` once per session (R26);
  `tools/call` results pass through whole so `_meta` survives for the widget host (R31).
- 100 tests across `test/{tools,apiProviders,api,mcpClient}.test.ts`. The MCP test connects the
  **real** `@modelcontextprotocol/sdk` client to a real child process
  (`test/mcpClientFixtureServer.mjs`, hand-written JSON-RPC) and asserts laziness from the server's
  own request log. The cache_control test asserts the real Anthropic request body.
- Live: `corepack pnpm --dir packages/engine live:api` prints `SKIP` — this machine has no key for
  any provider. Wiring proved with a deliberately invalid key: all three endpoints answered 401 and
  the harness surfaced it as an error block + `turn: error` (SPEC §Edge Cases). OpenRouter's
  `401 Missing Authentication header` is its own wording for a bad key — a direct `curl` with the
  same header returns the identical body.
- Not done / for the integrator: `createHarnessForBackend` in `packages/engine/src/index.ts` still
  throws for `api` (that file is B1's). It needs `export * from "./api/index.js"` (the surface is
  curated to be collision-free) and `case "api": return new ApiHarness(deps.api ?? {})`. The
  desktop must also inject `keys` (safeStorage `KeyProvider`) and `loadHistory` (turns → messages);
  without the latter an `api` session starts each app run with an empty transcript.

## 2026-09-06 — Phase 3 / B3: MCP Apps widget host + spike

- Spike first (`docs/spikes/mcp-apps.md`, evidence in `mcp-apps.evidence.json`): the Claude Agent
  SDK's stream carries an MCP tool call and its `structuredContent` but **strips the tool's
  `_meta`**, so the `ui://` URI is never on the wire. `Query.mcpServerStatus()` does give a locally
  hosted server's `config`, so capygen opens **its own MCP client to the same server** and reads
  `tools/list` `_meta` → `resources/read`. A `claudeai-proxy` connector has only an upstream URL
  and an Anthropic-side id — unreachable, so it falls back to a rich result card. Higgsfield
  (`balance`, and `generate_image{get_cost:true}`, both free) declares no MCP App UI at all.
  Codex's app-server is the easy case: `mcpToolCall.appContext.resourceUri` plus
  `mcpServer/resource/read`.
- Measured, not assumed: an `<iframe srcdoc>` inherits the renderer's CSP, so a widget's inline
  script never runs. Widgets are therefore served by the main process from a privileged
  `capygen-widget://<block>/index.html` scheme with the resource's own CSP, framed
  `sandbox="allow-scripts allow-forms"` (opaque origin: `window.origin === "null"`, `localStorage`
  throws). `apps/renderer/index.html` gains `frame-src capygen-widget:` and nothing else.
- Built: `packages/engine/src/mcp/apps/**` (`WidgetHostBridge` + protocol readers + a pool-backed
  `WidgetMcpAccess`), `apps/desktop/src/ipc/widgets.ts` (one bridge per project, the scheme
  handler, `widget.callTool` / `widget.event` / `mcp.readResource`), `apps/renderer/src/widgets/**`
  (ext-apps `AppBridge` over `postMessage`, theme passthrough, size negotiation, rich fallback) and
  `WidgetCard`. A widget may only call tools on its own server, and never one the server marked
  `visibility:["model"]`.
- Proven live: `tests/e2e/widget.spec.ts` — a real Sonnet turn calls the fixture MCP Apps server
  registered through the project's `.mcp.json`, the widget renders inside the transcript with the
  tool's arguments, and its button round-trips `echo` back through the host (`e2e-out/widget.png`).

## 2026-09-06 — Phase 3 / B4: interaction cards, tool cards, slash menu, usage meter, providers page

- PermissionCard: title/displayName/description from the block, an Allow once / Allow for session
  (`allow_always`) / Deny action row with an optional deny reason, and Enter/Escape shortcuts
  scoped to the pending card (skipped while a text field has focus, so the composer's own Enter
  still sends). QuestionCard now honours `allowOther`. ElicitationCard is a real form generated
  from the request schema (`elicitationForm.ts`: text/number/boolean/enum controls, required-field
  gating, MCP's flat `ElicitResult.content` shape) instead of a read-only placeholder, wired
  through a new `answerElicitation` store action; a schema with no properties reads as a bare
  Accept/Decline consent prompt.
- ToolCallCard renders per family (`toolFamily.ts`): bash (command summary, a detected exit/timeout
  status line), read (path + line range), write/edit (a synthetic diff — `DiffCard`'s view factored
  out into a reusable `DiffView`), glob/grep (a match list instead of raw text), web (URL summary),
  mcp (`server · tool`, an MCP `CallToolResult` renderer for text/image/JSON content), task (a link
  that scrolls to the spawned sub-agent's block, once it exists). A truncated output whose full
  value moved to `tool_outputs` (`outputRef`, not inline `fullOutput`) is fetched on demand via
  `blocks.getOutput`, the first time "Show full output" is clicked.
- SlashMenu groups matches into Built-ins / Skills / Plugins / Backend-commands sections; Composer
  now runs an argument-less command immediately on selection (click or Enter) and only inserts one
  that takes an argument (`argumentHint` set) for editing — R14's actual behaviour, not just
  insert-then-a-second-Enter. The harness/model picker is driven by `harness.list` instead of a
  hardcoded "Claude Code": a new session (LandingPage) threads the chosen backend/model into
  `sessions.create`'s lead-agent draft; an open session (ChatPage) only offers its own agent's
  backend's other models and dispatches a change through the existing `/model` built-in — an
  agent's backend is fixed for its lifetime (one harness instance per agent), so there is no
  separate "switch backend" operation for the picker to call.
- UsageLine grows a byModel breakdown tooltip once a turn billed more than one model (a sub-agent
  call, a compaction summary on a different model); a new `SessionUsageMeter` sums the session's
  `usage_events` into the chat header. Settings ▸ API keys (`ProvidersSection`) is a real page:
  Anthropic/OpenAI/OpenRouter rows with Set/Replace/Remove backed by `secrets.has/set/delete` — a
  key is never read back once set, only its presence. `apps/desktop/src/ipc/{secrets,harnessList}.ts`
  (safeStorage-backed store; `claude --version`/`codex --version` CLI probe) were sound partial
  work from an interrupted earlier attempt at this task, kept as-is and wired into `main.ts`.
- A dev-only `/dev/cards` route renders a static fixture of every block kind and tool-call family
  for visual QA (`e2e-out/cards.png`); confirmed tree-shaken out of the production bundle (`grep` on
  the built JS finds no trace of it) rather than merely runtime-gated.
- Downstream fixes for a green tree: `ipc.test.ts`'s two "(B4)" tests referenced a fixture
  block/turn id with no real row behind it, violating the FK migration 0002 added
  (`tool_outputs.block_id`, `usage_events.turn_id`) — fixed to create a real session/turn/block
  first. `UsageLine`'s first draft selected a filtered `usage_events` slice directly from the
  zustand store, handing `useSyncExternalStore` a new array every render ("Maximum update depth
  exceeded") — fixed by selecting the store's stable array and filtering in a `useMemo`. The custom
  `Tooltip`'s click handler initially toggled, which a real click (or `userEvent.click`) undid
  immediately because a click fires its own `mouseenter` first — fixed to only ever open on click.
- `apps/desktop/src/main.ts`, `apps/desktop/src/ipc/handlers.ts` and `packages/shared/src/ipc.{ts,
  test.ts}` were sitting uncommitted with both this task's wiring and Task B3's MCP Apps widget-host
  integration (`protocol.handle`, the `widgets` dependency) tangled together in the same hunks —
  neither task's file list names these three files. Committed as one coherent, green snapshot
  (typecheck/test/build all pass) rather than left permanently uncommitted.
- `corepack pnpm typecheck` clean across all 5 packages; `corepack pnpm test` 441/441 (up from 358);
  `corepack pnpm build` clean. Screenshots: `e2e-out/cards.png`, `e2e-out/providers.png`.

## 2026-09-06 — Phase 3 / C: harness layer integrated — Claude/Codex/API, widgets, cards

- **The registry is now what picks the backend.** `createHarnessForBackend` gained the `api` case
  (`packages/engine/src/index.ts`) and `SessionRunner`'s default `makeHarness` calls it with
  `agent.backend` instead of always building a `ClaudeHarness`. Everything backend-specific that
  needs the desktop is injected in that one place: the `api` key provider (`safeStorage` →
  `SecretsStore.get`, main-process-only — `secrets.has` stays the whole renderer-facing read
  surface, R21) and `loadHistory`, the SQLite transcript replay an `api` agent needs because it has
  no backend session to resume (`apps/desktop/src/engine/history.ts`).
- **Elicitation round-trips.** B1 and B2 both recorded the same blocker: `EngineEvent` had no
  elicitation variant and `Harness` no `answerElicitation`, so `CodexHarness` declined every MCP
  `elicitation/create` in a `queueMicrotask` the moment the card appeared. Added the event variant
  and an **optional** `answerElicitation` (optional because only a backend that relays
  `elicitation/create` ever emits the event); the runner routes it the way it routes permissions,
  and `elicitation.answer` — which is addressed by `blockId`, not `requestId` — reads the id back
  off the row. Interrupt/dispose still decline whatever is pending, so Codex is never left waiting.
- **`harness.list` tells the truth.** Claude: `claude --version` plus a login signal (the CLI's
  credentials file, existence only — never its contents — or `CLAUDE_CODE_OAUTH_TOKEN` /
  `ANTHROPIC_API_KEY`). Codex: `account/read {refreshToken:true}` through a short-lived
  `codex app-server`, which is the only check a dead token fails — `codex login status` printed
  "Logged in using ChatGPT" on this machine while every model call 401'd (spike §3) — and the same
  child returns `model/list`, so the picker offers Codex's own catalogue (`gpt-5.6-terra` &co).
  API: a stored or env key, per provider. Results are cached 60 s and the renderer's bootstrap no
  longer awaits them, because probing spawns a process and G1 budgets 3 s to a usable composer.
- **Block parity is a contract, not a checklist.** `BACKEND_BLOCK_PARITY` in `@capygen/shared`
  lists, per backend, the kinds it can emit and — for every other kind — the reason it cannot.
  `apps/desktop/test/blockParity.test.ts` runs a recorded stream per backend through the real
  runner, handlers and SQLite (including `maybeOpenWidget`'s detect→open path and the
  permission/question/elicitation round-trips); `apps/renderer/src/components/blocks/blockParity.test.tsx`
  renders every kind through `BlockRenderer`. Adding a kind to `BLOCK_KINDS` fails both suites
  until the table has an answer for all three backends.
- **Two real bugs the integration surfaced.** (1) The built app was resolving the *wrong Codex*:
  `resolveBundledCodex` walks up for `node_modules/@openai/codex-sdk`, and from
  `apps/desktop/dist/main.cjs` that walk never passes `packages/engine/node_modules` — so the
  bundle silently fell back to the machine's installed 0.139.0, a different protocol version on
  which the approval never fires. Fixed by making `@openai/codex-sdk` a direct dependency of
  `apps/desktop`. (2) Codex's Windows sandbox denies an *approved* command whose `cwd` is an 8.3
  short name, and `os.tmpdir()` returns exactly that here; `longPath()` now normalises
  `--project`/`CAPYGEN_PROJECT_DIR` and the folder picker's answer.
- **Slash menu refresh.** A backend only reports its commands once it is running (Claude's arrive
  with `system/init`), so the list fetched at `openSession` was built-ins only. The store refetches
  when a turn ends, and `chat.listCommands` now takes an `agentId` so a round-table session offers
  the menu of the agent that will actually receive the message.
- Gate, all re-run on the final tree: `corepack pnpm typecheck` clean across 5 packages +
  `tests/tsconfig.json`; `corepack pnpm test` **494/494** in 32 files (441 before); `corepack pnpm
  build` clean; `corepack pnpm exec playwright test` **11 passed, 1 skipped** in 2.5 m — the skip is
  the API-model e2e, which names the missing key. New screenshots: `e2e-out/codex-pong.png`,
  `codex-permission.png`, `codex-allowed.png`, `slash-menu.png`.

## Open / next
- R2 (tray / close-to-tray) has no e2e — Playwright cannot drive the Windows tray; it is unit-tested
  in `apps/desktop/test/win.test.ts`.
- Permission cards now have a **live** proof, on Codex rather than Claude: `harnesses.spec.ts` sets
  the agent's `approvalPolicy: "untrusted"` and answers the card, which sidesteps the user's
  `~/.claude` allowlist entirely. A live Claude permission is still machine-dependent.
- `tests/e2e/skeleton.spec.ts` runs on every `pnpm e2e` and spends real tokens. If that becomes
  annoying in CI, gate it behind a tag rather than deleting it — it is the only proof the app talks
  to a real model.
- Sub-agent routing policy is a stub (`ClaudeHarness` `routeSubagent` dep, fail-open) — Phase 4 fills it in.
- Round-table queuing: the runner allows one in-flight turn per session; Phase 4 adds the dispatcher.
- The `api` backend has never made a real call from this machine (no key). Everything below the
  provider client is covered by mocked-provider tests plus a desktop test that proves an `api` turn
  reaches capygen's own loop and stops at the missing key; the fourth e2e unskips the moment a key
  is stored in Settings ▸ API keys.
- `api` model ids in the picker are a curated list (the ones `api/pricing.ts` can price), not a
  catalogue call. Prices stay `[assumed 2026-09-06]` until a key exists to check an invoice against.
- Codex sub-agents (`collabAgentToolCall`, `subAgentActivity`) still render nothing; the parity
  table records that as inapplicable rather than missing, and Phase 4 owns it.
- `harness.list`'s Codex probe spawns a child every 60 s of use. If that ever shows up in a profile,
  the fix is a longer TTL plus an explicit refresh button in Settings ▸ Harnesses, not a weaker check.

## 2026-09-06 — Phase 4 / B1: round-table dispatcher, hop cap, sub-agent routing + delegation

- `packages/engine/src/roundtable/` is pure: mention parsing (code spans and email addresses are
  blanked in place, so reported offsets still index the original text), target resolution
  (explicit pick > mentions in order > lead > first agent), the absolute hop index (a user turn is
  0, so "until the user speaks" needs no flag to clear), the labelled context delta and the
  session-stable prompt addition. `apps/desktop/src/engine/RoundTable.ts` is the stateful half:
  turn rows, the queue, `chat.chainStopped`, and the pending hop `chat.continue` resumes.
- R23 in one sentence: a stateful backend is never re-sent the transcript. What Claude and Codex
  get is `[@name (Backend)]: …` for the other speakers' turns **since their own last turn**, then
  the addressed message. `api` starts its delta at the later of that and the history watermark
  `history.ts` replayed from, or a relaunch would send the same turns twice.
- R24: the roster/`delegate_task` text goes in `HarnessAgent.promptAddition`, applied once per
  backend session — Claude `systemPrompt.append` on the `claude_code` preset with `snapshot: true`,
  Codex `developerInstructions`, `api` `buildSystemPrompt({extra})`. A solo session with no routing
  override gets `undefined`, so its prompt stays byte-identical to Phase 2's.
- Sub-agent routing (ADR-0004): same backend → the `PreToolUse` hook rewrites `updatedInput.model`;
  cross-backend → `delegate_task`, an in-process MCP server for Claude (`createSdkMcpServer`) and
  one more `ToolDefinition` for `api`. Every failure inherits the parent's model instead.
- A Codex agent cannot be handed `delegate_task`: `codex app-server` reads MCP servers from the
  user's `~/.codex/config.toml`, which capygen will not write behind their back. It fails open and
  the opt-in server is Phase 6 work.
- Two round-level defects found while reviewing the interrupted first attempt and fixed with
  regression tests: a round that blocked *two* chains kept only the last (Continue silently
  dropped the other) and wrote one "chain stopped" line per blocked agent; and under
  `parallelAgents`, two hops addressed to the same agent raced, so the runner refused the second
  outright. Blocked chains are now a list resumed together under one notice, and a parallel round
  runs one lane per agent.

## 2026-09-06 — Phase 4 / C: round-table and routing integrated, e2e green

- **The renderer was narrowing round-table dispatch to one agent.** `appStore.dispatchNow` sent
  `agentId: parseMentions(text)[0]`, but on `chat.send` an `agentId` means "the composer
  explicitly picked this one", which *overrides* mention parsing in `resolveTargets` — so
  "@claude … @codex …" reached @claude alone. It now sends `agentId: null` and the main process's
  dispatcher does the fan-out, which is the only place that parses mentions with code-fence and
  `user@host` handling. `lib/mentions.ts` keeps the composer's autocomplete and nothing else.
- **`agents.describe` was a placeholder** (`capabilities: [], tools: []`) with the real engine
  sitting unwired in `ipc/agentsDescribe.ts`, because the missing input — a *running* harness —
  is `SessionRunner` state. Closed with `Engine.describeAgent`, `ClaudeHarness.describeSnapshot()`
  (remembers the last `system/init`), `CodexHarness.describeSnapshot()` (`mcpServerStatus/list` +
  `skills/list`, best-effort) and `ApiHarness.describeSnapshot()` (the tool list it was built
  with), narrowed and merged by `apps/desktop/src/engine/describeSnapshot.ts`. An agent that has
  not spoken still gets the config-only answer rather than a guess. Live output now reads "Lead
  agent on Claude Code (claude-sonnet-4-5) … use 3 connected MCP servers and use 56 skills across
  3 plugins", with ten grouped tool badges.
- **A routed sub-agent lost its model.** The `PreToolUse` hook upserts the `subagent` block with
  the routed model, then the assistant `tool_use` frame for the same call upserts it again with
  `model: str(input.model) ?? null` — an explicit `null`, which `upsertSubagent` treats as "clear
  it". So R12's whole visible effect was erased a beat after it happened. Both call sites now omit
  `model` when the model itself named none; regression test in `ClaudeHarness.test.ts`.
- **Per-agent permission modes were dead.** `SessionRunner` filled `HarnessAgent.permissionMode`
  from the global setting, and that field is the *highest* priority a harness knows
  (`agent.permissionMode ?? config.permissionMode ?? "default"`), so `config.claude.permissionMode`
  never applied. The agent's own config now wins.
- **Every control in the chat header was unclickable.** `.titlebar-drag` is a window-wide fixed
  strip at `z-index: 40` over the top 36 px — exactly the height of that header, which held only
  non-interactive text until Phase 4 put the mode picker, the settings gear and the agents toggle
  in it. `.titlebar-clearance` now lifts the row above the strip and supplies its own drag region,
  so the buttons work and the empty part still moves the window.
- **The agents tree never opened for a sub-agent that arrived later**: `useState(subagents.length
  > 0)` latched the value from the first render, so a pane opened before the spawn showed a
  disclosure triangle over nothing for the rest of the session.
- **The info drawer hid whichever description came second**: `info.description || agent.description`
  meant a user-written note vanished the moment the harness started reporting. The two are
  different things (R13 asks for both) and are now two sections.
- `CAPYGEN_ENGINE=stub-roundtable` is the echo double with `peerMentions`: every reply ends
  "over to @<next agent>" and dispatch runs through the **real** `createRoundTable`. The hop cap is
  a loop bound, and a loop bound must not be proved with a model that might choose to stop by
  itself.
- **Every Claude reply was rendered twice** (found in the round-table screenshot, then measured:
  one turn, two `text` blocks with identical content). The two representations of one assistant
  message disagree about content indices — the delta stream sends `[0]=thinking, [1]=text`, and the
  settled `assistant` message drops the thinking block, so its `content` is `[text]` at index 0.
  Keyed by the raw index, the settled walk wrote the answer over the thinking block *and* under its
  own key. Blocks are now keyed `msg:<id>:<kind>:<ordinal within that kind>`, which both views can
  compute; two regression tests in `ClaudeHarness.test.ts`.
- …and the same bug had a second half in the database: `BlocksRepo.upsert`'s `ON CONFLICT` updated
  the payload but **not** `kind`, so the overwritten row kept `thinking` with the answer inside it.
  The live transcript and the relaunched one disagreed, which R15 forbids. `kind = excluded.kind`.
- `tests/e2e/roundtable.spec.ts` (5 tests): the two-backend round table with the context delta
  proved by making Codex quote Claude's first line verbatim; the hop cap offline; the routed
  sub-agent; cross-backend delegation; the info drawer, asserted in the UI *and* straight off
  `agents.describe`.

## Phase 4 — review fixes (2026-09-06)

- **`chat.continue` kept the wrong chain root.** `PendingChain` remembered only the blocked
  turn, so a resumed hop was persisted with `triggeredByTurnId` pointing at itself and every
  later hop inherited that — the exact opposite of the invariant `Turn` documents. The root is
  captured at block time now (`rootTriggeredByTurnId`), and the Continue test asserts it.
- **`Session.mode` is finally load-bearing.** Nothing read it: a solo session still routed
  `@codex` to Codex and still chained peer hops, while the confirm dialog promised the opposite
  and the UI hid the mention menu. `resolveTargets`/`nextHopTargets`/`buildRoundTablePrompt`
  take a `mode` (default `round-table`, so every existing caller is unchanged).
- **A peer could forge a speaker label.** The context delta is line-oriented, so an agent
  manipulated by attacker-controlled tool output could emit `[user]: …` and it arrived in the
  next agent's prompt indistinguishable from a real turn. Quoted text is now backslash-escaped
  at a line-leading `[`; capygen never escapes its own labels, so the two always differ.
- **`permissionMode` was read from `.claude` for every backend.** An `api` agent configured
  `default` under a global `bypassPermissions` silently ran write/execute tools with no card
  (R19/R27). Read per backend (`permissionModeFor`).
- **Stop did not reach a delegated sub-agent.** The child harness lives inside
  `createDelegateRunner`'s closure and was in no registry, so a cross-backend sub-agent kept
  running (and billing) for up to ten minutes after Interrupt. `onHarness` registers it next to
  the parent's turn; `Engine.interrupt` stops both.
- **`delegate_task`'s result was the only unbounded tool result in the codebase.** Clamped at
  the source (both call sites) and again against the caller's `ctx.maxOutputChars`.
- **A delegated sub-agent's text was folded into its parent's reply.** Blocks now carry
  `delegatedFrom`; `RoundTable.textOfTurn`/`transcriptOf` skip them (so another model's whole
  answer is not re-sent as the next hop's message, R23) and the transcript nests them under
  their own label instead of showing them as the lead's own words.
- UI: `AddAgentDialog` re-seeds on open (the first open after launch was a dead end — `harness.list`
  is un-awaited) and re-reads `defaultLead` (the second drafted agent stole the crown); the agents
  tree gained Make-lead/Remove and the info drawer an editable sub-agent routing section (the three
  store methods and their IPC channels had no caller at all); a Codex parent's cross-backend route
  is disabled with the ADR-0004 reason; `chainPending` on `sessions.get` rebuilds the Continue bar
  after navigating away; `chat.send` returns `unknownMentions` and the transcript badges them next
  to the turn's recipients; the sub-agent card shows model/routed/cost; the model picker is disabled
  for a backend with no `/model`, and a real switch is persisted onto the agent row; `min-w-0` +
  `overflow-hidden` stop the Agents pane scrolling the whole shell sideways.
- Gate: typecheck, 731 unit tests (was 696), build, 16/17 Playwright (the API-key case is skipped —
  no key on this machine).

- [Phase 5 · B1] Workspace services: FsService (bounded list/read/write/search + chokidar 5 watcher),
  GitService (simple-git 3.36, null on non-repos), TerminalService (node-pty 1.1.0 — verified to load
  under Electron 44 and Node 22.16 with no rebuild, ADR-0005), DevServerService (four detectors,
  ring-buffered logs, stdout-URL then port-probe discovery, port-in-use adoption with the owning PID),
  TasksService (TodoWrite / Codex plan derivation via a broadcast tap, no tokens spent) and
  BrowserViewService (WebContentsView per pane, own partition, http(s) only). All 30 workspace IPC
  channels wired in apps/desktop/src/ipc/workspace.ts; the notImplemented stubs are gone.
- Gate: typecheck ok for shared/db/engine/desktop + tests/tsconfig (renderer red on another agents
  in-flight src/panes/**); desktop vitest project 279/279 green (20 files).

- [Phase 5 · B2] Dockview workspace shell + Files/Editor/Diff/Agents panes: `workspace/registry.ts`
  (a pane registers itself by calling `registerPane({kind, title, icon, component})` at module
  load; `panes/index.ts` is the side-effect aggregator both this task and B3 import into), a
  `WorkspaceHost` (dockview-react 8.2.0) with a toolbar of per-kind toggles, a "+" add-pane menu, a
  pointer-driven resize handle, and a per-group maximize button (dockview's own tab context menu
  needs the paid `dockview-enterprise` "ContextMenu" module, so `getTabContextMenuItems` was tried
  and removed — float still works via drag-out, just not from a right-click menu). Layout
  round-trips through `layout.get`/`layout.set` (debounced 400 ms on `onDidLayoutChange`), falling
  back to a Files+Agents default (Agents active, matching the old header toggle's behaviour) when
  nothing is saved or a saved layout throws on `fromJSON`. Files (lazy `fs.list` tree, `fs.search`,
  copy-path context menu — no `shell.showItemInFolder` channel exists yet, so "reveal in Explorer"
  is not offered), Editor (CodeMirror 6: one shared `EditorView` whose `EditorState` is swapped per
  tab so undo history survives a tab switch; `@lezer/highlight` tags mapped onto capygen's own
  tokens rather than importing `@codemirror/theme-one-dark`; Ctrl+S saves; binary/truncated files
  get no editable state at all, just a notice), Diff (`git.status` list + the existing `DiffView`
  block component reused for the unified patch + a `git.commit` box), and the pre-existing
  `AgentsPane` wrapped unmodified as a dockview panel (`AgentsPane.test.tsx` stays green untouched).
  ChatPage's "Agents" header button now opens `WorkspaceHost` instead of the bare pane.
  A real double-click in a browser fires two ordinary `click`s before the `dblclick` — jsdom's
  `fireEvent.doubleClick` does not — which had let a single click *also* open a file, racing three
  `fs.read`s for the same path into two duplicate Editor tabs; caught by the screenshot script
  driving a real Chromium, not by the (now also fixed and regression-tested) unit tests.
- Gate: `pnpm typecheck` clean (6 projects), `pnpm test` 66 files / 947 passed (repo-wide, alongside
  two other agents' in-flight files at the time), `pnpm build` clean. Screenshots via the new
  `/dev/workspace` dev-only route (fakes its own IPC bridge — this pane's `fs`/`git` calls bypass
  the store) at `e2e-out/workspace-files.png` / `workspace-editor.png`, captured with the throwaway
  `scripts/dev-workspace-screenshots.mjs` against a plain `vite` dev server (not Electron).

- [Phase 5 · C] Integration: every pane wired into the registry and the workspace host, the desktop
  services behind all 30 workspace channels, and `tests/e2e/workspace.spec.ts` — seven proofs,
  entirely offline (`CAPYGEN_ENGINE=stub`, a `git init`-ed temp copy of `tests/fixtures/servers/node`,
  a dev server that is a 30-line node script). Integration work beyond wiring, each of it a thing
  that was broken until it was found:
  * `defaultRenderer="always"` on the dockview host. The default (`onlyWhenVisible`) *unmounts*
    every non-active tab — which throws away an xterm and its scrollback, unsubscribes the Servers
    pane from `servers.status` while a start is still in flight (that is how "click Start, then look
    at the Browser tab" lost the URL), and destroys a `WebContentsView`.
  * The Browser overlay now also listens to `containerApi.onDidMaximizedGroupChange`: maximising a
    group rearranges dockview's presentation *without* changing the serialisable tree, so
    `onDidLayoutChange` never fires and the native view lagged a maximise by up to the 500 ms
    backstop poll. e2e `(g)` asserts `WebContentsView.getBounds()` and the placeholder's
    `getBoundingClientRect()` agree to 2px through a maximise and a window resize — the one fact
    neither process can photograph.
  * A saved layout's ids are rewritten **inside the JSON, before `fromJSON`**, not only patched
    after it. `toJSON()` serialises each panel's `params`, so a restored Terminal pane would
    `terminal.create` against yesterday's project; its "open one terminal" effect has a `[]`
    dependency list and would never reconsider. Patching afterwards only worked because dockview
    happens to build panels synchronously before React commits.
  * Caption-button clearance moved to whichever column is rightmost: `WorkspaceHost`'s toolbar
    reserves it while mounted and `ChatPage`'s header drops its own copy, otherwise the chat row
    had a 9rem hole in the middle of it.
  * `openInBrowser.ts` (new): the Servers pane's "open in Browser pane" used to be a no-op whenever
    the Browser tab was closed — which is the default layout's state, the one case the button
    matters most. It now creates the panel with `params.initialUrl`, exactly the shape
    `openInEditor.ts` already used, and only auto-opens for a start *this pane* asked for.
  * xterm's `fontFamily` is resolved to real family names (`readXtermFontFamily`): a
    `var(--font-mono)` reaches a `CanvasRenderingContext2D.font` string, where Chromium drops the
    whole declaration and measures a proportional face, so the cursor landed in the wrong column.
    The active tab is also focused now — the pane used to open with a terminal nobody could type
    into until they thought to click the black rectangle.
  * The offline echo engine turns a `todo: a, b, c` message into a real Claude-shaped `TodoWrite`
    tool call, which is what lets the Tasks derivation be proved without asking a model for a plan
    (R26). Two e2e-only seams: `data-status` on the server dot, and the xterm instance hung on its
    own container (`__xterm`) because under WebGL there is nothing in the DOM to read.
  Not achieved, recorded rather than hidden: switching away from the Browser tab still detaches the
  native view, so its back/forward history is lost on return (the address survives); `TaskSource`
  has no `"subagent"` value; the Codex plan path has no live backend to observe.
- Gate: `pnpm typecheck` clean (6 projects), `pnpm test` 66 files / 952 passed, `pnpm build` clean,
  `pnpm exec playwright test` 22 passed / 1 skipped (the API-key case) in 6.3 min — then
  `workspace.spec.ts` re-run at 7/7 after `(g)` was added. Screenshots: `e2e-out/workspace-layout.png`,
  `workspace-server.png`, `workspace-server-view.png` (the native view's own pixels),
  `workspace-tasks.png`. PLAN.md Phase 5 ticked with six deviations; A5 held with the float asterisk.

## Phase 5 review fixes (2026-09-06)

- Ask: fix the verified findings from the Phase 5 review wave (7 high, 12 medium, 5 low) and re-run
  the gate. Files touched: `apps/desktop/src/{main.ts,workspace/{paths,FsService,GitService,
  DevServerService,BrowserViewService,detectors}.ts}`, `apps/renderer/src/{workspace/{WorkspaceHost.tsx,
  browserOverlay.ts},panes/{editor,diff,browser,terminal,servers,files,agents}/**,components/
  {TurnRail,AgentsPane}.tsx,pages/ChatPage.tsx}` plus their tests and `tests/e2e/workspace.spec.ts`.
- Security: `fs.write` resolved its target lexically, so a junction inside a project let a save land
  outside it (proved: `path.relative` calls `<root>/escape/x` inside, `realpath` does not) — new
  `resolveNewInside` realpath-checks the nearest existing ancestor and the leaf. The Browser pane's
  partitioned session had no permission handlers, which is Electron's *approve everything*; both
  handlers now deny. `git.commit` passes `--` before its pathspecs, so `paths: ["-p"]` can no longer
  become `git add -p` waiting on stdin forever.
- Correctness: a legitimately-empty saved layout is no longer read as a failed restore (it was
  re-defaulting Files+Agents on every relaunch); `layout.set` is flushed on unmount instead of
  dropped inside the 400 ms debounce; `FsService.watch/unwatch` is reference-counted so a second
  Files pane keeps the watcher; `DevServerService.stop` always attempts the direct child kill, as
  `TerminalService.kill` always has; the Browser pane's native views are keyed by window and
  resolved from the calling renderer (`AsyncLocalStorage` carries the IPC sender), so a second
  window drives its own view.
- UX: the Editor asks before a dirty tab closes, has a visible Save button, follows `fs.changed`
  and refuses the first save over a file something else rewrote; the Diff pane commits the ticked
  rows rather than `git commit --all`, and renders untracked/staged/binary entries instead of an
  empty `+0 −0` card; the Terminal adopts `terminal.list` rather than orphaning a pty and spawning
  another, and waits to be visible; the Browser pane's empty state is reachable (a view is created
  by the first navigation) and parks itself while a DOM overlay or a dockview drag needs the box;
  the workspace width re-clamps against the window and is stored per project; the turn rail is
  anchored to the chat column, not the viewport; syntax keywords use `--brand-accent` (an opaque
  token) instead of `--tag-pink` (a 6 %-alpha chip background at ~1.1:1 contrast).
- Efficiency: `fs.changed` is debounced in both the Files and Diff panes, the Files pane re-lists
  only the directories the batch actually touched (and defers entirely while hidden), and
  `git.status` is sequence-guarded so a stale answer cannot overwrite a fresher one.
- Deferred, deliberately: the `TasksPane` half of the hover-focus finding (another agent has that
  file in flight this session — the identical `TerminalPane` control is fixed), and the Files pane's
  "reveal ignored directories" toggle (a new UI affordance, not a fix); the two search backends were
  made to agree instead, which was the machine-dependent half of that finding.
- Gate: `pnpm typecheck` clean (6 projects), `pnpm test` 66 files / 967 passed, `pnpm build` clean,
  `pnpm exec playwright test` 23 passed / 1 skipped (the API-key case) in 6.4 min.

## 2026-09-06 — Phase 6 / P0: contracts for settings hub, integrations, prerequisites
- `packages/shared/src/domain.ts`: `GlobalSettingsSchema` (versioned, sectioned — general/
  appearance/git/shortcuts/notifications/updates/efficiency/backends, plus closeToTray/
  startWithWindows/telemetry:false), additive alongside the flat `SettingsSchema` (still what
  `SessionRunner`/`appStore`/`DevWorkspacePage` read; this pass documents but does not migrate
  those call sites). Layering documented: global (`GlobalSettings.backends.<backend>`) → per-agent
  override (`Agent.config.<backend>`, already shipped). `McpServerEntry`/`PluginEntry`/
  `SkillEntry`/`ToolPolicyEntry` (R28) and `PrereqStep`/`DiagnosticsInfo` (R3, R19).
- `packages/shared/src/ipc.ts`: 22 new channels (`settings.getAll/.patch/.reset`,
  `integrations.list/.mcp.add|update|remove|test/.plugin.install|uninstall|setEnabled|
  marketplaces/.skill.setEnabled|create|open/.tools.setPolicy|removePolicy/.refresh`,
  `prereqs.status/.run`, `diagnostics.get/.copy`) + 3 events (`settings.changed`,
  `integrations.changed`, `prereqs.changed`).
- `packages/db`: migration `0005_integrations_backend_column.sql` adds the `backend` column
  `mcp_servers`/`policies` (migration 0001) were missing, plus `policies.updated_at` and a unique
  natural-key index — `plugins`/`skills` already had `backend` hoisted, and `GlobalSettings` needed
  no new table at all (one more row in the existing key/value `settings` table). New repos:
  `GlobalSettingsRepo`, `McpServersRepo`, `PluginsRepo`, `SkillsRepo`, `ToolPoliciesRepo`, all keyed
  by the entry's own natural identity (none of the four domain shapes has an `id` field) and fully
  unit-tested (`packages/db/test/store.test.ts` now 68 tests, `packages/shared/src/ipc.test.ts`
  now 42).
- `apps/desktop/src/ipc/handlers.ts`: minimal stub handlers (throw "not implemented — Phase 6
  Build wires this") for all 22 new channels, only to satisfy the exhaustive `IpcHandlers` type —
  wiring them to the new repos and to live CLI/file probes is Phase 6 Build's job.
- Gate: `pnpm typecheck` clean (5 workspace projects + `tests/tsconfig.json`), `pnpm test` 66 files
  / 993 passed, no regressions in files this task did not touch.

## 2026-09-06 — Phase 6 / B3: prerequisites detection + confirmed visible bootstrap
- `apps/desktop/src/prereqs/detect.ts`: real detection (no Electron) for node/git/ripgrep/uv/
  Windows Terminal (all optional or supporting) plus Claude Code and Codex — install and sign-in
  as two separate steps each, the sign-in step `blockedBy` its own install step. Claude's install
  check tries PATH, then the native installer's fixed `~/.local/bin/claude.exe`, then an npm-global
  shim, matching how this machine's own install was found (SPEC "Current State"); Codex is
  PATH-only, matching how this machine's own Codex was installed. Reuses `harnessList.ts`'s
  `CliProbe`/`claudeSignInSignal`/`probeCodex` outright rather than re-implementing them, so the
  setup panel and the New Session picker can never disagree about what is signed in.
- `apps/desktop/src/prereqs/runGate.ts`: pure functions only — `confirmOptionsFor` (dialog text
  quoting the exact command, CLAUDE.md), `consoleArgv` (visible `-NoExit` PowerShell, ported from
  Omnigent-windows' `bootstrap.js`), `firstUnmetDependency` (refuses a step out of order).
- `apps/desktop/src/prereqs/electronDefaults.ts`: the two Electron-shaped pieces
  (`dialog.showMessageBox`, a detached visible console) — `electron` loaded with a runtime
  `import()` inside the functions, never a top-level import, the same rule `ClaudeHarness` follows
  for its ESM-only SDK (COMPAT.md) and why this file has no import-time Electron dependency under
  vitest even though nothing in it is ever called from a test.
- `apps/desktop/src/ipc/prereqs.ts`: wires the above into `prereqs.status`/`prereqs.run`, with a
  Codex-probe cache (`cachedCodexProbe`, same shape as `harnessList.ts`'s own) so the panel's 3s
  poll does not spawn a fresh `codex app-server` child every three seconds. `prereqs.run` refuses
  an unknown step or an unmet dependency without ever showing the confirm dialog; a confirmed run
  starts a bounded main-process background re-detect that broadcasts `prereqs.changed` until the
  step is detected or ~2 minutes pass — which is what makes Settings ▸ Prerequisites'
  (`PrereqsSection`, built in parallel by the Settings-hub task) own `prereqs.changed` listener
  real, since nothing broadcast that event before. Wired into `apps/desktop/src/ipc/handlers.ts`
  (registration lines only — replaces the two `prereqs.*` stub entries from the P0 pass above).
- Renderer: `apps/renderer/src/components/prereqs/PrereqPanel.tsx` (step rows — detected/version
  badge, description, exact command, Run — with the 3s poll while a run might still be finishing,
  capped at ~40 polls) and `apps/renderer/src/components/SetupBanner.tsx` (reads the same
  `appStore.harnesses` snapshot Settings ▸ Harnesses uses, so no second Codex probe; renders
  nothing once a backend is available, a compact link-out banner once a CLI is installed but not
  signed in, or the full `PrereqPanel` inline on a genuinely fresh machine — SPEC R3's "first-run"
  case). `LandingPage.tsx` gained one `<SetupBanner />` line (minimal compat edit outside this
  task's file list, needed for the banner to actually appear anywhere).
- Found in flight, left alone: `apps/renderer/src/pages/settings/PrereqsSection.tsx` (the
  Settings-hub task's own file) had already built its own inline step list before `PrereqPanel`
  existed on disk, per its own header comment — the two are not de-duplicated; that is a follow-up
  for whoever finishes the Settings-hub integration, not this task's file to touch.
- Gate: `pnpm typecheck` clean (5 workspace projects + `tests/tsconfig.json`); `pnpm test` 93 files
  / 1203 passed / 4 skipped (pre-existing, not this task's), including the new
  `prereqsDetect`/`prereqsRunGate`/`prereqsIpc`/`PrereqPanel`/`SetupBanner` suites (50 new tests).

## 2026-09-06 — Phase 6 / B2: settings hub UI
- `shell/settingsNav.tsx`: `SETTINGS_NAV_GROUPS`/`SETTINGS_SECTIONS`, grouped like the reference's
  own `settingsNav.tsx` (General / Harnesses & tools / Workspace / Desktop / Admin / Archived).
  22 ids total — R19's list (general, appearance, git, shortcuts, import, integrations, account,
  cli, updates, members, policies, sharing, archived) plus capygen's own (harnesses, mcp, skills,
  plugins, api-keys, dev-servers, diagnostics) plus two Task B2 names outside R19's prose (tools,
  prereqs). `SettingsPage.tsx` rewritten to render this nav and route each id to a section body.
- New GlobalSettings-backed sections (`settings.getAll`/`.patch`/`.reset` via a shared
  `useGlobalSettings` hook, `components/settings/`, deliberately outside `appStore` — the
  established `ProvidersSection.tsx` pattern of a settings page talking to `ipc()` directly):
  General, Appearance, Git, Shortcuts (the last with a hand-picked default keybinding list —
  capygen has no shipped registry yet).
- New Integrations-backed sections (`integrations.list`/`.mcp.*`/`.plugin.*`/`.skill.*`/`.tools.*`
  via a shared `useIntegrations` hook), each per-backend-tabbed: Harnesses (availability from
  `appStore.harnesses` + a Defaults card per backend editing `GlobalSettings.backends.<backend>`,
  with a note that a per-agent override wins), MCP servers (add/edit dialog for stdio/http with
  client-side validation, Test, remove, a read-only note for `claudeai-proxy` entries), Skills
  (enable/disable, Create-skill dialog with a markdown editor, Open), Plugins (Claude:
  install/enable/uninstall + marketplace browse+install; Codex: read-only list with a note), Tools
  (per-backend allow/deny/ask policy table + pattern editor, Claude's four permission modes
  explained above it).
- Dev servers: no `GlobalSettings.devServers` section exists in the Phase 6 contract and adding one
  is outside this task's file ownership (`packages/shared`) — kept in `localStorage` for now with a
  note in the page and the commit, a documented provisional gap rather than a silent one.
- Prerequisites: swapped to render the real `components/prereqs/PrereqPanel.tsx` once it landed
  from the parallel B3 task mid-session — exactly the follow-up that task's own log entry above
  flagged as left for "whoever finishes the Settings-hub integration."
- Diagnostics (`diagnostics.get`/`.copy`) and Archived sessions (real, reusing the existing
  `appStore.sessions`/`archiveSession`/`setShowArchived` from Phase 2/4) are fully live. Import,
  Updates, Members, Policies, Sharing name their arriving phase; Account (no cloud login — local
  app) and the legacy Omnigent "Integrations" / "Local CLI" ids redirect to the capygen sections
  that actually cover the same ground, per Task B2 item 1's "no dead controls."
- `lib/theme.ts`: `applyTheme()` (pure DOM: `.dark` class, `data-theme=<palette>` attribute reusing
  `themePalettes.generated.css`'s existing palette selectors, `--desktop-ui-font-size` scaled by
  `fontScale` — that token's own doc comment already anticipated this — and a scoped
  reduced-motion stylesheet) plus `useApplyGlobalTheme()`, wired into `AppShell.tsx` in place of
  its old inline effect that read the flat Phase-2 `Settings.theme`; re-applies live on every
  `settings.changed` broadcast and on an OS light/dark flip while `theme==="system"`.
- `/dev/settings/:section` (dev-only route, `DevSettingsPage.tsx`) installs a fixture
  `window.capygen` bridge before anything mounts, for visual QA outside Electron. Screenshots:
  `e2e-out/settings-mcp.png`, `settings-plugins.png`, `settings-dark.png`.
- Gate: `corepack pnpm typecheck` clean for the 5 workspace projects this task touches (renderer
  included); `corepack pnpm test` 92/93 files green — the one red file,
  `packages/engine/test/configLayering.test.ts` (4 failing), is unrelated concurrent work in this
  worktree (`packages/engine`, explicitly outside this task's ownership) and was left untouched;
  `corepack pnpm build` clean. Committed only this task's 41 files (`git add` by path).

## 2026-09-06 — Phase 6 / B1: config sync engine (Claude + Codex stores, watchers, settings hub, diagnostics)

- New `packages/engine/src/config/**` (pure Node, no Electron): `ClaudeConfigStore` (reads
  `.claude.json` user + `projects[<cwd>]` local scopes, `<project>/.mcp.json`, the four-file
  settings chain, `plugins/installed_plugins.json` + `known_marketplaces.json`, user/project/plugin
  skills; writes MCP through `claude mcp add|remove -s <scope>` for the `.claude.json` scopes and
  by file edit for `.mcp.json`, tool policies into `permissions.{allow,deny,ask}`, skill
  enable/disable through the real `skillOverrides` settings key, plugins through
  `claude plugin install|uninstall|enable|disable`), `CodexConfigStore` (config.toml read + a
  **comment-preserving text-range patcher**, `[mcp_servers.*]`, `[plugins."…"]`, `[marketplaces.*]`,
  the model/effort/approval/sandbox root keys, skills by rename), `ApiConfigStore` (own servers in
  one `settings` key, plus the Claude/Codex servers it inherits, read-only), `toml.ts` (a TOML
  reader that records byte ranges — no library round-trips comments), `layering.ts`
  (global → backend default → agent override, merged field by field), `paths.ts`/`files.ts`/`cli.ts`.
- New `apps/desktop/src/integrations/**`: `SyncCoordinator` (chokidar watchers, 5 s TTL cache,
  concurrent-refresh dedupe, 300 ms debounce, `integrations.changed` only for kinds that moved,
  cache = a projection of the files), `IntegrationsService` (the 15 channels; every write is
  followed by a re-read), `SettingsService` (the hub, plus the projection onto Phase 2's flat
  `Settings` row so `SessionRunner`/`appStore` pick up the global defaults with no second source of
  truth), `DiagnosticsService` (versions/paths/backends/db size, redacted), `probeMcpServer` (the
  shared MCP pool behind `integrations.mcp.test`).
- Wired: `ipc/{settings,integrations,diagnostics}.ts` + three registration lines in `handlers.ts`
  (the 20 `notImplemented` stubs for those channels are gone), and `main.ts` supplies the Electron
  half — `nativeTheme.themeSource`, `app.setLoginItemSettings`, `clipboard.writeText`,
  `shell.openPath`, the pool probe — then calls `settings.applyOnStart()` and starts the watchers
  without awaiting them (G1's 3 s budget). `prereqs.*` was left alone: another session had already
  landed `ipc/prereqs.ts` + `src/prereqs/**`, so the duplicate `PrereqService` and
  `config/prereqs.ts` this task had written were deleted rather than shipped twice.
- Two real bugs found by the tests rather than by review: chokidar **silently drops** an edit made
  before its initial scan finishes with `ignoreInitial: true` (fixed by awaiting `ready`), and the
  diagnostics redactor left a short `Authorization: Bearer <token>` intact (fixed by taking the rest
  of the line).
- Verified live, read-only, against the real installation: `claude plugin list --json`,
  `claude plugin marketplace list --json`, `claude mcp list`
  (`CAPYGEN_LIVE_CONFIG=1 … --project engine configLive`, 5 passed); and, before any code was
  written, `CLAUDE_CONFIG_DIR=<temp> claude mcp add -s user|project|local`, which proved the
  isolation every test in this task depends on and that `.claude.json` moves inside that directory.
- Gate: `corepack pnpm typecheck` clean (6 projects); `corepack pnpm test` 97 files / 1244 passed,
  4 skipped, zero failures repo-wide; `corepack pnpm build` clean. COMPAT.md gained a
  "Config sync" section (every file, CLI command and flag relied on, with the version it was
  verified against) plus three Internal-seams rows.

## 2026-09-06 — Phase 6 / C: settings hub + two-way config sync + prerequisites integrated, e2e green

- **Isolation seam** (`apps/desktop/src/win/configHomes.ts`, applied in `main.ts` before anything
  reads `process.env`): `CAPYGEN_CLAUDE_CONFIG_DIR` → `CLAUDE_CONFIG_DIR`, `CAPYGEN_CODEX_HOME` →
  `CODEX_HOME`. One interception point, because everything downstream copies `process.env` —
  `resolveBackendHomes()` (stores, watchers, settings pages) and `cleanEnv()` (every harness
  child, every `claude mcp`/`claude plugin` spawn, MCP stdio servers, terminals, dev servers).
  Namespaced rather than the backends' own names on purpose: a capygen launched *from* a Claude
  Code terminal inherits that terminal's `CLAUDE_CONFIG_DIR` and would silently drive the wrong
  home. The directory is created first (`claude mcp add -s user` writes into it but will not make
  it) and the mapping is logged once, which the e2e asserts on — a run that used the real homes
  cannot pass as an isolated one.
- **Settings that actually do something**: `nativeTheme.themeSource` (e2e reads it back from the
  main process), `app.setLoginItemSettings` now **read-then-write** so `applyOnStart` on every
  launch is a registry read rather than a write to the machine's real Run key, the tray's
  `closeToTray` reads the hub with the flat row as fallback, and `notifications` finally has a
  consumer: `apps/desktop/src/win/notify.ts` taps the same `broadcast` the UI gets (no second
  event path, nothing new in a model's context — R26). `onFinish` ← `chat.turnStatus: done`;
  `onNeedsInput` ← the three R32 blocking cards; `onRunnerDisconnect` ← turn `error` +
  `app.status` `error`. A focused window never toasts, and each `<kind>:<turnId>` fires once.
  `app.setAppUserModelId` is required or `new Notification(...)` silently does nothing on
  Windows 10.
- **e2e** `tests/e2e/settings.spec.ts` — 9 pass, 1 skips: (a) all 22 nav ids + a non-empty body
  each + the isolation log lines; (b) a UI add writes the isolated `.claude.json` and
  `claude mcp list` (same temp home) prints it; (b3) capygen's own MCP client connects to that
  registered server and reads `show_card`/`echo` — live, no model, never skips; (c) an outside
  `permissions.allow` edit reaches the Tools table in <3 s; (d) a Codex UI add patches
  `config.toml` with every comment intact, and an outside `[mcp_servers.…]` block comes back;
  (e) an API key is absent byte-for-byte from every file in the profile and both homes and from
  the log, while `secrets.has` says `stored`; (f) with every `codex`-bearing directory pruned off
  `PATH`, Run… builds the dialog for that exact command and never reaches the console launcher
  (`CAPYGEN_PREREQ_CONFIRM=cancel` replaces the dialog and *only* the dialog); (g)
  `e2e-out/settings-dark.png`; (h) the real installed Claude plugins, read-only.
- **A safety call, and a real bug behind it.** The first draft of (b2) copied the machine's
  `~/.claude/.credentials.json` into the temp home so a live turn could run there. That is worse
  than a config write: the SDK refreshes from the copy, the refresh **rotates** the token
  server-side, and the new one lands in a directory the test deletes — logging the real Claude
  Code out. Removed. (b2) now runs against the real home with the server at **project** scope
  (`<tempProject>/.mcp.json` + `enableAllProjectMcpServers` in that project's `.claude/settings.json`)
  and re-checks the real home's mtimes at the end.
  Investigating why it still failed turned up the bug: this machine's `.credentials.json` **exists
  and holds empty token strings** (a Claude Code host that refreshes auth out of process leaves a
  stub; `claude -p` outside that host answers `Failed to authenticate: OAuth session expired and
  could not be refreshed`). `claudeSignInSignal` treated existence as a login, so the New Session
  picker offered a backend whose every turn 401s. It now reads three fields, returning and logging
  none of them: both token strings must be non-empty and `refreshTokenExpiresAt` must not be past;
  `expiresAt` is ignored (an expired access token is the normal state between refreshes); an
  unparseable or unrecognised shape still counts as a login, so a working machine cannot be locked
  out. Six unit tests pin each branch.
- Consequence for the suite: `tests/e2e/claudeAvailability.ts` gives `skeleton`/`widget` the skip
  guard `harnesses`/`roundtable` already had, quoting the app's own reason. On this machine the
  Claude-dependent tests now skip **in seconds with a sentence you can act on** instead of failing
  after a 150 s timeout.
- Also finished, from a session that ended mid-change: `tasks.create` (IPC channel, `TasksService`,
  the Tasks pane's add row) and the type errors its `notify.test.ts` had left behind.
- Gate: `corepack pnpm typecheck` clean (5 projects + `tests/tsconfig.json`); `corepack pnpm test`
  99 files / 1272 passed, 4 skipped; `corepack pnpm build` clean; `corepack pnpm exec playwright
  test` 34 tests — 0 failed. PLAN.md Phase 6 ticked with its deviations; COMPAT.md gained the
  credential-stub row and three Internal-seams rows; `docs/RUN.md` §4 gained the settings spec and
  §7 the three new environment seams.

## 2026-09-06 — Phase 6 review fixes

- Security. `createSkill` (both stores) now resolves the caller's name through
  `safeChildPath`, which refuses a separator, `..`, a drive letter or a control character and
  re-checks containment — a name off the IPC boundary used to reach `FileIo.write`, which
  `mkdir -p`s whatever parent it is given. `integrations.skill.open` checks the path against the
  skill files capygen actually lists before it reaches `shell.openPath`, so the channel can no
  longer launch an arbitrary program. `assertCliPositional` refuses an MCP-server or plugin name
  starting with `-`, which the `claude` CLI's own option parser would otherwise swallow.
- R27. `integrations.plugin.install`/`.uninstall` are gated in **main** by a native confirm that
  quotes the exact `claude plugin …` command (`integrations/installGate.ts`), and the two commands
  run with `showConsole: true` (`windowsHide: false`). The engine comment claiming a renderer
  dialog satisfied this was wrong: there was no such dialog.
- Correctness/efficiency. `retargetIfProjectMoved` clears the sync cache synchronously, so
  `integrations.list` right after a project switch can no longer answer with the previous
  project's project-scope rows. `ClaudeConfigStore.read()` builds one `ClaudeReadContext` (settings
  chain + parsed `.claude.json`) and threads it down instead of re-reading both per `.mcp.json`
  server and per sub-read. `cachedCliProbe` is shared by `harness.list` and Diagnostics, so
  `claude --version` is one child process, not two per page.
- Settings UI honesty. Every inline row action reports its failure on the row (`useRowActions`);
  rows no store will write (plugin scope, inherited, `sse`, claude.ai) are read-only with a
  reason; scope options are derived from the backend and whether a project is open; clearing
  Arguments sends `args: []` rather than silently restoring them; the MCP form gained an `env`
  editor and an enabled toggle; MCP/Skills/Plugins gained a Refresh button and a "synced …" line;
  Tools drops the `session` scope, badges unenforced rows and replaces the Codex/API editors with
  a Phase 9 note (nothing reads those rows); Dev servers replaces two dead `localStorage` controls
  with the same note treatment.
- Deferred: the low-severity duplicate-heading finding (page `<h1>` + `SectionIntro` `<h2>`).
  Removing the page heading leaves a section with no title at all while it loads, since ten
  sections return `SectionLoading`/`SectionError` before their intro — not a trivial fix.
- Gate: `corepack pnpm typecheck` clean (5 projects + `tests/tsconfig.json`); `corepack pnpm test`
  99 files / 1296 passed, 4 skipped; `corepack pnpm build` clean; `corepack pnpm exec playwright
  test` 34 tests — 24 passed, 10 skipped (Claude sign-in), 0 failed. COMPAT.md's headless-CLI
  section records `showConsole` and `assertCliPositional`.

## 2026-09-06 — Astra takeover review and next-phase preparation

- Read/imported the relevant context from both local Claude Code transcripts named
  “Omnigent Windows app bootstrap”; source sessions/timestamps/message UUIDs recorded in
  `docs/reviews/phase1-6.md`. Raw transcripts, credentials and tool payloads were not imported
  into git or the app DB. App transcript importing remains Phase 7.
- Crew confirmed: GPT Astra medium lead/design/decisions, Luna simple inventory/docs check,
  Opus 5 independent substantive review, Fable 5.1 medium core-decision debate. Claude's first
  attempts failed on login; after the user's reauthentication, Opus completed review and Fable
  completed two debate rounds. No silent model substitution.
- Confirmed open: API/widget MCP discovery diverges from Settings and ignores isolated homes;
  MCP pool identity omits env/headers; Codex/global backend defaults aren't consumed by the
  harness; project settings use recency rather than active project identity. Opus independently
  confirmed all four. Focused mocked probes confirmed the isolation and pool-key cases without
  reading real config or starting servers. A reviewer argument-joining false positive was
  challenged and withdrawn (the delimiter is U+0001, not the empty string).
- Corrected stale plan/handoff/policy-enforcement prose; updated persistent crew instructions.
  Retained the stack after Fable debate. Added `docs/plans/phases7-12.md`: corrective batch
  first, combined runtime wiring ownership, explicit repo/worktree identity, inert bounded
  imports, persistent isolated live-test identity, automation lifecycle, permissions/shares,
  dictation/extension decision gates, byte-cap correction, compaction implementation and
  measured efficiency, native packaging/parity acceptance. No later phase ticked or implemented.
- Baseline checks run through native Windows Node 22.16 from WSL:

```text
corepack pnpm typecheck
  packages/shared typecheck: Done
  packages/db typecheck: Done
  packages/engine typecheck: Done
  apps/renderer typecheck: Done
  apps/desktop typecheck: Done
corepack pnpm test
  Test Files 99 passed (99)
  Tests 1296 passed | 4 skipped (1300)
corepack pnpm build
  Done in 273ms
  [build] desktop bundle written to .../apps/desktop/dist
```

- First full e2e baseline under explicitly isolated backend homes: 21 passed, 12 skipped,
  1 failed. The existing real-plugin-inventory case compares a personal registry to the app's
  isolated list. Final verification mirrors only `installed_plugins.json` (non-secret inventory)
  into the temporary Claude fixture; no auth or settings copied. This is a fixture-environment
  accommodation, not a runtime fix. Final complete gate is recorded with the mascot task below.
- Review artifacts/logs retained locally in ignored `e2e-out/review/`; runtime findings remain
  open, with acceptance tests assigned to their implementation tasks. Nothing pushed.

## 2026-09-06 — Sharp pixel mascot with drawn frame animation

- Preserved the supplied reference as `assets/mascot/pixel-reference.png`. Two imagegen atlas
  drafts failed true transparency/grid requirements; the user explicitly authorized finishing
  with code. `scripts/mascot-pixels.py` uses the existing Windows Python/Pillow installation,
  not a newly installed dependency, and preserves the reference's 29-colour palette.
- Generated 8 states × 4 distinct drawn frames at 72 logical pixels, exported 4× nearest-neighbor
  to a 1152×2304 RGBA atlas. Only alpha 0/255; no smoothed edges. Updated static state assets,
  manifest/legacy strip and animated review board. Removed enclosed background in the listening
  headband. Source and authoring instructions are in `assets/mascot/README.md`.
- Replaced static-image bobbing/fades with CSS stepped atlas playback. Landing size is 144px
  (2× logical pixels); existing inline icon layout stays intact. Accessible state labels and
  stationary first-frame handling work for both OS and Settings reduced motion. Renderer staging
  copies the atlas for dev/build/file:// use; no generated-home path is a production dependency.
- Verification discipline: updated Mascot unit expectations failed first (3 assertions against
  the old implementation), then all four passed. The new offline Electron test decodes the actual
  atlas, captures four distinct frames, checks 144px/pixelated/steps(4), OS/app reduced motion,
  and supported minimum viewport. The legacy skeleton test's static img/src expectation failed
  in the full suite; updated that check to decode the actual CSS atlas, preserving its original
  pre-live image-load guarantee. No existing live-turn assertions removed.
- Visually inspected the supplied reference, all-state animated-frame board, native desktop
  screenshot and supported 860×560 minimum: mascot and composer fit. A 380px stress screenshot
  exposes the existing fixed sidebar constraint, outside the supported desktop minimum;
  no mobile-support claim or unrelated responsive redesign. Screenshots: `e2e-out/mascot-*.png`.
- Opus independently decoded the PNG twice: 32 unique/nonblank cells, binary alpha, original
  palette membership, correct row/column math. Two consecutive clean reviews; the second covered
  the final generator, skeleton test, minimum-size check and documentation changes.
- **Final full gate: exit 0**, native Windows Node 22.16, final implementation and test changes.
  Commands: `corepack pnpm typecheck && corepack pnpm test && corepack pnpm build &&
  corepack pnpm exec playwright test`. E2e launched through the local PowerShell fixture wrapper
  with fresh `CLAUDE_CONFIG_DIR` / `CODEX_HOME` plus the CAPYGEN equivalents, empty API-key env,
  and only the non-secret installed-plugin inventory mirrored for the legacy registry assertion.
  No personal credentials copied, no real-user configuration changed, no live models invoked.
  Complete output: ignored `e2e-out/review/full-gate.log`; fixture wrapper retained alongside it.

```text
packages/shared typecheck: Done
packages/db typecheck: Done
packages/engine typecheck: Done
apps/renderer typecheck: Done
apps/desktop typecheck: Done

Test Files 99 passed (99)
Tests 1296 passed | 4 skipped (1300)
Duration 33.99s

Done in 261ms
[build] desktop bundle written to .../apps/desktop/dist

ok 33 ... (e) dragging the Terminal tab under the Browser group survives a restart
ok 34 ... (f) the fixture dev server is detected, started, and loaded in the Browser pane
ok 35 ... (g) the native overlay tracks its placeholder through maximise and a window resize
12 skipped
23 passed (58.0s)
```

- Unit skips are the opt-in live config checks; e2e skips require authenticated Claude/Codex/API
  homes. Reauthenticated review workers do not make disposable app test homes signed in. The
  full gate is green with those explicit skips; it does not re-prove the historical live phases.
- Local review/preparation commit: `7f94de2`. Mascot task committed separately. No pushes.
  Phases 7–12 remain open, and R-A–R-D remain reviewed corrective implementation tasks.

## 2026-09-06 — static PNG mascots (user correction)

- Replaced frame animation with one static PNG per reactive state. Kept the 144px landing
  mascot, sharp pixel rendering and accessible labels. Removed animation CSS and atlas staging;
  historical authoring assets remain available. Luna implemented; Astra integrated and verified.
- Updated the asset contract, run instructions and existing mascot/skeleton assertions.
- Windows validation: brand unit tests, workspace typecheck, build, and isolated offline mascot
  Electron e2e passed. Desktop screenshot reviewed. No phase completion claim or push.

```text
Test Files 3 passed (3)
Tests 10 passed (10)
apps/renderer typecheck: Done
apps/desktop typecheck: Done
[build] desktop bundle written to .../apps/desktop/dist
1 passed (4.4s)
```

- Opus 5 independently reviewed the static conversion: approved, no high/medium findings.

## 2026-09-07 — remaining phases and Custom Mode authorized

- User adds Custom Mode from supplied diagram and requests completing all remaining phases.
  SPEC R33/R34 and PLAN Phase9C capture prompt authoring, visual/JSON review/editing, combined
  solo/debate behavior and example role/model/effort routing. All test prompts now restricted
  to GPT Luna low / Sonnet5 low, with no silent substitution.
- Astra/Fable completed two design debate rounds. ADR-0006 records decisions and required
  capability proofs; this is accepted design, not implemented feature acceptance.
- Phase7-P0 explicit project context contract frozen before implementation. Opus implements
  P0 and independently owned P2 connection identity; Luna updates isolated live test scripts.
- Validation for this documentation task: checked PLAN Phase9C and SPEC R33/R34 against all
  image requirements and both debate reviews; no numbered phase marked complete.

### Phase 7-P2 — MCP connection identity

Opus fixed canonical connection identity to include env/headers and hash unambiguous JSON.
Astra review caught duplicate-case header order and mutable base env; Opus reproduced and
fixed both. Base environment is captured once per registry; differing effective connection
options isolate pools, equivalent maps share. No keys or credentials appear in leases/logs.

Red: 7 failed / 10 passed before initial fix; both review regressions also reproduced red.
Final independent Windows check: `corepack pnpm exec vitest run --project desktop
apps/desktop/test/mcpPools.test.ts`:

```text
Test Files 1 passed (1)
Tests 19 passed (19)
Duration 1.45s
```

An earlier final-check attempt hit an in-progress P0 shared-schema edit (ProjectScoped not
yet declared); rerun after declaration passed. This task is accepted after two review rounds;
Phase7 overall remains open, with full integration gate due after its remaining work.

### Test prerequisite — Claude effort reaches the SDK

Opus wired valid `agent.config.claude.effort` into query options on fresh and resumed
backend sessions; unset/invalid values retain the existing default behavior. Astra reviewed
the diff and independently ran the request-capture suite. Global hub defaults still need P1.
Red evidence reproduced by removing propagation; final Windows check:

```text
corepack pnpm exec vitest run --project engine packages/engine/test/claudeHarness.test.ts
Test Files 1 passed (1)
Tests 34 passed (34)
Duration 4.62s
```

No model calls or personal login/config access.

### Test prerequisite — Anthropic API effort reaches request bodies

Opus added supported `output_config.effort` to Anthropic request construction; Astra
reviewed against installed SDK 0.124.0 `OutputConfig` and independently ran body-capture tests.
Low effort is no longer silently dropped for the API smoke path. Cache breakpoints and
thinking configuration remain asserted on the same request. Whole-harness capture is next.

```text
corepack pnpm exec vitest run --project engine packages/engine/test/apiProviders.test.ts packages/engine/test/testPolicy.test.ts
apiProviders.test.ts (28 tests)
Test Files 2 passed (2)
Tests 33 passed (33)
Duration 822ms
```

The second suite checks dedicated test-home guards; no model/network calls.

### Phase 7-P0 — explicit project context (Opus 5)

Every `integrations.*` channel now carries an optional explicit `projectId`
(`packages/shared/src/ipc.ts`). Omitted means **global only**, never the
most-recently-touched project; an unknown id is refused before any read, write,
probe or shell open; a project/local mutation requires one. `IntegrationsService`
resolves the id once per request into an immutable `ProjectScope` and threads it
through the Claude/Codex/API stores (the mutable "active project" and its
`retargetIfProjectMoved` are gone). `SyncCoordinator` keys its cache, in-flight
reads, watchers and debounce timers by `(backend, scope)`; only the **global**
read is projected into the SQLite cache tables, so a project read can no longer
overwrite the global rows, and app-owned policy rows are untouched. A global
write invalidates every project snapshot as well; watchers start once per pair,
close on disposal and their late callbacks broadcast nothing. Renderer keeps the
selected project per window (`appStore.selectedProjectId`, seeded from recency
once on `init`, then only by an explicit pick / session open), sends it on every
integrations call, drops stale answers from a scope it has left, filters
`integrations.changed` by scope, and names the project on the scoped settings
sections.

```
corepack pnpm typecheck   (shared, db, renderer, desktop: Done)
vitest run --project desktop --exclude **/mcpPools.test.ts  29 files, 410 passed
vitest run --project renderer --project shared              52 files, 507 passed
```

New: `apps/desktop/test/integrationsProjectScope.test.ts` (10),
`apps/renderer/src/components/settings/useIntegrations.test.tsx` (4),
`apps/renderer/src/store/selectedProject.test.ts` (4). No commit, no push, no
live model calls; all backend homes isolated. `mcpPools.ts` (7-P2) and
`packages/engine/scripts` untouched.

### 2026-09-07 — test isolation review correction (Astra)

The e2e worker ran the legacy `settings.spec.ts` before conversion despite the task requiring
its personal-home reads to be reported for correction. Its plugin case read the personal
installed-plugin registry while the launched app inherited isolated backend homes; the case
failed comparing personal plugin names with the isolated app list (8 passed, 1 skipped,
1 failed). Astra stopped that worker and assigned conversion of every direct personal-file
read before this suite may run again. No passing phase proof is claimed from that run.
The new e2e teardown also trusted an environment-supplied deletion path; review requires
cleanup to capture only the temporary directory allocated by setup. Both remain under
corrective review, alongside the final low-effort request-capture test type error.
- S0 (Opus): MCP secret refs added to the safeStorage secrets store (apps/desktop/src/ipc/secrets.ts) — opaque `mcp/<32 hex>` refs with setRef/getRef/hasRef/deleteRef, namespaced `mcp` ciphertext map beside the unchanged provider keys, atomic temp+rename writes, corrupt files refused for mutation; new apps/desktop/test/mcpSecrets.test.ts (13 tests). No IPC or handlers.ts changes.

### S0 accepted — encrypted MCP reference foundation

Opus implemented the main-process reference namespace in the existing safeStorage store.
Astra review corrected unreadable-file data loss, input-bearing encryption errors, malformed
entry acceptance and temporary-file collision handling. Astra re-read the final code and
independently ran the focused suite; Fable's final review found no high/medium findings.

```text
corepack pnpm exec vitest run --project desktop apps/desktop/test/mcpSecrets.test.ts
Test Files 1 passed (1)
Tests 19 passed (19)
Duration 1.13s
```

Evidence: `e2e-out/review/mcp-secrets-final.log`. Tests use temporary files and fake encryption,
not user keys or personal configuration. The reference API is not yet connected to MCP runtime
resolution; P1 owns that integration. Atomic rename is not a power-loss durability guarantee
(the store does not fsync); reference presence is not proof this account can decrypt it.
No overall phase has been marked complete.

### Phase 7-P0 — review round 2 (Astra + Fable findings, Opus 5)

Seven correctness fixes on top of the first P0 pass, each with a regression that
was confirmed to fail with the fix reverted:

1. **`McpDialog` writes to the scope it opened on.** `backend` + `projectId` are
   frozen in a ref when the dialog opens and sent with the add/update; a scope
   that moved under the open dialog disables Save with a stated reason, and the
   panel closes the dialog on any backend/project change.
2. **Write reach is the resource's, not the request's.** `afterWrite` takes a
   `WriteReach`: `user`/`plugin` MCP servers, plugins and user skills are
   `global` however the request was addressed, so they re-read at global scope —
   which drops every project snapshot of that backend, re-persists the global
   SQLite projection, and emits `projectId: null`. `project`/`local` MCP servers,
   project skills and project policies stay per project.
3. **A global re-read invalidates the project snapshots before it broadcasts.**
   `SyncCoordinator.refreshOne` drops the backend's project memos at the top of
   the run, so the reload a watcher event asks for cannot be served the snapshot
   computed against the previous global content.
4. **`api` is watched and refreshed with what it inherits.** Listing `api` for a
   project also establishes the Claude and Codex watchers for that scope, and
   every `claude`/`codex` refresh fans out to `api` in the same scope.
   Project watchers now watch only the paths the project *adds*.
5. **`useIntegrations` guards on the current scope, not only the ticket.** An old
   refresh's captured `reload` resolving after a scope switch took the newest
   ticket and overwrote the new project's data; a scope check at request entry
   and completion stops it, and the previous scope's rows are cleared the moment
   the scope changes so nothing stale stays actionable.
6. **Unidentifiable tool-policy scopes are refused.** `policies` has no project
   column, its natural key is (backend, scope, pattern) and `session_id` is
   always NULL — so `project`/`session` for `codex`/`api` and `session` for
   `claude` are refused with that reason instead of stored as if scoped.
   Removal still works, so pre-existing rows stay deletable. The Tools editor
   already renders only for Claude and only offers global/project.
7. **The project watcher pool is bounded.** LRU over project scopes
   (`DEFAULT_MAX_PROJECT_WATCHERS = 8`) closes and drops the coldest project's
   watchers, timers and snapshots; a watcher that cannot be created backs off for
   `DEFAULT_WATCH_RETRY_COOLDOWN_MS` instead of being retried by every list.

Also: `refreshOne` no longer needs (and callers must not do) a pre-emptive
`invalidate` — that dropped the `before` snapshot and made every refresh claim
all four kinds moved. Dead `invalidateAll`/`invalidateAllScopes` removed.

Projection audit for the review's open question: `mcp_servers`, `plugins` and
`skills` have **no** production reader — `SyncCoordinator.persist` is the only
writer and nothing outside tests reads them back. `policies` **is** read
(`IntegrationsService.toolPolicies`), so it stays. The three dead projections
were left in place rather than removed in a review round; they are global-scope
only and no longer a correctness hazard. Recommend removal as a separate task.

```
corepack pnpm --filter @capygen/shared --filter @capygen/desktop --filter @capygen/renderer -r typecheck
  packages/shared: Done   apps/desktop: Done   apps/renderer: Done
corepack pnpm exec vitest run --project desktop --exclude **/mcpPools.test.ts
  Test Files  30 passed (30)      Tests  437 passed (437)      7.93s
corepack pnpm exec vitest run --project renderer --project shared
  Test Files  52 passed (52)      Tests  511 passed (511)     30.72s
```

Run natively on Windows via `cmd.exe /c corepack pnpm …`. No commit, no push, no
installs, no live model calls; every backend home isolated under a temp dir.
`mcpPools.ts`/test (7-P2) and `packages/engine/scripts` untouched. **Not claiming
P0 accepted — this is the fix round, awaiting Astra's re-review.**

### Live script policy accepted (Luna implementation, Astra/Opus review)

All live/spike entrypoints require explicit isolated Claude/Codex homes and pin model prompts
to Sonnet 5 low or GPT Luna low. Other provider/model selections are refused before dispatch.
The path guard rejects personal roots, descendants, ancestors and symlink aliases. API smoke
no longer logs even a masked key. Same-model native routing reports PARTIAL rather than
claiming proof of a different-model rewrite. Opus reviewed the final scripts and guard fixes.

The five guard regressions passed within Astra's independent Windows gate:

```text
corepack pnpm typecheck
all packages: Done
corepack pnpm test
Test Files 104 passed (104)
Tests 1388 passed | 4 skipped (1392)
Duration 42.29s
corepack pnpm build
[build] desktop bundle written
```

Logs: `e2e-out/review/p0-gate-{typecheck,unit,build}.log`. This is offline evidence, not a live
CLI capability proof or an overall phase completion. Full e2e and P0 final review are pending.

### Phase 7-P0 accepted — explicit project scope

Astra reviewed the final implementation, inspected the isolated Plugins screenshot showing
its project label, and verified the complete gate evidence. Fable's final substantive review
found no high/medium findings after the seven fixes. Native Windows gate on this implementation:

```text
corepack pnpm typecheck
all packages: Done
corepack pnpm test
Test Files 104 passed (104)
Tests 1388 passed | 4 skipped (1392)
Duration 42.29s
corepack pnpm build
[build] desktop bundle written
corepack pnpm exec playwright test
12 skipped
43 passed (55.6s)
```

Astra ran the first three checks; the e2e worker ran the full final suite after static isolation
review, and Astra collected its literal output. Nine converted settings cases passed offline.
The 12 skips are pending live/runtime proofs: six UI-created effort gates, five unavailable
backends in disposable homes and one case requiring dedicated authenticated homes. They do
not complete the remaining Phase 7 runtime/worktree/import acceptance.

Low follow-ups: remove dead MCP/plugin/skill projections, avoid an evicted watcher's last
queued read, and avoid broad manual-refresh notifications. P1 owns full transport redaction,
canonical runtime defaults and widget configuration identity; none is silently claimed here.

### E2E isolation and pre-dispatch model policy accepted

Opus converted all legacy personal-config content reads to owned fixtures/dedicated identities.
Astra caught and corrected an environment-controlled teardown deletion target, Windows casing
bypasses, and a model/effort assertion that ran after the landing composer had already sent its
prompt. The six UI-created live paths now stop before dispatch until P1 and an effective-config
assertion exist. Explicitly configured paths retain assertions before send, including pinned
Codex configuration on a delegated child. No live prompts were run for this acceptance.

Final native Playwright output: `12 skipped`, `43 passed (55.6s)`. The converted settings cases
contributed nine offline passes. The whole-harness Anthropic low-effort capture is type-safe;
API/provider/test-policy focused tests passed 60 cases after final typecheck. Astra reviewed
source and inspected `settings-plugins-isolated.png`. Skips remain open live-proof items.
