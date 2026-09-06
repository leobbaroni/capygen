export const meta = {
  name: 'capygen-phase3-harnesses',
  description: 'Phase 3: complete the harness layer — Codex app-server harness, API-model harness with local tool runtime + MCP client, MCP Apps widget host (spike first), structured interaction cards, slash menu + usage meter; integrate, live-prove, review and fix',
  phases: [
    { title: 'Contracts', detail: 'shared Block/IPC additions so parallel agents do not collide (Sonnet)' },
    { title: 'Build', detail: 'Codex harness (Opus) · API harness + tools + MCP (Opus) · MCP Apps spike + widget host (Opus) · cards/slash/usage/providers UI (Sonnet)' },
    { title: 'Integrate', detail: 'harness registry, fixtures for every block through every harness, live e2e (Opus)' },
    { title: 'Review', detail: 'four-lens adversarial review on the other model, then fixes' },
  ],
}

const ROOT = 'C:/Users/TugaPlayz/Desktop/GITHUB/capygen'
const REF = ROOT + '/reference/omnigent/web/src'
const PNPM = 'corepack pnpm --dir ' + ROOT
const COMMON = [
  'Repo: ' + ROOT + '. Read ' + ROOT + '/CLAUDE.md, ' + ROOT + '/SPEC.md (R6–R9, R14, R23–R27, R31, R32), ' + ROOT + '/PLAN.md (Phase 3), ' + ROOT + '/CONTEXT.md, ' + ROOT + '/docs/RUN.md and ' + ROOT + '/COMPAT.md first.',
  "Absolute paths everywhere. Package manager: 'corepack pnpm' (never bare pnpm). Windows 10, Node 22.16, Electron 44 (node:sqlite, no native modules — keep it that way unless the task says otherwise). Never push. Commit only when your task says so and only your own files (git add by path, never -A).",
  'Existing code you build on (read before writing): packages/shared/src/{domain.ts,ipc.ts,defineIpc.ts} (zod domain + typed IPC), packages/engine/src/harness.ts (Harness interface + EngineEvent), packages/engine/src/claude/ClaudeHarness.ts (the reference implementation of a harness: block keys, canUseTool → question/permission events, hooks, usage), packages/engine/src/env.ts (cleaned child env), apps/desktop/src/engine/{SessionRunner.ts,persist.ts,types.ts} (runs harnesses, persists blocks incrementally, forwards IPC events), apps/desktop/src/ipc/handlers.ts, apps/renderer/src/components/blocks/* (block renderers), apps/renderer/src/components/{Composer,SlashMenu,Transcript}.tsx, apps/renderer/src/store/appStore.ts, packages/db (repos + migrations).',
  'Phase 1 evidence (verified shapes): ' + ROOT + '/docs/spikes/claude-sdk-shapes.md, ' + ROOT + '/docs/spikes/codex-shapes.md (Codex SDK + app-server JSON-RPC; generated bindings under docs/spikes/codex-app-server-schema/v0.153.4-ts — the authoritative method/param types), ' + ROOT + '/docs/spikes/engine.md, spike scripts packages/engine/scripts/spike-codex.ts (working app-server client code: initialize, thread/start with approvalsReviewer "user", turn/start, item/commandExecution/requestApproval → {decision:"accept"}, thread/resume, turn/interrupt, skills/list, mcpServerStatus/list, model/list). Codex is signed in on this machine (ChatGPT). Claude Code is signed in (claude.ai OAuth).',
  'Design reference (read-only, never import): ' + REF + ' — Omnigent SPA; block/card components under ' + REF + '/components/{blocks,ai-elements,chat,ui}, permission modal ' + REF + '/components/PermissionsModal.tsx, slash menu ' + REF + '/components/SlashCommandMenu.tsx, usage UI under ' + REF + '/components/usage and ' + REF + '/pages/UsagePage.tsx.',
  'Efficiency rules (SPEC R23–R26): no per-turn system prompt churn, cache_control on system+tools for Anthropic API calls, lazy MCP tool schemas, truncated tool outputs with expandable stubs, incremental persistence, usage accounting per model.',
  'Every claim in your final report must be something you ran or read; paste each Done-when command + output tail. If something is impossible, say so explicitly with the evidence and the fallback you implemented.',
].join('\n')

