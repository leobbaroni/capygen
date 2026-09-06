export const meta = {
  name: 'capygen-phase6-settings',
  description: 'Phase 6: settings hub (Omnigent sections + harnesses/MCP/skills/plugins/tools/providers/dev servers/diagnostics), two-way sync with Claude/Codex config files, global vs per-backend settings, prerequisites/bootstrap panel; integrate, e2e, review, fix',
  phases: [
    { title: 'Contracts', detail: 'settings/integrations/prereqs contracts + migration (Sonnet)' },
    { title: 'Build', detail: 'config sync engine (Opus) · settings hub UI (Sonnet) · prerequisites panel (Sonnet)' },
    { title: 'Integrate', detail: 'wire, e2e two-way sync + secrets + prereq gate (Opus)' },
    { title: 'Review', detail: 'four-lens review on the other model, then fixes' },
  ],
}

const ROOT = 'C:/Users/TugaPlayz/Desktop/GITHUB/capygen'
const REF = ROOT + '/reference/omnigent/web/src'
const WINREF = 'C:/Users/TugaPlayz/Desktop/GITHUB/Omnigent-windows/app'
const PNPM = 'corepack pnpm --dir ' + ROOT
const COMMON = [
  'Repo: ' + ROOT + '. Read ' + ROOT + '/CLAUDE.md, ' + ROOT + '/SPEC.md (R3, R19–R21, R28–R30, R27), ' + ROOT + '/PLAN.md (Phase 6, A9, A14), ' + ROOT + '/CONTEXT.md, ' + ROOT + '/docs/RUN.md, ' + ROOT + '/COMPAT.md first.',
  "Absolute paths everywhere. Package manager: 'corepack pnpm' (never bare pnpm). Windows 10, Node 22.16, Electron 44. Never push. Commit only when your task says so and only your own files (git add by path, never -A). Other agents work in this same worktree in parallel: report red tests that are not yours precisely; keep what you own green. NOTE: eight files may be uncommitted from a separate user session adding a tasks.create IPC channel (apps/desktop/src/ipc/workspace.ts, apps/desktop/src/workspace/TasksService.ts, apps/desktop/test/workspaceTasks.test.ts, packages/shared/src/ipc.ts + ipc.test.ts, apps/renderer/src/panes/tasks/TasksPane*.tsx) — never revert them; make only additive edits there if you must.",
  'HARD SAFETY RULE: never modify the real user configuration on this machine (~/.claude/**, ~/.codex/**, %APPDATA%/capygen used by the real app). Every test and every live check that writes config must run against isolated homes: Claude honours CLAUDE_CONFIG_DIR, Codex honours CODEX_HOME; the app must accept an env/flag to point both at a temp dir for e2e. Reads of the real config are fine.',
  'Existing code (read before writing): packages/shared/src/{domain.ts,ipc.ts}, apps/desktop/src/{main.ts,preload.ts,ipc/handlers.ts,ipc/secrets.ts,ipc/harnessList.ts}, apps/desktop/src/win/*, packages/engine/src/{claude/ClaudeHarness.ts,codex/CodexHarness.ts,mcp/client/**,api/**,describe/**}, apps/renderer/src/pages/SettingsPage.tsx + pages/settings/**, apps/renderer/src/store/appStore.ts, packages/db repos + migrations. Phase 1 facts: Claude system/init exposes slash_commands/skills/plugins/mcp_servers (docs/spikes/claude-sdk-shapes.md); Codex app-server exposes config/read, mcpServerStatus/list, skills/list, plugin/list, model/list (docs/spikes/codex-shapes.md + bindings under docs/spikes/codex-app-server-schema/v0.153.4-ts).',
  'Design reference (read-only, never import): ' + REF + '/pages/SettingsPage.tsx + ' + REF + '/shell/settingsNav.tsx (section ids: general, appearance, git, shortcuts, import, integrations, account, cli, updates, members, policies, sharing, archived), ' + REF + '/components/{HarnessConfigControls,ModelValueCombobox,KeyboardShortcutsDialog}.tsx, ' + REF + '/shell/{HarnessSetupDialog,HarnessCredentialForm}.tsx, ' + REF + '/components/onboarding/**, ' + REF + '/pages/SetupPage.tsx. Bootstrap/prerequisites pattern proven in the sibling project: ' + WINREF + '/src/win/bootstrap.js (detection, steps with exact commands, confirm dialog in main, visible PowerShell console, never silent) + ' + WINREF + '/setup/win-bootstrap.js (panel UI).',
  'Claude Code config surfaces (verify by reading the real files on this machine, read-only): ~/.claude/settings.json (permissions allow/deny, hooks, mcpServers? env, model), ~/.claude/settings.local.json, project .claude/settings.json + .claude/settings.local.json, project .mcp.json, ~/.claude.json (user-scope mcpServers + per-project state — read only what you need), ~/.claude/plugins/installed_plugins.json + marketplaces + cache, ~/.claude/skills/**, .claude/skills/**, plugin skills/commands; CLI: `claude mcp list|add|remove|get`, `claude plugin list|install|uninstall|enable|disable|marketplace list|add`. Codex: ~/.codex/config.toml ([mcp_servers.*], model, approval_policy, sandbox_mode, [projects], skills), ~/.codex/skills/**; app-server config/read for the merged view. Use a TOML library that round-trips comments (e.g. @iarna/toml, smol-toml — verify on npm) or patch text ranges; never clobber unknown keys.',
  'Efficiency rules apply: file watchers bounded and debounced; live lists cached with TTL; no settings IPC reaches any model context.',
  'Every claim in your final report must be something you ran or read; paste each Done-when command + output tail.',
].join('\n')

