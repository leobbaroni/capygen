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

## Open / next (superseded — see the entry for Task B1 below)
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

## Open / next
- R2 (tray / close-to-tray) has no e2e — Playwright cannot drive the Windows tray; it is unit-tested
  in `apps/desktop/test/win.test.ts`.
- Permission cards round-trip in unit tests only. A live proof would depend on the user's own
  `~/.claude` allowlist not pre-approving the tool, so it is left for Phase 3's harness matrix.
- `tests/e2e/skeleton.spec.ts` runs on every `pnpm e2e` and spends real tokens. If that becomes
  annoying in CI, gate it behind a tag rather than deleting it — it is the only proof the app talks
  to a real model.
- Sub-agent routing policy is a stub (`ClaudeHarness` `routeSubagent` dep, fail-open) — Phase 4 fills it in.
- Round-table queuing: the runner allows one in-flight turn per session; Phase 4 adds the dispatcher.
