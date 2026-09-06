export const meta = {
  name: 'capygen-phase5-workspace',
  description: 'Phase 5: dockable workspace panes (files, editor, diff, browser, terminal, agents, tasks, servers) with per-project layout persistence, and one-click dev servers with auto-detection; integrate, e2e, review, fix',
  phases: [
    { title: 'Contracts', detail: 'fs/git/terminal/servers/layout/tasks IPC + migration (Sonnet)' },
    { title: 'Build', detail: 'desktop services (Opus) · dockview shell + files/editor/diff (Sonnet) · browser/terminal/tasks/servers panes (Sonnet)' },
    { title: 'Integrate', detail: 'wire, e2e drag/restore + dev server + fixtures (Opus)' },
    { title: 'Review', detail: 'four-lens review on the other model, then fixes' },
  ],
}

const ROOT = 'C:/Users/TugaPlayz/Desktop/GITHUB/capygen'
const REF = ROOT + '/reference/omnigent/web/src'
const PNPM = 'corepack pnpm --dir ' + ROOT
const COMMON = [
  'Repo: ' + ROOT + '. Read ' + ROOT + '/CLAUDE.md, ' + ROOT + '/SPEC.md (R16–R18, R23, R27, G5, G6), ' + ROOT + '/PLAN.md (Phase 5), ' + ROOT + '/CONTEXT.md, ' + ROOT + '/docs/RUN.md, ' + ROOT + '/COMPAT.md, ' + ROOT + '/docs/adr/0003-sqlite-driver.md first.',
  "Absolute paths everywhere. Package manager: 'corepack pnpm' (never bare pnpm). Windows 10, Node 22.16, Electron 44. Native modules: the repo has none so far (node:sqlite); if a task needs one (node-pty for the terminal), verify whether the package's prebuilt binaries load under Electron 44 as-is (N-API / prebuilds shipped in the npm package), else add @electron/rebuild (4.2.0 on npm) for that module only, and record the decision + how packaging must handle it in an ADR. Never push. Commit only when your task says so and only your own files (git add by path, never -A). Other agents work in this same worktree in parallel: the repo-wide suite may be red because of their in-flight files — report precisely and keep what you own green.",
  'Existing code (read before writing): packages/shared/src/{domain.ts,ipc.ts,defineIpc.ts}, apps/desktop/src/{main.ts,preload.ts,ipc/handlers.ts,ipc/widgets.ts,win/*}, apps/desktop/src/engine/**, apps/renderer/src/{App.tsx,shell/AppShell.tsx,pages/ChatPage.tsx,components/AgentsPane.tsx,store/appStore.ts,lib/ipc.ts,index.css}, packages/db/src/repos.ts + migrations.',
  'Design reference (read-only, never import): ' + REF + ' — workspace rail in ' + REF + '/pages/ChatPage.tsx + ' + REF + '/shell/AppShell.tsx; files: ' + REF + '/shell/{FilesPanel,FilesPanelDrawer,FolderTree,FlatFileList,FileViewer,FileViewerContext,CodeViewer,CopyPathButton,FileDownloadButton}.tsx; browser: ' + REF + '/components/BrowserPane/BrowserPane.tsx (Omnigent uses a native Electron WebContentsView positioned over the page via getBoundingClientRect → IPC, NOT <webview>, which is deprecated — do the same); logs: ' + REF + '/shell/ExecutionLogsPanel.tsx; git: ' + REF + '/shell/GithubPanel.tsx; tasks: ' + REF + '/pages/TasksPage.tsx + ' + REF + '/shell/ChatPlanAccordion.tsx; terminal: Omnigent uses @xterm/xterm 6 + addon-fit + addon-web-links + addon-webgl (verified in its package.json).',
  'Verified registry versions (npm view, 2026-09-06): dockview 8.2.0, node-pty 1.1.0, chokidar 5.0.0, simple-git 3.36.0, @codemirror/view 6.43.11, @electron/rebuild 4.2.0, @xterm/xterm 6.0.0.',
  'Dev-server config format (SPEC R18): .claude/launch.json → {"version":"0.0.1","configurations":[{"name","runtimeExecutable","runtimeArgs":[…],"port",("url" optional)}]} plus auto-detection from package.json scripts (dev/start/serve/preview), pyproject/manage.py (uvicorn/flask/django runserver), docker-compose.yml services with ports; starting streams logs, probes the port until the URL answers, then opens it in the Browser pane; no agent tokens are spent.',
  'Efficiency rules (SPEC R23–R26) still apply: pane IPC must never enter any model context; file watchers bounded (ignore node_modules/.git/dist, depth/size caps); log ring buffers capped.',
  'Every claim in your final report must be something you ran or read; paste each Done-when command + output tail.',
].join('\n')