phase('Contracts')
const contracts = await agent(COMMON + '\n' + [
  'TASK P0 — Contracts for Phase 6 (you own ONLY packages/shared/src/**, packages/db/migrations/0005_*.sql, packages/db/src/** and their tests; plus minimal compat edits elsewhere to keep the repo green, listed in your report).',
  '1. GlobalSettings schema (one object, versioned): general {defaultBackend, defaultModel, submitWithCtrlEnter, alwaysSteer, autoTitleSessions}, appearance {theme: "system"|"light"|"dark", palette, fontScale, reducedMotion}, git {autoCommitMessages?, worktreeDefault}, shortcuts {overrides: Record<string,string>}, notifications {enabled, onFinish, onNeedsInput, onRunnerDisconnect}, updates {mode: "automatic"|"at-launch"|"manual"|"never", installOnQuit}, efficiency {compactionThresholdPct (70), toolOutputCapKb (64), lazyMcpSchemas}, closeToTray, startWithWindows, telemetry:false; plus per-backend defaults {claude: {permissionMode, effort}, codex: {approvalPolicy, sandbox, reasoningEffort}, api: {provider, model}}; per-agent overrides already exist in Agent.config — document the layering: global → backend default → agent override.',
  '2. Integrations domain: McpServerEntry {backend: "claude"|"codex"|"api", name, transport: "stdio"|"http"|"sse"|"claudeai-proxy", command?, args?, url?, env?, scope: "user"|"project"|"local"|"plugin", source: file path or "live", enabled, status?: "connected"|"failed"|"needs-auth"|"unknown", tools?: string[]}; PluginEntry {backend, name, version?, marketplace?, enabled, installed, path?, commands: string[], skills: string[], source}; SkillEntry {backend, name, scope, path, pluginName?, enabled, description?}; ToolPolicyEntry {backend, pattern, decision: "allow"|"deny"|"ask", scope}; PrereqStep {id, title, detected: boolean, version?, command, description, blockedBy?, kind: "cli"|"runtime"|"tool"}.',
  '3. IPC: settings.getAll / settings.patch {patch} (deep-merge, validated) / settings.reset {section}; integrations.list {backend} → {mcpServers, plugins, skills, tools, lastSync}; integrations.mcp.add {backend, scope, entry} / .update / .remove / .test {backend, name} (connect + list tools, timeout); integrations.plugin.install {backend, marketplace, name} / .uninstall / .setEnabled / .marketplaces {backend}; integrations.skill.setEnabled {backend, name, enabled} / .create {backend, scope, name, markdown} / .open {path} (reveal in editor pane or shell); integrations.tools.setPolicy {backend, scope, pattern, decision} / .removePolicy; integrations.refresh {backend}; prereqs.status → PrereqStep[] + recommendation; prereqs.run {stepId} → {ok, started} (main shows the confirm dialog and opens a visible console); diagnostics.get → {versions, paths, harness availability, db size, log dir}; diagnostics.copy; events: settings.changed {settings}, integrations.changed {backend, kinds: string[]}, prereqs.changed.',
  '4. Migration 0005 only if settings need a table beyond the existing settings key/value store (probably not — document).',
  'Done when: ' + PNPM + ' typecheck ok and ' + PNPM + ' test green repo-wide (report other agents\' in-flight failures precisely). Commit "Phase 6: contracts for settings hub, integrations, prerequisites" with trailer "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>".',
  'Return: exact type/field names and IPC payloads.',
].join('\n'), { label: 'P0 contracts', phase: 'Contracts', model: 'sonnet' })
if (!contracts) throw new Error('contracts agent returned nothing')
const CONTRACTS = 'CONTRACT REPORT (code against these; verify by reading packages/shared/src):\n' + contracts

