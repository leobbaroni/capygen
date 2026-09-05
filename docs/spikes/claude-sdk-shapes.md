# Claude Agent SDK — shapes capygen relies on (Phase 1 spike)

Package: `@anthropic-ai/claude-agent-sdk@0.3.261` (bundles Claude Code `2.1.261`, see
`packages/engine/node_modules/@anthropic-ai/claude-agent-sdk/package.json` `"claudeCodeVersion"`).
All citations below are to files under `packages/engine/node_modules/@anthropic-ai/claude-agent-sdk/`
(read 2026-09-05): `sdk.d.ts` (8804 lines), `sdk-tools.d.ts` (4134 lines, generated tool input/output
schemas), `agentSdkTypes.d.ts` (a one-liner: `export * from './sdk.js'`), `README.md` (65 lines — install,
`bun build --compile` note, migration link; no API reference).

Spike script: `packages/engine/scripts/spike-claude.ts`. Raw stream log: `docs/spikes/claude.raw.json`
(gitignored). Observed-shape sections at the end of this file are copied from that log.

Machine facts that matter: `claude` on PATH is `C:\Users\TugaPlayz\.local\bin\claude.exe` 2.1.261; the SDK
also ships its own `claude.exe` (218 MB) in `@anthropic-ai/claude-agent-sdk-win32-x64@0.3.261` and uses it
when `pathToClaudeCodeExecutable` is not set (`sdk.d.ts:1824`). User plugins installed under
`~/.claude/plugins` (`installed_plugins.json`): `cockpit@cockpit` 3.0.0, `maestro@cockpit` 5.0.0,
`hyperframes@claude-plugins-official` 0.8.4. `~/.claude/settings.json` sets `model: "sonnet"`,
`permissions.defaultMode: "auto"`, `outputStyle: "Concise"` and a PowerShell command hook on eleven events
(`UserPromptSubmit, Stop, StopFailure, PreToolUse(*), PostToolUse(*), PostToolUseFailure(*),
PermissionRequest(*), SessionStart, SubagentStart, SubagentStop, TeammateIdle`) — all of these load when
`settingSources` includes `'user'`.

## 1. `query()` and `Options`

`sdk.d.ts:2953-2956`:

```ts
export declare function query(_params: {
    prompt: string | AsyncIterable<SDKUserMessage>;
    options?: Options;
}): Query;
```

`Query extends AsyncGenerator<SDKMessage, void>` (`sdk.d.ts:2601`) and carries control requests
(`interrupt`, `setPermissionMode`, `setModel`, `initializationResult`, `supportedCommands`,
`supportedModels`, `supportedAgents`, `mcpServerStatus`, `getContextUsage`, `accountInfo`,
`setMcpServers`, `streamInput`, `stopTask`, `backgroundTasks`, `close`, …) — `sdk.d.ts:2601-2951`. The
header comment says control requests "are only supported when streaming input/output is used"
(`sdk.d.ts:2602-2606`); the string-prompt form closes stdin after the prompt (`perTaskStopAffordance`
doc, `sdk.d.ts:1662-1663`: "a one-shot run (the string `prompt` form and `-p`, which close stdin)";
field itself `:1672`).

`Options` (`sdk.d.ts:1396-2279`) — the members capygen uses. Citations below point to each field's
own declaration line, or the field's full span when the declaration itself is multi-line (verified
by grepping the member name in the installed `.d.ts` and reading the surrounding block — the
previous version of this table cited a mix of stale and off-by-N-line ranges, corrected here):