phase('Contracts')
const contracts = await agent(COMMON + '\n' + [
  'TASK P0 — Contracts for Phase 5 (you own ONLY packages/shared/src/**, packages/db/migrations/0004_*.sql, packages/db/src/** and their tests; plus minimal compat edits elsewhere to keep the repo green, listed in your report).',
  '1. Domain: PaneKind enum (files, editor, diff, browser, terminal, agents, tasks, servers); WorkspaceLayout {projectId, layoutJson (dockview serialized), updatedAt}; DevServer {id, projectId, name, source: "launch.json"|"package.json"|"python"|"docker-compose"|"custom", command, args, cwd, port?, url?, env?}; DevServerRun {serverId, status: "starting"|"running"|"stopped"|"failed", pid?, url?, startedAt?, exitCode?}; Task {id, sessionId?, agentId?, title, status: "pending"|"in_progress"|"completed"|"cancelled", source: "todo_write"|"codex_plan"|"manual", order, updatedAt}; TerminalInfo {id, projectId, sessionId?, title, cwd, shell, cols, rows}; FileEntry {path, name, kind: "file"|"dir", size?, mtime?}; GitStatus {branch, ahead, behind, entries: [{path, status}]}; GitDiff {path, unified: string, binary?: boolean}.',
  '2. IPC invoke: layout.get {projectId} / layout.set {projectId, layoutJson}; fs.list {projectId, dir, depth?} / fs.read {projectId, path, maxBytes?} / fs.write {projectId, path, content} / fs.search {projectId, query, limit?} / fs.watch {projectId} / fs.unwatch {projectId}; git.status {projectId} / git.diff {projectId, path?, staged?} / git.commit {projectId, message, paths?} (paths optional = all); terminal.create {projectId, sessionId?, cwd?, cols, rows} / terminal.write {id, data} / terminal.resize {id, cols, rows} / terminal.kill {id} / terminal.list {projectId}; servers.detect {projectId} / servers.list {projectId} / servers.start {serverId} / servers.stop {serverId} / servers.logs {serverId, tail?} / servers.saveCustom {projectId, server} / servers.remove {serverId}; tasks.list {sessionId?|projectId?} / tasks.update {id, patch}; browser.attach {viewId, bounds, url?} / browser.detach {viewId} / browser.navigate {viewId, url|"back"|"forward"|"reload"} / browser.setBounds {viewId, bounds} / browser.devtools {viewId}; events: fs.changed {projectId, changes[]}, terminal.data {id, data}, terminal.exit {id, exitCode}, servers.status {run}, servers.log {serverId, line}, tasks.updated {sessionId, tasks}, browser.state {viewId, url, title, canGoBack, canGoForward, loading}.',
  '3. Migration 0004: workspace_layouts, dev_servers, tasks (and a terminals table only if persistence is needed — otherwise state in memory, document); repos + tests.',
  'Done when: ' + PNPM + ' typecheck ok and ' + PNPM + ' test green repo-wide. Commit "Phase 5: contracts for workspace panes, dev servers, tasks" with trailer "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>".',
  'Return: exact type/field names, IPC payloads, migration summary.',
].join('\n'), { label: 'P0 contracts', phase: 'Contracts', model: 'sonnet' })
if (!contracts) throw new Error('contracts agent returned nothing')
const CONTRACTS = 'CONTRACT REPORT (code against these; verify by reading packages/shared/src):\n' + contracts