phase('Contracts')
const contracts = await agent(COMMON + '\n' + [
  'TASK P0 — Shared contract additions (you own ONLY packages/shared/src/** and packages/db/migrations/0002_*.sql + the repo changes needed to persist new fields; nothing else). Keep every existing field and test green.',
  "1. Block union additions in domain.ts: kind 'widget' {toolCallId, serverName, toolName, resourceUri (ui://…), html?: string | null, htmlStatus: 'pending'|'ready'|'unavailable', toolInput, toolResult (structured content + content blocks), meta (the tool/result _meta), size?: {width?, height?}}; kind 'elicitation' {requestId, title?, description?, schema (JSON schema or Codex user-input fields), answers?: object|null, status}; extend 'permission' with {title?, displayName?, description?, suggestions?: array (updatedPermissions candidates), decision: 'allow'|'allow_always'|'deny'|null, reason?}; extend 'question' with {allowOther: boolean, otherText?: string|null}; extend 'tool_call' with {family: 'bash'|'read'|'write'|'edit'|'glob'|'grep'|'web'|'mcp'|'task'|'other', serverName?, truncated?: boolean, outputRef?: string (id of the full output stored separately)}; kind 'usage' gains byModel[] {model, input, output, cached, cacheWrite, costUsd}.",
  "2. Agent config: backend 'claude'|'codex'|'api'; config schema per backend: claude {model?, permissionMode?, effort?}, codex {model?, approvalPolicy?: 'untrusted'|'on-request'|'on-failure'|'never', sandbox?: 'read-only'|'workspace-write'|'danger-full-access', reasoningEffort?}, api {provider: 'anthropic'|'openai'|'openrouter', model, baseUrl?, maxTokens?, thinking?, permissionMode?}.",
  "3. IPC additions in ipc.ts: invoke harness.list → [{backend, label, available: boolean, reason?, models: [{id, label}], defaultModel}] ; chat.listCommands stays; secrets.set {provider, value} / secrets.has {provider} / secrets.delete {provider} (never returns the value); mcp.readResource {sessionId, agentId, serverName, uri} → {mimeType, text?|blob?}; widget.callTool {sessionId, agentId, blockId, name, args} → result; widget.event {blockId, type, payload} (renderer → main for host-side handling); elicitation.answer {sessionId, turnId, blockId, answers|null}; permission.answer accepts decision 'allow'|'allow_always'|'deny'; events: elicitation.request, widget.update (block upsert covers it — document that).",
  '4. DB: migration 0002 adding what the new block fields need (blocks are JSON in a column? check packages/db; if blocks are stored as JSON payloads, no schema change is needed — then add a tool_outputs table {id, block_id, content, created_at} for full outputs referenced by outputRef) and repo methods toolOutputs.put/get.',
  '5. Update packages/shared/src/ipc.test.ts and packages/db tests for the additions.',
  'Done when: ' + PNPM + ' typecheck ok and ' + PNPM + ' test green (the whole repo, not just your packages — if a downstream package breaks on a widened union, make the minimal compatible change there and list it). Commit "Phase 3: shared contracts for codex/api backends, widget/elicitation blocks, secrets/mcp IPC" with trailer "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>".',
  'Return: the exact new/changed type names and fields, the IPC channel list with payload shapes, and the migration summary — the next agents will code against your report.',
].join('\n'), { label: 'P0 contracts', phase: 'Contracts', model: 'sonnet' })
log('contracts: ' + String(contracts).slice(0, 160))
if (!contracts) throw new Error('contracts agent returned nothing')
const CONTRACTS = 'CONTRACT REPORT (the shared types/IPC you must code against; verify by reading packages/shared/src):\n' + contracts

