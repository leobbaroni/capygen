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

## Open / next
- Phase 2: A1 foundation landed (echo stub engine). Next: the real Claude harness behind the
  same `Engine` interface (`apps/desktop/src/engine/stub.ts`), block streaming, permission and
  AskUserQuestion cards.

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