| Option | Type | Citation | Notes |
|---|---|---|---|
| `cwd` | `string` | `sdk.d.ts:1463` | defaults to `process.cwd()` |
| `permissionMode` | `PermissionMode` = `'default' \| 'acceptEdits' \| 'bypassPermissions' \| 'plan' \| 'dontAsk' \| 'auto'` | `sdk.d.ts:1833`, type `sdk.d.ts:2317` | |
| `allowDangerouslySkipPermissions` | `boolean` | `sdk.d.ts:1845` | must be `true` with `'bypassPermissions'` |
| `permissionPrompts` | `'host' \| 'none'` | `sdk.d.ts:1859` | `'none'` ⇒ `canUseTool` never called |
| `canUseTool` | `CanUseTool` | `sdk.d.ts:1454`, type `sdk.d.ts:209-269` | see §4 |
| `hooks` | `Partial<Record<HookEvent, HookCallbackMatcher[]>>` | `sdk.d.ts:1595` | see §5 |
| `includeHookEvents` | `boolean` | `sdk.d.ts:1720` | emits `hook_started/hook_progress/hook_response` |
| `mcpServers` | `Record<string, McpServerConfig>` | `sdk.d.ts:1802`; `McpServerConfig` union `sdk.d.ts:1110` (stdio `:1209`, sse `:1192`, http `:1073`, sdk `:1090`) | |
| `strictMcpConfig` | `boolean` | `sdk.d.ts:2134` | ignore `.mcp.json`/user/plugin MCP |
| `settingSources` | `SettingSource[]` = `('user' \| 'project' \| 'local')[]` | `sdk.d.ts:2085`, type `sdk.d.ts:8273` | omitted ⇒ all; `[]` ⇒ isolation; must include `'project'` for CLAUDE.md |
| `plugins` | `SdkPluginConfig[]` = `{ type: 'local'; path: string; skipMcpDiscovery?: boolean }[]` | `sdk.d.ts:1874`, `SdkPluginConfig` `sdk.d.ts:4883-4896` | `pluginDelivery: 'argv' \| 'initialize'` `sdk.d.ts:1889` (initialize form avoids the 32 767-char Windows command-line cap) |
| `skills` | `string[] \| 'all'` | `sdk.d.ts:2108` | |
| `model` | `string` | `sdk.d.ts:1807` | examples `'claude-sonnet-5'`, `'claude-opus-4-8'`, `'claude-fable-5'`; `fallbackModel` `sdk.d.ts:1549` |
| `resume` | `string` (session id) | `sdk.d.ts:1925` | `resumeSessionAt` `sdk.d.ts:1939`, `resumeDropsTurn` `sdk.d.ts:1990`, `forkSession` `sdk.d.ts:1574`, `sessionId` `sdk.d.ts:1931` |
| `continue` | `boolean` | `sdk.d.ts:1459` | mutually exclusive with `resume` |
| `env` | `{ [k: string]: string \| undefined }` | `sdk.d.ts:1525-1527` | **replaces** the child env entirely — spread `process.env` yourself |
| `pathToClaudeCodeExecutable` | `string` | `sdk.d.ts:1824` | |
| `executable` / `executableArgs` | `'bun' \| 'deno' \| 'node'` / `string[]` | `sdk.d.ts:1532` / `sdk.d.ts:1536` | |
| `spawnClaudeCodeProcess` | `(o: SpawnOptions) => SpawnedProcess` | `sdk.d.ts:2278`, `SpawnOptions` `sdk.d.ts:8364-8398`, `SpawnedProcess` `sdk.d.ts:8312-8359` | custom spawn (e.g. `windowsHide`) — not exercised by the spike [untested] |
| `includePartialMessages` | `boolean` | `sdk.d.ts:1725` | emits `stream_event` |
| `forwardSubagentText` | `boolean` | `sdk.d.ts:1732` | subagent text/thinking as messages with `parent_tool_use_id` |
| `maxTurns` | `number` | `sdk.d.ts:1772` | |
| `maxBudgetUsd` | `number` | `sdk.d.ts:1777` | result subtype `error_max_budget_usd` |
| `thinking` | `ThinkingConfig` = `{type:'adaptive', display?}` \| `{type:'enabled', budgetTokens?, display?}` \| `{type:'disabled'}` | `sdk.d.ts:1745`, `ThinkingConfig` `sdk.d.ts:8572` (variants `ThinkingAdaptive` `:8564-8567`, `ThinkingEnabled` `:8584-8588`, `ThinkingDisabled` `:8577-8579`) | supersedes deprecated `maxThinkingTokens` `sdk.d.ts:1767` |
| `effort` | `EffortLevel` = `'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'` | `sdk.d.ts:1758`, type `sdk.d.ts:591` | |
| `systemPrompt` | `string \| string[] \| {type:'custom',prompt,snapshot?} \| {type:'preset',preset:'claude_code',append?,excludeDynamicSections?,snapshot?}` | `sdk.d.ts:2237-2247` | `snapshot: true` recommended for cache stability (R24-relevant); `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` `sdk.d.ts:8513` |
| `agents` / `agent` | `Record<string, AgentDefinition>` / `string` | `sdk.d.ts:1441` / `sdk.d.ts:1425`, `AgentDefinition` `sdk.d.ts:38-100` | programmatic subagents |
| `tools` / `allowedTools` / `disallowedTools` / `toolAliases` | | `sdk.d.ts:1505-1508` / `sdk.d.ts:1449` / `sdk.d.ts:1469` / `sdk.d.ts:1495` | |
| `outputFormat` | `{ type: 'json_schema'; schema }` | `sdk.d.ts:1820`, `JsonSchemaOutputFormat` `sdk.d.ts:968` | structured output |
| `persistSession` | `boolean` | `sdk.d.ts:1680` | `false` ⇒ no `~/.claude/projects` transcript |
| `settings` / `managedSettings` | `string \| Settings` | `sdk.d.ts:2050` / `sdk.d.ts:2074` | flag-layer settings |
| `abortController` | `AbortController` | `sdk.d.ts:1397-1401` | |
| `stderr` / `debug` / `debugFile` | callback / bool / path | `sdk.d.ts:2126` / `sdk.d.ts:2116` / `sdk.d.ts:2121` | |
| `toolConfig.askUserQuestion.previewFormat` | `'markdown' \| 'html'` | `sdk.d.ts:1569`, `ToolConfig` `sdk.d.ts:8600-8615`, `previewFormat` field `sdk.d.ts:8612` | HTML previews for web UIs |
| `promptSuggestions`, `agentProgressSummaries`, `perTaskStopAffordance`, `onUserDialog`, `onElicitation` | | `sdk.d.ts:1910`, `sdk.d.ts:1920`, `sdk.d.ts:1672`, `sdk.d.ts:1630`, `sdk.d.ts:1616` | |

Env handling observed in `sdk.mjs` (minified): `rn = J ? {...J} : {...process.env}` then it sets
`CLAUDE_CODE_ENTRYPOINT="sdk-ts"` and `CLAUDE_AGENT_SDK_VERSION="0.3.261"` when absent (grep of
`sdk.mjs` for `CLAUDE_CODE_ENTRYPOINT="sdk-ts"`). CLI args it builds: `--output-format stream-json
--verbose --input-format stream-json` always, then `--permission-mode`,
`--allow-dangerously-skip-permissions`, `--setting-sources=<a,b>`, `--mcp-config <json>`,
`--strict-mcp-config`, `--plugin-dir`, `--max-turns`, `--model`, `--thinking`, `--effort`, `--resume`,
`--continue`, `--include-partial-messages`, `--include-hook-events`, `--await-initialize`, … (string
literals grepped from `sdk.mjs`).

## 2. `SDKMessage` union

`sdk.d.ts:4681` — 39 members. The ones capygen renders:

- **`SDKSystemMessage`** (`type:'system', subtype:'init'`) `sdk.d.ts:5148-5208`: `agents?: string[]`,
  `apiKeySource: ApiKeySource` (`:127`: `'ANTHROPIC_API_KEY' | 'apiKeyHelper' | '/login managed key' | 'none' | …`),
  `betas?`, `claude_code_version: string`, `cwd: string`, `tools: string[]`,
  `mcp_servers: {name, status}[]`, `model: string`, `permissionMode`, **`slash_commands: string[]`**,
  `terminal_slash_commands?: string[]`, `output_style: string`, **`skills: string[]`**,
  **`plugins: {name, path, version?}[]`**, `fast_mode_state?`, `effort?: EffortLevel | null`,
  `capabilities?: string[]` (feature detection: `'interrupt_receipt_v1'`, `'interrupt_cancel_queued_v1'`,
  `'queued_notifications'`), `uuid`, `session_id`. Emitted "at the start of each turn" (`:5145-5147`).
- **`SDKAssistantMessage`** (`type:'assistant'`) `sdk.d.ts:3318-3382`: `message: BetaMessage` (Anthropic
  Messages API shape: `id, model, role, content[], stop_reason, usage`), `parent_tool_use_id: string | null`
  (non-null ⇒ subagent frame), `error?: SDKAssistantMessageError` (type `:3384`), `uuid`, `session_id`,
  `request_id?`, `subagent_type?`, `task_description?`, `timestamp?`, **`context_usage?: SDKContextUsage`**
  (field+comment `:3364-3367`, only on `/context` results; type `:3468-3529`).
- **`SDKUserMessage`** (`type:'user'`) `sdk.d.ts:5365-5414`: `message: MessageParam`
  (`{role:'user', content: string | block[]}`), `parent_tool_use_id`, `isSynthetic?`,
  **`tool_use_result?: unknown`** (the tool's full Output object; for Task it is the subagent's final report +
  run totals, field+comment `:5373-5376`), `shouldQuery?`, `uuid?`, `session_id?`. `SDKUserMessageReplay`
  (`:5416`) is the same plus `isReplay: true`.
