export const meta = {
  name: 'capygen-phase2-skeleton',
  description: 'Phase 2: walking skeleton app (Electron shell, Omnigent theme, landing + chat, Claude harness, SQLite persistence, mascot/wordmark) with e2e proof, plus spike-gate fixes; then adversarial review and fix loop',
  phases: [
    { title: 'Foundation', detail: 'monorepo + Electron shell + renderer skeleton + shared contracts + db (Opus); spike-gate fixes (Sonnet)' },
    { title: 'Build', detail: 'Claude harness + session runner (Opus) · landing/chat UI port (Sonnet) · brand assets (Sonnet)' },
    { title: 'Integrate', detail: 'wire everything, e2e pong + restart persistence (Opus)' },
    { title: 'Review', detail: 'adversarial review wave on the other model, then fixes' },
  ],
}

const ROOT = 'C:/Users/TugaPlayz/Desktop/GITHUB/capygen'
const REF = ROOT + '/reference/omnigent/web/src'
const WINREF = 'C:/Users/TugaPlayz/Desktop/GITHUB/Omnigent-windows/app/src/win'
const PNPM = 'corepack pnpm --dir ' + ROOT
const COMMON = [
  'Repo: ' + ROOT + '. Read ' + ROOT + '/CLAUDE.md, ' + ROOT + '/SPEC.md, ' + ROOT + '/PLAN.md (Phase 2 + Approach layout), ' + ROOT + '/CONTEXT.md first.',
  "Absolute paths everywhere. Package manager: 'corepack pnpm' (never bare pnpm). Windows 10, Node 22.16. Run TS with tsx. Never push. Commit only when your task says so, and only your own files.",
  'This repo is a monorepo: apps/desktop (Electron main + preload, TypeScript bundled with esbuild), apps/renderer (Vite 8 + React 18 + Tailwind 4 + shadcn/ui), packages/shared (zod IPC contracts + domain types), packages/db (SQLite), packages/engine (harnesses).',
  'Design reference (read-only, never import): ' + REF + " — Omnigent's SPA. Copy its look: tokens from " + REF + '/index.css + ' + REF + '/themePalettes.generated.css (keep the Apache-2.0 attribution comment), layout from ' + REF + '/shell/AppShell.tsx, landing state in ' + REF + '/pages/ChatPage.tsx + ' + REF + '/lib/branding.ts ("What should we build?"), composer/chat blocks under ' + REF + '/components/{chat,blocks,ai-elements,ui}.',
  'Windows shell patterns already proven in the sibling project (port to TS, same behaviour): ' + WINREF + '/chrome.js (seamless title bar: titleBarStyle hidden + titleBarOverlay, caption buttons blended to the sampled page colour, injected drag-region CSS), ' + WINREF + '/integration.js (tray, close-to-tray, single instance), ' + WINREF + '/logger.js (rotating file log with secret redaction), ' + WINREF + '/cli_windows.js (cliEnv: strip nested-session vars CLAUDECODE, CLAUDE_PID, CLAUDE_EFFORT, CLAUDE_CODE_*; PYTHONUTF8=1; windowsHide).',
  'Assets: ' + ROOT + '/assets/mascot/states/{idle,thinking,working,waiting,success,error,sleeping,listening}.png (256px, transparent), ' + ROOT + '/assets/mascot/capybara-states-256.png (strip) + capybara-states.json, ' + ROOT + '/assets/fonts/CheGuevaraBarry-Brown.ttf.',
  'Claude Agent SDK facts proven in Phase 1 (read ' + ROOT + '/docs/spikes/claude-sdk-shapes.md and ' + ROOT + '/docs/spikes/engine.md; line citations there are unreliable — read ' + ROOT + '/packages/engine/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts yourself): query({prompt, options}) streams SDKMessages; includePartialMessages gives stream_event deltas; system/init carries slash_commands/skills/plugins/tools/model; canUseTool receives AskUserQuestion and returns {behavior:"allow", updatedInput:{...input, answers:{[question]:label}}}; PreToolUse hook matcher must be "Task|Agent" (wire name "Agent"); usage on result.usage/result.modelUsage/total_cost_usd; pass options.model explicitly; settingSources ["user","project"] loads the user\'s skills/plugins/MCP (and runs their hooks); env must be the cleaned env.',
  'Efficiency rules (SPEC R23–R26): no per-turn system prompt churn, persist blocks incrementally, keep IPC out of the model context, lazy MCP schemas.',
  'Every claim in your final report must be something you ran or read; paste the command + output tail for each Done-when check.',
].join('\n')

