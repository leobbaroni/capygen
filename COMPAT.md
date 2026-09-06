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
| `hookSpecificOutput.updatedInput.model` steers a sub-agent | spike §8.9, `sdk.d.ts:2577-2583` | routing policy (stubbed; the lever is wired) | fallback: deny the Task/Agent call and re-issue the work as a fresh `query()` with `options.model` |
| `result` is the turn boundary, one per turn | `sdk.d.ts:5000-5003` | turn status + usage | a second `result` per turn would double-count usage |
| `result.modelUsage` is **cumulative** in a streaming session | `sdk.d.ts:5036-5039` | per-turn usage is the delta (`deltaUsage`) | if it became per-turn, every turn after the first would under-report |
| `result.usage` is main-loop only | `sdk.d.ts:5032-5035` | fallback when `modelUsage` is empty (local slash commands) | — |
| `Query.interrupt()` | `sdk.d.ts:2615`, streaming input only | `chat.interrupt` | the harness still ends the turn after `interruptGraceMs` (5 s) |
| `system/init.slash_commands` / `.skills` / `.plugins` | `sdk.d.ts:5148-5208` | the slash menu (R14) | fallback: build the list from `~/.claude/commands`, `<repo>/.claude`, `installed_plugins.json` |
| slash commands are plain prompt text | spike §3 | `chat.send` passes the text through unchanged | — |
| ESM-only package, loaded with a runtime `import()` | `package.json` `"type": "module"` | `packages/engine/src/claude/sdk.ts` | it is **external** to the esbuild bundle (`apps/desktop/scripts/build.ts`): the SDK finds its bundled `claude.exe` through `createRequire(import.meta.url)`, which an inlined copy could not do. Verified inside Electron 44 (`node=24.20.0`, `query=function`) |
| SDK spawns the child with `windowsHide: true` | grep of `sdk.mjs` | no console flash on Windows | if it regresses, pass `Options.spawnClaudeCodeProcess` |

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
| server request `mcpServer/elicitation/request` → `{action, content, _meta}` | `v2/McpServerElicitationRequestParams.ts` | elicitation card (R32) | **declined today**: `EngineEvent` has no elicitation variant, so nothing can carry the answer back. `CodexHarness.answerElicitation` is the seam |
| server request `currentTime/read` → `{currentTimeAt}` | `ServerRequest.ts` | answered directly | every other server request is refused with `-32601` and Codex applies its own default |
| MCP App widgets: `mcpToolCall.appContext.resourceUri` (`ui://…`) + `result._meta` kept verbatim | `v2/McpToolCallAppContext.ts`, `v2/McpToolCallResult.ts` | `widget` block (R31) | stripping `_meta` makes the widget unrenderable |

Sign-in: ChatGPT OAuth (`account/read` → `{type:"chatgpt"}`). No API key is read or
stored by the Codex harness. An `unauthorized` turn error renders "run `codex login`".

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
| `cache_control: {type:"ephemeral"}` on the **system** block and on the **last** tool | SPEC R24 | `buildAnthropicBody` | one breakpoint covers the whole prefix (system + tools); asserted on the real request body in `test/api.test.ts` |
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
| `tools/call` result passed through whole (`content`, `structuredContent`, `_meta`) | MCP spec | `McpClientPool.callTool`, `tools/mcpTools.ts` | R31's widget host finds `ui://` in `_meta`; normalising the result would leave it nothing |
| MCP Apps `_meta` key `ui/resourceUri` (also nested `_meta.ui.resourceUri`), mime `text/html;profile=mcp-app` | `@modelcontextprotocol/ext-apps` `1.7.5` — `RESOURCE_URI_META_KEY` / `RESOURCE_MIME_TYPE` in `dist/src/server/index.js` | `widgetResourceUri` → the `widget` block (R31) | a renamed key means widget cards stop appearing; the tool card still renders |
| MCP server config sources, read-only | `<project>/.mcp.json`, `~/.claude/settings.json` `mcpServers`, `~/.codex/config.toml` `[mcp_servers.*]` | `mcp/client/config.ts` | precedence agent > project > Claude > Codex; capygen never writes these (Phase 6 owns editing) |

Keys: `${ANTHROPIC_API_KEY}` / `${OPENAI_API_KEY}` / `${OPENROUTER_API_KEY}` as a fallback only.
In the app they arrive through the injected `KeyProvider` (Electron `safeStorage`); the engine
never reads a key from disk and never logs one (`maskKey` is the only form allowed in a log).

## Internal seams

| Seam | Meaning |
|---|---|
| `CAPYGEN_ENGINE=stub` | run the offline echo engine instead of a real backend (the e2e suite sets it) |
| `CAPYGEN_USER_DATA_DIR` | isolated Electron profile |
| `CAPYGEN_PROJECT_DIR` / `--project=<dir>` | pre-select a project folder |
| `CAPYGEN_DEV_URL` | load the renderer from Vite |