- **`SDKPartialAssistantMessage`** (`type:'stream_event'`) `sdk.d.ts:4826-4844`:
  `event: BetaRawMessageStreamEvent` (`message_start | content_block_start | content_block_delta |
  content_block_stop | message_delta | message_stop`), `parent_tool_use_id`, `uuid`, `session_id`, `ttft_ms?`.
- **`SDKResultMessage`** = `SDKResultSuccess | SDKResultError` `sdk.d.ts:5003`. Success `:5005-5054`:
  `subtype:'success'`, `duration_ms`, `duration_api_ms`, `ttft_ms?`, `is_error`, `num_turns`,
  **`result: string`** (`:5026`), `stop_reason`, **`total_cost_usd`** (field+comment `:5028-5031`),
  **`usage: NonNullableUsage`** (main loop only, field+comment `:5032-5035`; keys are the Messages API
  `BetaUsage` keys: `input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, …`
  `:1334-1336`), **`modelUsage: Record<string, ModelUsage>`** ("the correct field for token/cost
  accounting", field+comment `:5036-5039`; `ModelUsage` `:1307-1332`: `inputTokens, outputTokens,
  thinkingTokens?, cacheReadInputTokens, cacheCreationInputTokens, webSearchRequests, costUSD,
  contextWindow, maxOutputTokens, canonicalModel?, provider?, costBasis?`), `permission_denials:
  SDKPermissionDenial[]` (field `:5041`; type `:4846-4850`), `structured_output?` (`:5046`), `terminal_reason?`
  (field `:5048`; type `:8559`), `uuid`, `session_id`. Error `:4957-4998`: `subtype: 'error_during_execution' |
  'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries'`, same usage fields,
  `errors: string[]`. Exactly one result per turn; it is the turn-complete signal (comment `:5000-5001`
  on the `SDKResultMessage` union, immediately above `:5003`).
- **System subtypes** (all `type:'system'`): `status` (`:5133`, `status: 'compacting'|'requesting'|null`),
  `compact_boundary` (`:3430`), `local_command_output` (`:4621`, `content: string` — "output from a local
  slash command (e.g. /voice, /usage)"), `informational` (`:4591`, `content, level`), `notification`
  (`:4811`), `hook_started/hook_progress/hook_response` (`:4578/:4550/:4563`: `hook_id, hook_name,
  hook_event, output, stdout, stderr, outcome`), `task_started` (`:5261-5295`: `task_id, tool_use_id?,
  description, subagent_type?, is_backgrounded?, spawn_depth?, task_type?, prompt?`), `task_progress`
  (`:5236`), `task_updated` (`:5297`, `patch.status`), `task_notification` (`:5210-5234`: `task_id,
  tool_use_id?, status, output_file, summary, usage?{total_tokens,tool_uses,duration_ms}`),
  `permission_denied` (`:4855`), `thinking_tokens` (`:5319`), `plugin_install` (`:4901`),
  `commands_changed` (`:3422`), `api_retry` (`:3296`), `rate_limit_event` (`:4924`).
- `SDKToolUseSummaryMessage` (`type:'tool_use_summary'`, `:5353`), `SDKPromptSuggestionMessage` (`:4914`),
  `SDKAuthStatusMessage` (`:3386`).

`SDKControlInitializeResponse` (`Query.initializationResult()`, `sdk.d.ts:4035-4070`): `commands:
SlashCommand[]`, `agents: AgentInfo[]`, `output_style`, `available_output_styles`, `models: ModelInfo[]`,
`account: AccountInfo` (`:23-33`: `email?, organization?, subscriptionType?, tokenSource?, apiKeySource?,
apiProvider?`), `hooks_applied?`, `plugins_applied?`. `SlashCommand` (`:8288-8305`): `{ name, description,
argumentHint, aliases? }` — `name` has no leading slash.

## 3. Sending a slash command

There is no dedicated API: a slash command is the prompt text. `AgentDefinition.initialPrompt` doc:
"Slash commands are processed" (`sdk.d.ts:68-71`); `SDKLocalCommandOutputMessage` doc: "Output from a local
slash command (e.g. /voice, /usage)" (`:4618-4620`); `SDKAssistantMessage.context_usage` doc: "carried on
the synthetic assistant message that delivers the [/context] markdown table" (`:3364-3367`). So:

```ts
query({ prompt: '/context', options })                         // string form
// or, streaming form:
yield { type: 'user', message: { role: 'user', content: '/cockpit:pilot what\'s next' }, parent_tool_use_id: null }
```

Skill/plugin commands are `<plugin>:<skill>` in `slash_commands` (see observed §8). The CLI expands the
command into the model's first turn itself; the stream does **not** echo an expanded user message — the
first frame after `init` is the assistant's first `tool_use` (observed §8.4). Built-in local commands such
as `/context` never hit the model: `num_turns: 0`, `total_cost_usd: 0`, and the reply is a synthetic
assistant message (`message.model: "<synthetic>"`, `is_meta: true`, `local_command_source`, §8.3).

## 4. `AskUserQuestion` through `canUseTool`

`CanUseTool` (`sdk.d.ts:209-269`):

```ts
(toolName: string, input: Record<string, unknown>, options: {
    signal: AbortSignal; suggestions?: PermissionUpdate[]; blockedPath?: string; decisionReason?: string;
    title?: string; displayName?: string; description?: string; toolUseID: string; agentID?: string;
    requestId: string; matchedAskRule?: {...};
}) => Promise<PermissionResult | null>
```

`PermissionResult` (`sdk.d.ts:2339-2351`):

```ts
{ behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: PermissionUpdate[];
  toolUseID?: string; decisionClassification?: 'user_temporary'|'user_permanent'|'user_reject' }
| { behavior: 'deny'; message: string; interrupt?: boolean; toolUseID?; decisionClassification? }
```

`AskUserQuestionInput` (`sdk-tools.d.ts:1026-2602`): `questions: [{ question: string; header: string
(≤12 chars); options: [{ label; description; preview? }, …2-4]; multiSelect: boolean }, …1-4]`,
**`answers?: { [k: string]: string }`** — "User answers collected by the permission component"
(field `sdk-tools.d.ts:2575-2577`), `annotations?`, `metadata?`. `AskUserQuestionOutput`
(`sdk-tools.d.ts:3665-3851`): `questions`, **`answers: { [k: string]: string }`** — "question text ->
answer string; multi-select answers are comma-separated" (field `:3825-3827`), `response?: string` (freeform),
`annotations?`, `afkTimeoutMs?`.

So the host answers a question by returning
`{ behavior: 'allow', updatedInput: { ...input, answers: { [question.question]: option.label } } }` from
`canUseTool` — the tool then completes with those answers as its output. Wire form on the CLI side is the
`can_use_tool` control request (`SDKControlPermissionRequest`, `sdk.d.ts:4202-4245`: `tool_name, input,
permission_suggestions?, blocked_path?, decision_reason?, decision_reason_type?, title?, display_name?,
tool_use_id, agent_id?, description?, requires_user_interaction?` — AskUserQuestion sets the last one,
field+comment `:4241-4244`). Observed behaviour (which `permissionMode` still routes it to `canUseTool`)
is in §8.

## 5. Hooks — `PreToolUse` on `Task`

`HookCallback` (`sdk.d.ts:859-861`): `(input: HookInput, toolUseID: string | undefined, options: { signal })
=> Promise<HookJSONOutput>`. Registered as `hooks: { PreToolUse: [{ matcher?: string; hooks: HookCallback[];
timeout?: number }] }` (`HookCallbackMatcher`, `:866-871`; `matcher` is a tool-name regex, e.g. `'Task'`).

`PreToolUseHookInput` (`sdk.d.ts:2570-2575`) = `BaseHookInput & { hook_event_name: 'PreToolUse';
tool_name: string; tool_input: unknown; tool_use_id: string }`. `BaseHookInput` (`:167-193`):
`session_id, transcript_path, cwd, prompt_id?, permission_mode?, agent_id?` (present only inside a
subagent), `agent_type?`, `effort?: { level }`.

Return value `HookJSONOutput` = `AsyncHookJSONOutput ({async:true, asyncTimeout?}) | SyncHookJSONOutput`
(`:877`, `:129-132`, `SyncHookJSONOutput` `:8489-8503`): `{ continue?, suppressOutput?, stopReason?,
decision?: 'approve'|'block', systemMessage?, reason?, hookSpecificOutput?: PreToolUseHookSpecificOutput }`
where `PreToolUseHookSpecificOutput` (`:2577-2583`) = `{ hookEventName: 'PreToolUse'; permissionDecision?:
'allow'|'deny'|'ask'|'defer'; permissionDecisionReason?; updatedInput?: Record<string, unknown>;
additionalContext? }`. Returning `{}` allows. **Routing lever for capygen (SPEC R12):** `updatedInput`
lets the hook rewrite the Task tool's input — `AgentInput` (`sdk-tools.d.ts:662-699`): `description,
prompt, subagent_type?, model?: 'sonnet'|'opus'|'haiku'|'fable', run_in_background?, name?, isolation?:
'worktree'|'remote'` — e.g. force `model` per routing policy, or `permissionDecision: 'deny'` to reroute to
another backend.

**Tested (capability `routing_lever`, step g): the lever works.** A `PreToolUse` hook matching
`'Task|Agent'` returned `{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow',
updatedInput: { ...tool_input, model: 'haiku' } } }` for a spawned sub-agent. Neither `task_started` nor
`task_notification.usage` carries a model field (confirmed absent from both this run's frames and the
`.d.ts`), so the proof is in the final `result.modelUsage` keys: `["claude-sonnet-5",
"claude-haiku-4-5-20251001"]` — a second, haiku-named key with its own nonzero `inputTokens`/`outputTokens`/
`costUSD` exists only because the sub-agent actually billed against that model. Corroborating (undocumented)
evidence: the Task tool's `tool_use_result.resolvedModel` on the completion frame read
`"claude-haiku-4-5-20251001"` (§8.6 shows this same field resolving to `"claude-sonnet-5"` when no override
is applied). **Fallback, if a future SDK version ignores this override:** deny the Task/Agent call from the
hook (`permissionDecision: 'deny'`) and have capygen's own dispatcher re-issue the equivalent work as a
fresh `query()` with `options.model` set directly, rather than depending on the CLI to honour an in-flight
rewrite of a tool it is already committed to running.

Related: `SubagentStartHookInput` (`:8448`: `agent_id, agent_type`), `SubagentStopHookInput` (`:8459`:
`agent_id, agent_transcript_path, agent_type, last_assistant_message?`), `HOOK_EVENTS` (`:854`).

## 6. Usage / cost

Per turn: `result.usage` (main loop only, field+comment `sdk.d.ts:5032-5035`) and `result.modelUsage` (all
models incl. subagents, cumulative within one `query()` in streaming-input sessions — "read the latest
result rather than summing", field+comment `:5036-5039`), `result.total_cost_usd` (field+comment
`:5028-5031`). Per subagent: `task_notification.usage` (`:5218-5222`). Per API response:
`assistant.message.usage` (BetaMessage). Live context: `Query.
getContextUsage({detail:'summary'|'full'})` → `SDKControlGetContextUsageResponse` (`:3638`), and the
`/context` reply's `context_usage` (`SDKContextUsage`, `:3468-3529`: `model, total_tokens, raw_max_tokens,
percentage, over_limit?, categories[{name,tokens,kind:'used'|'free'|'buffer'|'deferred'}], mcp_tools[],
memory_files[], agents[], skills?[]`). Plan limits: `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`
(`:2779-2798`; not exercised by the spike [untested]).

## 7. Spawning from inside a Claude Code session (spike-specific)

The spike runs under a Claude Code session, so the child env is `process.env` minus `CLAUDECODE`,
`CLAUDE_PID`, `CLAUDE_EFFORT`, `CLAUDE_AGENT_SDK_VERSION` and every `CLAUDE_CODE_*`, plus `PYTHONUTF8=1`,
passed via `Options.env` (which replaces the child env wholesale, `sdk.d.ts:1525-1527`). The SDK then
re-adds `CLAUDE_CODE_ENTRYPOINT=sdk-ts` and `CLAUDE_AGENT_SDK_VERSION`. In the app this stripping is
unnecessary (Electron is not a Claude Code session) but harmless [assumed — not exercised from inside
an Electron host by this spike].

## 8. Observed shapes (from `docs/spikes/claude.raw.json`, run 2026-09-05, 108 log entries; §8.9 is
from a later same-day re-run, 139 entries, after the gate fixes below)

Run: `corepack pnpm --dir packages/engine exec tsx scripts/spike-claude.ts` → all 7 `CAP … PASS`, exit 0,
~90 s wall. Every query: `cwd` = repo root, `settingSources: ['user','project']`,
`permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions: true`, SDK-bundled `claude.exe`
(no `pathToClaudeCodeExecutable`), child env = `process.env` minus the nested-session variables (§7).
Model resolved from the user's `settings.json`: `claude-sonnet-5` (1M context). Auth: `apiKeySource:
"none"` (claude.ai OAuth), `accountInfo().subscriptionType: "Claude Max"`, `apiProvider: "firstParty"`.

### 8.1 `system/init` (step a) — fields beyond the `.d.ts`

```json
{"type":"system","subtype":"init","cwd":"C:\\Users\\TugaPlayz\\Desktop\\GITHUB\\capygen","session_id":"aa8b29f7-…",
 "mcp_servers":[{"name":"claude.ai Higgsfield","status":"connected"},{"name":"claude.ai Gmail","status":"connected"},
                {"name":"claude.ai Context7","status":"connected"},{"name":"claude.ai Microsoft 365","status":"needs-auth"}],
 "model":"claude-sonnet-5","permissionMode":"bypassPermissions",
 "terminal_slash_commands":["doctor","color","reload-plugins"],"apiKeySource":"none","claude_code_version":"2.1.261",
 "output_style":"Concise","agents":["claude","Explore","general-purpose","Plan","statusline-setup"],
 "plugins":[{"name":"cockpit","path":"C:\\Users\\TugaPlayz\\.claude\\plugins\\cache\\cockpit\\cockpit\\3.0.0","source":"cockpit@cockpit","version":"3.0.0"},
            {"name":"maestro","path":"…\\maestro\\5.0.0","source":"maestro@cockpit","version":"5.0.0"},
            {"name":"hyperframes","path":"…\\hyperframes\\0.8.4","source":"hyperframes@claude-plugins-official","version":"0.8.4"}],
 "capabilities":["interrupt_receipt_v1","interrupt_cancel_queued_v1","msg_lifecycle_v1"],
 "analytics_disabled":false,"product_feedback_disabled":false,"uuid":"896a7c4e-…",
 "memory_paths":{"auto":"C:\\Users\\TugaPlayz\\.claude\\projects\\C--Users-TugaPlayz-Desktop-GITHUB-capygen\\memory\\"},
 "messaging_socket_path":"\\\\.\\pipe\\LOCAL\\cc-msg-…","fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required",
 "powershell_path":"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
 "slash_commands":[…92…],"tools":[…163…],"skills":[…56…]}