phase('Foundation')
const foundationP = agent(COMMON + '\n' + [
  'TASK A1 — Foundation (you own everything except packages/engine/scripts/* and docs/spikes/*).',
  'Build the monorepo skeleton so that the app launches to a placeholder landing page, with the shell, contracts and database in place. Deliverables:',
  '1. Root: package.json scripts (dev, build = renderer vite build + main/preload esbuild, start = electron on built output, test = vitest across packages, typecheck, e2e = playwright electron test). Keep the existing "spike" script. tsconfig.base.json. Vitest workspace. Playwright as devDependency (Chromium download NOT needed; use _electron).',
  "2. packages/shared: domain types + zod schemas: Project, Session {id, projectId, mode:'solo'|'round-table', leadAgentId, title, status, createdAt, updatedAt, archived}, Agent {id, sessionId, name, backend:'claude'|'codex'|'api', model, role, config}, Turn {id, sessionId, agentId|null, role:'user'|'agent'|'system', createdAt, parentTurnId?, hopIndex}, Block union (text, thinking, tool_call{name,input,output?,status}, diff, permission{request,decision?}, question{questions,answers?}, subagent, error, usage), UsageEvent, Settings. IPC channel contract as typed maps: renderer→main invoke (projects.pick/list, sessions.create/list/get/archive, turns.list, chat.send, chat.interrupt, chat.listCommands, permission.answer, question.answer, settings.get/set, app.version) and main→renderer events (chat.block (upsert by blockId), chat.turnStatus, session.updated, permission.request, question.request, app.status). Export a typed defineIpc helper used by preload + renderer hooks.",
  '3. packages/db: decide the SQLite driver by checking the Electron runtime: after adding electron as a devDependency of apps/desktop run: corepack pnpm --dir ' + ROOT + '/apps/desktop exec electron -e "console.log(process.versions.node, (()=>{try{require(\'node:sqlite\');return \'node:sqlite ok\'}catch(e){return \'no node:sqlite\'}})())" . If node:sqlite (DatabaseSync) is available in the Electron runtime, use it (no native build); otherwise better-sqlite3 + @electron/rebuild. Record the decision in ' + ROOT + '/docs/adr/0003-sqlite-driver.md. Schema per SPEC §Data as numbered migrations (0001_init.sql) applied on open with a backup file written before migrating; repositories for projects/sessions/agents/turns/blocks(tool_calls)/usage_events/settings; vitest tests using a temp DB file.',
  '4. apps/desktop: main.ts (single instance, seamless chrome ported from chrome.js incl. caption blend, tray with Open/New Window/Quit and close-to-tray, rotating redacting logger in %APPDATA%/capygen/logs, SQLite open in %APPDATA%/capygen/capygen.db, window state persistence, loads renderer dev URL when CAPYGEN_DEV_URL is set else the built index.html), preload.ts (contextBridge exposing only the typed IPC), ipc/ handlers for everything in the contract with a stub engine that echoes "echo: <text>" as a text block after 300 ms (so the UI can be built before the real harness lands), native folder picker for projects.pick. esbuild bundling to apps/desktop/dist. windowsHide + cleaned env helpers in apps/desktop/src/win/.',
  '5. apps/renderer: Vite + React 18 + Tailwind 4 + shadcn/ui initialised (components.json like the reference), index.css = Omnigent tokens copied with attribution, zustand store skeleton, router (landing "/", chat "/c/:sessionId", settings "/settings/*" placeholders), AppShell layout matching the reference (sidebar + main), a placeholder landing that shows the idle mascot PNG, the heading "What should we build?" and a composer textarea that calls chat.send and renders the echoed block in a minimal transcript. @font-face for CheGuevaraBarry-Brown from assets (copy font into apps/renderer/public/fonts).',
  '6. e2e: tests/e2e/launch.spec.ts using Playwright _electron: launch built app with an isolated --user-data-dir, wait for the landing heading, screenshot to e2e-out/landing.png, type "hello", press Enter, expect "echo: hello" in the transcript, close.',
  'Done when (paste outputs): ' + PNPM + ' install ok; ' + PNPM + ' typecheck ok; ' + PNPM + ' test green (db tests); ' + PNPM + ' build ok; ' + PNPM + ' e2e green with the screenshot saved. Then commit with message "Phase 2 foundation: monorepo, Electron shell, contracts, db, renderer skeleton" and trailer "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>".',
  'Return: what you built (file map), the SQLite decision, the exact commands + output tails, and any gotchas the next agents must know (dev URL env var, how to run the app, IPC helper usage).',
].join('\n'), { label: 'A1 foundation', phase: 'Foundation', model: 'opus', effort: 'high' })