phase('Build')
const servicesP = agent(COMMON + '\n' + CONTRACTS + '\n' + [
  'TASK B1 — Desktop workspace services (you own apps/desktop/src/workspace/** (new), apps/desktop/src/ipc/workspace*.ts (new handler files), the registration lines in apps/desktop/src/ipc/handlers.ts and apps/desktop/src/main.ts, apps/desktop/test/workspace*, and any ADR you add; nothing in apps/renderer).',
  '1. FsService: bounded directory listing (ignore node_modules, .git, dist, build, out, .venv, __pycache__; cap entries per dir), read with size cap + binary detection, write (atomic), search (ripgrep --files if on PATH else walker; name match), chokidar 5 watcher per project (ignored globs, awaitWriteFinish, debounced fs.changed batches).',
  '2. GitService via simple-git (or spawn git): status, diff (unstaged/staged, per path), commit; safe on non-repos (returns null status).',
  '3. TerminalService via node-pty: verify first whether node-pty 1.1.0 loads under Electron 44 without a rebuild (run a tiny Electron probe like ADR-0003 did); if not, add @electron/rebuild scoped to node-pty (postinstall script) and record docs/adr/0005-terminal-node-pty.md including what Phase 12 packaging must do (asarUnpack). Spawn PowerShell (pwsh if present else powershell.exe) in the project cwd with the cleaned env (packages/engine/src/env.ts), ConPTY, resize, kill tree on dispose, output throttled to the renderer.',
  '4. DevServerService: detectors for .claude/launch.json, package.json scripts (dev/start/serve/preview; infer port from common flags/scripts, else probe common ports after start by watching stdout for http://… URLs), pyproject/manage.py (uvicorn/flask/django), docker-compose.yml (services with published ports; command docker compose up <service>); start = spawn with windowsHide + cleaned env, ring-buffered logs (cap 2000 lines) streamed as servers.log, URL discovery (stdout regex first, then port probe every 500 ms up to 60 s), status events; stop = tree kill (taskkill /T /F on Windows); port-in-use detection reports the owning PID (netstat -ano parse) and offers the existing URL; persisted custom servers + last-known config in dev_servers.',
  '5. TasksService: derive tasks from blocks — Claude TodoWrite tool_call inputs (todos[] with status), Codex plan items (turn/plan or planning items from the app-server schema — search docs/spikes/codex-app-server-schema/v0.153.4-ts), and delegate/subagent completion; keep the tasks table in sync per session; tasks.update for manual edits; tasks.updated events.',
  '6. BrowserViewService: WebContentsView per viewId attached to the main window (Omnigent pattern), bounds from the renderer, navigation events → browser.state, devtools toggle, popup/navigation guards (only http/https; open external for others), per-view partition so sites do not share the app session.',
  '7. Tests: fs (temp dir, ignores, caps), git (temp repo), servers detectors (fixture projects under tests/fixtures/servers/{node,python,compose,launchjson}), start/stop with a tiny node http server fixture (URL discovery + port probe), tasks derivation from recorded TodoWrite blocks, terminal (spawn `echo` and read back — skip with reason if no ConPTY in CI).',
  'Done when (paste outputs): ' + PNPM + ' typecheck ok; desktop vitest project green (' + PNPM + ' exec vitest run --project desktop); ' + PNPM + ' test repo-wide reported honestly. Commit "Phase 5: workspace services — fs, git, terminal, dev servers, tasks, browser views" with trailer "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>".',
  'Return: service API summary, the node-pty decision, detector rules, and the exact event payloads the renderer consumes.',
].join('\n'), { label: 'B1 workspace services', phase: 'Build', model: 'opus', effort: 'high' })

const shellPanesP = agent(COMMON + '\n' + CONTRACTS + '\n' + [
  'TASK B2 — Dockview workspace shell + Files/Editor/Diff/Agents panes (you own apps/renderer/src/workspace/** (new: layout, registry, pane chrome) and apps/renderer/src/panes/{files,editor,diff,agents}/**, plus the minimal ChatPage/AppShell edits to mount the workspace; do not touch apps/desktop or packages/engine; other renderer panes belong to another agent).',
  '1. Dockview 8 integration: a WorkspaceHost component in the chat page (right of the transcript, resizable divider like the reference workspace rail) hosting dockview with pane components registered by PaneKind; toolbar with pane toggles (icons matching the reference rail: files, editor, browser, terminal, agents, tasks, servers), "+" menu to add a pane, maximise/restore, float/dock; drag-and-drop between groups (dockview built-in); layout serialised with dockview toJSON → layout.set (debounced) and restored with fromJSON on project open; default layout when none saved (reference: agents/files tabs on the right); reduced-motion safe.',
  '2. Files pane: tree (lazy fs.list per dir, virtualised for big dirs), search box (fs.search), file icons by extension, context menu (open, copy path, reveal in Explorer via shell.showItemInFolder IPC if present), watches fs.changed to refresh; double-click opens in the Editor pane; matches FilesPanel/FolderTree/FlatFileList look.',
  '3. Editor pane: CodeMirror 6 (basic-setup, languages for ts/js/json/md/py/css/html/yaml/toml/sh via @codemirror/lang-* and legacy modes where needed, oneDark-like theme mapped to Omnigent tokens), tabs per open file, save (Ctrl+S → fs.write), dirty indicator, read-only mode for files over the size cap, line/column status; matches FileViewer/CodeViewer look.',
  '4. Diff pane: git.status list (staged/unstaged, badges), click → unified diff with syntax colouring (render with CodeMirror merge view or a unified renderer), stage-less commit box (message → git.commit), refresh on fs.changed; matches GithubPanel look.',
  '5. Agents pane: move the existing AgentsPane into a dockview pane (keep its tests green).',
  '6. Tests: RTL for the workspace host (registers panes, toggles, persists layout via mocked IPC), files tree (lazy expand, search), editor (open/save/dirty), diff (status list, commit).',
  'Done when (paste outputs): ' + PNPM + ' typecheck ok; renderer vitest project green (' + PNPM + ' exec vitest run --project renderer); ' + PNPM + ' build ok; screenshots via a dev fixture route /dev/workspace saved to e2e-out/workspace-files.png and e2e-out/workspace-editor.png. Commit "Phase 5: dockview workspace + files/editor/diff/agents panes" with trailer "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>".',
  'Return: component map, how a pane registers, layout persistence details, screenshots.',
].join('\n'), { label: 'B2 dockview+files/editor/diff', phase: 'Build', model: 'sonnet' })

