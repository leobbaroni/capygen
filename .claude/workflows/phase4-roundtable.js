export const meta = {
  name: 'capygen-phase4-roundtable',
  description: 'Phase 4: round-table + solo session modes, mention dispatcher with hop cap, sub-agent routing policy (same-backend model routing + cross-backend delegation), agents pane/info cards, Codex sub-agent blocks; integrate, live-prove, review, fix',
  phases: [
    { title: 'Contracts', detail: 'session mode/agents/settings contracts + migration (Sonnet)' },
    { title: 'Build', detail: 'dispatcher + routing (Opus) · agents UI (Sonnet) · Codex sub-agents + agent descriptions (Sonnet)' },
    { title: 'Integrate', detail: 'wire, live round-table e2e, hop cap, routed sub-agent, info card (Opus)' },
    { title: 'Review', detail: 'four-lens review on the other model, then fixes' },
  ],
}

const ROOT = 'C:/Users/TugaPlayz/Desktop/GITHUB/capygen'
const REF = ROOT + '/reference/omnigent/web/src'
const PNPM = 'corepack pnpm --dir ' + ROOT
const COMMON = [
  'Repo: ' + ROOT + '. Read ' + ROOT + '/CLAUDE.md, ' + ROOT + '/SPEC.md (R10–R13, R23, R27), ' + ROOT + '/PLAN.md (Phase 4), ' + ROOT + '/CONTEXT.md, ' + ROOT + '/docs/adr/0002-round-table-session-model.md, ' + ROOT + '/docs/RUN.md, ' + ROOT + '/COMPAT.md first.',
  "Absolute paths everywhere. Package manager: 'corepack pnpm' (never bare pnpm). Windows 10, Node 22.16, Electron 44 (node:sqlite; no native modules). Never push. Commit only when your task says so and only your own files (git add by path, never -A). Other agents work in this same worktree in parallel: the repo-wide test suite may be red because of their in-flight files — report that precisely (which files, whose) and make sure the tests you own and the packages you own are green.",
  'Existing code (read before writing): packages/shared/src/{domain.ts,ipc.ts,blockParity.ts}, packages/engine/src/{harness.ts,index.ts}, packages/engine/src/claude/ClaudeHarness.ts (PreToolUse hook on Task|Agent with routeSubagent dep — the routing lever proven in docs/spikes/engine.md: hookSpecificOutput.updatedInput.model reroutes a Claude sub-agent to another Claude model), packages/engine/src/codex/CodexHarness.ts, packages/engine/src/api/**, apps/desktop/src/engine/{SessionRunner.ts,persist.ts,history.ts,types.ts}, apps/desktop/src/ipc/handlers.ts, apps/renderer/src/{store/appStore.ts,components/Composer.tsx,components/Transcript.tsx,pages/LandingPage.tsx,pages/ChatPage.tsx,shell/*}.',
  'Design reference (read-only, never import): ' + REF + ' — agents UI: ' + REF + '/components/{AgentCard,AgentHoverCard,AgentInfo}.tsx, ' + REF + '/shell/{AddAgentDialog,CreateAgentDialog}.tsx, agent tree / workspace rail in ' + REF + '/pages/ChatPage.tsx and ' + REF + '/shell/AppShell.tsx, cost routing control ' + REF + '/components/CostRoutingControl.tsx.',
  'Round-table rules (ADR-0002, SPEC R11): a user message goes to the @-mentioned agents in mention order, none mentioned → the lead; agents may @-mention each other; an agent-to-agent chain stops after the session hop cap (default 3) until the user speaks or presses Continue; solo mode = round-table with exactly one agent, one code path. Each backend keeps its own conversation: Claude and Codex are stateful (resume ids), so they receive the OTHER speakers\' turns since their last turn as labelled context prepended to the message ("[@codex]: …"), never the whole transcript again (R23); the api backend replays the shared transcript with speaker labels via history.ts.',
  'Efficiency rules (SPEC R23–R26) apply: no per-turn system prompt churn (session-stable prompt additions only, set once at start/resume), no re-sending whole transcripts to stateful backends, usage per agent.',
  'Every claim in your final report must be something you ran or read; paste each Done-when command + output tail.',
].join('\n')

