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
| `thread/compact/start`, `review/start`, `thread/settings/update` | `CODEX_METHODS` in `codex/protocol.ts` | `/compact`, `/review`, `/model` | slash commands are **not** a protocol concept (spike §2): each built-in maps onto one of these, everything else is prompt text |
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

## Internal seams

| Seam | Meaning |
|---|---|
| `CAPYGEN_ENGINE=stub` | run the offline echo engine instead of a real backend (the e2e suite sets it) |
| `CAPYGEN_ENGINE=stub-roundtable` | the same echo engine with `peerMentions`: every reply ends `over to @<next agent>` and dispatch runs through the **real** `createRoundTable`. It is how `tests/e2e/roundtable.spec.ts` proves the hop cap (R11) without a model — a loop bound must not be proved with something that might choose to stop on its own |
| `CAPYGEN_USER_DATA_DIR` | isolated Electron profile |
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