phase('Build')
const codexP = agent(COMMON + '\n' + CONTRACTS + '\n' + [
  'TASK B1 — Codex harness via app-server (you own packages/engine/src/codex/**, packages/engine/test/codex*, packages/engine/scripts/live-codex.ts, and the minimal registry hook in packages/engine/src/index.ts; nothing else).',
  '1. CodexAppServerClient: spawn the bundled @openai/codex 0.153.4 binary (resolve like spike-codex.ts does) with "app-server", windowsHide, cleaned env (packages/engine/src/env.ts), JSON-RPC over stdio (newline-delimited; reuse the framing proven in spike-codex.ts), request/notification/serverRequest routing, timeouts, process exit handling.',
  "2. CodexHarness implements Harness: start → initialize + thread/start (cwd = project, model from config, approvalPolicy from config default 'on-request', sandbox default 'workspace-write', approvalsReviewer 'user') or thread/resume when a stored thread id exists; send → turn/start, map notifications: item/agentMessage/delta → text block deltas; reasoning items → thinking; commandExecution items → tool_call (family bash) with streamed output and exit code; fileChange items → tool_call family edit/write with diff block; mcpToolCall items → tool_call family mcp (serverName, toolName, structured result + _meta kept for the widget host); webSearch → web; server requests item/commandExecution/requestApproval and item/fileChange/requestApproval → permission events (decision accept/acceptForSession/decline mapped from allow/allow_always/deny); item/tool/requestUserInput (or the equivalent in the schema) → elicitation events; thread/tokenUsage/updated + turn/completed → usage (byModel with the thread model; cost from a small price table with [assumed] tag); turn/interrupt for interrupt(); errors → error block + turn:error; listCommands → built-ins (/compact → thread/compact/start, /review → review/start, /model, /status, /clear) + skills/list; capabilities → models from model/list (static fallback), approvals supported, mcp servers from mcpServerStatus/list.",
  '3. Tests with a fake transport replaying recorded frames (take real frames from docs/spikes/codex.raw.json where useful): text turn, command approval round-trip, file change diff, mcp tool call, interrupt, resume.',
  '4. packages/engine/scripts/live-codex.ts: real turn "Reply with exactly the word pong." and a second turn that runs a command requiring approval, answering accept programmatically; print blocks + usage.',
  'Done when (paste outputs): ' + PNPM + ' typecheck ok; ' + PNPM + ' test green; live script prints "pong" and a completed approval. Add COMPAT.md rows for every app-server method/notification you depend on (Codex 0.153.4). Commit "Phase 3: Codex app-server harness" with trailer "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>".',
  'Return: the notification → block mapping table, config knobs, approval/elicitation payloads, known limitations.',
].join('\n'), { label: 'B1 codex harness', phase: 'Build', model: 'opus', effort: 'high' })