phase('Build')
const syncP = agent(COMMON + '\n' + CONTRACTS + '\n' + [
  'TASK B1 — Config sync engine (you own packages/engine/src/config/** (new), packages/engine/test/config*, apps/desktop/src/integrations/** (new), apps/desktop/src/ipc/integrations.ts + settings.ts + diagnostics.ts (new handler files), their registration lines in apps/desktop/src/ipc/handlers.ts and apps/desktop/src/main.ts, apps/desktop/test/integrations*, settings*; nothing in apps/renderer).',
  '1. ClaudeConfigStore: read/merge all Claude surfaces (user settings.json, settings.local.json, project settings + local, .mcp.json, ~/.claude.json user-scope mcpServers, installed_plugins.json + marketplaces, skills dirs incl. plugin skills, commands) into the integrations view with source attribution; writes: mcp add/update/remove per scope (write the right file; for user scope prefer `claude mcp add/remove` CLI when the store is ~/.claude.json, else file edit), tool policies (permissions.allow/deny/ask arrays), skill enable/disable (settings key if Claude supports it — verify in the real settings schema/docs on disk; else move between an enabled dir and a disabled dir under capygen control and document), plugin install/uninstall/enable/disable/marketplace via `claude plugin …` headless (spawn with cleaned env, windowsHide, CLAUDE_CONFIG_DIR honoured) — parse output; every write followed by a re-read.',
  '2. CodexConfigStore: config.toml round-trip preserving comments/unknown keys (pick a library verified on npm or implement a minimal patcher for the sections you touch), mcp_servers add/update/remove, model/approval/sandbox defaults, skills dir; CODEX_HOME honoured; merged with app-server live lists (mcpServerStatus/list, skills/list, plugin/list, config/read) via a short-lived app-server child with TTL cache.',
  '3. Api backend: its MCP servers live in capygen settings (api.mcpServers) but the view also shows the Claude/Codex servers it inherits (read-only) as documented in Phase 3.',
  '4. Watchers: chokidar on the Claude/Codex config paths (bounded, debounced) → integrations.changed; live list refresh on demand (integrations.refresh) and after each write; a SyncCoordinator that dedupes concurrent refreshes.',
  '5. GlobalSettings store in SQLite (settings table) with validation, defaults, migration from any earlier keys, settings.changed events; the desktop applies: theme (nativeTheme + renderer), closeToTray/startWithWindows (reuse win/ patterns), notifications toggle, default backend/model used by the landing, per-backend defaults consumed by SessionRunner/harness factory (layering global → backend default → agent override), efficiency thresholds consumed by harnesses.',
  '6. Diagnostics: versions (app, electron, node, claude, codex), paths (db, logs, config dirs), harness availability (reuse harnessList), db size; copy-to-clipboard text with secrets redacted.',
  '7. Tests on temp homes (CLAUDE_CONFIG_DIR/CODEX_HOME): read/merge attribution; each write kind round-trips and preserves unrelated keys/comments; watcher emits on external edit; CLI-driven operations use a fake `claude` shim script in tests (record argv) plus one live read-only check against the real `claude plugin list` / `claude mcp list`; settings layering; diagnostics redaction.',
  'Done when (paste outputs): ' + PNPM + ' typecheck ok; engine + desktop vitest projects green; repo-wide reported honestly. Add COMPAT.md rows for every CLI command/flag/file format relied on (Claude Code 2.1.x, Codex 0.153.x). Commit "Phase 6: config sync engine — Claude/Codex stores, watchers, settings store, diagnostics" with trailer "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>".',
  'Return: file/CLI surface table per backend (what is read, what is written, how), the settings layering, event payloads, and known limitations.',
].join('\n'), { label: 'B1 config sync engine', phase: 'Build', model: 'opus', effort: 'high' })