```

Undocumented-in-`.d.ts` extras: `plugins[].source`, `analytics_disabled`, `product_feedback_disabled`,
`memory_paths`, `messaging_socket_path`, `powershell_path`. `slash_commands` (92) = 10 user skills
(`agent-reach … deep-research`) + **31 plugin-qualified** (`cockpit:diagnosing-bugs, cockpit:domain-modeling,
cockpit:grill-with-docs, cockpit:grilling, cockpit:handoff, cockpit:orchestrate, cockpit:pilot, cockpit:setup,
cockpit:test-driven-development, cockpit:using-worktrees, maestro:maestro, hyperframes:*` ×20) + built-in
skills (`dataviz, update-config, verify, debug, code-review, simplify, batch, …`) + built-in commands
(`clear, compact, config, context, effort, init, mcp, model, usage, insights, recap, resume-like
"rename", reload-plugins, reload-skills, …`). Plugin skills appear as slash commands **without a separate
`commands/` dir** (cockpit ships only `skills/`). `skills` (56) = the same names minus commands.
`tools` (163) = 32 built-ins (`Task Bash CronCreate … Skill TaskOutput TaskStop ToolSearch WebFetch WebSearch
Workflow Write`) + 131 `mcp__claude_ai_<Server>__<tool>` from claude.ai-connector MCP servers
(`mcpServerStatus()` shows `config: {type:"claudeai-proxy", url, id}`, `scope: "claudeai"`). Note
**`AskUserQuestion` is not in `tools`** yet the model can call it (§8.5) — do not gate on that list.

`initializationResult()` keys observed: `commands, agents, output_style, available_output_styles, models,
account, pid, current_permission_mode, analytics_disabled, remote_control_auto_enable,
remote_control_available, remote_control_auto_on_by_default, ide_rc_auto_enable_gate, fast_mode_state,
fast_mode_disabled_reason, session_state`. `models` (5): `{value:"default", resolvedModel:"claude-opus-5[1m]",
displayName:"Default (recommended)", description, supportsEffort:true, supportedEffortLevels:["low","medium",
"high","xhigh","max"], supportsAdaptiveThinking:true, supportsFastMode:true, supportsAutoMode:true}`, then
`opus[1m]`, `claude-fable-5-1[1m]`, …. `supportedCommands()` (92) entries: `{"name":"cockpit:pilot",
"description":"(Cockpit) Pilot","argumentHint":""}`, `{"name":"context","description":"Show current context
usage","argumentHint":""}`, `{"name":"usage",…,"aliases":["cost","stats"]}`, `{"name":"clear",…,
"argumentHint":"[name]","aliases":["reset","new"]}`. `supportedAgents()` (5): `{name, description, model?}`.
All six control requests succeeded in streaming-input mode after the `result` (stdin held open); the
string-prompt form was not tested for control requests. [untested]

### 8.2 Text turn (step a): `status` → `stream_event`×7 → `assistant` → `rate_limit_event` → `result`

```json
{"type":"system","subtype":"status","status":"requesting","session_id":"…","uuid":"…"}
{"type":"stream_event","event":{"type":"message_start","message":{"model":"claude-sonnet-5","id":"msg_011Cek…","role":"assistant","content":[],"stop_reason":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":33216,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":33216},"output_tokens":1,"service_tier":"standard"}}},"session_id":"…","parent_tool_use_id":null,"uuid":"…","ttft_ms":992}
{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}},…}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"p"}},…}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ong"}},…}
{"type":"stream_event","event":{"type":"content_block_stop","index":0},…}
{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":2,"cache_creation_input_tokens":33216,"cache_read_input_tokens":0,"output_tokens":4,"output_tokens_details":{"thinking_tokens":0},"iterations":[…]}},…}
{"type":"stream_event","event":{"type":"message_stop"},…}
{"type":"assistant","message":{"model":"claude-sonnet-5","id":"msg_011Cek…","role":"assistant","content":[{"type":"text","text":"pong"}],"stop_reason":null,"usage":{…}},"parent_tool_use_id":null,"session_id":"…","uuid":"…","timestamp":"2026-09-05T20:45:22.408Z","request_id":"req_011Cek…"}
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1788643200,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.39,"resetsAt":1788643200},"seven_day":{"utilization":0.16,"resetsAt":1789192800}}},"uuid":"…","session_id":"…"}
{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"pong","stop_reason":"end_turn","duration_ms":3596,"duration_api_ms":1506,"ttft_ms":2530,"ttft_stream_ms":2049,"time_to_request_ms":1057,"first_content_frame_ms":2049,
 "total_cost_usd":0.132908,
 "usage":{"input_tokens":2,"cache_creation_input_tokens":33216,"cache_read_input_tokens":0,"output_tokens":4,"output_tokens_details":{"thinking_tokens":0},"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":33216,"ephemeral_5m_input_tokens":0},"iterations":[{…}],"speed":"standard"},
 "modelUsage":{"claude-sonnet-5":{"inputTokens":2,"outputTokens":4,"cacheReadInputTokens":0,"cacheCreationInputTokens":33216,"webSearchRequests":0,"costUSD":0.132908,"contextWindow":1000000,"maxOutputTokens":64000,"thinkingTokens":0,"canonicalModel":"claude-sonnet-5","provider":"firstParty","costBasis":"list"}},
 "permission_denials":[],"terminal_reason":"completed","fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required",
 "subagent_stats":{"spawned":0,"requested":{"background":0,"foreground":0,"unset":0},"started_in_background":0,"max_depth":0,"spawned_by_subagents":0,"completed":0,"failed":0,"killed":{"parent":0,"user":0,"system":0},"refused":{"depth_limit":0,"concurrency_limit":0,"budget":0},"by_type":{}},
 "queued_turn_count":0,"api_error_status":null,"session_id":"…","uuid":"…"}