const spikeFixP = agent(COMMON + '\n' + [
  'TASK A2 — Spike gate fixes (you own ONLY ' + ROOT + '/packages/engine/scripts/spike-claude.ts, ' + ROOT + '/packages/engine/scripts/spike-engine.ts, ' + ROOT + '/docs/spikes/*.md and a new ' + ROOT + '/docs/spikes/claude.evidence.json). Do not touch package.json files or anything else.',
  'An adversarial verifier refuted parts of the Phase 1 spike. Fix exactly these:',
  "1. plugin_command gate: PASS must require evidence of expansion — e.g. a tool sequence that only the cockpit pilot skill would produce (its Step 0 runs 'git log --oneline -5' and 'git status --short' before anything else), AND the reply text; document the predicate in a comment.",
  '2. usage_reporting gate: PASS only if every model-calling step (a, b, d, e, f) reports input+output tokens > 0 and total_cost_usd > 0; step c (/context, local) is allowed to be zero and must be labelled local.',
  "3. Add capability routing_lever: in the PreToolUse hook for 'Task|Agent' return hookSpecificOutput {hookEventName:'PreToolUse', permissionDecision:'allow', updatedInput:{...input, model:'haiku'}} and assert from the stream (task_started / task_notification usage / modelUsage keys) that the sub-agent actually ran on a haiku model; if the SDK ignores updatedInput, report FAIL with the observed evidence and write the fallback (deny + re-spawn via our own Agent tool) into engine.md.",
  '4. Evidence durability: after a run, write ' + ROOT + '/docs/spikes/claude.evidence.json — a trimmed, redacted (no emails/orgs/tokens) copy containing, per step, the frames that justify each PASS (init summary, the canUseTool call/return, the hook input/output, the result usage). Commit-able (< 200 KB).',
  '5. Fix the .d.ts citations in claude-sdk-shapes.md and engine.md: for every cited line range, grep the member in sdk.d.ts and rewrite the range to the real lines; fix "SPEC R14" → R12 for routing; add [untested] tags where a claim is not backed by a log; mark the 1-hour cache-survival sentence as [assumed].',
  '6. Note R14 coverage in engine.md: /help absent, /cost alias of /usage, /effort present.',
  'Run: corepack pnpm --dir ' + ROOT + '/packages/engine exec tsx scripts/spike-claude.ts until your gates are green (Codex will still fail on auth; leave spike-codex.ts alone). Then commit ONLY your files with message "Spike: tighten gates, routing-lever test, durable evidence, citation fixes" and trailer "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>".',
  'Return: the CAP lines from your final run, whether routing_lever passed and its evidence, and the list of citations corrected.',
].join('\n'), { label: 'A2 spike fixes', phase: 'Foundation', model: 'sonnet' })