const apiP = agent(COMMON + '\n' + CONTRACTS + '\n' + [
  'TASK B2 — API-model harness + local tool runtime + MCP client (you own packages/engine/src/api/**, packages/engine/src/tools/**, packages/engine/src/mcp/client/** (the generic MCP client only — the widget host belongs to another agent), packages/engine/test/api*, tools*, mcpClient*, packages/engine/scripts/live-api.ts; nothing else).',
  '1. Providers: anthropic via @anthropic-ai/sdk (Messages API streaming, tools, cache_control ephemeral on the system prompt and on the tool definitions block, thinking when configured); openai via the openai SDK Responses API (streaming, function tools, reasoning effort); openrouter = openai SDK with baseURL https://openrouter.ai/api/v1 and the app headers. Keys come from a KeyProvider injected by the desktop (never read files yourself); env vars ANTHROPIC_API_KEY/OPENAI_API_KEY/OPENROUTER_API_KEY as fallback.',
  "2. Agent loop (ApiHarness implements Harness): system prompt = one stable capygen prompt (cwd, OS, tool guidance) that never changes within a session (R24); messages persisted/replayed from the session's turns; tool loop until end_turn or maxTurns; interrupt via AbortController; block keys as in ClaudeHarness; usage per response (input, output, cache read/write) with a price table (tag [assumed] with the date) → usage byModel.",
  '3. Local tool runtime packages/engine/src/tools/: read_file (with line ranges), write_file, edit_file (exact string replace, must-be-unique), list_dir, glob (fast-glob or a tiny walker), grep (ripgrep if on PATH else JS fallback), bash (PowerShell on Windows: powershell -NoProfile -Command with cwd, timeout, output cap 64 KB → stub + outputRef), web_fetch (https only, size cap, text extraction), ask_user_question (same shape as Claude: questions/options/multiSelect, allowOther) → question event; each tool declares a permission class (read/write/execute/network) and the harness raises permission events per permissionMode (default: ask for write/execute/network; acceptEdits; bypass).',
  "4. Generic MCP client packages/engine/src/mcp/client/: @modelcontextprotocol/sdk Client over stdio and streamable HTTP, config loaded from the agent/session config (and, read-only, from ~/.claude/settings.json mcpServers + project .mcp.json + ~/.codex/config.toml [mcp_servers] so the API harness sees the same servers the CLIs see); tools listed lazily on first use (R26); tool results passed through with content + structuredContent + _meta intact (the widget host needs _meta); resources/read supported (the widget host will call it).",
  '5. Tests: mocked provider clients (record/replay JSON) covering: text, tool loop with read+edit, permission ask/deny, ask_user_question round-trip, usage/cost, cache_control present on system+tools (assert the request body), MCP stdio server fixture (a tiny in-repo MCP server script) listing tools lazily and calling one.',
  '6. live-api.ts: runs only if a key is available (env or KeyProvider), otherwise prints SKIP with the reason.',
  'Done when (paste outputs): ' + PNPM + ' typecheck ok; ' + PNPM + ' test green; live script prints SKIP or pong. Add COMPAT.md rows for the provider SDK versions and MCP SDK version. Commit "Phase 3: API-model harness, local tool runtime, MCP client" with trailer "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>".',
  'Return: tool list with permission classes, provider config, how keys are injected, MCP config sources, limitations.',
].join('\n'), { label: 'B2 api harness+tools+mcp', phase: 'Build', model: 'opus', effort: 'high' })