```

`assistant.message.stop_reason` is `null` on the streamed frame (as the `.d.ts` warns); the `result` carries
the real `stop_reason`. `rate_limit_event` (`SDKRateLimitEvent`, `sdk.d.ts:4924`) arrives every turn with
plan-window utilisation — the Usage page (R23) can read `unifiedWindows.five_hour/seven_day.utilization`.
`subagent_stats` on `result` is not in the `.d.ts`. **Cost note (R23–R26):** a one-word reply cost
$0.13 because the first request wrote a 33 216-token cache (system prompt + 163 tool schemas + 56 skill
listings); step b on the same prefix read 20 742 from cache and cost $0.07. The user's claude.ai connector
MCP servers alone are 89 066 deferred tokens (§8.3). Skill/plugin/MCP surface must be curated per agent
(`skills`, `strictMcpConfig`, `tools`) — claude.ai-proxy servers come from the account, whether
`strictMcpConfig` removes them is untested [assumed no].

### 8.3 `/context` (step c) — local command, zero model calls

Frames: `hook_started/hook_response` (user's `SessionStart:startup` hook) → `init` → `assistant` → `result`
(`num_turns: 0`, `total_cost_usd: 0`, `modelUsage: {}`, `duration_ms: 537`).

```json
{"type":"assistant","message":{"id":"d2bceafc-…","model":"<synthetic>","role":"assistant","stop_reason":"end_turn","usage":{"input_tokens":0,"output_tokens":0,…},
   "content":[{"type":"text","text":"## Context Usage\n\n**Model:** claude-sonnet-5  \n**Tokens:** 21.6k / 1m (2%)\n\n### Estimated usage by category\n\n| Category | Tokens | Percentage |\n|…| System prompt | 228 | 0.0% |\n| System tools | 12.2k | 1.2% |\n| MCP tools (deferred) | 89.1k | 8.9% |…"}]},
 "parent_tool_use_id":null,"is_meta":true,"local_command_source":"<local-command-stdout>## Context Usage…","session_id":"…","uuid":"…","timestamp":"…",
 "context_usage":{"model":"claude-sonnet-5","total_tokens":21648,"raw_max_tokens":1000000,"percentage":2,
   "categories":[{"name":"System prompt","tokens":228,"kind":"used"},{"name":"System tools","tokens":12230,"kind":"used"},{"name":"MCP tools (deferred)","tokens":89066,"kind":"deferred"},{"name":"System tools (deferred)","tokens":15076,"kind":"deferred"},{"name":"Memory files","tokens":715,"kind":"used"},{"name":"Skills","tokens":8467,"kind":"used"},{"name":"Messages","tokens":8,"kind":"used"},{"name":"Autocompact buffer","tokens":33000,"kind":"buffer"},{"name":"Free space","tokens":945352,"kind":"free"}],
   "mcp_tools":[{"name":"mcp__claude_ai_Context7__query-docs","server_name":"claude_ai_Context7","tokens":691},…131…],
   "memory_files":[{"path":"C:\\Users\\TugaPlayz\\.claude\\CLAUDE.md","type":"User","tokens":101},{"path":"C:\\Users\\TugaPlayz\\Desktop\\GITHUB\\capygen\\CLAUDE.md","type":"Project","tokens":614}],
   "agents":[],
   "skills":[{"name":"agent-reach","source":"userSettings","tokens":215},…,{"name":"cockpit:grilling","source":"plugin","plugin_name":"cockpit","tokens":132},…,{"name":"dataviz","source":"built-in","tokens":482},…]}}