const toolPanesP = agent(COMMON + '\n' + CONTRACTS + '\n' + [
  'TASK B3 — Browser/Terminal/Tasks/Servers panes (you own apps/renderer/src/panes/{browser,terminal,tasks,servers}/** only; register them through the pane registry the other renderer agent is writing at apps/renderer/src/workspace/registry.ts — if it does not exist yet when you start, export your panes as { kind, title, icon, component } from apps/renderer/src/panes/index.ts and the integrator will register them; do not edit files outside your folders).',
  '1. Browser pane: URL bar (Enter navigates, shows title/loading, back/forward/reload, devtools, open-external), a placeholder box whose bounds are reported to browser.attach/setBounds via ResizeObserver + scroll/layout changes (the native WebContentsView from the desktop overlays it — Omnigent pattern), detach on unmount/hide (dockview tab hidden → detach; visible → attach), tabs for multiple views optional; link from the Servers pane opens the URL here.',
  '2. Terminal pane: @xterm/xterm 6 + addon-fit + addon-web-links + addon-webgl (fallback canvas), theme mapped to Omnigent tokens, terminal.create on mount (cwd = project), data/exit events, resize on fit, copy/paste (Ctrl+Shift+C/V), "New terminal" tabs, kill on close; a "Open claude / codex here" quick action typing the CLI command (terminal attach parity for SPEC P19 lands later).',
  '3. Tasks pane: list grouped by status (pending/in progress/completed) fed by tasks.list + tasks.updated; agent/session badges; manual add/edit/complete via tasks.update; matches TasksPage/ChatPlanAccordion look.',
  '4. Servers pane: servers.detect on open (with a Refresh), rows with source badge, Start/Stop buttons, status dot, log tail drawer (servers.log ring), "Open in Browser pane" when a URL is known, add custom server form (command/args/cwd/port), port-conflict message with the PID and "Open existing URL"; matches ExecutionLogsPanel look for logs.',
  '5. Tests: RTL for each pane with mocked IPC (browser bounds reporting, terminal create/resize/kill wiring with a mocked xterm, tasks grouping/update, servers start/stop/log/open-in-browser).',
  'Done when (paste outputs): ' + PNPM + ' typecheck ok; renderer vitest project green for your tests; ' + PNPM + ' build ok. Commit "Phase 5: browser, terminal, tasks, servers panes" with trailer "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>".',
  'Return: component map, IPC used per pane, registration exports.',
].join('\n'), { label: 'B3 browser/terminal/tasks/servers', phase: 'Build', model: 'sonnet' })

const [services, shellPanes, toolPanes] = await Promise.all([servicesP, shellPanesP, toolPanesP])
log('build: services ' + (services ? 'ok' : 'MISSING') + ' · shellPanes ' + (shellPanes ? 'ok' : 'MISSING') + ' · toolPanes ' + (toolPanes ? 'ok' : 'MISSING'))

