# Engine spike — Phase 1 consolidated results (2026-09-05)

Run: `corepack pnpm spike` (root `spike` → `@capygen/engine` `spike` → `packages/engine/scripts/spike-engine.ts`).
The runner executes `scripts/spike-claude.ts` and then `scripts/spike-codex.ts` as `tsx` child processes,
forwards their output (e-mail addresses and token-like JSON fields masked), collects every
`CAP <name> PASS|PARTIAL|FAIL - <evidence>` line and ends with `SPIKE <n> PASS, <m> PARTIAL, <k> FAIL`.
It exits 1 when any capability is FAIL (regression check, PLAN.md §Verification).

Evidence run: 2026-09-05 21:11:32Z → 21:13:23Z (Claude probe 89.3 s, Codex probe 21.9 s), Node v22.16.0,
Windows 10 19045 x64, pnpm 11.15.1 via corepack. Transcript `docs/spikes/engine.spike.log`, structured verdicts
`docs/spikes/engine.raw.json`, per-probe streams `docs/spikes/claude.raw.json` / `docs/spikes/codex.raw.json`
(all four gitignored). The final line of that run:

```
SPIKE 8 PASS, 1 PARTIAL, 4 FAIL
```

Backends under test:

| Backend | Package / binary | Sign-in | Model |
| --- | --- | --- | --- |
| Claude | `@anthropic-ai/claude-agent-sdk` 0.3.261, SDK-bundled `claude.exe` = Claude Code 2.1.261 | claude.ai OAuth (`init.apiKeySource: "none"`, `accountInfo.subscriptionType "Claude Max"`) | `claude-sonnet-5` (from `~/.claude/settings.json` `model: "sonnet"`; the account default resolves to `claude-opus-5[1m]`) |
| Codex | `@openai/codex-sdk` 0.153.4 + bundled `@openai/codex` 0.153.4 (`node_modules/.pnpm/@openai+codex@0.153.4-win32-x64/.../bin/codex.exe`); installed `codex` 0.139.0 compared in the probe run | ChatGPT OAuth — **dead**: refresh token rejected (`invalid_refresh_token`) | `gpt-5.5` (from `~/.codex/config.toml`) |

## 1. Verdict against PLAN.md Phase 1 "done when"

| PLAN.md item | Capability | Status |
| --- | --- | --- |
| Claude SDK stream text | `stream_text` | PASS |
| `/context` built-in handled | `slash_context` | PASS |
| plugin command `/cockpit:pilot what's next` executed | `plugin_command` | PASS |
| `AskUserQuestion` surfaced via `canUseTool` and answered | `ask_user_question` | PASS |
| PreToolUse hook fired on `Task` | `pretooluse_hook_task` | PASS (wire name is `Agent`) |
| Codex app-server thread+turn streamed | `appserver-thread-turn-stream` | FAIL — blocked by sign-in |
| Codex approval request answered | `appserver-command-approval` | FAIL — blocked by sign-in |
| token usage recorded per call | `usage_reporting` | PASS (Claude); Codex reported nothing because no turn reached the model |

**Phase 1 stays open** (PLAN.md checkbox left `[ ]`): five of seven items pass; both Codex items fail on one
root cause — the ChatGPT refresh token in `~/.codex/auth.json` (dated 2026-06-10) is rejected with
`invalid_refresh_token`, and has been since 2026-09-03 18:00 per the Codex log DB (codex-shapes.md §3).
The app-server protocol is proven up to the model call (handshake, `thread/start`, `turn/start`, eight
notification kinds, `turn/completed`), so the remaining work is the user's `codex logout` + `codex login`
followed by `corepack pnpm spike --only codex`.

## 2. Capability table (this run)