const [foundation, spikeFix] = await Promise.all([foundationP, spikeFixP])
log('foundation: ' + String(foundation).slice(0, 160) + ' · spikeFix: ' + String(spikeFix).slice(0, 120))
if (!foundation) throw new Error('foundation agent returned nothing')

phase('Build')
const FOUND = 'FOUNDATION REPORT (from the agent that built the skeleton — trust its commands and file map, verify by reading):\n' + foundation

const harnessP = agent(COMMON + '\n' + FOUND + '\n' + [
  'TASK B1 — Claude harness + session runner (you own packages/engine/src/**, apps/desktop/src/engine/** and the IPC handlers in apps/desktop that call the engine; do not edit apps/renderer or brand assets).',
  '1. packages/engine/src/harness.ts: the Harness interface (start(session, agent), send(turnInput, ctx) → async iterable of engine events, interrupt(), listCommands(), capabilities()). Engine events map 1:1 to shared Block upserts + turn status + permission/question requests + usage events.',
  "2. packages/engine/src/claude/ClaudeHarness.ts using @anthropic-ai/claude-agent-sdk query(): streaming (includePartialMessages) → text/thinking deltas as block upserts; tool_use/tool_result → tool_call blocks with status; AskUserQuestion via canUseTool → question request event, awaits the answer (Promise resolved by the runner) and returns updatedInput.answers; other permission asks → permission request event (permissionMode 'default' unless the agent config says otherwise); PreToolUse hook on 'Task|Agent' → subagent block + routing policy stub (fail-open, returns {} for now); system/init → listCommands() cache (slash_commands, skills, plugins, tools, mcp_servers, model); result → usage event (usage + modelUsage + cost) and turn status; resume via options.resume with the stored SDK session id; interrupt via query.interrupt(); options.model from the agent config; settingSources ['user','project']; env = cleaned env (strip CLAUDECODE, CLAUDE_PID, CLAUDE_EFFORT, CLAUDE_CODE_*; PYTHONUTF8=1); cwd = project path. Slash commands are sent as the prompt text unchanged.",
  '3. apps/desktop/src/engine/SessionRunner.ts: owns one harness per (session, agent); on chat.send: create user turn + agent turn rows, run the harness, persist every block upsert and usage event as it arrives (incremental, not at the end), forward events to the renderer via the shared IPC events; replaces the echo stub; supports interrupt; restores runner state on app relaunch lazily (a resumed session continues with options.resume).',
  '4. Tests (vitest): a fake SDK (inject the query function) driving text delta → tool_use → AskUserQuestion → result; assert emitted events, persisted rows, the answer round-trip, and that no per-turn system prompt is injected (efficiency).',
  '5. Live check script packages/engine/scripts/live-claude.ts: creates a temp session and sends "Reply with exactly the word pong." through the real harness, prints the blocks and usage.',
  'Done when (paste outputs): ' + PNPM + ' test green including your tests; ' + PNPM + ' typecheck ok; live script prints a text block "pong" and a usage event with cost > 0. Commit with message "Phase 2: Claude harness + session runner" and trailer "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>".',
  'Return: event/block mapping table, how the renderer must answer permission/question requests (channel + payload), the resume/interrupt semantics, and commands + output tails.',
].join('\n'), { label: 'B1 claude harness', phase: 'Build', model: 'opus', effort: 'high' })