const widgetP = agent(COMMON + '\n' + CONTRACTS + '\n' + [
  'TASK B3 — MCP Apps widget host: spike, then implementation (you own docs/spikes/mcp-apps.md, packages/engine/src/mcp/apps/**, packages/engine/scripts/spike-mcp-apps.ts, apps/renderer/src/components/blocks/WidgetCard.tsx + apps/renderer/src/widgets/** (the iframe host + bridge), tests/fixtures/mcp-apps-server/** (fixture server), and the widget-related IPC handlers in apps/desktop/src/ipc/widgets.ts; you may add ext-apps as a dependency of the packages that need it).',
  'SPIKE FIRST (write docs/spikes/mcp-apps.md with evidence):',
  '  a) Read the MCP Apps spec + host API in node_modules/@modelcontextprotocol/ext-apps (README, dist/*.d.ts, examples/basic-host if shipped) — how a tool declares its ui:// resource in _meta, what the host must send (ui/initialize, tool input, tool result, size, theme), how the app calls tools through the host, sandboxing rules (iframe sandbox attrs, CSP).',
  '  b) Claude backend: with the SDK (see spike-claude.ts patterns), register the ext-apps example server (or a tiny fixture server you write with ext-apps server SDK exposing one tool with a ui:// resource) via options.mcpServers and run a query that calls it; record EXACTLY what the stream exposes for that tool call: tool_use, tool_result content, tool_use_result, _meta, resource_links, structuredContent. Then test the resource read paths available to the host: (1) capygen connecting its own MCP client to the same server config and calling resources/read on the ui:// uri; (2) any SDK/CLI surface that returns the resource. Record which works.',
  '  c) Claude backend + claude.ai connector: the user has the Higgsfield connector (claudeai-proxy, see init.mcp_servers). Run a query that calls its balance tool (free) or generate_image with get_cost:true (returns cost only, spends nothing; NEVER call a generating tool without get_cost) and record what the stream exposes (_meta with ui resource? structuredContent? images?). If the widget HTML cannot be fetched for proxy connectors (no direct client access), document the fallback: a rich generic result card (images from URLs, links, JSON tree, action-less) and note what Claude Code desktop does differently.',
  '  d) Codex backend: check the app-server schema for mcpToolCall item fields (_meta, structuredContent) and whether the app-server exposes resources/read (search the v0.153.4-ts bindings). Record.',
  'THEN IMPLEMENT the verified path:',
  '  1. packages/engine/src/mcp/apps/: WidgetHostBridge (main-process side): given a tool_call with ui _meta, resolve the ui:// HTML (own MCP client resources/read via the generic client from packages/engine/src/mcp/client if present, else the fallback), produce the widget block (htmlStatus ready/unavailable), and serve widget.callTool by calling the tool through the same server; keep per-widget state.',
  '  2. Renderer WidgetCard: sandboxed <iframe sandbox="allow-scripts allow-forms" (no allow-same-origin), srcdoc = html, CSP meta injected, ext-apps host protocol over postMessage (ui/initialize handshake, deliver tool input + result, size-change → iframe height, theme → light/dark, ui/callTool → widget.callTool IPC, open-link → external browser via a main handler, save/download → main dialog), loading + unavailable states (fallback rich card), matching the Claude Code look in the user\'s screenshot (card with the widget, header "Widget from <server> <tool>", collapsible prompt).',
  '  3. Fixture: tests/fixtures/mcp-apps-server (ext-apps server SDK) with a tool "show_card" whose widget renders the input and has a button that calls a second tool "echo" through the host; vitest tests for the bridge (resource resolution, callTool) and an e2e (tests/e2e/widget.spec.ts) that registers the fixture server for a Claude session (project .mcp.json in the temp project), asks Claude to call show_card, and asserts the iframe renders and the button round-trip works.',
  'Done when (paste outputs): docs/spikes/mcp-apps.md has evidence for a–d; ' + PNPM + ' typecheck ok; ' + PNPM + ' test green; widget e2e green (spends a few cents; ok). Add COMPAT.md rows (ext-apps version, MCP Apps protocol messages used). Commit "Phase 3: MCP Apps widget host + spike" with trailer "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>".',
  'Return: the verified resolution path per backend/server type, the fallback, the host messages implemented, and what Higgsfield showed.',
].join('\n'), { label: 'B3 mcp apps widgets', phase: 'Build', model: 'opus', effort: 'high' })