phase('Contracts')
const contracts = await agent(COMMON + '\n' + [
  'TASK P0 — Contracts for Phase 4 (you own ONLY packages/shared/src/**, packages/db/migrations/0003_*.sql, packages/db/src/** and their tests; plus the minimal compatibility edits elsewhere needed to keep the repo green, listed in your report).',
  "1. Session: mode 'solo'|'round-table' already exists — add settings {hopCap: number (default 3), routing?: {subagents?: {backend?: 'claude'|'codex'|'api', model?: string}}, parallelAgents?: boolean (default false)}; Agent gains {displayName, mentionName (unique per session, lowercase, no spaces), role: 'lead'|'member', description?: string, subagentRouting?: {backend?, model?}, color?: string, order}; Turn gains {mentions: string[] (agent ids addressed), triggeredByTurnId?: string, hopIndex (exists), speakerLabel?}; SubagentBlock gains {backend?, model?, parentAgentId?, costUsd?, description?, delegated?: boolean (ran via capygen delegation rather than the backend's own spawn)}.",
  "2. IPC: agents.list {sessionId}; agents.add {sessionId, backend, model, displayName?, mentionName?, role?, config?}; agents.update {agentId, patch}; agents.remove {agentId}; agents.setLead {sessionId, agentId}; sessions.setMode {sessionId, mode}; sessions.updateSettings {sessionId, patch}; chat.continue {sessionId} (resume a chain stopped by the hop cap); agents.describe {agentId} → {description, capabilities: string[], tools: string[], model, backend, usage: {input, output, cached, costUsd}, others: [{agentId, mentionName, backend, model}]}; events: agents.updated {sessionId, agents}, chat.chainStopped {sessionId, turnId, reason: 'hop_cap'|'error'}.",
  '3. Migration 0003 for the new columns (JSON columns where the field is structured); repos updated; tests.',
  'Done when: ' + PNPM + ' typecheck ok and ' + PNPM + ' test green repo-wide. Commit "Phase 4: contracts for session modes, agents, dispatcher, routing" with trailer "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>".',
  'Return: exact type/field names, IPC payloads, migration summary.',
].join('\n'), { label: 'P0 contracts', phase: 'Contracts', model: 'sonnet' })
if (!contracts) throw new Error('contracts agent returned nothing')
const CONTRACTS = 'CONTRACT REPORT (code against these; verify by reading packages/shared/src):\n' + contracts