const hubP = agent(COMMON + '\n' + CONTRACTS + '\n' + [
  'TASK B2 — Settings hub UI (you own apps/renderer/src/pages/settings/**, apps/renderer/src/pages/SettingsPage.tsx, apps/renderer/src/shell/settingsNav.ts(x), apps/renderer/src/components/settings/** and their tests; the theme application hook apps/renderer/src/lib/theme.ts; nothing in apps/desktop or packages/engine).',
  '1. Port Omnigent\'s settings shell and every section it has (ids: general, appearance, git, shortcuts, import, integrations, account, cli, updates, members, policies, sharing, archived), matching ' + REF + '/pages/SettingsPage.tsx layout/behaviour: sections whose backend lands in a later phase (import → Phase 7, updates → Phase 12, members/policies/sharing → Phase 9) render the reference layout with a clear "arrives with …" note and no dead controls.',
  '2. Add capygen sections with the same look: Harnesses (per backend: availability + reason, sign-in guidance, defaults: model/permission or approval/sandbox/effort → settings.patch), MCP servers (per backend tabs; list with scope/source/status badges; add/edit dialog for stdio/http; Test button; remove; a note for claude.ai proxy connectors that they are managed on claude.ai), Skills (per backend; list with scope/plugin; enable/disable; Create skill (name + markdown editor); open in Editor pane), Plugins (Claude: installed list with enable/disable/uninstall; marketplaces with browse + install; Codex: plugin/list read-only with a note), Tools (per backend policy table allow/deny/ask with pattern editor; Claude permission modes explained), Providers & API keys (exists — move under the hub), Dev servers (global defaults: auto-detect on/off, default browser pane behaviour), Prerequisites (renders the panel from the other agent\'s component — import apps/renderer/src/components/prereqs/PrereqPanel.tsx; if absent yet, render a placeholder the integrator replaces), Diagnostics (diagnostics.get + Copy).',
  '3. Global vs per-backend layering visible in the UI: a "Defaults" card per backend under Harnesses and an "Overrides" note on the agent info drawer path (link only).',
  '4. Appearance: theme system/light/dark applied live via lib/theme.ts (data-theme on <html> + Omnigent palette tokens), font scale, reduced motion.',
  '5. Tests: nav lists every section id (assert the full list), each section renders with mocked IPC, MCP add dialog validation, tools policy editing, theme application.',
  'Done when (paste outputs): ' + PNPM + ' typecheck ok; renderer vitest project green; ' + PNPM + ' build ok; screenshots via the dev fixture route saved to e2e-out/settings-mcp.png, e2e-out/settings-plugins.png, e2e-out/settings-dark.png. Commit "Phase 6: settings hub — Omnigent sections + harnesses/MCP/skills/plugins/tools/providers/diagnostics" with trailer "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>".',
  'Return: section map (id → component), IPC used, screenshots.',
].join('\n'), { label: 'B2 settings hub UI', phase: 'Build', model: 'sonnet' })