const uiP = agent(COMMON + '\n' + FOUND + '\n' + [
  'TASK B2 — Landing + chat UI port (you own apps/renderer/src/** EXCEPT apps/renderer/src/brand/** and public/fonts; do not touch apps/desktop or packages/engine; use only the IPC contract in packages/shared — if it lacks something you need, add it to packages/shared with a zod schema and note it in your report).',
  "Port Omnigent's look for these screens, matching the reference component-for-component (read the reference files, reproduce structure, class names may differ, tokens must be the copied ones):",
  '1. New Session landing (' + REF + '/pages/ChatPage.tsx landing state + ' + REF + '/components/chat composer + ' + REF + '/lib/branding.ts): the mascot (use <Mascot state=…/> from apps/renderer/src/brand/Mascot.tsx — if it does not exist yet, create a minimal one that renders /mascot/<state>.png and the brand agent will improve it), heading "What should we build?", composer (auto-growing textarea, attach + mic buttons as in reference, agent picker showing "Claude Code" with a settings gear, send button), chips row: host (this machine name, green dot), working directory (opens projects.pick, shows the folder name), worktree (placeholder). Enter submits (Shift+Enter newline). Submitting creates a session (sessions.create with the picked directory; if none picked, prompt the picker first) and navigates to /c/:id.',
  '2. Chat page (' + REF + '/shell/AppShell.tsx, ' + REF + '/pages/ChatPage.tsx, ' + REF + '/components/blocks + ai-elements): sessions sidebar (list from sessions.list with search, New session button, project grouping, archive), chat header (title, running dot), transcript rendering every Block kind: user message, text (markdown via react-markdown + shiki or the reference stack), thinking (collapsed, expandable), tool_call card (name, input summary, expandable output, status icon), diff (simple unified view), permission card (Allow / Deny buttons → permission.answer), question card (AskUserQuestion: options as buttons, multiSelect support → question.answer), subagent block (collapsible), error, usage line (tokens in/out/cached + cost) at the end of a turn; turn rail; queued/streaming indicator; composer docked at the bottom with the same controls; slash menu wired to chat.listCommands (built-ins + backend commands, filtered as you type after "/").',
  '3. State: zustand store fed by the main→renderer events (chat.block upsert by blockId, turnStatus, session.updated); persisted sessions load via turns.list on open.',
  '4. Reactive mascot: apps/renderer/src/hooks/useMascotState.ts mapping the active session status → idle/thinking/working/waiting(question or permission pending)/success/error/sleeping (no activity 5 min)/listening (mic pressed).',
  '5. Tests: vitest + @testing-library/react for each block renderer and the composer submit behaviour (Enter vs Shift+Enter, empty guard).',
  'Done when (paste outputs): ' + PNPM + ' typecheck ok; ' + PNPM + ' test green; ' + PNPM + ' build ok; and screenshots you took with the app running (use the e2e harness or scripts to launch with the stub engine) saved to ' + ROOT + '/e2e-out/landing.png and chat.png, described in your report. Commit with message "Phase 2: landing + chat UI ported from the reference" and trailer "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>".',
  'Return: component map (reference file → ours), any contract additions, screenshots taken, commands + output tails.',
].join('\n'), { label: 'B2 landing+chat UI', phase: 'Build', model: 'sonnet' })