```

`is_meta` and `local_command_source` are not in the `.d.ts`. `result.result` repeats the markdown.
No `local_command_output` system message was emitted for `/context`.

### 8.4 `/cockpit:pilot what's next` (step d) — plugin skill executed

Frames after `init`: `assistant`×10 (5 `tool_use` + `thinking` blocks + final text), `user`×5 (tool
results), `thinking_tokens`×11, `result` (`num_turns: 6`, 43.5 s, $0.158, `thinkingTokens: 914`). No
expanded user message is echoed; the first assistant frame is already
`tool_use: Bash {"command":"cd \"C:\\Users\\TugaPlayz\\Desktop\\GITHUB\\capygen\" && git log --oneline -5 && … git status --short …"}`
— exactly the pilot skill's "Step 0". Tools used: `Bash, Bash, Bash, Read
(…\cockpit\3.0.0\skills\pilot\nodes\build.md), Bash`. Final text: `"Phase: BUILD — because PLAN.md's
Phase 1 checkbox is still unchecked and PROJECT_LOG's \"Open / next\" points there; …"`. Bash
`tool_use_result` shape: `{"stdout":"…","stderr":"","interrupted":false,"isImage":false,
"noOutputExpected":false}`; Read: `{"type":"text","file":{"filePath","content","numLines":16,"startLine":1,
"totalLines":16}}`. `thinking_tokens`: `{"type":"system","subtype":"thinking_tokens","estimated_tokens":50,
"estimated_tokens_delta":50,…}`.

### 8.5 `AskUserQuestion` (step e) — reaches `canUseTool` even under `bypassPermissions`

The SDK prints `(node:…) [CLAUDE_SDK_CAN_USE_TOOL_SHADOWED] Warning: canUseTool will not be invoked:
permissionMode 'bypassPermissions' auto-approves every tool call (except explicit deny rules) before the
callback is consulted. To gate every tool call, use a PreToolUse hook instead.` — yet AskUserQuestion still
came through (it `requires_user_interaction`), so the `'default'` fallback in the script was never needed.