| # | Backend | Capability | Status | Evidence (observed) |
| --- | --- | --- | --- | --- |
| 1 | claude | `stream_text` | PASS | `result.result="pong"`, `model=claude-sonnet-5`, `claude_code_version=2.1.261`, 7 `stream_event` frames (`message_start` → `content_block_delta` text_delta `"p"`/`"ong"` → `message_stop`), `apiKeySource=none` |
| 2 | claude | `system_init_commands` | PASS | `init.slash_commands=92` (built-ins `context, compact, clear, model, usage, init`; 31 plugin-qualified incl. `cockpit:pilot`), `plugins=[cockpit@3.0.0, maestro@5.0.0, hyperframes@0.8.4]`, `skills=56`, `tools=163`, `mcp_servers=4`, `capabilities=["interrupt_receipt_v1","interrupt_cancel_queued_v1","msg_lifecycle_v1"]`; control request `supportedCommands()` = 92 entries `{name, description "(Cockpit) Pilot", argumentHint}`; `initializationResult()`, `supportedModels()` (5), `supportedAgents()` (5), `accountInfo()`, `mcpServerStatus()` all answered in streaming-input mode |
| 3 | claude | `slash_context` | PASS | synthetic assistant frame (`message.model "<synthetic>"`, `is_meta`, `local_command_source`) carrying `context_usage{total_tokens=21988, raw_max_tokens=1000000, percentage=2, categories: System prompt 404 / System tools 12230 / MCP tools (deferred) 89066 / System tools (deferred) 15076 / Memory files 879 / Skills 8467 / Messages 8 / Autocompact buffer 33000 / Free space 945012}`; `result.num_turns=0`, `total_cost_usd=0` |
| 4 | claude | `plugin_command` | PASS | `/cockpit:pilot what's next` ran as a normal model turn: tools `Bash, Read, Bash, Bash`, 5 turns, 30.2 s, reply `"Phase: BUILD — because PLAN.md Phase 1 is unchecked …"`; no `<command-name>` echo in any user frame |
| 5 | claude | `ask_user_question` | PASS | `canUseTool("AskUserQuestion", {questions:[{question:"Which colour do you prefer?", header:"Colour", options:[{label:"Red",…},{label:"Blue",…}], multiSelect:false}]}, {toolUseID, requestId, displayName, signal})` → returned `{behavior:"allow", updatedInput:{…input, answers:{"Which colour do you prefer?":"Blue"}}}`; `tool_use_result.answers` echoed; `result.result="Blue"`; reached under `permissionMode:"bypassPermissions"` despite the `[CLAUDE_SDK_CAN_USE_TOOL_SHADOWED]` warning |
| 6 | claude | `pretooluse_hook_task` | PASS | hook fired once with `tool_name:"Agent"` (matcher `'Task\|Agent'`), `hook_name "PreToolUse:Agent"`; `system/task_started{task_id ac5d6d18072f40a61, subagent_type general-purpose, description "Count .md files in directory", is_backgrounded false, spawn_depth 1}`; 3 subagent frames with `parent_tool_use_id`; `task_notification` 1; `hook_started/hook_response` for SessionStart, UserPromptSubmit, PreToolUse; final `"6 .md files: CLAUDE.md, CONTEXT.md, PLAN.md, PROJECT_LOG.md, README.md, SPEC.md"` |
| 7 | claude | `usage_reporting` | PASS | `result.usage`, `result.modelUsage`, `result.total_cost_usd` present on every step a–f (numbers in §4) |
| 8 | codex | `codex-auth` | FAIL | `getAuthStatus{includeToken:false}` → `{authMethod:"chatgpt", authToken:null, requiresOpenaiAuth:true}`; `account/read{refreshToken:true}` → `{account:null, requiresOpenaiAuth:true}`; stderr `codex_login::auth::manager: Failed to refresh token: 401 Unauthorized … "code":"invalid_refresh_token"` |
| 9 | codex | `sdk-runStreamed-pong` | FAIL (blocked by #8) | `runStreamed("Reply with exactly the word pong.")` events `thread.started, turn.started, error, turn.failed` then the generator threw `Codex Exec exited with code 1`; `usage` null. Spawn/stdin/JSONL path works (thread id assigned, rollout written under `~/.codex/sessions/2026/09/05/`) |
| 9b | codex | `sdk-resumeThread` | not reached | depends on #9 (wired in `spike-codex.ts`) |
| 10 | codex | `sdk-command-approval` | PARTIAL (by design) | `TurnOptions = {outputSchema?, signal?}` and `ThreadOptions.approvalPolicy` only — no approval callback exists in the SDK; codex 0.153.4 `exec` rejects `--config approval_policy="untrusted"` ("no longer supported") although `ApprovalMode` still lists it (probe run, raw `sdk-b1`); this run errored on auth before the command |
| 11 | codex | `appserver-thread-turn-stream` | FAIL (blocked by #8) | `initialize` → `initialized` → `thread/start{cwd, approvalPolicy:"never", sandbox:"read-only", approvalsReviewer:"user"}` → `thread.id 01a0736b-0751-…`, `model gpt-5.5`, `sandbox {type:"readOnly", networkAccess:false}` → `turn/start` → `turn.status "inProgress"`; notifications `mcpServer/startupStatus/updated, thread/settings/updated, thread/status/changed, turn/started, item/started, item/completed, error{codexErrorInfo:"unauthorized", willRetry:false}, turn/completed{status:"failed"}` |
| 11b | codex | `appserver-thread-resume` | not reached | depends on #11 (wired) |
| 12 | codex | `appserver-command-approval` | FAIL (blocked by #8) | three attempts — `untrusted`/`workspace-write` (×2, `sandbox {type:"workspaceWrite", writableRoots:[], networkAccess:false}`, `approvalsReviewer "user"` accepted) and `on-request`/`read-only` with a sandbox-blocked write — all `turn.status "failed"` on auth before any `commandExecution` item; 0 server requests. Handler wired for `item/commandExecution/requestApproval` → `{decision:"accept"}` |
| 13 | codex | `appserver-discovery` | PASS | 14/16 methods answered: `model/list, skills/list, mcpServerStatus/list, hooks/list, config/read, account/read, getAuthStatus, permissionProfile/list, experimentalFeature/list, collaborationMode/list, windowsSandbox/readiness, thread/list, plugin/list, server/diagnostics`; failed `account/rateLimits/read` (401, auth) and `app/list` (Cloudflare managed challenge 403). No protocol method lists slash commands |

## 3. Observed shapes — where they are written down

Both shape docs cite the installed `.d.ts` / generated bindings by `file:line` and the raw logs by entry.

Claude — [`claude-sdk-shapes.md`](./claude-sdk-shapes.md):

- §1 `query()` and `Options` — `prompt: string | AsyncIterable<SDKUserMessage>` (`sdk.d.ts:2953-2956`); `cwd`, `env`,
  `permissionMode`, `canUseTool`, `hooks`, `settingSources`, `plugins`, `includePartialMessages`, `includeHookEvents`,
  `model`, `resume`, `pathToClaudeCodeExecutable`.
- §2 `SDKMessage` union — `system/init` (`sdk.d.ts:5148-5206`), `assistant` (`:3318-3382`), `stream_event`
  (`:4826-4845`), `result` (`:5005-5057`), `rate_limit_event` (`:4924`), `task_started` / `task_notification`
  (`:5261-5295`, `:5210-5234`), `hook_started` / `hook_response`.
- §3 slash commands are plain prompt text; §8.3 `/context` returns a synthetic assistant frame with `context_usage`
  (`SDKContextUsage`, `sdk.d.ts:3468-3532`) and no `local_command_output` frame; §8.4 plugin skills run as normal
  turns with no echo of the expansion.
- §4 `AskUserQuestion` through `canUseTool` — `CanUseTool` (`sdk.d.ts:209-270`), `PermissionResult` (`:2339-2351`),
  `AskUserQuestionInput.answers` (`sdk-tools.d.ts:2571-2576`), output `answers` (`:3690-3695`).
- §5 `PreToolUse` hook — `HookCallback` (`sdk.d.ts:859-861`), `PreToolUseHookInput` (`:2570-2575`),
  `hookSpecificOutput.permissionDecision / updatedInput` (`:2577-2583`, `:8489-8500`) as the sub-agent routing lever;
  `AgentInput {description, prompt, subagent_type?, model?, run_in_background?, …}` (`sdk-tools.d.ts:662-706`).
- §6 usage — `result.usage` (main loop only, `sdk.d.ts:5021-5024`), `result.modelUsage` (includes sub-agents,
  `:5025-5028`, `ModelUsage :1307-1332`), `total_cost_usd`, `task_notification.usage`, `Query.getContextUsage()`.
- §8.1 fields observed but absent from the `.d.ts` (unstable): `init.plugins[].source`, `init.memory_paths`,
  `init.messaging_socket_path`, `init.powershell_path`, `result.subagent_stats`, `assistant.is_meta`,
  `assistant.local_command_source`, `tool_use.caller`.
- §8.8 gotchas for the harness.

Codex — [`codex-shapes.md`](./codex-shapes.md) (+ generated JSON-RPC bindings under
`docs/spikes/codex-app-server-schema/v0.153.4-ts/`, regenerate with `codex app-server generate-ts --experimental --out <dir>`):

- §0 which binary the SDK spawns (bundled 0.153.4, never the installed 0.139.0 unless `codexPathOverride`) and the
  0.139.0 → 0.153.4 protocol drift.
- §1 SDK — `CodexOptions {codexPathOverride?, apiKey?, config?, env?}` (`index.d.ts:218-240`; `env` replaces
  `process.env`), `ThreadOptions` (`:246-260`), `ApprovalMode` (`:242`), `TurnOptions` (`:169-174`), `ThreadEvent`
  union (`:107-167`), `Usage` (`:120-131`), `run()` throws on `turn.failed` (`dist/index.js:118`), spawn without
  `windowsHide` (`dist/index.js:263-266`).
- §2 app-server — JSONL framing without `"jsonrpc"` (`v0.153.4-json/JSONRPCMessage.json`), handshake
  (`InitializeParams.ts`, `InitializeResponse.ts`), `thread/start` / `turn/start` params and responses
  (`v2/ThreadStartParams.ts:18-76`, `v2/TurnStartParams.ts:20-122`, `v2/UserInput.ts:7`), per-turn notifications
  (`ServerNotification.ts:89`, `v2/AgentMessageDeltaNotification.ts:5`), server → client requests
  (`ServerRequest.ts:20`; `v2/CommandExecutionRequestApprovalParams.ts:13-72`; decisions
  `v2/CommandExecutionApprovalDecision.ts:7`), discovery responses (`v2/SkillMetadata.ts`, `v2/Model.ts`,
  `v2/McpServerStatus.ts`, `v2/ConfigReadResponse.ts`, `v2/HooksListEntry.ts`).
- §3 sign-in state and how the app should probe it; §4 usage locations; §5 the probe's own verdict table.

## 4. Usage observed

Claude, this run (`result.usage` / `result.modelUsage` / `total_cost_usd`, model `claude-sonnet-5`, 1M window;
parentheses = all-models totals including the sub-agent):

| step | turns | ms | input | output | cache_creation | cache_read | total_cost_usd |
| --- | --- | --- | --- | --- | --- | --- | --- |
| a `pong` (partial messages) | 1 | 4 406 | 2 | 4 | 15 749 | 20 742 | 0.0672 |
| b `ok` (streaming input + control requests) | 1 | 3 779 | 2 | 4 | 15 749 | 20 742 | 0.0672 |
| c `/context` | 0 | 478 | 0 | 0 | 0 | 0 | 0 |
| d `/cockpit:pilot what's next` | 5 | 30 237 | 8 | 1 390 | 22 948 | 141 321 | 0.1340 |
| e `AskUserQuestion` | 2 | 7 033 | 4 | 127 | 16 060 | 60 057 | 0.0775 |
| f Task hook + sub-agent | 2 | 18 884 | 4 (8) | 254 (423) | 16 244 (50 672) | 57 252 (89 700) | 0.1732 |
| **total** | | 64 817 | | | | | **0.5191** |

- `total_cost_usd` is the API-equivalent price; the account bills against the Claude Max plan (`apiKeySource "none"`).
- The probe's first run (21:46, cold cache) paid 33 216 cache-write tokens and $0.1329 for step a with zero cache
  reads; this run read 20 742 tokens from cache on its very first request — the 1-hour ephemeral prefix cache
  (`cache_creation.ephemeral_1h_input_tokens`) survives across processes, so one streaming-input session per agent
  keeps `cache_read` high (R24) and even cold starts reuse the system-prompt prefix.
- The fixed per-request prefix on this machine is ~21 k tokens plus 89 066 deferred tokens of claude.ai connector MCP
  tools (131 tools) and 8 467 of skills (`/context` above) — the levers for R26 are `settingSources`, `strictMcpConfig`,
  `tools`, and per-agent skill curation.
- `result.usage` is main-loop only; `result.modelUsage` (+ `task_notification.usage`, the Task `tool_use_result`
  `totalTokens`) is what usage meters must sum. `rate_limit_event.rate_limit_info.unifiedWindows.five_hour /
  seven_day.utilization` carries plan-window utilisation (probe run observed 0.39 / 0.16).

Codex: no tokens were observed — every turn failed with `codexErrorInfo:"unauthorized"` before the model was reached
(SDK `usage: null`; no `thread/tokenUsage/updated`; `account/rateLimits/read` → 401). Where they will appear: SDK
`turn.completed.usage {input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens,
reasoning_output_tokens}`; app-server `thread/tokenUsage/updated {threadId, turnId, tokenUsage:{total, last,
modelContextWindow}}` with `TokenUsageBreakdown {totalTokens, inputTokens, cachedInputTokens, cacheWriteInputTokens,
outputTokens, reasoningOutputTokens}`, `account/usage/read`, `account/rateLimits/read|updated` (codex-shapes.md §4).

## 5. Fallback for every non-PASS capability

| Capability | Root cause | Concrete fallback / plan |
| --- | --- | --- |
| #8 `codex-auth` FAIL | ChatGPT refresh token dead (`invalid_refresh_token`) | **User action, cannot be automated and must not be done by the app on the user's behalf:** `codex logout` then `codex login` in a visible console (browser OAuth), then `corepack pnpm spike --only codex`. **App design (R3, SPEC §Edge cases):** the setup panel probes sign-in with `account/read {refreshToken:true}` (`account:null` ⇒ needs sign-in) — not `codex login status` / `getAuthStatus`, which only report the auth *mode* and still say "Logged in" now; a needs-sign-in card whose button runs `codex login` in a visible console — the ConPTY-driven piece (node-pty terminal pane, or a plain console window). **Alternative credential path [assumed, untested]:** `new Codex({apiKey})` → env `CODEX_API_KEY` (codex-shapes.md §1) with an OpenAI key from Settings ▸ API keys (safeStorage); whether app-server honours the same env is untested. |
| #9 `sdk-runStreamed-pong` FAIL | blocked by #8 | No protocol fallback needed: spawn, stdin prompt, JSONL events, thread id and rollout file all worked. Harness plan: app-server is the primary Codex transport; the SDK (`codex exec --experimental-json`) stays for fire-and-forget runs (automations, review jobs) with `approvalPolicy "never"/"on-failure"` and a full cleaned env passed via `CodexOptions.env`; a ConPTY-driven `codex` TUI in a terminal pane (Phase 10 Terminal attach) is the last resort for interactive use only, never for structured events. Re-run after sign-in; `sdk-resumeThread` then runs automatically. |
| #10 `sdk-command-approval` PARTIAL (by design) | `TurnOptions`/`ThreadOptions` expose no approval callback; `exec` is non-interactive; 0.153.4 rejects `approval_policy="untrusted"` | **PARTIAL-with-fallback:** approvals go through the app-server (`item/commandExecution/requestApproval` → `{decision:"accept"\|"acceptForSession"\|"decline"\|"cancel"\|…}`, `item/fileChange/requestApproval`, `item/tool/requestUserInput`) — capability #12. Always pass `approvalsReviewer:"user"` on `thread/start` (or `-c approvals_reviewer="user"` for exec) because the user's `config.toml` sets `approvals_reviewer = "auto_review"`, which would let a review sub-agent decide instead of the client. |
| #11 `appserver-thread-turn-stream` FAIL | blocked by #8 | Protocol proven up to the model call: `initialize` / `initialized` / `thread/start` / `turn/start` and the notification order above. After sign-in expect `item/agentMessage/delta` and `thread/tokenUsage/updated` (codex-shapes.md §2). If app-server ever regresses (it is experimental; pin 0.153.4 in COMPAT.md): `@openai/codex-sdk` `runStreamed` for streaming (PLAN.md risk 2) + ConPTY TUI for interactive use. `appserver-thread-resume` runs automatically once #11 passes. |
| #12 `appserver-command-approval` FAIL | blocked by #8 | `thread/start` already accepted `approvalPolicy:"untrusted"` + `sandbox:"workspace-write"` and `approvalsReviewer:"user"`; `windowsSandbox/readiness` → `{status:"ready"}`; the client handler answers `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` and legacy `execCommandApproval`. Durable trigger if `untrusted` is ever dropped from `thread/start` (it already is from `exec`): `on-request` + `read-only` + a sandbox-blocked write (attempt 3). Re-run after sign-in. |
| Slash menu (PLAN.md risk 1) | Claude: list only exists once a session process has emitted `system/init`; Codex: no protocol method | Claude: `init.slash_commands` + `supportedCommands()` while a session runs; a **file-derived list** (`~/.claude/commands`, `<repo>/.claude/commands`, `~/.claude/plugins/installed_plugins.json` + each plugin's `commands/` and `skills/`) for the composer before the first query. Codex: **static + file-derived list** — `skills/list` (54 entries with `name, description, path, scope, enabled`) plus a static map of the TUI commands to protocol calls (`/review` → `review/start`, `/compact` → `thread/compact/start`, `/model` → `model/list` + `turn/start.model`, MCP → `mcpServerStatus/list`, plugins → `plugin/*`). |

## 6. Warnings carried into the harness phase

1. Claude sub-agent tool is `Agent` on the wire (`tool_use.name`, hook `tool_name`, `hook_name "PreToolUse:Agent"`) while `init.tools` lists `Task`; register matchers as `'Task|Agent'`.
2. `AskUserQuestion` is absent from `init.tools` yet callable, and reaches `canUseTool` under `bypassPermissions`; ordinary permission cards need `permissionMode "default"/"auto"` + `canUseTool`, or a `PreToolUse` hook.
3. `settingSources: ['user','project']` runs the user's `~/.claude/settings.json` PowerShell command hooks on every event and loads every claude.ai connector MCP server (131 tools, 89 k deferred tokens); whether `strictMcpConfig` removes `claudeai-proxy` servers is untested.
4. Pass `Options.model` explicitly — the user's settings pick `sonnet`, the account default is `claude-opus-5[1m]`.
5. Control requests (`initializationResult`, `supportedCommands`, …) were only verified in streaming-input mode (stdin held open); the string-prompt form was not tested for them.
6. `codex login status` prints "Logged in using ChatGPT" even with a dead token; probe with `account/read {refreshToken:true}`.
7. `@openai/codex-sdk` always spawns its bundled 0.153.4 (never the installed 0.139.0) and without `windowsHide`; its `env` option replaces `process.env` wholesale — pass a complete cleaned env; prefer app-server (spawned by us with `windowsHide`) for interactive sessions.
8. app-server threads are recorded with `source:"vscode"` regardless of `clientInfo`; identify capygen threads by cwd or a local store of ids.
9. `model/list` returns a static catalogue while the online refresh 401s (gpt-6-astra / gpt-5.6-* on 0.153.4) — authoritative only once signed in. `app/list` fails with a Cloudflare challenge from this network independently of auth.
10. Root `package.json` scripts must call `corepack pnpm …`: bare `pnpm` is not on PATH here (the user runs pnpm through corepack without `corepack enable`); `spike` was fixed this way, `test` / `typecheck` still use bare `pnpm`.
11. `docs/spikes/codex-app-server-schema/` (12 MB, four generated bundles) is untracked; keep only `v0.153.4-ts` (or gitignore the `*-json` bundles) before committing.

## 7. Files

| Path | Role |
| --- | --- |
| `packages/engine/scripts/spike-engine.ts` | consolidated runner (`corepack pnpm spike`; `--only claude,codex`, `--claude-steps`, `--codex-only`, `--codex-bin`, `SPIKE_TIMEOUT_MS`) |
| `packages/engine/scripts/spike-claude.ts` | Claude probe (7 capabilities; `SPIKE_STEPS=a,b,c,d,e,f`, `SPIKE_CLAUDE_EXE`) |
| `packages/engine/scripts/spike-codex.ts` | Codex probe (auth + 5 checks + 2 sub-checks; `--only`, `--bin`, `--raw`) |
| `docs/spikes/claude-sdk-shapes.md`, `docs/spikes/codex-shapes.md` | shapes with `.d.ts` / binding citations and observed frames |
| `docs/spikes/engine.spike.log`, `docs/spikes/engine.raw.json` | this runner's transcript and structured verdicts (gitignored) |
| `docs/spikes/claude.raw.json`, `docs/spikes/codex.raw.json`, `docs/spikes/codex-0.139.0-discovery.raw.json` | redacted raw streams (gitignored) |