const prereqP = agent(COMMON + '\n' + CONTRACTS + '\n' + [
  'TASK B3 — Prerequisites / bootstrap (you own apps/desktop/src/prereqs/** (new), apps/desktop/src/ipc/prereqs.ts (new) + its registration lines, apps/desktop/test/prereqs*, apps/renderer/src/components/prereqs/** and tests, and the landing banner hook apps/renderer/src/components/SetupBanner.tsx; nothing else).',
  '1. Detection (main process, never installs): claude.exe (where + ~/.local/bin + npm global; `claude --version`; signed-in signal from ~/.claude presence of credentials file existence only), codex.exe (`codex --version`; signed-in via account/read through a short-lived app-server — reuse harnessList\'s probe), node, git, ripgrep, uv/python (optional), Windows Terminal (optional); each step with exact install command (winget/npm/official installer URL), description, blockedBy.',
  '2. Run gate (R3/R27): prereqs.run → main shows a native confirm dialog quoting the exact command → on Run opens a visible PowerShell window (start powershell -NoExit -Command …) detached, windowsHide false; Cancel runs nothing; a unit-tested pure function decides dialog text/args; sign-in steps open the CLI in a visible console (`claude` / `codex login`).',
  '3. Renderer: PrereqPanel (setup page look ported from Omnigent-windows setup/win-bootstrap.js + Omnigent onboarding components): step rows with detected/version/Run/Re-detect, live re-detect after a run finishes (poll prereqs.status every 3 s while a console is open), recommendation text; SetupBanner on the landing when no backend is available ("Set up Claude Code or Codex to start" → opens Settings ▸ Prerequisites); first-run: if nothing is available, the landing shows the panel inline.',
  '4. Tests: detection on a fake PATH/home, step list + blockedBy, the run gate (dialog text, cancel runs nothing, run spawns a visible console with the exact command), panel rendering with mocked IPC.',
  'Done when: ' + PNPM + ' typecheck ok; desktop + renderer vitest projects green for your tests; commit "Phase 6: prerequisites detection + confirmed visible bootstrap" with trailer "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>".',
  'Return: step list, gate behaviour, component map.',
].join('\n'), { label: 'B3 prerequisites', phase: 'Build', model: 'sonnet' })

const [sync, hub, prereq] = await Promise.all([syncP, hubP, prereqP])
log('build: sync ' + (sync ? 'ok' : 'MISSING') + ' · hub ' + (hub ? 'ok' : 'MISSING') + ' · prereq ' + (prereq ? 'ok' : 'MISSING'))