```json
canUseTool("AskUserQuestion",
  {"questions":[{"question":"Which colour do you prefer?","header":"Colour","options":[{"label":"Red","description":"Choose red"},{"label":"Blue","description":"Choose blue"}],"multiSelect":false}]},
  {"displayName":"AskUserQuestion","toolUseID":"toolu_01SWMwjLUKSJs3VEvYaE1Dwa","requestId":"cb9a9e6b-…","signal":AbortSignal})
→ {"behavior":"allow","updatedInput":{"questions":[…same…],"answers":{"Which colour do you prefer?":"Blue"}}}
```

No `suggestions`, `title` or `description` were present for this tool. Resulting frames:

```json
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_01SWMw…","name":"AskUserQuestion","input":{"questions":[…]},"caller":{"type":"direct"}}],"stop_reason":null,…},…}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01SWMw…","content":"Your questions have been answered: \"Which colour do you prefer?\"=\"Blue\". You can now continue with these answers in mind."}]},"parent_tool_use_id":null,
 "tool_use_result":{"questions":[…],"answers":{"Which colour do you prefer?":"Blue"}},…}
{"type":"assistant","message":{"content":[{"type":"text","text":"Blue"}],…},…}
{"type":"result","subtype":"success","num_turns":2,"result":"Blue","total_cost_usd":0.1609944,…}
```

`tool_use.caller: {"type":"direct"}` is not in the `.d.ts`.

### 8.6 PreToolUse hook + subagent (step f) — the tool is `Agent`, not `Task`

`init.tools` lists `Task`, but the model emits `tool_use.name: "Agent"` and the hook receives
`tool_name: "Agent"` (`hook_name: "PreToolUse:Agent"`). Register the matcher as `'Task|Agent'`.

```json
hook(input={"session_id":"e1bebc20-…","transcript_path":"C:\\Users\\TugaPlayz\\.claude\\projects\\C--Users-TugaPlayz-Desktop-GITHUB-capygen\\e1bebc20-….jsonl","cwd":"C:\\Users\\TugaPlayz\\Desktop\\GITHUB\\capygen","prompt_id":"b67c16f4-…","permission_mode":"bypassPermissions","effort":{"level":"medium"},
            "hook_event_name":"PreToolUse","tool_name":"Agent",
            "tool_input":{"description":"Count .md files","prompt":"Count the number of .md files (non-recursive, just this directory) in C:\\Users\\TugaPlayz\\Desktop\\GITHUB\\capygen and report the number.","run_in_background":false},
            "tool_use_id":"toolu_01FJWHvB8YdhbEspKNqQbcRM"},
     toolUseID="toolu_01FJWHvB8YdhbEspKNqQbcRM") → {}
```

With `includeHookEvents: true` the stream shows the SDK hook as
`{"type":"system","subtype":"hook_started","hook_id":"84db4830-…","hook_name":"PreToolUse:Agent","hook_event":"PreToolUse",…}` /
`{"subtype":"hook_response",…,"output":"{}\r\n","stdout":"{}\r\n","stderr":"","exit_code":0,"outcome":"success"}` — and the
user's own settings hooks alongside it (`SessionStart:startup`, `UserPromptSubmit`, `PreToolUse:Bash`, …;
9 started/9 responses in this step). Subagent lifecycle frames:

```json
{"type":"system","subtype":"task_started","task_id":"aaab96c9f5e991ce6","tool_use_id":"toolu_01FJWH…","description":"Count .md files","subagent_type":"general-purpose","is_backgrounded":false,"spawn_depth":1,"task_type":"local_agent","prompt":"Count the number of .md files …",…}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Count the number of .md files …"}]},"parent_tool_use_id":"toolu_01FJWH…","subagent_type":"general-purpose","task_description":"Count .md files",…}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_01L2iN…","name":"Bash","input":{"command":"cd \"C:\\…\\capygen\" && ls *.md 2>/dev/null | wc -l","description":"Count .md files in capygen root directory"}}]},"parent_tool_use_id":"toolu_01FJWH…","subagent_type":"general-purpose",…}
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01L2iN…","type":"tool_result","content":"6","is_error":false}]},"parent_tool_use_id":"toolu_01FJWH…",…}
{"type":"system","subtype":"task_progress","task_id":"aaab96c9f5e991ce6","tool_use_id":"toolu_01FJWH…","description":"Running Count .md files in capygen root directory","subagent_type":"general-purpose","usage":{"total_tokens":32140,"tool_uses":1,"duration_ms":4230},"last_tool_name":"Bash",…}
{"type":"system","subtype":"task_updated","task_id":"aaab96c9f5e991ce6","patch":{"status":"completed","end_time":1788641215535},…}
{"type":"system","subtype":"task_notification","task_id":"aaab96c9f5e991ce6","tool_use_id":"toolu_01FJWH…","status":"completed","output_file":"C:\\Users\\TUGAPL~1\\AppData\\Local\\Temp\\claude\\C--Users-TugaPlayz-Desktop-GITHUB-capygen\\e1bebc20-…\\tasks\\aaab96c9f5e991ce6.output","summary":"There are **6** `.md` files directly in `C:\\…\\capygen` (non-recursive).","usage":{"total_tokens":34113,"tool_uses":1,"duration_ms":10436},…}
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01FJWH…","type":"tool_result","content":[{"type":"text","text":"There are **6** `.md` files …"},{"type":"text","text":"agentId: aaab96c9f5e991ce6 (use SendMessage with to: 'aaab96c9f5e991ce6', …)\n<usage>subagent_tokens: 34118\ntool_uses: 1\nduration_ms: 10437</usage>"}]}]},"parent_tool_use_id":null,
 "tool_use_result":{"status":"completed","prompt":"…","agentId":"aaab96c9f5e991ce6","agentType":"general-purpose","harnessNoteCount":0,"harnessTailCount":0,"harnessSectionHash":"df9791c8c997fd17","content":[{"type":"text","text":"There are **6** `.md` files …"}],"resolvedModel":"claude-sonnet-5","totalDurationMs":10437,"totalTokens":34118,"totalToolUseCount":1,
                    "usage":{"input_tokens":2,"cache_creation_input_tokens":1971,"cache_read_input_tokens":32093,"output_tokens":52,…},"toolStats":{"readCount":0,"searchCount":0,"bashCount":1,"editFileCount":0,"linesAdded":0,"linesRemoved":0,"otherToolCount":0}},…}
{"type":"assistant","message":{"content":[{"type":"text","text":"6 .md files."}]},"parent_tool_use_id":null,…}
{"type":"result","subtype":"success","num_turns":2,"result":"6 .md files.","total_cost_usd":0.1704582,
 "usage":{"input_tokens":4,"output_tokens":160,"cache_creation_input_tokens":16009,"cache_read_input_tokens":57088,…},          // main loop only
 "modelUsage":{"claude-sonnet-5":{"inputTokens":8,"outputTokens":341,"cacheReadInputTokens":89181,"cacheCreationInputTokens":50073,"costUSD":0.1704582,…}},  // incl. subagent
 "subagent_stats":{"spawned":1,"requested":{"background":0,"foreground":1,"unset":0},"max_depth":1,"completed":1,"by_type":{"general-purpose":1},…},…}
```

