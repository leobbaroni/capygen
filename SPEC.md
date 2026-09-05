# capygen — SPEC

One-line goal: a standalone native-Windows desktop app that looks and works like Omnigent
(every surface), runs Claude Code, Codex and API models side by side with no server to connect
to, and adds dockable panes, one-click dev servers and in-app harness/MCP/skill/plugin management.

## Classification

Track: **From scratch** — nothing exists; a new Electron + TypeScript app. Omnigent is the design
and behaviour reference, never a dependency.
Parked secondary asks (by name): full rebrand beyond name/mascot/font (user: "later"); macOS/Linux
builds; WSL backend; Omnigent's enterprise/Databricks-managed features.

## Goal & Success Criteria

- G1 Launch `capygen.exe` → composer is focused and usable within 3 s; no connect/host screen.
- G2 Type a task, press Enter → the default agent (Claude Code) streams a reply; tool calls,
  permission prompts and `AskUserQuestion` render as cards in the chat; answers reach the agent.
- G3 A round-table session with ≥2 agents on different backends (e.g. Claude + Codex) where an
  agent @-mentions another and that agent replies in the same thread.
- G4 `/` in the composer lists built-ins and the harness's skills/plugin commands; a plugin
  command (e.g. `/cockpit:pilot`) executes.
- G5 Files, editor, diff, browser, terminal, agents and tasks panes can be dragged to any dock
  position (side, stacked, tabbed, reordered); layout persists per project across restarts.
- G6 A project with a `dev` script is auto-detected; one click starts it, shows status + log
  tail, and opens it in the browser pane. No prompt, no agent tokens spent.
- G7 Settings hub manages harnesses, MCP servers, skills, plugins, API keys, appearance,
  shortcuts, git, updates, prerequisites.
- G8 Every item in the Parity Inventory (§P) is checked.
- G9 Efficiency: per-session token/cost meter is live; Anthropic prompt caching is on; context
  compaction triggers at a configurable threshold; a 20-turn benchmark session spends ≤ 110 % of
  the tokens the same prompts spend in the Claude Code CLI (measured, Phase 11).
- G10 NSIS installer + portable exe; in-app self-update from GitHub Releases.

## Current State

- Target directory was empty before this session (verified: `ls`).
- Machine: Windows 10 Pro 19045; Node 22.16; pnpm 11 via corepack; Claude Code 2.1.261 native
  (`~/.local/bin/claude.exe`); Codex CLI 0.139.0 signed in (`~/.codex/auth.json`); OpenCode on
  PATH; no `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` in the environment
  (verified: `where`, `claude --version`, `codex --version`, env check, 2026-09-05).
- Reference: Omnigent `main@44378d6` SPA sources, server route modules, `openapi.json`, docs,
  vendored read-only under `reference/omnigent/` (verified: fresh clone). Apache-2.0; NOTICE kept.
- Registry versions (verified: `npm view`, 2026-09-05): electron 44.2.0,
  @anthropic-ai/claude-agent-sdk 0.3.261, @openai/codex-sdk 0.153.4, dockview 8.2.0,
  node-pty 1.1.0, better-sqlite3 13.0.3, @modelcontextprotocol/sdk 1.30.0,
  @anthropic-ai/sdk 0.124.0, openai 7.10.0, vite 8.2.2, tailwindcss 4.3.3, @xterm/xterm 6.0.0,
  zustand 5.0.15.
- `codex app-server` exists and is marked experimental (verified: `codex app-server --help`).
- Font `CheGuevaraBarry-Brown.ttf` is installed per-user and copied to `assets/fonts/`
  (verified). Its zip carries no license file [assumed: free for personal use; redistribution
  in the installer unverified — if wrong: ship the wordmark as a pre-rendered SVG instead].

## Scope (v1)

Full Omnigent parity (user), delivered as milestones M1–M7 (see PLAN.md); each milestone is
usable on its own. Name: **capygen** (user). Look: Omnigent's, with the hero star replaced by a
reactive 32-bit pixel capybara mascot in Codex's mascot style, and brand text set in
CheGuevaraBarry-Brown (user).

## Out of Scope & Parked Items

- Rebrand beyond name/mascot/font — user: after everything works.
- macOS / Linux packaging — Windows-first; the code stays portable but no CI for them.
- WSL backend — the whole point is native Windows.
- Omnigent's Databricks/Arca/isaac/MDM-managed paths — no equivalent exists for us [assumed].
- Multi-tenant cloud server mode — members/sharing/policies exist as local parity surfaces
  (roles and rules apply to local sessions), not as a network service.