phase('Integrate')
const integ = await agent(COMMON + '\n' + CONTRACTS + '\nSYNC ENGINE REPORT:\n' + sync + '\nSETTINGS HUB REPORT:\n' + hub + '\nPREREQS REPORT:\n' + prereq + '\n' + [
  'TASK C — Integrate Phase 6 and prove it (you may edit anything; keep the structure others built).',
  '1. Wire the hub to the sync engine and prereqs; make the app accept CAPYGEN_CLAUDE_CONFIG_DIR / CAPYGEN_CODEX_HOME (mapped to CLAUDE_CONFIG_DIR / CODEX_HOME for every child process and for the config stores) so e2e never touches the real config; ensure theme/closeToTray/startWithWindows/notifications settings actually take effect in the desktop.',
  '2. e2e (tests/e2e/settings.spec.ts) on isolated homes: (a) nav lists every section id; (b) add a stdio MCP server (the tests/fixtures/mcp-apps-server or a tiny fixture) at user scope for Claude in the UI → assert the written file/`claude mcp list` (with CLAUDE_CONFIG_DIR) shows it, and a new Claude session\'s tool list includes it (live, few cents); (c) external edit: modify the isolated settings.json (add a permissions.allow entry) while the app is open → Tools table shows it within 3 s; (d) Codex: add an MCP server in the UI → config.toml has it with prior comments preserved; edit config.toml externally → UI reflects it; (e) API key: store a key via Providers → grep the settings DB, logs and config files for the plaintext → absent; secrets.has true; (f) prerequisites: with a fake PATH lacking codex, the panel shows the step; clicking Run shows the confirm dialog (stub the dialog in e2e via an env flag that auto-cancels) and nothing is spawned; (g) theme dark screenshot e2e-out/settings-dark.png; (h) plugin list shows the real installed Claude plugins (read-only, real config dir is fine for reads).',
  '3. Full gate: ' + PNPM + ' typecheck, test, build, exec playwright test — fix until green (API-key skip is fine). Update PLAN.md (tick Phase 6 only if its Done-when holds; record deviations), PROJECT_LOG.md, COMPAT.md, docs/RUN.md. Commit "Phase 6: settings hub + two-way config sync + prerequisites integrated; e2e green" with trailer "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>".',
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
  { key: 'correctness', model: 'sonnet', prompt: 'Correctness of the config stores and sync: JSON/TOML round-trips (comments, unknown keys, arrays), scope resolution, write-then-reread, watcher debouncing and loops (our own write must not trigger a spurious "external change"), settings layering, CLI output parsing. Read packages/engine/src/config/** and apps/desktop/src/integrations/** fully.' },
  { key: 'security', model: 'sonnet', prompt: 'Security: config writes never escaping the intended files, CLI spawn argument injection (server names, commands from the UI), secrets never in files/logs/IPC results, prerequisite runner cannot be abused to run arbitrary commands without the dialog, IPC validation, the real-home safety rule honoured by tests.' },
  { key: 'ux-parity', model: 'opus', prompt: 'UI parity vs the reference ' + REF + '/pages/SettingsPage.tsx and vs Claude Code\'s /mcp /plugin /skills UX for the new sections: look at ' + ROOT + '/e2e-out/settings-*.png, read apps/renderer/src/pages/settings/**; list concrete deviations, broken/confusing states, missing affordances (SPEC R19, R28–R30, R3).' },
  { key: 'efficiency', model: 'sonnet', prompt: 'Efficiency: watcher scope, TTL caches, no redundant app-server spawns, no settings/integration data reaching model context, startup cost of the settings store, IPC chatter. Read apps/desktop/src/integrations/** and packages/engine/src/config/**.' },
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
    'TASK D — Fix verified review findings from the Phase 6 review wave, then re-run the full gate.',
    'Findings (JSON): ' + JSON.stringify(serious, null, 2),
    'Low-severity findings (fix only if trivial): ' + JSON.stringify(all.filter((f) => f.severity === 'low'), null, 2),
    'For each finding: reproduce or confirm it in code, fix it minimally, add/adjust a test where behavioural. Then run ' + PNPM + ' typecheck, test, build, exec playwright test until green. Commit "Phase 6: review fixes" with trailer "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>". Return: per finding → fixed / not-a-bug (reason) / deferred (reason), and the command output tails.',
  ].join('\n'), { label: 'D fixes', phase: 'Review', model: 'opus', effort: 'high' })
}

return { contracts: String(contracts).slice(0, 1500), sync: String(sync).slice(0, 3000), hub: String(hub).slice(0, 2000), prereq: String(prereq).slice(0, 1500), integ: String(integ).slice(0, 4000), findings: all, fixReport: fixReport ? String(fixReport).slice(0, 4000) : null }
