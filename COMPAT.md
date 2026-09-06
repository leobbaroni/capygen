# capygen — COMPAT

Every external CLI/SDK contract capygen depends on at runtime, the version it was verified
against, what breaks if the contract moves, and the fallback. Update this file with any new
command, endpoint or SDK member the app starts to rely on (CLAUDE.md).

Verified on: Windows 10 Pro 19045 · Node 22.16 · Electron 44.2.0 (Node 24.20.0) · pnpm 11.15.1.

## Claude Code — `@anthropic-ai/claude-agent-sdk`

| Item | Pinned / verified | Used by | If it changes |
|---|---|---|---|
| package version | `0.3.261` (bundles Claude Code `2.1.261`) | `packages/engine/src/claude/*` | re-run `corepack pnpm --dir packages/engine live:claude` and `corepack pnpm spike` |
| `query({ prompt, options })` | `sdk.d.ts:2953-2956` | `ClaudeHarness.ensureQuery` | the harness's only entry point; a signature change is a compile error |
| streaming input (`prompt: AsyncIterable<SDKUserMessage>`) | verified live 2026-09-06 | one backend session per agent (SPEC R24) | fall back to one `query()` per turn with `options.resume`; costs a cold prefix per turn |
| `Options.env` **replaces** the child env | `sdk.d.ts:1525-1527` | `packages/engine/src/env.ts` builds a complete env | if it became a patch, `cleanEnv` would still be correct, just redundant |
| `Options.settingSources: ['user','project']` | `sdk.d.ts:2085` | loads the user's `~/.claude` settings, skills, plugins, MCP servers and hooks (SPEC R7) | drop to `[]` for isolation; the slash menu then only has built-ins |
| `Options.model` passed explicitly | spike §6 warning 4 | the account default is `claude-opus-5[1m]`, the user's settings say `sonnet` | never rely on the default |
| `Options.includePartialMessages` → `stream_event` | `sdk.d.ts:1725` / `:4826-4844` | text/thinking deltas | without it the harness still works — the settled `assistant` message carries the same text |
| `canUseTool` → `PermissionResult` | `sdk.d.ts:209-269`, `:2339-2351` | permission cards + AskUserQuestion (SPEC R27) | see the AskUserQuestion row |
| `AskUserQuestion` answered via `{behavior:'allow', updatedInput:{...input, answers}}` | `sdk-tools.d.ts:2575-2577`, verified in the spike | `ClaudeHarness.onCanUseTool` | if the field moves, the question card stops round-tripping; the deny path still protects the user |
| `AskUserQuestion` reaches `canUseTool` even under `bypassPermissions` | spike §8.5 | question cards in every permission mode | ordinary tools do **not**: they need `permissionMode: 'default'`/`'auto'` |
| the same `AskUserQuestion` call *also* arrives on the stream as `tool_use` + `tool_result`, under the id `canUseTool` gave as `toolUseID` | verified live 2026-09-06 (`tests/e2e/skeleton.spec.ts`) | `ClaudeHarness` `INTERACTION_TOOLS`: those frames are dropped so the question card is not shadowed by a raw tool-call card | if the ids stopped matching, the transcript would show the question card *and* a duplicate `AskUserQuestion` tool card — cosmetic, not a data loss |
| `PreToolUse` hook matcher must be `'Task\|Agent'` | spike §8.6 — `init.tools` says `Task`, the wire name is `Agent` | sub-agent blocks + routing policy (SPEC R12) | a matcher of `'Task'` alone silently never fires |
| `hookSpecificOutput.updatedInput.model` steers a sub-agent | spike §8.9, `sdk.d.ts:2577-2583`; confirmed live 2026-09-06 (`tests/e2e/roundtable.spec.ts` (c): a `Task` spawn re-homed onto `haiku`) | the same-backend half of the routing policy (SPEC R12) | fallback: deny the Task/Agent call and re-issue the work as a fresh `query()` with `options.model`. Note the ordering trap: the hook fires **before** the assistant `tool_use` frame for the same call, and both upsert the `subagent` block — the later one must not write `model: null`, or it erases the route |
| `result` is the turn boundary, one per turn | `sdk.d.ts:5000-5003` | turn status + usage | a second `result` per turn would double-count usage |
| `result.modelUsage` is **cumulative** in a streaming session | `sdk.d.ts:5036-5039` | per-turn usage is the delta (`deltaUsage`) | if it became per-turn, every turn after the first would under-report |
| `result.usage` is main-loop only | `sdk.d.ts:5032-5035` | fallback when `modelUsage` is empty (local slash commands) | — |
| `Query.interrupt()` | `sdk.d.ts:2615`, streaming input only | `chat.interrupt` | the harness still ends the turn after `interruptGraceMs` (5 s) |
| `system/init.model` is the model the session **actually** runs on | `sdk.d.ts:5148-5208`; observed live 2026-09-06 | `SessionRunner`'s `session` case writes it onto the agent row and broadcasts `agents.updated`, so the composer's picker and the info card follow a `/model` switch instead of showing the model the agent was created with | if it stopped being reported the agent row simply keeps its configured model, which is what it did before |
| `system/init.slash_commands` / `.skills` / `.plugins` | `sdk.d.ts:5148-5208` | the slash menu (R14) | fallback: build the list from `~/.claude/commands`, `<repo>/.claude`, `installed_plugins.json` |
| `system/init.tools` / `.mcp_servers` / `.permissionMode` | `sdk.d.ts:5148-5208`; observed live 2026-09-06 (`tests/e2e/roundtable.spec.ts` (e): 56 skills, 3 plugins, 3 MCP servers, 10 tool groups) | `agents.describe` (SPEC R13) — `ClaudeHarness.describeSnapshot()` remembers the last `init`, `claude/describe.ts` turns it into the info card's text | `init` is the **only** place the SDK reports this session's tool list, so an agent that has not started a turn has no snapshot and the card honestly says "Not reported yet" rather than guessing from config |
| `Query.supportedCommands()` → `{name, description, argumentHint, aliases?}[]` | `sdk.d.ts:2747`, `:8288-8305`; 92 entries observed (spike §8.1) | the slash menu's **descriptions and argument hints** — `slash_commands` is a bare `string[]`, so without this every Claude command was name-only *and* argument-less, which made the composer fire `/cockpit:pilot` immediately instead of letting the argument be typed | fire-and-forget after `system/init`: a backend that does not answer keeps the bare names |
| `system/commands_changed` → `{commands: SlashCommand[]}` | `sdk.d.ts:3420-3427` ("clients should REPLACE their cached list") | mid-session skill discovery replaces the menu | ignored if it stops arriving; the init-time list stands |
| `canUseTool` options carry `title` / `displayName` / `description` | `sdk.d.ts:209-269`, spike §4 | stamped onto the `permission` block so the card has a real header (R32) instead of "Permission requested" over a JSON dump | the card falls back to a per-tool view (command+cwd, file list) and only then to the JSON |
| slash commands are plain prompt text | spike §3 | `chat.send` passes the text through unchanged | — |
| ESM-only package, loaded with a runtime `import()` | `package.json` `"type": "module"` | `packages/engine/src/claude/sdk.ts` | it is **external** to the esbuild bundle (`apps/desktop/scripts/build.ts`): the SDK finds its bundled `claude.exe` through `createRequire(import.meta.url)`, which an inlined copy could not do. Verified inside Electron 44 (`node=24.20.0`, `query=function`) |
| SDK spawns the child with `windowsHide: true` | grep of `sdk.mjs` | no console flash on Windows | if it regresses, pass `Options.spawnClaudeCodeProcess` |
| `Options.systemPrompt` = `{type:'preset', preset:'claude_code', append, snapshot:true}` | `sdk.d.ts:2237-2249` | the round table's session-stable prompt addition (ADR-0002, SPEC R23/R24) — set once in `ClaudeHarness.buildOptions`, never per turn | `append` on the **preset**, not a custom prompt: replacing the preset would drop the CLI's own prompt *and* the cached prefix. `snapshot:true` records the rendered prompt for the conversation, so a roster that changes mid-session cannot rewrite the prefix (the d.ts's own recommendation); where prompt recording is not enabled for the account it is accepted and does nothing |
| `Options.mcpServers?: Record<string, McpServerConfig>` | `sdk.d.ts:1802` | capygen's own in-process `delegate_task` server is merged in here at `query()` creation (SPEC R12) | resolved **once** per backend session: an MCP server list that moved between turns is a cache miss on every turn (R24). A failure to build it logs and starts the session without it — R12 fails open |
| `createSdkMcpServer({name, version, instructions, tools})` → `McpSdkServerConfigWithInstance` | `sdk.d.ts:511-524`, `:1103-1105` | `packages/engine/src/routing/sdkMcp.ts` — the only mechanism by which the Claude CLI can be handed a tool capygen implements | imported **lazily** by name; if either export is missing, `createDelegateMcpServer` returns `null`, the session starts without the tool and the agent spawns its sub-agent natively (fail open, ADR-0004) |
| `tool(name, description, zodRawShape, handler)` | `sdk.d.ts:8590` | the `delegate_task` definition inside that server; the model sees `mcp__capygen__delegate_task` | the input schema is a **Zod raw shape**, not a JSON Schema — the `api` backend's copy of the same tool uses `DELEGATE_TASK_SCHEMA` (JSON Schema) instead, and the two are kept side by side in `routing/delegate.ts` |

Sign-in: claude.ai OAuth (`init.apiKeySource: "none"`). No API key is read or stored by the Claude
harness.

## Codex — `codex app-server` (`@openai/codex` 0.153.4)

Driven by `packages/engine/src/codex/*`. Verified live on 2026-09-06 against the
**bundled** binary (`corepack pnpm --dir packages/engine live:codex` → `LIVE PASS`:
a "pong" turn and an accepted command approval). The `@openai/codex-sdk` package
is a dependency **only** so its vendored binary ships with the app — its own
`Codex`/`Thread` API is never called (spike §1: no approval callback).

| Item | Pinned / verified | Used by | If it changes |
|---|---|---|---|
| binary | `@openai/codex` **0.153.4**, vendored inside `@openai/codex-sdk` 0.153.4 | `codex/binary.ts` `resolveBundledCodex()` | the machine's own install (0.139.0 here) is the fallback and speaks a *different* protocol — the live run on it lost approvals entirely. Order: `binaryPath` → `CAPYGEN_CODEX_BIN` → bundled → `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin` → PATH |
| finding the vendored binary | walk up for `node_modules/@openai/codex-sdk/package.json`, then `@openai/codex` → `@openai/codex-<platform>` → `vendor/<triple>/bin/codex.exe` | same | `@openai/codex-sdk`'s `exports` has **only** an `import` condition, so `require.resolve` throws and `import.meta.resolve` is absent under vitest/esbuild-CJS. A regression test pins this (`test/codexHarness.test.ts` › `resolveCodexBinary`) |
| `@openai/codex-sdk` is also a **direct dependency of `apps/desktop`** | `apps/desktop/package.json` | the walk-up above, from `apps/desktop/dist/main.cjs` | the engine is inlined into `main.cjs`, so `packages/engine/node_modules` is no longer on the way up. Without the desktop dependency the built app silently fell back to the machine's *installed* Codex (0.139.0), a different protocol version on which the approval never fired. Packaging (Phase 12) must ship it |
| a project path handed to Codex must be the **long** Windows path | live run, 2026-09-06 | `longPath()` in `apps/desktop/src/win/projectArg.ts`, applied to `--project`/`CAPYGEN_PROJECT_DIR` and to the folder picker's answer | Codex's Windows sandbox denies an *approved* command whose `cwd` is an 8.3 short name (`C:\Users\TUGAPL~1\…`, which is what `os.tmpdir()` returns here) |
| `vendor/<triple>/codex-path` prepended to `PATH` | `dist/index.js:470,485-496` | `createStdioTransport` | Codex's search tools lose `rg.exe` |
| framing | newline-delimited JSON, **no** `"jsonrpc"` member; server ids are their own space starting at 0 | `CodexAppServerClient` | spike §2; the schema bundle has no `jsonrpc` property |
| `initialize` + `initialized` | `InitializeParams.ts` / `InitializeResponse.ts` | `CodexAppServerClient.start` | handshake; nothing else can be sent first |
| `thread/start` `{cwd, model, approvalPolicy, sandbox, approvalsReviewer}` | `v2/ThreadStartParams.ts` | `CodexHarness.startThread` | **`approvalsReviewer: "user"` is passed explicitly** — this machine's `~/.codex/config.toml` says `auto_review`, under which capygen would never see an approval card |
| `thread/resume` `{threadId, …, excludeTurns: true}` | verified 2026-09-05 (spike `appserver-c-resume`) | resume after a restart | without `excludeTurns` the server sends a `deprecationNotice`; a refused resume falls back to `thread/start` + an error block |
| `turn/start` `{threadId, input: UserInput[], effort?}` → `{turn:{id}}` | `v2/UserInput.ts` | `CodexHarness.dispatch` | answers when the turn is *accepted*, not finished; a `{type:"skill"}` part is how `/skill` reaches the protocol |
| `turn/interrupt` `{threadId, turnId}` | spike §5 | `chat.interrupt` | the harness still ends the turn after `interruptGraceMs` (5 s) |
| `thread/compact/start`, `review/start`, `thread/settings/update` | `CODEX_METHODS` in `codex/protocol.ts` | `/compact`, `/review`, `/model` | slash commands are **not** a protocol concept (spike §2): each built-in maps onto one of these, everything else is prompt text. After `thread/settings/update` the harness re-emits `session` with the new `model`, which `SessionRunner` persists onto the agent row |
| `skills/list` `{cwds:[…]}`, `model/list`, `mcpServerStatus/list` | spike §2 (`appserver-e`) | slash menu (R14), model picker, Settings ▸ MCP (R28) | discovery only — a failure logs and leaves the built-ins, it never fails a turn |
| notifications: `item/started`, `item/completed`, `item/agentMessage/delta`, `item/reasoning/{textDelta,summaryTextDelta}`, `item/commandExecution/outputDelta`, `item/fileChange/patchUpdated`, `turn/started`, `turn/completed`, `thread/tokenUsage/updated`, `error`, `warning` | `ServerNotification.ts` | `CodexHarness.onNotification` → blocks | an unmapped `item.type` logs and renders nothing; a renamed *notification* silently stops a block kind, which the fixture-replay tests would catch |
| `turn/completed` is the turn boundary | spike `appserver-c`/`d1` | turn status + usage | a second one per turn would double-count usage |
| `thread/tokenUsage/updated.tokenUsage.last` is **this turn**, `.total` the thread | `v2/ThreadTokenUsage.ts` | `usage` event (R23) | billing `total` would re-charge the whole thread every turn |
| cost | **not reported by app-server** — estimated from `codex/pricing.ts`, every entry tagged `[assumed]` | usage meter | an unknown model costs **0**, never a guess |
| server requests: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` → `{decision}` | `v2/CommandExecutionApprovalDecision.ts` | permission cards (R27/R32) | `allow`→`accept`, `allow`+`scope:session\|always`→`acceptForSession`, `deny`→`decline`; no open turn → `decline` |
| server request `item/tool/requestUserInput` → `{answers:{[questionId]:{answers:[label]}}}` | `v2/ToolRequestUserInputParams.ts` | question cards (R32) | Codex's AskUserQuestion equivalent; `isOther` becomes the card's `allowOther` |
| server request `mcpServer/elicitation/request` → `{action, content, _meta}` | `v2/McpServerElicitationRequestParams.ts` | elicitation card (R32) | round-trips since Phase 3's integration: an `elicitation` `EngineEvent` carries the `requestId` to the UI, `elicitation.answer` maps the block back to it, and `CodexHarness.answerElicitation` replies `accept`/`decline`. With no open turn, or on interrupt/dispose, the pending request is **declined**, never auto-accepted |
| `account/read {refreshToken:true}` → `{account}` | `v2/Account.ts`, spike §3 | `harness.list` availability probe (`packages/engine/src/codex/account.ts`) | the **only** honest sign-in check: `codex login status` and `getAuthStatus` report the auth *mode* and pass with a dead token — on this machine both said "Logged in using ChatGPT" while every model call 401'd. `model/list` is asked in the same short-lived child, so the picker offers Codex's own catalogue |
| server request `currentTime/read` → `{currentTimeAt}` | `ServerRequest.ts` | answered directly | every other server request is refused with `-32601` and Codex applies its own default |
| MCP App widgets: `mcpToolCall.appContext.resourceUri` (`ui://…`) + `result._meta` kept verbatim | `v2/McpToolCallAppContext.ts`, `v2/McpToolCallResult.ts` | `widget` block (R31) | stripping `_meta` makes the widget unrenderable |

Sign-in: ChatGPT OAuth (`account/read` → `{type:"chatgpt"}`). No API key is read or
stored by the Codex harness. An `unauthorized` turn error renders "run `codex login`",
and `harness.list` runs the same `account/read` probe up front, so an unavailable Codex is
a greyed-out picker row with a reason instead of a turn that fails on a 401.

## API models — `@anthropic-ai/sdk`, `openai`, MCP (`@modelcontextprotocol/sdk`)

The `api` backend has no CLI: capygen runs the agent loop itself
(`packages/engine/src/api/**`), with its own tool runtime (`src/tools/**`) and its own MCP client
(`src/mcp/client/**`). Verified 2026-09-06 against the installed packages' `.d.ts` and, for the
three endpoints, against a live 401 (an invalid key, no tokens spent) —
`corepack pnpm --dir packages/engine live:api`.

| Item | Pinned / verified | Used by | If it changes |
|---|---|---|---|
| `@anthropic-ai/sdk` | `0.124.0` | `api/providers/anthropic.ts` | the adapter reads the stream through its own structural interface (`AnthropicClientLike`), so only `messages.create(body, {signal})` and the raw event names below are load-bearing |
| `client.messages.create({…, stream:true})` → async iterable of raw events | verified live (401 reached the endpoint) | `AnthropicProvider.stream` | the one call the provider makes |
| raw stream events read: `message_start`, `content_block_start/delta/stop`, `message_delta`, `error`; deltas `text_delta`, `thinking_delta`, `signature_delta`, `input_json_delta` | `resources/messages/messages.d.ts` `RawMessageStreamEvent` | `mapAnthropicStream` | an unknown event is ignored, not fatal; a *renamed* one silently drops that content — `test/apiProviders.test.ts` replays each shape |
| `cache_control: {type:"ephemeral"}` on the **system** block, the **last** tool, and the last content block of each of the **final two messages** | SPEC R24; Anthropic allows 4 breakpoints and all 4 are used | `buildAnthropicBody`, `markMessageCacheBreakpoints` | the first two cover the fixed prefix (system + tools); the trailing pair is what stops the whole growing `messages` array being re-billed on every tool-loop round trip and every later turn. Asserted on the real request body in `test/api.test.ts` and `test/apiProviders.test.ts` |
| `usage.input_tokens` **excludes** cached tokens; `cache_read_input_tokens` / `cache_creation_input_tokens` are separate | `messages.d.ts` `Usage` | `anthropicUsage` → the price table | if it became inclusive, input cost would be double-counted |
| a replayed `thinking` block needs its `signature` | API contract | `anthropicMessages` drops unsigned ones | losing earlier visible reasoning beats losing the turn |
| `openai` | `7.10.0` | `api/providers/openai.ts` (and OpenRouter) | as above: only `responses.create(body, {signal})` and the event names below matter |
| **Responses** API, not Chat Completions; `store: false` | `resources/responses/responses.d.ts` | `buildOpenAiBody` | server-side prompt caching is automatic there and there is no `cache_control` to set; capygen keeps every request self-contained |
| events read: `response.created/in_progress`, `response.output_text.delta/done`, `response.reasoning_text.*`, `response.reasoning_summary_text.*`, `response.output_item.done`, `response.completed/incomplete/failed` | same file | `mapOpenAiStream` | unknown events are ignored |
| a tool call is keyed by **`call_id`**, and `function_call_output` must echo it | same file | `mapOpenAiStream`, `openaiInput` | using the item `id` instead makes every tool result orphaned |
| `usage.input_tokens` **includes** `input_tokens_details.cached_tokens` | `ResponseUsage.InputTokensDetails` | `openaiUsage` subtracts them | the opposite convention to Anthropic's; both normalise to "uncached input" |
| `reasoning: {effort}` only on o1/o3/o4/gpt-5 | model contract [assumed 2026-09-06] | `supportsReasoning` | a non-reasoning model rejects the field outright |
| OpenRouter = the same SDK at `https://openrouter.ai/api/v1` with `HTTP-Referer` + `X-Title` | verified live 2026-09-06: a direct `curl` with a bad key returns the identical `401 Missing Authentication header`, i.e. the header is being sent | `clientOptions` | if OpenRouter drops `/responses`, fall back to its Chat Completions path |
| model prices | **[assumed 2026-09-06]**, `api/pricing.ts` `PRICES_ASSUMED_ON` | the usage meter's dollar figure only | token counts come from the provider and are unaffected; an unpriced model reports `costUsd: 0` with `isEstimate: false` |
| `@modelcontextprotocol/sdk` | `1.30.0` | `mcp/client/**` | dual ESM/CJS build; loaded with a runtime `import()` so a session with no MCP servers never loads it |
| `Client`, `StdioClientTransport`, `StreamableHTTPClientTransport`; `listTools()`, `callTool()`, `readResource()` | `dist/esm/client/*.d.ts`; verified against a real stdio server in `test/mcpClient.test.ts` | `McpClientPool` | the only four SDK members capygen touches |
| `sse` transport | **not implemented** | `McpClientPool.open` throws a sentence | streamable HTTP is what the current CLIs use; an SSE-only server needs a URL change |
| `Tool.annotations` is a **sibling** of `inputSchema`, not a member of it | `@modelcontextprotocol/sdk` 1.30.0 `types.d.ts:2381-2419` | `McpToolInfo.annotations` → `mcpPermissionClass`; `annotations.readOnlyHint === true` makes a server tool the `read` class instead of `execute` | read it from inside the schema (as this once did) and every read-only tool raises a permission card in `default` mode |
| `tools/call` result passed through whole (`content`, `structuredContent`, `_meta`) | MCP spec | `McpClientPool.callTool`, `tools/mcpTools.ts` | R31's widget host finds `ui://` in `_meta`; normalising the result would leave it nothing |
| MCP Apps `_meta` key `ui/resourceUri` (also nested `_meta.ui.resourceUri`), mime `text/html;profile=mcp-app` | `@modelcontextprotocol/ext-apps` `1.7.5` — `RESOURCE_URI_META_KEY` / `RESOURCE_MIME_TYPE` in `dist/src/server/index.js` | `widgetResourceUri` → the `widget` block (R31) | a renamed key means widget cards stop appearing; the tool card still renders |
| MCP server config sources, read-only | `<project>/.mcp.json`, `~/.claude/settings.json` `mcpServers`, `~/.codex/config.toml` `[mcp_servers.*]` | `mcp/client/config.ts` | precedence agent > project > Claude > Codex; capygen never writes these (Phase 6 owns editing) |

Keys: `${ANTHROPIC_API_KEY}` / `${OPENAI_API_KEY}` / `${OPENROUTER_API_KEY}` as a fallback only.
In the app they arrive through the injected `KeyProvider` (Electron `safeStorage`); the engine
never reads a key from disk and never logs one (`maskKey` is the only form allowed in a log).
The bridge is one line in `apps/desktop/src/ipc/handlers.ts` — `keys: { getKey: (p) => secrets.get(p) }`
— and `SecretsStore.get` exists only for it: `secrets.has` stays the whole renderer-facing read
surface, so a decrypted key never crosses IPC. `harness.list` uses `has` alone to decide whether
the `api` backend is offered at all.

Conversation state: an `api` agent has **no** backend session id to resume (`backendSessionId()`
returns `null`). Its memory is the SQLite transcript, replayed on `start()` by
`apps/desktop/src/engine/history.ts` — which pairs every `tool_use` with a `tool_result` (both
providers reject a conversation missing one) and drops unsigned `thinking`.

## MCP Apps widget host — `@modelcontextprotocol/ext-apps` (SPEC R31)

Evidence for every row: `docs/spikes/mcp-apps.md` (run 2026-09-06). The widget *host* lives in
`packages/engine/src/mcp/apps/**` (main-process resolution) and `apps/renderer/src/widgets/**`
(the sandboxed frame and the bridge); it sits on top of the generic MCP client above.

| Item | Pinned / verified | Used by | If it changes |
|---|---|---|---|
| package version | `@modelcontextprotocol/ext-apps` **1.7.5** | `mcp/apps/protocol.ts`, `widgets/bridge.ts` | re-run `SPIKE_STEPS=client corepack pnpm --dir packages/engine exec tsx scripts/spike-mcp-apps.ts` |
| protocol version **`2026-01-26`** (`LATEST_PROTOCOL_VERSION`) | `spec.types.d.ts:16` | `AppBridge` negotiates it | `packages/engine/test/mcpApps.test.ts` asserts our copied constants against the real package and fails on drift |
| `_meta.ui.resourceUri`, deprecated `_meta["ui/resourceUri"]`, on the **tool definition** | verified live against the fixture server | `readUiResourceUri` | a third form would send every widget to the fallback card |
| `_meta.ui.visibility` `["model"]` / `["app"]` (default both) | `McpUiToolMeta` | `WidgetHostBridge.callTool` refuses a model-only tool to a widget | a widget could call tools the server meant for the model alone |
| resource `_meta.ui` = `{csp, permissions, domain, prefersBorder}`; the **tool's** `csp` is `never` and is ignored | `McpUiResourceMeta` | `buildWidgetCsp`, `buildAllowAttribute` | a widget with remote assets would be served under the deny-all default |
| host↔view messages implemented: `ui/initialize`, `ui/notifications/initialized`, `ui/notifications/tool-input`, `ui/notifications/tool-result`, `ui/notifications/host-context-changed`, `ui/notifications/size-changed`, `tools/call`, `resources/read`, `ui/open-link`, `ui/download-file`, `ui/request-display-mode`, `notifications/message`, `ping` | the package's own `AppBridge` + `PostMessageTransport` | `apps/renderer/src/widgets/bridge.ts` | ext-apps *is* the reference implementation, so a protocol change arrives as a version bump here |
| host capabilities advertised: `openLinks`, `downloadFile`, `serverTools`, `serverResources`, `logging` | — | `HOST_CAPABILITIES` | `message`, `updateModelContext` and `sampling` are withheld on purpose: third-party HTML must not write the model's context or spend tokens (R27) |
| theme variables = the spec's fixed `McpUiStyleVariableKey` names | `spec.types.d.ts` | `widgets/hostContext.ts` maps capygen's tokens onto them | widgets fall back to their own defaults; nothing breaks |
| client capability `capabilities.extensions["io.modelcontextprotocol/ui"]` | `server/index.d.ts:315` `EXTENSION_ID` | **not sent yet** — `MCP_APPS_CLIENT_CAPABILITY` is ready for the pool to take | a server that gates App tools on it hides them from our listing → fallback card |

### The Claude Agent SDK as a widget host

| Item | Pinned / verified | Used by | If it changes |
|---|---|---|---|
| the stream carries **no** tool `_meta` for an MCP tool call | verified live 2026-09-06, spike §b2 | why the host re-reads the URI over its own MCP client | if `_meta` appeared, resolution gets cheaper — the host already checks the result `_meta` first |
| `Query.mcpServerStatus()` → `{name, status, scope, config}`; `config.type` ∈ `stdio` / `http` / `claudeai-proxy` | spike §b1 | how a CLI-hosted server's config is recovered; `claudeai-proxy` is the unreachable class | a new `type` lands in the fallback card, not in a bad connection |
| its `tools[]` entries are `{name, annotations}` — no `_meta` | spike §b1 | the URI is deliberately *not* taken from there | — |
| `tool_use_result._meta` **is** passed through (Higgsfield's `io.modelcontextprotocol/serverInfo`) | spike §c | a result-side `ui.resourceUri` is honoured when a server offers one | — |
| assistant `tool_use_meta[] = {id, display_name, server_display_name, icon_url?}` | verified live | available for card headers (not used yet) | cosmetic |
| project `.mcp.json` + `.claude/settings.local.json` `enableAllProjectMcpServers` | `tests/e2e/widget.spec.ts` | one registration that both the CLI and capygen's own client read | the widget e2e stops seeing the fixture server |
| claude.ai connectors (Higgsfield included) declare **no** `ui://` resource | spike §c, `balance` and `generate_image{get_cost:true}` | the fallback rich card is the normal rendering for that whole class | if one ever does, it is still unreadable without the connector's OAuth |

### Codex app-server as a widget host

A Codex `mcpToolCall` states its `ui://` outright, so `CodexHarness` emits the
`widget` block itself. Fetching the document is `SessionRunner`'s
`resolveHarnessWidget`, which calls the same `widgets.open()` the Claude path
uses — capygen's own MCP client against the same server config, per A13. (It
used to be reachable only from `maybeOpenWidget`, gated on a tool name starting
with `mcp__`, which no Codex tool_call ever is: every Codex widget stayed on a
loading spinner.) The two app-server methods below remain the fallback if that
client cannot reach a Codex-hosted server.

| Item | Pinned / verified | Used by | If it changes |
|---|---|---|---|
| `ThreadItem` `mcpToolCall.appContext = {connectorId, linkId, resourceUri, appName, actionName}` | bindings v0.153.4 | Codex needs no second MCP client — the URI is stated outright | fall back to `mcpServerStatus/list`, whose `Tool`/`Resource` do carry `_meta` |
| `McpToolCallResult {content, structuredContent, _meta}` | bindings v0.153.4 | result `_meta` survives | — |
| `mcpServer/resource/read` → `{contents: ResourceContent[]}`; `mcpServer/tool/call` | bindings v0.153.4 | the Codex implementation of `WidgetMcpAccess` | — |

### capygen's own widget surface

| Item | Value | Why |
|---|---|---|
| widget scheme | `capygen-widget://<blockid>/index.html`, registered `standard` + `secure` **before** `app.ready` | a `srcdoc` / `data:` / `blob:` frame inherits the renderer's CSP and cannot run a widget at all — measured, spike §a4 |
| renderer CSP | `frame-src capygen-widget:` added to `apps/renderer/index.html` | without it Chromium refuses the frame outright (`ERR_BLOCKED_BY_CSP`) |
| iframe sandbox | `allow-scripts allow-forms` — never `allow-same-origin` | opaque origin: `window.origin === "null"` and `localStorage` throws (measured) |
| per-widget response CSP | `default-src 'none'` plus only the resource's declared domains | the spec's stated secure default |
| widget document cap | 4 MB (`DEFAULT_MAX_WIDGET_HTML_BYTES`) | a hostile server must not be able to exhaust the main process's heap |

## Config sync — Claude Code and Codex configuration (SPEC R19–R21, R28–R30)

Driven by `packages/engine/src/config/**` (the stores) and
`apps/desktop/src/integrations/**` (watchers, cache, IPC). Every row was
verified on this machine on **2026-09-06** against Claude Code **2.1.261** and
Codex **0.153.4**: the files by reading them, the CLI shapes by running the
read-only commands, and the three MCP scopes by running `claude mcp add`
against an isolated `CLAUDE_CONFIG_DIR` — which wrote only inside that temp
directory, the isolation proof every test here depends on.

### Claude Code — files

| Item | Pinned / verified | Used by | If it changes |
|---|---|---|---|
| `CLAUDE_CONFIG_DIR` relocates the whole home | `sdk.mjs`: `process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")`; live run 2026-09-06 | `resolveBackendHomes`, every test under `packages/engine/test/config*` and `apps/desktop/test/integrations*` | without it no test could run without touching the user's real config; the suite would have to be deleted, not adapted |
| **`.claude.json` moves inside `CLAUDE_CONFIG_DIR`** when it is set | `sdk.mjs`: `join(CLAUDE_CONFIG_DIR or homedir(), ".claude.json")`; the live run wrote `<tmp>/.claude.json` | `claudePaths().globalConfig` | reading `~/.claude.json` unconditionally would make an "isolated" home read the user's real MCP servers |
| `.claude.json` → `mcpServers` | user-scope servers, `{type,command,args,env}` / `{type,url}` | `ClaudeConfigStore` scope `user` | the *name → object* map is Claude Code's own `mcpServers` format, shared with `.mcp.json` |
| `.claude.json` → `projects["<forward-slashed cwd>"].mcpServers` | local-scope servers; **the key uses `/` even on Windows** (live: a `C:\…\cfgproj` cwd produced the key `C:/Users/…/cfgproj`) | scope `local`, `claudeProjectKey()` | a backslashed lookup finds nothing and every local server vanishes from the page |
| `<project>/.mcp.json` → `mcpServers` | project-scope servers; **edited directly**, never through the CLI | scope `project` | three lines a repo checks in — re-serialising it is safe, unlike `.claude.json`'s 70 KB of session bookkeeping |
| `.mcp.json` approval: `enableAllProjectMcpServers`, `enabledMcpjsonServers`, `disabledMcpjsonServers` | settings-schema keys in `sdk.mjs`; also mirrored in `.claude.json`'s project node | `mcpJsonApproved()` → the row's `enabled` | an unapproved `.mcp.json` server is listed but shown off, which is what `claude mcp list` prints as "⏸ Pending approval" |
| `permissions.{allow,deny,ask}` — arrays of patterns | `sdk.mjs` settings schema; this machine's own `settings.local.json` uses `allow` | tool policies: read from the whole chain, written to `<configDir>/settings.json` (scope `global`) or `<project>/.claude/settings.local.json` (scope `project`) | an emptied bucket is deleted rather than written as `[]` |
| **`skillOverrides`**: `Record<string, "on" \| "name-only" \| "user-invocable-only" \| "off">` | `sdk.mjs` settings schema, described there as *"Per-skill listing overrides keyed by skill name … `off` hides it from both. Absent = on."*; already present in this machine's `settings.local.json` | `ClaudeConfigStore.setSkillEnabled` | **this is why capygen never moves a Claude skill file.** If the key disappeared, the fallback would be an enabled/disabled directory pair under capygen's control — strictly worse, because the CLI would not honour it |
| `enabledPlugins`: `{ "<plugin>@<marketplace>": boolean }` | `sdk.mjs` settings schema; precedence user < project < local | a plugin row's `enabled` | a plugin disabled in user settings can still be re-enabled by a project — the schema says so explicitly |
| `plugins/installed_plugins.json` — `{version:2, plugins:{id:[{scope,installPath,version,installedAt}]}}` | read from this machine | which plugins exist, and their `installPath` (source of `commands`/`skills`) | an unreadable file yields no plugins, never a crash |
| `plugins/known_marketplaces.json` — `{name:{source:{source,repo},installLocation}}` | read from this machine | the marketplaces fallback when the CLI cannot run | the CLI's `--json` output is preferred; this is the offline answer |
| skills at `<configDir>/skills/<name>/SKILL.md`, `<project>/.claude/skills/**`, `<installPath>/skills/**` | read from this machine | `SkillEntry` (`name`/`description` from the YAML front matter) | only those two fields are parsed — the rest of the document is prose, not config |
| the settings precedence chain | `<configDir>/settings.json` < `settings.local.json` < `<project>/.claude/settings.json` < `.claude/settings.local.json` | `settingsChain()`, and every merged read above | a fifth source (managed/policy settings) is one more entry, not a redesign |
| **`.credentials.json` can exist and hold nothing** | measured on this machine 2026-09-06: under a Claude Code host that refreshes auth out of process (`CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH`, `CLAUDE_CODE_MESSAGING_SOCKET`), `claudeAiOauth.accessToken` and `.refreshToken` are **empty strings** and `expiresAt` is `0`; `claude -p` run outside that host then answers `Failed to authenticate: OAuth session expired and could not be refreshed` | `claudeSignInSignal` (`apps/desktop/src/ipc/harnessList.ts`) | existence alone made `harness.list` offer a backend whose every turn 401s, and made three live e2e specs burn their full timeout instead of skipping. Only three fields are read and none is ever returned or logged: the two token strings must be non-empty, and `refreshTokenExpiresAt` must not be past. `expiresAt` (the *access* token's) is deliberately ignored — expired between refreshes is the normal state of a working login. A file that will not parse, or has no `claudeAiOauth` object, is still treated as a login: an unrecognised credential format must not lock a working machine out |

### Claude Code — CLI, headless (PLAN A9)

Every invocation is `execFile` with `windowsHide: true`, `cleanEnv()`, and
`CLAUDE_CONFIG_DIR` set **explicitly** to the store's own config dir — an
isolated home stays isolated even when the parent process has the variable
unset. A non-zero exit throws with the CLI's own stderr in the message.

| Command | Verified | Used by | If it changes |
|---|---|---|---|
| `claude mcp add -s <user\|local\|project> [--transport http\|sse] [-e K=V]… <name> [-- <command> <args…>]` / `… <url>` | live, all three scopes | `addMcpServer` for the two `.claude.json` scopes | `--` first, then argv, is the CLI's own documented spelling for a stdio server that has flags of its own |
| `claude mcp remove <name> -s <scope>` | live | `removeMcpServer`, and the first half of an update — the CLI has no `mcp update` | remove-then-add is also what stops a rename leaving two rows behind |
| `claude mcp list` | live | `liveMcpStatus()` — per-server status **and** the claude.ai cloud connectors that exist in no file at all | **no `--json` on 2.1.261** (`claude mcp list --help` offers only `-h`), so this parses text: `<name>: <target> - <glyph> <status>`, split on the first `": "` and the last `" - "` because a connector's name contains spaces (`claude.ai Higgsfield`). It can only *enrich*: an unrecognised line leaves the status undefined and the file-derived list stands |
| `claude plugin list --json` | live | reconciling installed plugins against the file | array of `{id,version,scope,enabled,installPath,installedAt,lastUpdated}` |
| `claude plugin marketplace list --json` | live | `integrations.plugin.marketplaces` | array of `{name,source,repo,installLocation}`; any failure falls back to `known_marketplaces.json` |
| `claude plugin install <plugin>@<marketplace> --yes` | `--help`, 2.1.261 | `installPlugin` | **`--yes` is required, not cosmetic**: the CLI refuses a marketplace-declared install command when stdout is not a TTY, which it never is here. R27's confirm-before-installing is satisfied by the renderer's dialog *before* this call is made |
| `claude plugin uninstall\|enable\|disable <plugin>` | `--help`; `enable`/`disable` exercised through the test shim | `uninstallPlugin`, `setPluginEnabled` | `-s <scope>` defaults to auto-detect and is deliberately not passed |

### Codex — `~/.codex/config.toml` (`CODEX_HOME`)

capygen **patches text ranges**; it never re-serialises this file. See
`packages/engine/src/config/toml.ts` for why: `@iarna/toml` 2.2.5 and
`smol-toml` 1.8.0 (both checked on npm, 2026-09-06) parse TOML into plain
JavaScript objects, and a plain object has nowhere to keep a comment, a key
order, or the difference between `'C:\Users\x'` and `"C:\\Users\\x"` — and this
machine's real file has ~80 literal-quoted `[projects.'…']` headers to lose.

| Item | Pinned / verified | Used by | If it changes |
|---|---|---|---|
| `CODEX_HOME`, default `~/.codex` | Codex's documented variable; used by every test here | `resolveBackendHomes` | same blast radius as `CLAUDE_CONFIG_DIR` |
| `[mcp_servers.<name>]` with `command`, `args`, `url`, `startup_timeout_sec`, and a child `[mcp_servers.<name>.env]` table | read from this machine's own file | `readMcpServers`, `mcpServerToml` | the **child env table** is why the Phase 3 reader (`mcp/client/config.ts`) was not reused: it skips nested tables by design and would drop every server's environment |
| `[plugins."<plugin>@<marketplace>"] enabled = <bool>` | read from this machine | the plugin list and `setPluginEnabled` | a quoted table name, so the writer quotes any key outside `[A-Za-z0-9_-]+` |
| `[marketplaces.<name>] source_type/source` | read from this machine | the Codex marketplace list | `marketplace/add`/`remove` exist on the app-server (Phase 9); capygen does not write these |
| top-level `model`, `model_reasoning_effort`, `approval_policy`, `sandbox_mode` | `v2/Config.ts` in the 0.153.4 bindings, plus this machine's file | `CodexConfigStore.defaults()` / `.setDefaults()` | a *new* root key is inserted **above the first table header**, or it would silently become a key of that table |
| `[projects.'<path>'] trust_level`, `[features]`, `[windows]`, `notify = [ … ]` | read from this machine | nothing — but they must survive every write | the patcher's whole reason to exist; `configStores.test.ts` asserts each one after an edit |
| skills at `<CODEX_HOME>/skills/<name>/SKILL.md`, `<project>/.codex/skills`, `plugins/cache/<marketplace>/<plugin>/<version>/skills` | the cache layout on this machine | `SkillEntry` | a plugin whose cache is absent is listed `installed: false`, not hidden |
| **Codex has no per-tool permission list** | `v2/Config.ts` (0.153.4) has neither an allow/deny list nor a permissions table; `ExecPolicyAmendment` is a runtime proposal, not a config key | `readToolPolicies()` returns `[]`; a `codex` tool policy is capygen's own SQLite row, enforced by capygen's permission cards | if Codex grows one, the row moves from the DB into the file and `BackendSyncSource.toolPolicyScopes` stops being empty |
| skill enable/disable is a **rename**: `SKILL.md` ⇄ `SKILL.md.disabled` | capygen's own convention (`CODEX_DISABLED_SKILL_FILE`) | `CodexConfigStore.setSkillEnabled` | the app-server's `skills/config/write {name\|path, enabled}` is the alternative, but it needs a running server and picks its own destination. The rename is reversible, visible in a diff, and cannot lose the file — `FileIo` deliberately has **no delete**, so a rename is the only way anything in this module makes a path stop existing |

### Watchers and refresh (SPEC R29)

| Item | Pinned / verified | Used by | If it changes |
|---|---|---|---|
| `chokidar` **5.0.0** — `watch(paths[], {ignoreInitial, depth: 2, awaitWriteFinish})` | already a desktop dependency (Phase 5) | `SyncCoordinator` | the same package and options the Files pane uses |
| **the watcher must be awaited to `ready`** | measured 2026-09-06 | `defaultCreateWatcher` | `chokidar.watch()` returns *before* its initial scan finishes, and with `ignoreInitial: true` an edit made inside that window is **silently dropped** — `integrationsWatcher.test.ts` failed in exactly that way before the `ready` await was added. `main.ts` does not await `start()`, so G1's 3 s landing budget is unaffected |
| `integrations.changed {backend, kinds}` fires only for the kinds that actually differ | `changedKinds` | the settings page | `.claude.json` is rewritten constantly for unrelated session bookkeeping; broadcasting every write would re-render the page continuously |
| cache TTL 5 s, watcher debounce 300 ms | `DEFAULT_SYNC_TTL_MS` / `DEFAULT_SYNC_DEBOUNCE_MS` | `SyncCoordinator` | R23–R26: the settings page, the composer and a second window share one read rather than each costing a directory walk |
| a re-sync **replaces** a backend's cached rows (`DELETE … WHERE backend = ?`, then upsert) | `SyncCoordinator.persist` | `mcp_servers`, `plugins`, `skills`, and only the policy scopes that backend's files own | the files are the source of truth, so a cached row the files stop mentioning is stale by definition. capygen's own `session` policies, and every policy for a backend with no permission file, are never pruned |

## Internal seams

| Seam | Meaning |
|---|---|
| `CAPYGEN_ENGINE=stub` | run the offline echo engine instead of a real backend (the e2e suite sets it) |
| `CAPYGEN_ENGINE=stub-roundtable` | the same echo engine with `peerMentions`: every reply ends `over to @<next agent>` and dispatch runs through the **real** `createRoundTable`. It is how `tests/e2e/roundtable.spec.ts` proves the hop cap (R11) without a model — a loop bound must not be proved with something that might choose to stop on its own |
| `CAPYGEN_USER_DATA_DIR` | isolated Electron profile |
| `CAPYGEN_CLAUDE_CONFIG_DIR` → `CLAUDE_CONFIG_DIR`, `CAPYGEN_CODEX_HOME` → `CODEX_HOME` | `apps/desktop/src/win/configHomes.ts`, applied to `process.env` in `main.ts` **before anything reads it**. That is the single interception point, because everything downstream copies `process.env`: `resolveBackendHomes()` (the config stores, the watchers, the settings pages) and `cleanEnv()` (every harness child, every `claude mcp`/`claude plugin` spawn, MCP stdio servers, the Terminal pane, dev servers). The seam is capygen-namespaced rather than the backends' own names on purpose — a capygen launched *from* a Claude Code terminal inherits that terminal's `CLAUDE_CONFIG_DIR` and would otherwise silently drive the wrong home. The directory is created first (`claude mcp add -s user` writes `<dir>/.claude.json` but does not create `<dir>`), and the mapping is logged once so an e2e run that used the real homes is distinguishable from one that did not |
| `CAPYGEN_PREREQ_CONFIRM=cancel` | e2e-only seam for R3/R27: replaces `PrereqsIpcDeps.confirm` with one that answers Cancel without drawing. **Only** the dialog — the refusal rules and the console launcher are the shipping code, and the assertion is that the launcher is never reached. Any other value leaves the real `dialog.showMessageBox` in place, so a packaged build has no way in |
| `notify.ts` taps `broadcast` | `apps/desktop/src/win/notify.ts` — `GlobalSettings.notifications` is consumed by watching the *same* event stream the UI gets, so there is no second event path and nothing new reaches a model's context (R26). `onFinish` ← `chat.turnStatus: done`; `onNeedsInput` ← `permission.request`/`question.request`/`elicitation.request` (R32's three blocking cards); `onRunnerDisconnect` ← `chat.turnStatus: error` and `app.status` level `error`. Two suppressions: a **focused** window never toasts (you are watching it happen), and each `<kind>:<turnId>` fires once, in a 200-entry ring. Windows needs `app.setAppUserModelId` or `new Notification(...)` silently does nothing on Windows 10 |
| `CAPYGEN_PROJECT_DIR` / `--project=<dir>` | pre-select a project folder |
| `CAPYGEN_DEV_URL` | load the renderer from Vite |
| `createHarnessForBackend(backend, deps)` | `packages/engine/src/index.ts` — the whole registry. `SessionRunner` calls it once per agent; `deps.api.keys` is the desktop's `safeStorage` bridge and `deps.api.loadHistory` the SQLite replay (`apps/desktop/src/engine/history.ts`) |
| `Harness.answerElicitation?` | optional on purpose: only a backend that relays MCP `elicitation/create` emits the matching event (Codex today). A missing method reads as "not delivered", the same answer a stale request gets |
| `BACKEND_BUILTIN_SLASH_COMMANDS` | `packages/shared/src/constants.ts` — which of the seven app built-ins each backend can run (R14). Claude: all seven; Codex and `api`: none, because Codex publishes its own `/compact`,`/model`,`/clear`,`/review`,`/status` and `api` has no command layer. `chat.listCommands` filters on it; offering the rest meant a menu click posted `/cost` to the model as literal text |
| `McpPoolRegistry` | `apps/desktop/src/ipc/mcpPools.ts` — one `McpClientPool` per distinct resolved server list, reference-counted, shared by `ApiHarness` (`deps.acquirePool`) and the widget host (`WidgetHostDeps.pools`). Without it both built their own pool for the same project and every stdio server was spawned twice per session (R26) |
| `secrets.has` → `{has, source}` | `source` is `stored` \| `environment` \| `none`. `harness.list` counts `ANTHROPIC_API_KEY` & co. as a key, so a bare boolean made Settings ▸ API keys say "Not set" for a provider the composer was offering |
| `BACKEND_BLOCK_PARITY` | `packages/shared/src/blockParity.ts` — which block kinds each backend can emit, and a written reason for each it cannot. Two suites read it (`apps/desktop/test/blockParity.test.ts`, `apps/renderer/src/components/blocks/blockParity.test.tsx`), so a new block kind fails both until the table answers for all three backends |
| `delegate_task` | `packages/engine/src/routing/delegate.ts` — capygen's own cross-backend sub-agent tool (SPEC R12, ADR-0004). Exposed to `claude` through `createSdkMcpServer` and to `api` as one more `ToolDefinition`; **not** to `codex`, whose MCP servers come from the user's `~/.codex/config.toml` and which capygen will not write to behind the user's back. A Codex agent with a cross-backend rule therefore fails open |
| `HarnessAgent.promptAddition` | the round table's session-stable prompt text, applied once per backend session: Claude `systemPrompt.append`, Codex `thread/start.developerInstructions`, `api` `buildSystemPrompt({extra})`. Nothing per-turn may go in it (R24) |
| `HarnessAgent.permissionMode` | the **highest**-priority permission mode a harness knows (`ClaudeHarness`: `agent.permissionMode ?? config.claude.permissionMode ?? "default"`). `SessionRunner` therefore fills it from `agent.config.<backend>.permissionMode` first and only then from the global setting — passing the global one unconditionally made the per-agent override dead (SPEC R19's "per-agent overrides") |
| `Harness.describeSnapshot?()` | optional, duck-typed, one shape per backend: Claude returns its last `system/init` (`ClaudeInitSnapshot`), Codex `{mcpServers, skills}` from `mcpServerStatus/list` + `skills/list`, `api` `{tools, mcpServers}` from the tool list it was built with. `apps/desktop/src/engine/describeSnapshot.ts` narrows it and merges the config-only halves; a harness without the method, or one whose method throws, simply has no snapshot — an info card never fails a lookup (SPEC R13) |
| `IntegrationsService` project resolution | `integrations.list` takes only `{backend}` — the contract has no `projectId` — so the project-scope rows (`.mcp.json`, `.claude/settings.local.json`, `.claude/skills`) are read for the **most-recently-touched project** (`projects.list()` is ordered `updated_at DESC`), which is the one the landing page and the open session are already on. When it changes, the watchers are re-pointed (`SyncCoordinator.retarget`) |
| `SettingsService` **projection** | Phase 2's flat `Settings` row is still what `SessionRunner`, `appStore` and `DevWorkspacePage` read. Rather than give the app two sources of truth, every `settings.patch` writes the overlapping fields down onto it: `appearance.theme`→`theme`, `general.defaultBackend/defaultModel`, `efficiency.compactionThresholdPct`÷100→`compactionThreshold`, `closeToTray`, and `backends.claude.permissionMode`→`permissionMode` (only when the hub has an opinion). That is how the R30 layering reaches a harness: the projected value is `SessionRunner`'s *lowest*-priority fallback, and `agent.config.<backend>` still outranks it (Phase 4) |
| `ApiConfigStore` inheritance | the `api` backend's own MCP servers live under one `settings` key (`api_mcp_servers`); everything else it lists is **inherited read-only** from the Claude and Codex stores, marked `scope:"plugin"` + `inherited:true`, and every write to one is refused by name. That mirrors what `loadMcpServers` actually hands an `api` agent (Phase 3), so the settings page cannot disagree with the agent |

## Workspace panes — node-pty, chokidar, simple-git, Electron views (SPEC R16–R18)

Added by Phase 5 task B1 (`apps/desktop/src/workspace/**`). Verified on this machine on
2026-09-06 against the installed packages and, for node-pty, against a live Electron 44 probe
(`docs/adr/0005-terminal-node-pty.md`).

| Item | Pinned / verified | Used by | If it changes |
|---|---|---|---|
| `node-pty` | **1.1.0**; prebuilds are N-API (`node-addon-api` ^7), so one binary answers Electron 44 (ABI 149) and Node 22.16 (ABI 127) — both measured, no `@electron/rebuild` | `workspace/TerminalService.ts` | see ADR-0005. Fallback: `@electron/rebuild` 4.2.0 scoped to this module |
| `pty.spawn(file, args, {name, cols, rows, cwd, env, useConpty})` → `IPty` (`pid`, `onData`, `onExit`, `write`, `resize`, `kill`) | `typings/node-pty.d.ts` 1.1.0 | the whole Terminal pane | the `PtySpawner` seam is one function type; a signature change is a compile error, and every test drives a fake through it |
| node-pty's binding loader is a **relative** `require("../build/Release/pty.node")` (then `build/Debug`, then `prebuilds/<platform>-<arch>`) | `node-pty/lib/utils.js` | why `node-pty` is **external** in `apps/desktop/scripts/build.ts`, and why Phase 12 must `asarUnpack` the whole package directory | inlining it into `main.cjs` makes the require resolve next to the bundle and find nothing |
| bundled ConPTY (`build/Release/conpty/{conpty.dll,OpenConsole.exe}`, v1.23.251008001 here) is placed by node-pty's own post-install | install log | `useConpty: true` | these are launched as *files*, so they cannot live inside an asar either |
| `chokidar` | **5.0.0** | `workspace/FsService.ts` watcher | `ignored` is a `Matcher` **predicate**, not a glob (chokidar 4 dropped globs, 5 kept it that way) — `ignoredUnder(root)`; event names `add`/`change`/`unlink`/`addDir`/`unlinkDir` are exactly `FileChangeKindSchema` |
| `simple-git` | **3.36.0**; `checkIsRepo`, `status`, `diff`, `add`, `commit`, `revparse` | `workspace/GitService.ts` | the only six members touched, declared structurally as `GitClientLike`; `status().files[].{index,working_dir}` are the two porcelain columns `GitStatusEntry.status` joins |
| `git diff` emits **one** patch for all files | git's own format | `splitUnifiedDiff` splits on `diff --git` and takes the `+++ b/` path | splitting here rather than running git per file: a 200-file tree would otherwise be 200 spawns |
| Electron `WebContentsView` + `BaseWindow.contentView.addChildView/removeChildView`, `webContents.navigationHistory.{canGoBack,goBack,…}` | Electron 44.2.0 | `workspace/BrowserViewService.ts` (Omnigent's pattern; **never** the deprecated `<webview>`) | the view floats above the DOM, so the renderer must send `browser.setBounds` on every move and `browser.detach` on unmount — that is why bounds are on the contract |
| `taskkill /PID <pid> /T /F` | Windows built-in | stopping a dev server or terminal | run **synchronously**: `/T` walks the tree by parent pid, so an async taskkill followed by `child.kill()` races and orphans the grandchildren (measured — the "port stops answering" test caught it) |
| `netstat -ano -p tcp`, `LISTENING` rows | Windows built-in | `ports.findListenerPid` — "port 3000 is in use by PID 1234" | a failure yields `null` and the pane says "another process" instead of a PID; nothing else breaks |
| `.cmd` / `.bat` need `cmd.exe /d /s /c` | Node refuses to `CreateProcess` a batch file since CVE-2024-27980 | `DevServerService.resolveWindowsCommand` | a real `.exe` is spawned **directly** with an argv array — routing it through cmd puts two quote parsers in the path and node's `\"` escaping is not what cmd understands |
| `rg --files` when ripgrep is on PATH | optional | `FsService.search` | probed once per process; absent (as on this machine) the bounded walker answers instead |
| `docker compose -f <file> up <service>` | detector output only, never run by capygen itself | `detectors.detectCompose` | if the v1 `docker-compose` binary is all a machine has, the row still lists and the start fails visibly with docker's own message |

### Renderer side of the panes — dockview, xterm (SPEC R16, R17)

Added by Phase 5 tasks B2/B3 and pinned by task C's integration. Versions are the ones
installed in `apps/renderer/node_modules` on 2026-09-06, read back from each package's own
`package.json`, not from the range in the manifest.

| Item | Pinned / verified | Used by | If it changes |
|---|---|---|---|
| `dockview-react` | **8.2.0** (exact, no caret — the layout JSON this app persists is dockview's own `toJSON()` output) | `workspace/WorkspaceHost.tsx` | `layout.set` stores a `SerializedDockview` verbatim; a format change across a major would make every saved layout unreadable. `applySavedOrDefaultLayout` already falls back to the default when `fromJSON` throws, so the failure mode is "layout resets", not "workspace is dead" |
| `DockviewApi.onDidLayoutChange` / `onDidMaximizedGroupChange` are **separate** events | measured against 8.2.0 | `BrowserPane`'s bounds tracker | maximising rearranges the grid's presentation without changing the serialisable tree, so a native overlay that only listens to `onDidLayoutChange` lags a maximise until the 500 ms poll. e2e `(g)` asserts the two rectangles agree to 2px |
| `defaultRenderer="always"` | dockview's default is `onlyWhenVisible` | `WorkspaceHost` | the default **unmounts** every non-active tab, which kills an xterm's scrollback, stops a Servers pane hearing `servers.status` mid-start, and destroys a `WebContentsView`. Every capygen pane that owns a live resource depends on `always` |
| dockview's tab context menu (float/popout from a right-click) | **paid** `dockview-enterprise` "ContextMenu" module | not used | `getTabContextMenuItems` throws at runtime without it; float is still reachable by dragging a tab past the group edge |
| dockview tabs are **HTML5** drag sources (`draggable` + `dragstart`), and its pointer backend ignores mouse input on a fine-pointer device | measured while writing the e2e | `tests/e2e/workspace.spec.ts` `(e)` | a Playwright drag must be *stepped* (one jump produces no `dragover`) and must dwell in the target quadrant before releasing |
| `@xterm/xterm` **6.0.0** + `addon-fit` 0.11.0, `addon-web-links` 0.12.0, `addon-webgl` 0.19.0 | same pins Omnigent ships | `panes/terminal/TerminalPane.tsx` | WebGL failure is caught and falls back to the DOM renderer silently; the fit addon is what turns a pane resize into `terminal.resize` |
| xterm's `fontFamily` reaches a `CanvasRenderingContext2D.font` string and the WebGL atlas | Chromium behaviour | `xtermTheme.readXtermFontFamily` | a CSS `var(--font-mono)` is **not** resolvable there — Chromium drops the whole declaration and measures a proportional face, so the cursor lands in the wrong column. Colours have the same constraint, which is why both are read with `getComputedStyle` |
| under WebGL, xterm draws to a canvas and puts nothing in the DOM | xterm's own design | `tests/e2e/workspace.spec.ts` `(d)` | there is no DOM-element → `Terminal` lookup in xterm's API, so the pane hangs the instance on its own container (`__xterm`) and the e2e reads the public `buffer` API off it |

**Packaging (Phase 12) owes this section three things**, all Windows-specific and all silent
failures if missed:

1. `asarUnpack` `**/node_modules/node-pty/**` — the *whole* package directory, not just the
   `.node`: `conpty.dll` and `OpenConsole.exe` are launched as files and the loader also needs
   `lib/`, `build/Release/conpty/` and `prebuilds/win32-<arch>/`. A packaged build that skips
   this looks fine until someone opens the Terminal pane (ADR-0005 makes that an acceptance step).
2. `node-pty` stays **external** in `apps/desktop/scripts/build.ts` — its binding loader is a
   relative `require`, so inlining it into `main.cjs` makes that require resolve next to the
   bundle and find nothing.
3. Nothing else here needs unpacking: `chokidar`, `simple-git`, `dockview` and `xterm` are pure
   JS and ride inside the asar, and the SQLite driver is `node:sqlite` (ADR-0003), not an addon.
