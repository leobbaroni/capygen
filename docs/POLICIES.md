# capygen — application policies

The rules the app enforces at runtime, where each lives in code, and how to change it. These are
the contract the new lead keeps; changes go through an ADR under `docs/adr/`.

## 1. Sub-agent routing policy (SPEC R12, ADR-0004)

- **Precedence:** `Agent.subagentRouting` (per agent) → `Session.settings.routing.subagents`
  (per session) → none. Resolved by `packages/engine/src/routing/policy.ts` (`resolveRoute`),
  which never throws.
- **Same backend, different model** (e.g. Claude lead, sub-agents on `haiku`): enforced through the
  Claude `PreToolUse` hook on `Task|Agent` by rewriting `updatedInput.model`; recorded on the
  `subagent` block as `{backend, model, delegated: false}`. Proven live (haiku accounting).
- **Different backend** (e.g. Claude lead, sub-agents on Codex): the lead is given the capygen tool
  `delegate_task` (Claude: in-process MCP server `capygen`; api: a registry tool; Codex: not
  available — app-server takes MCP servers only from `config.toml`) and a session-stable prompt
  telling it when to use it. capygen runs the sub-agent itself on the routed backend/model in the
  same project, streams it into the parent's turn under a `subagent` block `{delegated: true}`,
  bills tokens to the model that spent them, and returns the final text (size-bounded).
- **Fail open, always:** any resolver/harness/tool failure means the backend spawns its own
  sub-agent exactly as it would without capygen; the parent turn is never lost.
- **Interrupt** stops delegated children too (`SessionRunner.delegated` registry).
- UI: routing editable per agent in the Agent info drawer and per session in Session settings;
  the effective route is shown; Codex agents cannot be given a cross-backend rule.

## 2. Permissions, approvals and interaction (SPEC R27, R32)

- **Layering:** global defaults (`GlobalSettings.backends.<backend>`) → agent override
  (`Agent.config.<backend>`), resolved by `permissionModeFor()` in
  `apps/desktop/src/engine/SessionRunner.ts`.
- **Claude:** `permissionMode` (`default` asks; `acceptEdits`; `plan`; `bypassPermissions` only
  when the user chose it). `canUseTool` → permission card (Allow once / Allow for session /
  Deny with reason); `AskUserQuestion` always reaches the user, even under bypass, and an
  interrupted question is **denied**, never answered empty.
- **Codex:** `approvalPolicy` (`untrusted` / `on-request` default / `on-failure` / `never`) and
  `sandbox` (`read-only` / `workspace-write` default / `danger-full-access`); the app always
  passes `approvalsReviewer: "user"` so approvals reach the user, not an auto-reviewer; a turn
  that settles with an approval still open declines it.
- **api backend:** tools declare a permission class (read / write / execute / network);
  `default` asks for write/execute/network; file tools are confined to the project root
  (realpath, junction-safe); `web_fetch` refuses loopback/private/link-local hosts and re-checks
  every redirect hop.
- **Tool policies** (Claude `permissions.allow/deny/ask`) are edited in Settings ▸ Tools and
  written to the backend's own settings files; Codex/api policy tables are only shown where a
  turn actually consults them.
- **Elicitation / Codex user-input** render as forms; answers are addressed by block id.

## 3. Round-table policy (SPEC R10–R11, ADR-0002)

- A user message goes to the @-mentioned agents in mention order, otherwise to the lead. Unknown
  mentions are surfaced as a warning chip, never silently dropped.
- Agents may @-mention each other; hop indices are absolute (user = 0, first agent = 1); a chain
  stops when the next hop would exceed `Session.settings.hopCap` (default 3, max 20) with a system
  turn and a Continue bar; Continue grants exactly one more hop per blocked chain; a new user
  message resets the count; Interrupt cancels queued turns.
- Solo mode is round-table with one agent (mentions of others fall through to the lead).
- Context to stateful backends (Claude, Codex) is the **delta** of other speakers' turns since
  that agent's last turn, prefixed with labelled speakers; line-leading `[` in quoted text is
  escaped so a peer cannot forge a `[user]:` label. The api backend replays the shared transcript
  with speaker labels. The round-table prompt addition is set once per harness start, never per
  turn.
- `parallelAgents` (default off) runs targets concurrently; transcript order stays deterministic
  (rows opened in target order), completion order drives chaining.

## 4. Configuration source of truth (SPEC R28–R30, A14)

- Claude: `.claude.json` (user/local MCP), `<project>/.mcp.json` (project MCP), `settings.json` →
  `settings.local.json` → `<project>/.claude/settings(.local).json` chain for permissions/hooks/
  `skillOverrides`/`enabledPlugins`, `plugins/installed_plugins.json`, skills dirs. Writes go
  through `claude mcp add/remove` (user/local), direct edits (`.mcp.json`, settings arrays) and
  `claude plugin …` (with a confirm dialog and visible console, SPEC R27). Skills are toggled
  via `skillOverrides`, never moved.
- Codex: `<CODEX_HOME>/config.toml`, patched by byte range so comments and unknown keys survive;
  skills toggled by renaming `SKILL.md ⇄ SKILL.md.disabled`; no CLI is spawned for config.
- api backend: its own MCP servers in capygen settings; inherits Claude/Codex servers read-only.
- Watchers (chokidar, bounded, debounced, ref-counted) + live lists (Claude `system/init`, Codex
  app-server `mcpServerStatus/list`, `skills/list`, `plugin/list`, `config/read`) keep the hub in
  sync; the app's own writes are re-read, never assumed.
- Global settings (theme, defaults, efficiency thresholds, notifications, updates, close-to-tray,
  start-with-Windows) live in the SQLite `settings` store as one versioned `GlobalSettings`.

## 5. Safety and privacy

- Nothing installs silently; every install/sign-in is a confirmed, visible console command.
- No telemetry; nothing leaves the machine except model traffic to the backends the user chose.
- Secrets only in `safeStorage`; diagnostics copy is redacted; logs redact tokens/emails.
- Browser pane views run in their own partition with permission requests denied by default,
  navigation limited to http(s), everything else opened externally.
- Renderer: `contextIsolation`, sandboxed preload exposing only the typed IPC; IPC handlers
  validate the sender frame; `will-navigate` guarded.
- MCP App widgets run in an opaque-origin sandboxed iframe behind the `capygen-widget://` scheme
  with their own CSP; the host bridge forwards only the ext-apps messages listed in
  `docs/spikes/mcp-apps.md` (no `sampling`, no `updateModelContext`).

## 6. Efficiency (SPEC R23–R26)

Per-turn usage split by model (`usage_events`), session meter in the header, cumulative-vs-delta
handling for the Claude SDK, cost table `[assumed 2026-09-06]` in `packages/engine/src/api/pricing.ts`;
compaction threshold and tool-output cap in `GlobalSettings.efficiency`; MCP tool schemas listed
lazily; no per-turn system prompt churn (delta context only).