phase('Build')
const dispatcherP = agent(COMMON + '\n' + CONTRACTS + '\n' + [
  'TASK B1 — Dispatcher + sub-agent routing (you own packages/engine/src/roundtable/**, packages/engine/src/routing/**, packages/engine/test/roundtable*, routing*, apps/desktop/src/engine/** (SessionRunner and friends), apps/desktop/test/sessionRunner*, and the engine-related IPC handlers in apps/desktop/src/ipc/handlers.ts; nothing in apps/renderer).',
  '1. Mention parser (packages/engine/src/roundtable/mentions.ts): @mentionName tokens (case-insensitive, word-bounded, ignores emails/code spans), resolves against the session agents, preserves order, dedupes.',
  '2. Dispatcher (packages/engine/src/roundtable/dispatcher.ts + integration in SessionRunner): user message → target agents (mentions or lead) → one agent turn each, sequential by default (parallelAgents=true runs them concurrently, transcript order = completion order with a stable index); after an agent turn completes, parse its text for mentions of OTHER agents → enqueue their turns with hopIndex+1 and triggeredByTurnId; stop when hopIndex would exceed hopCap → emit chat.chainStopped {reason:"hop_cap"} and persist a system turn "Chain stopped after N hops"; chat.continue resumes the stopped chain; the user sending a new message resets hop counting; interrupt stops the whole chain. Context assembly per backend: for stateful backends (claude, codex) build the delta of other speakers\' turns since that agent\'s last turn as a compact labelled prefix ("[@alice (Claude Code)]: …") + the addressed message; for api agents rely on history.ts with speaker labels; all agents get a session-stable prompt addition (set once at harness start) that names the round-table participants and the mention convention; never re-send it per turn.',
  '3. Routing policy (packages/engine/src/routing/policy.ts): resolve(agentConfig, sessionSettings, spawnRequest) → {backend, model} | null (fail-open). Claude same-backend: PreToolUse hook on Task|Agent returns updatedInput.model (already proven) — implement via the existing routeSubagent dep and record the decision as a subagent block {backend, model, delegated:false}. Cross-backend delegation (e.g. Claude lead → Codex sub-agent): expose a capygen in-process MCP tool "delegate_task" (Claude: SDK createSdkMcpServer; Codex/api: registered in the harness tool list) whose implementation runs a short-lived sub-agent turn on the routed backend/model in the same project (through the harness registry), streams it as a subagent block (delegated:true, with nested blocks or a summary), and returns the result text to the caller; the session-stable prompt addition tells the lead when to use it (only when routing says sub-agents go to another backend). Fail-open everywhere: any routing failure → the backend\'s own spawn proceeds untouched.',
  '4. Tests (fake harnesses): mentions; lead fallback; two agents ping-pong stops at hopCap=3 with chainStopped; continue resumes exactly one more hop; interrupt cancels queued turns; context delta contains only turns since the agent\'s last turn; parallelAgents ordering; routing resolve precedence (agent override > session rule > none); delegate_task runs on the routed backend (fake registry) and returns text; routing failure falls open.',
  'Done when (paste outputs): ' + PNPM + ' typecheck ok; the engine and desktop vitest projects green (' + PNPM + ' exec vitest run --project engine --project desktop); ' + PNPM + ' test repo-wide reported honestly. Commit "Phase 4: round-table dispatcher, hop cap, sub-agent routing + delegation" with trailer "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>". Write docs/adr/0004-subagent-routing.md (decision: hook-based model routing for same backend, delegate_task tool for cross-backend, fail-open).',
  'Return: dispatcher semantics as implemented, the prompt addition text, delegate_task schema, and IPC handler changes.',
].join('\n'), { label: 'B1 dispatcher+routing', phase: 'Build', model: 'opus', effort: 'high' })

const agentsUiP = agent(COMMON + '\n' + CONTRACTS + '\n' + [
  'TASK B2 — Agents UI (you own apps/renderer/src/** except brand/** and widgets/**; do not touch packages/engine or apps/desktop).',
  '1. Landing + composer: mode picker (Solo orchestrator / Round-table) next to the harness picker; in round-table mode an "Agents" chip opens the Add agent dialog (port ' + REF + '/shell/AddAgentDialog.tsx + CreateAgentDialog.tsx look): backend, model, display name, mention name (auto from display name), role, per-agent sub-agent routing (backend/model) and description; the session is created with all agents (agents.add after sessions.create, or a create payload if the contract has one).',
  '2. Chat page: speaker labels on agent turns (avatar/colour per agent, mention name, backend badge) like the reference AgentCard; @mention autocomplete in the composer (typing "@" lists the session agents; Enter/Tab inserts @mentionName); hop badge for agent-to-agent turns; "Chain stopped after N hops — Continue" bar wired to chat.continue; mode switch in the chat header (sessions.setMode) with a confirm when going round-table → solo with >1 agents (keeps history, others become inactive members).',
  '3. Agents pane (workspace rail, right side like the reference workspace): tree of session agents → their sub-agents (subagent blocks grouped by parentAgentId, status, model, cost), click → Agent info drawer (port ' + REF + '/components/AgentInfo.tsx + AgentHoverCard.tsx): description (from agents.describe), capabilities, tools, model/backend, usage so far, the other agents in the session with their roles — this is the Claude-Code-style "usage description for the orchestrator (and info on the other agents)" from SPEC R13. Hover card on speaker labels.',
  '4. Settings: session settings sheet (hop cap, parallel agents, sub-agent routing rule) reachable from the chat header gear.',
  '5. Tests: RTL for mention autocomplete, mode picker, add-agent dialog validation (unique mention names), agents pane tree, info drawer, chain-stopped bar.',
  'Done when (paste outputs): ' + PNPM + ' typecheck ok; the renderer vitest project green (' + PNPM + ' exec vitest run --project renderer); ' + PNPM + ' build ok; screenshots via a fixture route /dev/agents (non-production) saved to e2e-out/agents-pane.png and e2e-out/add-agent.png. Commit "Phase 4: round-table UI — mode picker, add agent, mentions, agents pane, info drawer" with trailer "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>".',
  'Return: component map, IPC used, screenshots, commands + output tails.',
].join('\n'), { label: 'B2 agents UI', phase: 'Build', model: 'sonnet' })