const cardsP = agent(COMMON + '\n' + CONTRACTS + '\n' + [
  'TASK B4 — Interaction cards, tool cards, slash menu, usage meter, providers page (you own apps/renderer/src/** EXCEPT apps/renderer/src/components/blocks/WidgetCard.tsx and apps/renderer/src/widgets/** and apps/renderer/src/brand/**; plus apps/desktop/src/ipc/secrets.ts (safeStorage-backed secrets.set/has/delete) and apps/desktop/src/ipc/harnessList.ts (harness.list handler that asks the engine registry; if the registry does not exist yet, implement it against the Harness interface with claude + placeholders and mark it clearly for the integrator).',
  '1. PermissionCard: title/displayName/description from the block (Claude _meta permissionDisplay), the tool input summary, buttons Allow once / Allow for session (allow_always) / Deny, optional reason field on deny, keyboard shortcuts (Enter allow, Esc deny), pending/answered/expired states — modelled on ' + REF + '/components/PermissionsModal.tsx and Claude Code\'s prompt.',
  '2. QuestionCard: option buttons + multiSelect checkboxes, "Other" free-text row when allowOther, submit; answered state shows the answer; ElicitationCard: form generated from the schema/fields (text, number, boolean, enum), submit/cancel.',
  "3. ToolCallCard per family: bash (command, streamed output, exit code), read (path, line range, collapsed content), write/edit (file path + DiffCard), glob/grep (pattern → matching list), web (url → title), mcp (server · tool, input JSON, result content: text/images/JSON tree), task (subagent, links to the subagent block), other; truncated outputs show the stub with 'Show full output' fetching tool_outputs via IPC (add turns/blocks.getOutput if missing — coordinate through packages/shared minimal addition and report it). Match the reference blocks under " + REF + '/components/blocks and ai-elements.',
  '4. Slash menu: groups Built-ins / Skills / Plugins / Backend commands from chat.listCommands (per active agent), argument hint, insert-then-edit for commands with arguments, Enter runs argument-less commands, keyboard navigation; matches ' + REF + '/components/SlashCommandMenu.tsx.',
  '5. Usage: per-turn UsageLine with byModel breakdown tooltip; session header meter (tokens in/out/cached · cost) fed from usage_events via a turns/usage IPC (add minimal IPC if missing); Settings ▸ Providers & API keys page: provider rows (Anthropic, OpenAI, OpenRouter) with Set key (masked input, never shown back), Remove, "has key" state via secrets.has; harness picker in the composer lists harness.list entries (Claude Code / Codex / API model → then model dropdown) and stores the choice in the session\'s agent config.',
  '6. Tests: vitest + RTL for every card state, slash menu behaviour, providers page (secrets IPC mocked), usage meter.',
  'Done when (paste outputs): ' + PNPM + ' typecheck ok; ' + PNPM + ' test green; ' + PNPM + ' build ok; screenshots e2e-out/cards.png (a fixture transcript rendering every card kind — add a dev route or a storybook-free fixture page /dev/cards gated to non-production) and e2e-out/providers.png. Commit "Phase 3: interaction cards, tool cards, slash menu, usage meter, providers page" with trailer "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>".',
  'Return: component map, IPC additions you made, screenshots, commands + output tails.',
].join('\n'), { label: 'B4 cards+slash+usage UI', phase: 'Build', model: 'sonnet' })

const [codex, api, widget, cards] = await Promise.all([codexP, apiP, widgetP, cardsP])
log('build: codex ' + (codex ? 'ok' : 'MISSING') + ' · api ' + (api ? 'ok' : 'MISSING') + ' · widget ' + (widget ? 'ok' : 'MISSING') + ' · cards ' + (cards ? 'ok' : 'MISSING'))