Subagent frames without `forwardSubagentText` still included the subagent's `tool_use`/`tool_result` and
its initial prompt as a `user` frame — enough for a nested transcript card (SPEC block `subagent`). The
`usage` vs `modelUsage` split confirms the `.d.ts` note: main loop 160 output tokens, all models 341.

### 8.7 Usage per step (from `result`)

| step | turns | ms | input | output | cache_creation | cache_read | total_cost_usd |
|---|---|---|---|---|---|---|---|
| a `pong` | 1 | 3 596 | 2 | 4 | 33 216 | 0 | 0.1329 |
| b `ok` (streaming input) | 1 | 3 573 | 2 | 4 | 15 585 | 20 742 | 0.0665 |
| c `/context` | 0 | 537 | 0 | 0 | 0 | 0 | 0 |
| d `/cockpit:pilot what's next` | 6 | 43 527 | 12 | 1 945 (914 thinking) | 23 549 | 223 079 | 0.1583 |
| e AskUserQuestion | 2 | 8 996 | 4 | 131 | 38 031 | 37 762 | 0.1610 |
| f Task hook + subagent | 2 | 19 098 | 4 (8 all-models) | 160 (341) | 16 009 (50 073) | 57 088 (89 181) | 0.1705 |

Cache writes are 1-hour ephemeral (`cache_creation.ephemeral_1h_input_tokens`) on the main loop and 5-minute
on the subagent. Each `query()` is a new process and a new session id, so caches are only shared at the
API prefix level — a persistent streaming-input session per agent (R24) is the way to keep `cache_read` high.

### 8.8 Gotchas recorded for the harness

1. Subagent tool name is `Agent` on the wire (`tools` still says `Task`); hook matcher `'Task|Agent'`.
2. `AskUserQuestion` is absent from `init.tools` but callable; it reaches `canUseTool` under
   `bypassPermissions` despite the `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning. Ordinary tools do not —
   route permission cards through `permissionMode: 'default'` + `canUseTool`, or a `PreToolUse` hook.
3. Slash commands are plain prompt text; local ones (`/context`) return a synthetic assistant frame with
   `context_usage` and cost nothing; skill/plugin ones run as normal model turns with no echo of the
   expansion.
4. `settingSources: ['user', …]` runs the user's settings hooks (PowerShell here) on every event and pulls
   in every claude.ai connector MCP server (131 tools, 89k deferred tokens) — an efficiency lever for R26.
5. `Options.env` replaces the child env; when capygen is itself launched from a Claude Code terminal the
   `CLAUDECODE`/`CLAUDE_CODE_*` strip (§7) keeps the child from thinking it is nested.
6. `result.usage` is main-loop only; `result.modelUsage` (+ `task_notification.usage`, Task
   `tool_use_result.totalTokens`) is what the usage meters must sum.

### 8.9 Re-run after the gate fixes (step g `routing_lever`; tightened `plugin_command`/`usage_reporting`)

Run: `corepack pnpm --dir packages/engine exec tsx scripts/spike-claude.ts`, same day, 139 log entries,
all 8 `CAP … PASS` (`stream_text, system_init_commands, slash_context, plugin_command,
ask_user_question, pretooluse_hook_task, routing_lever, usage_reporting`), exit 0, ~120 s wall. A
redacted, trimmed extract of this run's frames is checked in at `docs/spikes/claude.evidence.json`
(the raw stream itself, `claude.raw.json`, stays gitignored).

**`plugin_command` fingerprint check.** The first top-level `tool_use` of the `/cockpit:pilot what's
next` turn was `Bash` with `input.command` beginning
`cd "…\capygen" && git log --oneline -5 && echo --- && git status --short && echo --- && tail -n 40
PROJECT_LOG.md …` — both `git log --oneline -5` and `git status --short` present, in order, as the
very first tool call, plus a reply text matching `/phase|plan/i` (`"**Phase: BUILD** — because PLAN.md
has Phase 2 unchecked, …"`). Both conditions of the tightened PASS predicate (`spike-claude.ts` step d
comment) are met by direct observation, not inference.

**`routing_lever` (step g).** `PreToolUse` hook on matcher `'Task|Agent'` returned
`{hookSpecificOutput:{hookEventName:'PreToolUse', permissionDecision:'allow',
updatedInput:{...tool_input, model:'haiku'}}}`. Observed frames: `task_started` fields were `["type",
"subtype","task_id","tool_use_id","description","subagent_type","is_backgrounded","spawn_depth",
"task_type","prompt","uuid","session_id"]` — no `model` key (confirms the `.d.ts` has none, rather than
assuming it); `task_notification.usage` likewise carried no model key. The result's `modelUsage` had
**two** keys: `claude-sonnet-5` (main loop) and `claude-haiku-4-5-20251001` (`inputTokens:18,
outputTokens:422, costUSD:0.0250, contextWindow:200000`) — direct proof the sub-agent billed against
haiku. Corroborating: the Task tool's `tool_use_result.resolvedModel` on the completion frame read
`"claude-haiku-4-5-20251001"` (contrast §8.6's unforced run, where the same field read
`"claude-sonnet-5"`). The override took effect; no fallback was needed this run. If a future SDK
version stops honouring `updatedInput.model`, the recorded fallback (§5 above) is: deny the Task/Agent
call from the hook and have capygen's own dispatcher re-issue the work as a fresh `query()` with
`options.model` set directly.

**`usage_reporting`.** Per-step numbers this run (`result.usage.input_tokens`, `.output_tokens`,
`result.total_cost_usd`): `a: in=2 out=4 cost=0.0676`, `b: in=2 out=4 cost=0.0676`, `d: in=12 out=2811
cost=0.1888`, `e: in=4 out=127 cost=0.0780`, `f: in=4 out=252 cost=0.1755` — every model-calling step
has all three fields greater than zero, and `c` (`/context`) correctly reported `cost=0`, exempted as a
local command rather than counted as evidence either way.