const brandP = agent(COMMON + '\n' + FOUND + '\n' + [
  'TASK B3 — Brand assets (you own apps/renderer/src/brand/**, apps/renderer/public/mascot/**, apps/renderer/public/fonts/**, apps/desktop/build/icons/** and assets/** and scripts/make-icons.py; nothing else).',
  '1. Copy the 8 mascot PNGs to apps/renderer/public/mascot/ and the font to public/fonts; write apps/renderer/src/brand/Mascot.tsx: props {state, size}, renders the state PNG with image-rendering: pixelated, cross-fades between states (150 ms), and a gentle 2-frame idle bob (CSS keyframes translateY 0/-2px at 1.2 s) plus per-state micro-animations: thinking (slow "?" pulse), working (subtle 4-step typing jitter), waiting (blink), success (one-shot bounce), error (shake once), sleeping (slower bob), listening (pulse). CSS-only, GPU-friendly, honour prefers-reduced-motion.',
  '2. apps/renderer/src/brand/Wordmark.tsx: "capygen" in CheGuevaraBarry-Brown (font-face in brand.css), used where the reference shows BrandLogo (' + REF + '/components/BrandLogo.tsx) — export a drop-in <BrandLogo/> replacement with the same props the reference uses.',
  '3. App icon: generate apps/desktop/build/icons/icon.ico (256/128/64/48/32/16) and icon.png from the idle mascot (python Pillow is available: scripts/make-icons.py), a 16/32 px tray icon (tray.png) and favicon.ico for the renderer. Wire the icon into the BrowserWindow + tray only via a tiny exported constant file if the foundation left a hook; otherwise note the paths for the integrator.',
  '4. Visual check: scripts/brand-preview.html rendering all 8 states with the wordmark; open it with Playwright chromium if available, else describe.',
  'Done when: ' + PNPM + ' typecheck ok; the icon files exist with the listed sizes (verify with Pillow); Mascot + Wordmark have vitest render tests. Commit with message "Phase 2: mascot component, wordmark, app icons" and trailer "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>".',
  'Return: paths, how to use <Mascot/> and <BrandLogo/>, commands + output tails.',
].join('\n'), { label: 'B3 brand', phase: 'Build', model: 'sonnet' })

const [harness, ui, brand] = await Promise.all([harnessP, uiP, brandP])
log('build done · harness ' + (harness ? 'ok' : 'MISSING') + ' · ui ' + (ui ? 'ok' : 'MISSING') + ' · brand ' + (brand ? 'ok' : 'MISSING'))

phase('Integrate')
const integ = await agent(COMMON + '\n' + FOUND + '\nHARNESS REPORT:\n' + harness + '\nUI REPORT:\n' + ui + '\nBRAND REPORT:\n' + brand + '\n' + [
  'TASK C — Integrate Phase 2 and prove it (you may edit anything; keep the structure others built).',
  '1. Wire the real SessionRunner behind the IPC handlers (remove the echo stub), the Mascot/BrandLogo into the landing/sidebar, the app icon + tray icon into the window/tray, and make permission/question cards round-trip end to end.',
  '2. e2e (tests/e2e/skeleton.spec.ts): launch the built app with an isolated --user-data-dir and a temp project directory pre-set through settings or CAPYGEN_E2E_PROJECT env; on the landing, assert the mascot img and the heading; type "Reply with exactly the word pong." and press Enter; wait (≤120 s) for a text block containing "pong" and a usage line with a cost; screenshot e2e-out/chat-pong.png; close the app; relaunch with the same user-data-dir; assert the session appears in the sidebar and opening it shows the same "pong" transcript; screenshot e2e-out/restored.png. A second test drives an AskUserQuestion: prompt "Use the AskUserQuestion tool to ask me red or blue; then reply with just my answer.", click the "Blue" option in the question card, expect the reply "Blue".',
  '3. Run the full gate: ' + PNPM + ' typecheck, test, build, e2e — fix until all green. Check the landing screenshot against the reference layout intent (mascot centred above heading, composer width, chips row) and fix obvious mismatches.',
  '4. Update ' + ROOT + '/PLAN.md: tick Phase 2 only if every Done-when item passed; append one line to ' + ROOT + '/PROJECT_LOG.md; add ' + ROOT + '/docs/RUN.md (how to dev/build/test/e2e). Commit "Phase 2: integrated walking skeleton — landing → Claude reply → persisted; e2e green" with trailer "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>".',
  'Return: the four command output tails, screenshot paths, anything not achieved (explicitly), and a list of the riskiest code paths for reviewers (file:line).',
].join('\n'), { label: 'C integrate', phase: 'Integrate', model: 'opus', effort: 'high' })
log('integrate: ' + String(integ).slice(0, 200))