const codexSubP = agent(COMMON + '\n' + CONTRACTS + '\n' + [
  'TASK B3 — Codex sub-agent blocks + agent descriptions for all harnesses (you own packages/engine/src/codex/** (sub-agent parts only), packages/engine/src/describe/**, packages/engine/src/claude/describe.ts, packages/engine/src/api/describe.ts, their tests, and the agents.describe IPC handler file apps/desktop/src/ipc/agentsDescribe.ts; nothing else).',
  '1. CodexHarness: map collabAgentToolCall / subAgentActivity items (see docs/spikes/codex-app-server-schema/v0.153.4-ts for the exact fields) to subagent blocks {backend:"codex", model, status, description, costUsd if derivable}, nested tool activity summarised inside the block; tests with recorded frames (write realistic frames from the bindings if no raw log has them, and say so).',
  '2. describe(agent): for claude — from the harness init cache: model, tools (names grouped), skills count, plugins, MCP servers, permission mode, plus a generated one-paragraph usage description in Claude Code\'s style ("Lead agent on Claude Code (claude-sonnet-5). Can read/edit files, run commands, browse, use N skills…"); for codex — model, sandbox/approval policy, MCP servers, skills; for api — provider/model, capygen tools, MCP servers; include usage totals from usage_events (query via a provided repo function) and the other agents list.',
  'Done when: ' + PNPM + ' typecheck ok; engine + desktop vitest projects green; commit "Phase 4: Codex sub-agent blocks, agent descriptions" with trailer "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>".',
  'Return: mapping + describe() output samples for each backend.',
].join('\n'), { label: 'B3 codex subagents+describe', phase: 'Build', model: 'sonnet' })

const [dispatcher, agentsUi, codexSub] = await Promise.all([dispatcherP, agentsUiP, codexSubP])
log('build: dispatcher ' + (dispatcher ? 'ok' : 'MISSING') + ' · agentsUi ' + (agentsUi ? 'ok' : 'MISSING') + ' · codexSub ' + (codexSub ? 'ok' : 'MISSING'))