phase('Integrate')
const integ = await agent(COMMON + '\n' + CONTRACTS + '\nSERVICES REPORT:\n' + services + '\nSHELL/PANES REPORT:\n' + shellPanes + '\nTOOL PANES REPORT:\n' + toolPanes + '\n' + [
  'TASK C — Integrate Phase 5 and prove it (you may edit anything; keep the structure others built).',
  '1. Wire all panes into the registry and the desktop services into the IPC; make the Browser pane overlay track its placeholder precisely (scroll, resize, dockview drag, tab switch, maximise); make the terminal usable (type `echo hi` → output); Servers → Start → URL discovered → Browser pane opens it.',
  '2. e2e (tests/e2e/workspace.spec.ts, offline where possible): (a) open a session in a fixture project, open Files + Editor, open a file, edit, save → file changed on disk; (b) drag the Terminal tab under the Browser group (dockview DnD via mouse), restart the app with the same profile, assert the layout is restored (same group tree order) — screenshot e2e-out/workspace-layout.png; (c) fixture project tests/fixtures/servers/node (package.json with a dev script that starts a tiny http server printing its URL) → Servers pane detects it → Start → status running + log lines + Browser pane URL bar shows the server URL and the native view loaded it (assert via browser.state event/title) — screenshot e2e-out/workspace-server.png; (d) Diff pane shows a modified file after the edit; (e) Tasks pane shows tasks from a recorded TodoWrite block (stub engine) — screenshot e2e-out/workspace-tasks.png; (f) Terminal: type `echo capy` + Enter, expect "capy" in the xterm buffer.',
  '3. Full gate: ' + PNPM + ' typecheck, test, build, exec playwright test — fix until green (API-key skip is fine). Update PLAN.md (tick Phase 5 only if its Done-when holds; record deviations), PROJECT_LOG.md, COMPAT.md (node-pty/dockview/chokidar versions, packaging notes), docs/RUN.md. Commit "Phase 5: workspace panes + dev servers integrated; e2e green" with trailer "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>".',
  'Return: command output tails, e2e list with timings, explicit not-achieved list, riskiest paths (file:line).',
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
  { key: 'correctness', model: 'sonnet', prompt: 'Correctness of the workspace services and panes: watcher lifecycle and leaks, terminal spawn/resize/kill, dev-server start/stop/URL discovery/port conflicts, layout persistence edge cases (unknown pane kinds, corrupt JSON), browser view bounds tracking, tasks derivation. Read apps/desktop/src/workspace/** and apps/renderer/src/{workspace,panes}/** fully.' },
  { key: 'security', model: 'sonnet', prompt: 'Security: fs IPC path boundaries (project root, symlinks, UNC), terminal command/env exposure, dev-server spawn (shell injection from package.json/launch.json), WebContentsView navigation/popup/permission guards and partition isolation, devtools exposure, IPC sender validation for the new channels.' },
  { key: 'ux-parity', model: 'opus', prompt: 'UI parity vs the reference ' + REF + ' workspace rail and panels (FilesPanel/FolderTree/FileViewer/BrowserPane/ExecutionLogsPanel/GithubPanel/TasksPage) and vs Claude Code desktop panes (movable/stackable/reorderable, browser + servers UX): look at ' + ROOT + '/e2e-out/workspace-*.png, read apps/renderer/src/{workspace,panes}/**; list concrete deviations, broken states, missing affordances (SPEC R16–R18, G5, G6).' },
  { key: 'efficiency', model: 'sonnet', prompt: 'Performance/efficiency: watcher scope and debouncing, terminal output throttling, log ring buffers, big-directory listing, editor for large files, IPC chatter volume (nothing must reach model context), layout save debouncing, memory of detached browser views. Read apps/desktop/src/workspace/** and apps/renderer/src/{workspace,panes}/**.' },
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
    'TASK D — Fix verified review findings from the Phase 5 review wave, then re-run the full gate.',
    'Findings (JSON): ' + JSON.stringify(serious, null, 2),
    'Low-severity findings (fix only if trivial): ' + JSON.stringify(all.filter((f) => f.severity === 'low'), null, 2),
    'For each finding: reproduce or confirm it in code, fix it minimally, add/adjust a test where behavioural. Then run ' + PNPM + ' typecheck, test, build, exec playwright test until green. Commit "Phase 5: review fixes" with trailer "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>". Return: per finding → fixed / not-a-bug (reason) / deferred (reason), and the command output tails.',
  ].join('\n'), { label: 'D fixes', phase: 'Review', model: 'opus', effort: 'high' })
}

return { contracts: String(contracts).slice(0, 1500), services: String(services).slice(0, 3000), shellPanes: String(shellPanes).slice(0, 2000), toolPanes: String(toolPanes).slice(0, 1500), integ: String(integ).slice(0, 4000), findings: all, fixReport: fixReport ? String(fixReport).slice(0, 4000) : null }