phase('Integrate')
const integ = await agent(COMMON + '\n' + CONTRACTS + '\nCODEX REPORT:\n' + codex + '\nAPI REPORT:\n' + api + '\nWIDGET REPORT:\n' + widget + '\nCARDS REPORT:\n' + cards + '\n' + [
  'TASK C — Integrate Phase 3 and prove it (you may edit anything; keep the structure others built).',
  '1. Harness registry in packages/engine (claude, codex, api) used by SessionRunner: the composer\'s backend/model choice creates the agent with that backend; harness.list reports availability (claude signed in? codex signed in via account/read? api key present?) with reasons; chat.listCommands per backend; permission/question/elicitation answers routed to the right harness; widget IPC wired; secrets KeyProvider wired into the API harness.',
  '2. Fixture matrix test (vitest): for each harness, a recorded event stream that produces every Block kind (text, thinking, tool_call of each family, diff, permission, question, elicitation, subagent, widget, error, usage) → persisted rows + renderer snapshot via RTL (a "block parity" test that fails if a kind is missing for a backend where it is applicable; document inapplicable kinds per backend).',
  '3. Live e2e additions (tests/e2e/harnesses.spec.ts): (a) Codex session: "Reply with exactly the word pong." → pong + usage; (b) Codex approval: a prompt that runs a shell command → permission card → Allow → output shown; (c) Claude slash menu: typing "/" lists Built-ins and Skills including a cockpit: entry; (d) API model: only if a key is present in secrets/env, else test.skip with reason.',
  '4. Run the full gate: ' + PNPM + ' typecheck, test, build, e2e — fix until green. Then update PLAN.md (tick Phase 3 only if its Done-when holds; record deviations), PROJECT_LOG.md (one entry), COMPAT.md, docs/RUN.md. Commit "Phase 3: harness layer integrated — Claude/Codex/API, widgets, cards; e2e green" with trailer "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>".',
  'Return: the four command output tails, e2e list with timings, explicit list of anything not achieved, and the riskiest code paths (file:line) for reviewers.',
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
  { key: 'correctness', model: 'sonnet', prompt: 'Correctness of the Codex harness, API harness/tool loop, MCP client and widget bridge: protocol framing, request/notification routing, approval/elicitation round-trips, interrupt/resume, error propagation, Windows path/quoting in the bash tool, race conditions. Read packages/engine/src/** (codex, api, tools, mcp) and apps/desktop/src/engine/** + ipc/** fully.' },
  { key: 'security', model: 'sonnet', prompt: 'Security: widget iframe sandboxing/CSP and the postMessage bridge (origin checks, message validation, what a hostile widget can reach), tool runtime (path traversal outside the project, command injection, web_fetch SSRF), secrets handling (safeStorage, never logged, never in renderer), MCP server spawning env, IPC sender validation. Read apps/renderer/src/widgets/**, packages/engine/src/{tools,mcp,api}/**, apps/desktop/src/ipc/**.' },
  { key: 'ux-parity', model: 'opus', prompt: 'UI parity vs the reference ' + REF + ' and vs Claude Code for the new cards (permission, question with Other, elicitation, tool families, widget card, slash menu groups, usage meter, providers page, harness picker): look at ' + ROOT + '/e2e-out/*.png and read apps/renderer/src/components/**; list concrete deviations and broken states.' },
  { key: 'efficiency', model: 'sonnet', prompt: 'Token/context efficiency (SPEC R23–R26) across the three harnesses: stable system prompt, cache_control placement, lazy MCP schemas, tool output truncation + outputRef, no IPC/UI leakage into model context, usage accounting per model and cost table correctness. Read packages/engine/src/** and apps/desktop/src/engine/**.' },
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
    'TASK D — Fix verified review findings from the Phase 3 review wave, then re-run the full gate.',
    'Findings (JSON): ' + JSON.stringify(serious, null, 2),
    'Low-severity findings (fix only if trivial): ' + JSON.stringify(all.filter((f) => f.severity === 'low'), null, 2),
    'For each finding: reproduce or confirm it in code, fix it minimally, add/adjust a test where the finding was behavioural. Then run ' + PNPM + ' typecheck, test, build, e2e until green. Commit "Phase 3: review fixes" with trailer "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>". Return: per finding → fixed / not-a-bug (reason) / deferred (reason), and the command output tails.',
  ].join('\n'), { label: 'D fixes', phase: 'Review', model: 'opus', effort: 'high' })
}

return { contracts: String(contracts).slice(0, 2000), codex: String(codex).slice(0, 2500), api: String(api).slice(0, 2500), widget: String(widget).slice(0, 3500), cards: String(cards).slice(0, 2000), integ: String(integ).slice(0, 4000), findings: all, fixReport: fixReport ? String(fixReport).slice(0, 4000) : null }