phase('Integrate')
const integ = await agent(COMMON + '\n' + CONTRACTS + '\nDISPATCHER REPORT:\n' + dispatcher + '\nAGENTS UI REPORT:\n' + agentsUi + '\nCODEX SUBAGENT/DESCRIBE REPORT:\n' + codexSub + '\n' + [
  'TASK C — Integrate Phase 4 and prove it (you may edit anything; keep the structure others built).',
  '1. Wire everything end to end: mode + agents from the landing → dispatcher → speaker-labelled turns → agents pane → info drawer; delegate_task and hook routing reachable from a real session; chain-stopped bar + continue.',
  '2. Live e2e (tests/e2e/roundtable.spec.ts): (a) round-table session with @claude (Claude Code) and @codex (Codex): send "@claude write a haiku about capybaras. @codex review what @claude wrote in one sentence." → two agent turns in order (Claude first, then Codex), Codex\'s turn references the haiku (context delta worked); screenshot e2e-out/roundtable.png; (b) hop cap: with fake/stub harnesses (CAPYGEN_ENGINE=stub extended to mention the other agent every time), a ping-pong stops at 3 hops with the Continue bar, Continue yields exactly one more hop; (c) routed sub-agent: solo Claude session with subagentRouting {backend:"claude", model:"haiku"}, prompt "Use the Task tool to spawn a subagent that counts the .md files here and report the number" → the agents pane shows a sub-agent whose model is a haiku id (assert from the subagent block); (d) cross-backend delegation: Claude lead with routing {backend:"codex"}, prompt "Delegate to a sub-agent: reply with the word pong" → a delegated subagent block with backend codex and the lead\'s reply contains pong; (e) agent info drawer shows description, model, tools and the other agent.',
  '3. Full gate: ' + PNPM + ' typecheck, test, build, exec playwright test — fix until green (the pre-existing API-key skip is fine). Update PLAN.md (tick Phase 4 only if its Done-when holds; record deviations), PROJECT_LOG.md, COMPAT.md, docs/RUN.md. Commit "Phase 4: round-table + routing integrated; e2e green" with trailer "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>".',
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
  { key: 'correctness', model: 'sonnet', prompt: 'Correctness of the dispatcher, hop cap, context delta assembly, queueing/interrupt/continue, delegate_task lifecycle, routing precedence, persistence of triggeredByTurnId/hopIndex, concurrency when parallelAgents is on. Read packages/engine/src/{roundtable,routing}/** and apps/desktop/src/engine/** fully.' },
  { key: 'security', model: 'sonnet', prompt: 'Security of delegation and routing: can a sub-agent escalate permissions (delegated turn permission mode vs lead), does delegate_task run in the right cwd with the right policy, prompt-injection surface in labelled context (are other agents\' outputs clearly delimited as data), IPC validation for agents.* and sessions.setMode/updateSettings.' },
  { key: 'ux-parity', model: 'opus', prompt: 'UI parity vs the reference ' + REF + ' for agents (AgentCard/AgentHoverCard/AgentInfo/AddAgentDialog) and the round-table flow: look at ' + ROOT + '/e2e-out/*.png, read apps/renderer/src/**; list concrete deviations, confusing states, missing affordances (mode switch, mention autocomplete, chain-stopped bar, info drawer content vs SPEC R13).' },
  { key: 'efficiency', model: 'sonnet', prompt: 'Token efficiency (SPEC R23–R26) of the round-table: is the prompt addition session-stable, is the context delta minimal and not duplicated, are stateful backends never re-sent history, per-agent usage split correct, delegate_task result size bounded. Read packages/engine/src/roundtable/** and apps/desktop/src/engine/**.' },
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
    'TASK D — Fix verified review findings from the Phase 4 review wave, then re-run the full gate.',
    'Findings (JSON): ' + JSON.stringify(serious, null, 2),
    'Low-severity findings (fix only if trivial): ' + JSON.stringify(all.filter((f) => f.severity === 'low'), null, 2),
    'For each finding: reproduce or confirm it in code, fix it minimally, add/adjust a test where behavioural. Then run ' + PNPM + ' typecheck, test, build, exec playwright test until green. Commit "Phase 4: review fixes" with trailer "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>". Return: per finding → fixed / not-a-bug (reason) / deferred (reason), and the command output tails.',
  ].join('\n'), { label: 'D fixes', phase: 'Review', model: 'opus', effort: 'high' })
}

return { contracts: String(contracts).slice(0, 1500), dispatcher: String(dispatcher).slice(0, 3000), agentsUi: String(agentsUi).slice(0, 2000), codexSub: String(codexSub).slice(0, 1500), integ: String(integ).slice(0, 4000), findings: all, fixReport: fixReport ? String(fixReport).slice(0, 4000) : null }