- Omnigent monorepo extras (Android app, VS Code editor package, Cloudflare deploy).

## Requirements

Format: WHEN <trigger> THE SYSTEM SHALL <behaviour>. Each carries an acceptance check.

### Shell
- R1 WHEN the app starts THE SYSTEM SHALL open the seamless window (hidden title bar, caption
  buttons blended to the page colour) directly on the New Session landing (mascot + "What should
  we build?" + composer) with no server/host selection. Check: e2e screenshot ≤3 s after launch.
- R2 WHEN the last window closes THE SYSTEM SHALL keep running in the tray with Open / New Window
  / Quit; running agents keep running. Check: e2e.
- R3 WHEN a required CLI (claude.exe, codex.exe) is missing THE SYSTEM SHALL show a setup panel
  with one button per step that confirms the exact command and runs it in a visible console;
  nothing is ever installed silently. Check: unit test on the step list; manual.
- R4 WHEN the app is packaged THE SYSTEM SHALL check GitHub Releases for updates (modes:
  automatic / at launch / manual / never) and never install without an explicit click. Check: e2e
  against a test feed.

### Sessions and agents
- R5 WHEN the user submits the composer THE SYSTEM SHALL create a session (project = chosen
  working directory) and start the lead agent's first turn. Check: DB row + first stream event.
- R6 WHEN an agent streams THE SYSTEM SHALL render text, thinking (collapsed), tool calls with
  inputs/outputs, diffs, permission prompts, `AskUserQuestion` cards, and sub-agent spawns, in
  Omnigent's chat layout. Check: fixture-driven UI tests per block type.
- R7 WHEN a backend is Claude Code THE SYSTEM SHALL drive it through the Claude Agent SDK
  (headless) honouring the user's Claude login, `~/.claude` settings, skills, plugins, MCP
  servers and hooks. Check: Phase 1 spike log.
- R8 WHEN a backend is Codex THE SYSTEM SHALL drive it through `codex app-server` (JSON-RPC over
  stdio), honouring `~/.codex` auth and config, approvals and MCP. Check: spike log.
- R9 WHEN a backend is an API model THE SYSTEM SHALL run our own agent loop (Anthropic Messages /
  OpenAI Responses, OpenRouter via OpenAI-compatible base URL) with the local tool runtime
  (read, write, edit, bash, glob, grep, web fetch, MCP tools) and the same permission cards.
  Check: fixture test with a mocked API; live smoke with a key.
- R10 WHEN a session is created THE SYSTEM SHALL let the user pick mode **Solo orchestrator**
  (one lead agent) or **Round-table** (several top-level agents in one chat); the mode can be
  switched later without losing history. Check: UI test.
- R11 WHEN in round-table mode THE SYSTEM SHALL deliver a user message to the @-mentioned agents
  (none mentioned → the lead), let agents @-mention each other, and stop agent-to-agent chains
  after 3 hops until the user speaks (configurable). Check: unit test on the dispatcher.
- R12 WHEN any agent spawns a sub-agent THE SYSTEM SHALL apply the routing policy (per-agent
  config or per-session rule: "sub-agents run on <backend/model>") and show the spawn in the
  agent tree; policy failures fail open (spawn on the inherited model). Check: unit test.
- R13 WHEN the user opens an agent's info THE SYSTEM SHALL show its usage description
  (orchestrator role, capabilities, tools, model, cost so far) in Claude-Code style, and a
  listing of the other agents in the session. Check: UI test.
- R14 WHEN the user types `/` THE SYSTEM SHALL show built-ins (`/compact`, `/context`, `/effort`,
  `/model`, `/help`, `/clear`, `/cost`) plus the backend's commands, skills and plugin commands;
  selecting one sends it to the backend. Check: UI test + spike.
- R15 WHEN a session is idle THE SYSTEM SHALL persist everything (turns, tool calls, usage) in
  SQLite so relaunching the app restores the session list and any open session. Check: restart e2e.

### Panes and workspace
- R16 WHEN a session is open THE SYSTEM SHALL offer panes: Files (tree + open in editor),
  Editor (Monaco-free CodeMirror or Shiki-highlighted viewer with edit), Diff, Browser (embedded
  webview with URL bar), Terminal (node-pty + xterm, the session's cwd), Agents (tree), Tasks
  (plan/todos from the agents), Servers (dev servers). Check: each pane has a UI test.
- R17 WHEN the user drags a pane tab THE SYSTEM SHALL allow docking left/right/top/bottom,
  stacking as tabs, reordering, floating, maximising; layout is saved per project. Check: e2e
  drag + restart.
- R18 WHEN a project is opened THE SYSTEM SHALL detect dev servers from `.claude/launch.json`
  (Claude Code format), `package.json` scripts (dev/start/serve), `pyproject`/`manage.py`,
  `docker-compose.yml`, and list them with Start/Stop; starting streams logs and opens the URL
  in the Browser pane once the port answers. Check: fixture projects.

### Settings hub
- R19 THE SYSTEM SHALL provide settings sections mirroring Omnigent (general, appearance, git,
  shortcuts, import, integrations, account, cli, updates, members, policies, sharing, archived)
  plus Harnesses, MCP servers, Skills, Plugins, API keys, Dev servers, Diagnostics. Check: nav
  test lists all ids.
- R20 WHEN the user edits MCP servers / skills / plugins THE SYSTEM SHALL write the backend's
  own config (Claude: `~/.claude/settings.json`, `.claude/`, plugin marketplaces via the `claude`
  CLI headless; Codex: `~/.codex/config.toml`) and show the effect per agent. Check: round-trip
  tests on temp homes.
- R21 WHEN the user enters an API key THE SYSTEM SHALL store it with Electron `safeStorage`
  (Windows DPAPI) and never write it to plain files or logs. Check: grep test on the settings
  file + log redaction test.

### Integrations management and MCP Apps (user, 2026-09-05: "very important")
- R28 THE SYSTEM SHALL manage, from the app, plugins, skills, MCP servers (ComfyUI, Higgsfield,
  claude.ai connectors, local stdio/HTTP servers) and tools for every backend: list with status,
  enable/disable, add/remove/configure, and show which agents/sessions see them. Check: settings
  pages backed by round-trip tests on temp homes for Claude and Codex.
- R29 WHEN the user changes Claude Code or Codex configuration outside the app (settings.json,
  `.claude/`, plugin installs, `~/.codex/config.toml`, MCP registrations) THE SYSTEM SHALL
  reflect it on next open (file watchers + the backend's live lists such as `system/init`
  slash_commands/skills/plugins/mcp_servers and Codex `mcpServerStatus/list`, `skills/list`,
  `plugin/list`); WHEN the user changes them in the app THE SYSTEM SHALL write the backend's own
  files so the CLIs see the same change. Two-way, the backend's files are the source of truth.
  Check: edit outside → UI updates; edit inside → `claude`/`codex` CLIs list the change.
- R30 THE SYSTEM SHALL keep global settings (API keys and providers, app behaviour, appearance,
  default backend/model, efficiency thresholds, notifications, updates) in one Settings hub,
  separate from per-backend configuration, with per-agent overrides layered on top. Check: UI
  test + settings round-trip.
- R31 WHEN a tool result carries an MCP App UI (a `ui://` resource referenced by the tool's
  `_meta` per the MCP Apps extension, `@modelcontextprotocol/ext-apps` 1.7.5, verified: npm)
  THE SYSTEM SHALL render it as a widget card in the transcript — sandboxed iframe, the host
  side of the MCP Apps bridge (tool input/result delivery, `ui/*` messages, the widget calling
  tools through the host, size negotiation), theme passthrough, and the widget's actions
  (e.g. Higgsfield's Animate / Edit / Download) working — matching Claude Code desktop's
  rendering. Non-App tool results keep the tool-call card. Check: fixture MCP server from the
  ext-apps basic example rendered in a session; live check with the user's Higgsfield connector.
- R32 WHEN a backend tool needs user interaction (AskUserQuestion, permission prompts,
  elicitation with `_meta['anthropic/permissionDisplay']`, Codex approval and user-input
  requests) THE SYSTEM SHALL render the same structured cards Claude Code shows (headers,
  option buttons, multi-select, free text "Other"), and the answer reaches the tool. Check:
  fixture-driven UI tests + the Phase 2 live AskUserQuestion e2e.

### Parity surfaces (see §P for the checklist)
- R22 THE SYSTEM SHALL implement each Parity Inventory item with Omnigent's page layout and
  behaviour adapted to local-only operation. Check: per-item checkbox with an e2e or UI test.

### Efficiency
- R23 THE SYSTEM SHALL show live tokens (in/out/cached) and estimated cost per turn, session and
  day; Usage page aggregates by backend/model. Check: UI test with fixture usage events.
- R24 WHEN using Anthropic API models THE SYSTEM SHALL set `cache_control` on the system prompt
  and tool definitions; WHEN using the Claude SDK THE SYSTEM SHALL not inject per-turn system
  text that would break its cache. Check: request capture test.
- R25 WHEN a session's context exceeds the threshold (default 70 % of the model window)
  THE SYSTEM SHALL offer/auto-run compaction (backend-native `/compact` where available,
  otherwise our summariser) and truncate large tool outputs with an expandable stub. Check: unit.
- R26 THE SYSTEM SHALL load MCP tool schemas lazily (on first listing) and keep the UI's own
  IPC chatter out of the agent's context. Check: token count assertion in a fixture session.

### Safety
- R27 THE SYSTEM SHALL never run an install/upgrade/uninstall without the confirm dialog and a
  visible console; never auto-approve destructive tool calls unless the user chose that
  permission mode. Check: unit tests on the gates.

## Key Decisions

- Build strategy: clean TypeScript rewrite — (user, Q1).
- Backends in v1: Claude Code + Codex + API models — (user, Q2).
- Collaboration: round-table first, plus solo orchestrator; mode selectable per session; both
  route sub-agents — (user, Q3).
- v1 finish line: full Omnigent parity — (user, Q4).
- Engine: SDK/headless, our own chat UI; no embedded CLI TUI as primary path — (user, Q5).
- Name capygen; mascot capybara 32-bit pixel, Codex-mascot style, reactive; wordmark font
  CheGuevaraBarry-Brown — (user, Q6 amendments).
- Stack: Electron 44 + Vite 8 + React 18 + Tailwind 4 + shadcn/ui + zustand — (verified:
  Omnigent `web/package.json` uses React 18/Vite 8/Tailwind 4; versions verified: npm view)
  [assumed the match keeps its theme CSS reusable — if wrong: port tokens by hand].
- Panes: dockview 8 — [assumed: default; if wrong: react-resizable-panels with a custom tab bar].
- Storage: better-sqlite3, one DB at `%APPDATA%\capygen\capygen.db`; migrations as numbered SQL
  files — [assumed: default].
- Terminal: node-pty (ConPTY) + xterm 6 — [assumed: default].
- Secrets: Electron safeStorage — [assumed: default].
- Updates: electron-updater, GitHub provider, owner `leobbaroni`, repo `capygen` —
  [assumed: mirrors Omnigent-windows; if wrong: change publish block].
- Push policy: commit locally, push only when asked, never force-push — (user, prior project).

## Data & State Changes

New SQLite schema (no existing data). Entities: `projects` (path, name, layout_json,
dev_servers_json) · `sessions` (project_id, mode, lead_agent_id, title, status, archived,
created/updated) · `agents` (session_id, name, backend, model, role, config_json, usage totals)
· `turns` (session_id, agent_id, role, content_json, parent_turn_id, hop_index) · `tool_calls`
(turn_id, name, input_json, output_json, status, approved_by) · `usage_events` (session_id,
agent_id, model, in/out/cached tokens, cost_usd, ts) · `tasks` (session_id, title, status,
source) · `automations` (schedule, prompt, project_id, last_run) · `inbox_items` (session_id,
kind, read) · `settings` (key, value_json) · `mcp_servers`, `plugins`, `skills` caches ·
`shares`, `members`, `policies`, `approvals` (local parity). Migration: forward-only numbered
SQL; rollback = restore the pre-migration backup the migrator writes next to the DB.

## Interfaces, Integrations & Credentials

- Claude Agent SDK `query()` (TS): `cwd`, `permissionMode`, `canUseTool` (permission +
  AskUserQuestion), `hooks` (PreToolUse for sub-agent routing), `mcpServers`, `settingSources`,
  `plugins`, `model`, `resume`; slash commands sent as prompt text. Shapes [assumed until the
  Phase 1 spike reads the installed package's `.d.ts`].
- Codex `codex app-server` JSON-RPC over stdio: thread create/resume, turn start, approval
  requests, tool events, usage. Shapes [assumed until spike; fallback `@openai/codex-sdk`].
- Anthropic SDK Messages API with tools + `cache_control`; OpenAI SDK Responses API; OpenRouter
  = OpenAI SDK with `baseURL https://openrouter.ai/api/v1` [assumed].
- MCP client: @modelcontextprotocol/sdk (stdio + streamable HTTP).
- Dev-server config: `.claude/launch.json` (`configurations[].runtimeExecutable/runtimeArgs/
  port/url`) — (verified: format used by this session's harness).
- Secrets: `${ANTHROPIC_API_KEY}`, `${OPENAI_API_KEY}`, `${OPENROUTER_API_KEY}` — Settings ▸ API
  keys (safeStorage); environment variables honoured when present. Never logged.
- Fixed contracts: none external. Internal IPC is versioned in `packages/shared`.

## Edge Cases & Failure Handling

- Backend CLI missing / not signed in → setup panel step with a visible console (R3); the
  session shows a clear "needs sign-in" card instead of failing silently.
- Backend crashes mid-turn → turn marked failed with stderr excerpt; Retry button; session keeps
  history.
- Round-table loop (agents ping-ponging) → hop cap (R11); a "Continue" button resumes.
- Sub-agent routing endpoint down → fail open, log a warning (R12).
- Port already in use when starting a dev server → show the owning PID and offer to open the
  existing URL instead.
- Tool output > 64 KB → stored whole, sent to the model truncated with a stub (R25).
- Context window exceeded → compaction offered; if refused, the turn errors with a clear message.
- API key invalid → 401 surfaced on the agent card with a link to Settings ▸ API keys.
- Long paths / non-ASCII cwd on Windows → all child processes spawn with UTF-8 env and
  `windowsHide`; paths normalised.
- Default posture: fail loudly with the actual error text; never swallow.

## Design Reference

- Omnigent SPA under `reference/omnigent/web/src` (`index.css`, `themePalettes.generated.css`,
  `components/`, `pages/`, `shell/`) — reuse tokens and component styles verbatim (Apache-2.0,
  NOTICE kept). Screens: New Session landing (hero + composer + host/dir/worktree chips), Chat
  page with workspace rail, Settings, Tasks, Inbox, Usage, Sharing, Members, Policies, Approvals,
  Setup/Onboarding.
- Hero: 32-bit pixel capybara, Codex-mascot style (rounded blob body, dark visor face with
  cyan glyph eyes → capybara with dark face plate and `>_`-style eyes), reactive states: idle,
  thinking, working, waiting-for-you, success, error, sleeping, listening. Sprite sheet PNG,
  96 px cells, CSS `steps()` animation; state driven by the active session's status.
- Wordmark "capygen" and brand headings in CheGuevaraBarry-Brown; body text stays Omnigent's.

## P — Parity Inventory (from Omnigent `web/src/pages` and `server/routes`, verified)

| ID | Surface | Milestone |
|----|---------|-----------|
| P1 | New Session landing (hero, composer, attachments, mic, harness picker, dir picker, worktree) | M1 |
| P2 | Chat page: transcript, turn rail, queued messages strip, indicators, scrollbar map | M1 |
| P3 | Sessions sidebar: list, search, filters, projects grouping, archive | M1 |
| P4 | Workspace rail: files, editor, diff, browser, terminal, agents tree, tasks, servers | M1 |
| P5 | Settings: general, appearance, git, shortcuts, cli, updates, archived | M1 |
| P6 | Settings: harnesses, MCP servers, skills, plugins, API keys, dev servers, diagnostics | M1 |
| P7 | Setup / onboarding pages (prerequisites, sign-in) | M1 |
| P8 | Projects + worktrees (host_worktree, projects routes), git integration | M2 |
| P9 | Session import (Claude Code / Codex transcripts) | M2 |
| P10 | Tasks page | M3 |
| P11 | Inbox page | M3 |
| P12 | Usage page | M3 |
| P13 | Scheduled tasks / automations | M4 |
| P14 | Session MCP servers, harness catalogue, builtin agents, host model options | M5 |
| P15 | Sharing page, comments | M6 |
| P16 | Members page, accounts (local roles), device auth (local) | M6 |
| P17 | Policies page, default policies, session policies, Approve page | M6 |
| P18 | Dictation | M7 |
| P19 | Hosts page (local machine only; remote hosts parked), terminal attach | M7 |
| P20 | Extensions (canvas-style page extensions) | M7 |