phase('Review')
const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          file: { type: 'string' }, line: { type: 'integer' },
          summary: { type: 'string' }, failure_scenario: { type: 'string' }, fix_hint: { type: 'string' },
        },
        required: ['severity', 'file', 'summary', 'failure_scenario'],
      },
    },
  },
  required: ['findings'],
}
const DIMS = [
  { key: 'correctness', model: 'sonnet', prompt: 'Correctness of the engine + runner + IPC: streaming block upserts, persistence ordering, resume/interrupt, question/permission round-trips, race conditions between events and DB writes, Windows path/env handling. Read apps/desktop/src/** and packages/engine/src/** and packages/db/src/** fully.' },
  { key: 'security', model: 'sonnet', prompt: 'Security of the Electron shell: contextIsolation/sandbox/nodeIntegration settings, preload surface (only typed channels?), navigation/window.open guards, IPC sender validation, secrets/logging redaction, env passed to child processes, file dialogs. Read apps/desktop/src/** and packages/shared/src/**.' },
  { key: 'ux-parity', model: 'opus', prompt: 'UI parity and quality versus the reference ' + REF + ': compare apps/renderer/src/** with the reference landing/chat/sidebar/blocks; look at ' + ROOT + '/e2e-out/*.png; list concrete deviations (layout, spacing, missing controls, block rendering), keyboard behaviour, empty/loading/error states, mascot state mapping.' },
  { key: 'efficiency', model: 'sonnet', prompt: 'Token/context efficiency (SPEC R23–R26): does the harness add any per-turn system text or extra tool schemas; are blocks persisted incrementally; is anything from the UI/IPC leaking into the model context; usage accounting correctness (input/output/cached/cost); lazy loading of commands/MCP. Read packages/engine/src/** and apps/desktop/src/engine/**.' },
]
const reviews = await parallel(DIMS.map((d) => () =>
  agent(COMMON + '\nINTEGRATOR REPORT:\n' + integ + '\nYou are an adversarial reviewer for the dimension "' + d.key + '". ' + d.prompt + '\nReport only findings you verified against the actual code path (cite file:line and the concrete inputs → wrong outcome). No style nits. Do not edit files.',
    { label: 'review:' + d.key, phase: 'Review', model: d.model, schema: FINDINGS })
))
const all = reviews.filter(Boolean).flatMap((r, i) => r.findings.map((f) => ({ ...f, dim: DIMS[i].key })))
const serious = all.filter((f) => f.severity !== 'low')
log('review: ' + all.length + ' findings, ' + serious.length + ' high/medium')

let fixReport = null
if (serious.length) {
  fixReport = await agent(COMMON + '\n' + [
    'TASK D — Fix verified review findings from the Phase 2 review wave, then re-run the full gate.',
    'Findings (JSON): ' + JSON.stringify(serious, null, 2),
    'Low-severity findings (for context, fix only if trivial): ' + JSON.stringify(all.filter((f) => f.severity === 'low'), null, 2),
    'For each finding: reproduce or confirm it in code, fix it minimally, add/adjust a test where the finding was behavioural. Then run ' + PNPM + ' typecheck, test, build, e2e until green. Commit "Phase 2: review fixes" with trailer "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>". Return: per finding → fixed / not-a-bug (with reason) / deferred (with reason), and the command output tails.',
  ].join('\n'), { label: 'D fixes', phase: 'Review', model: 'opus', effort: 'high' })
}

return { foundation: String(foundation).slice(0, 3000), spikeFix: String(spikeFix).slice(0, 2000), harness: String(harness).slice(0, 2500), ui: String(ui).slice(0, 2500), brand: String(brand).slice(0, 1500), integ: String(integ).slice(0, 4000), findings: all, fixReport: fixReport ? String(fixReport).slice(0, 4000) : null }
