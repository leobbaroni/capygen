# ADR-0004: Sub-agent routing — a hook for the same backend, `delegate_task` across backends

Date: 2026-09-06 · Status: accepted · Supersedes nothing · Implements SPEC R12, ADR-0002

Updated 2026-09-07: the pinned Codex dynamic client-tool protocol supplies the cross-backend
path. The earlier config-only limitation is superseded by the measured protocol below.

## Context

SPEC R12: *"WHEN any agent spawns a sub-agent THE SYSTEM SHALL apply the routing policy
(per-agent config or per-session rule: 'sub-agents run on `<backend/model>`') and show the spawn
in the agent tree; policy failures fail open (spawn on the inherited model)."*

Two facts from the Phase 1 spike decide the shape of this:

- Claude's `PreToolUse` hook on `'Task|Agent'` **can** move a sub-agent onto another model. The
  spike forced one onto `haiku` and proved it from the result's own accounting —
  `modelUsage` came back keyed `["claude-sonnet-5", "claude-haiku-4-5-20251001"]`, and
  `tool_use_result.resolvedModel` agreed (docs/spikes/engine.md §2 row 7, §5).
- The hook's only lever is `hookSpecificOutput.updatedInput.model`. There is no lever that moves
  a spawn onto **another backend**: a Claude CLI cannot open a Codex thread, and a Codex model id
  written into `updatedInput.model` fails the spawn rather than redirecting it — which is the
  opposite of failing open.

So "sub-agents run on codex/gpt-5.5" cannot be enforced the same way "sub-agents run on haiku"
can, and pretending otherwise would turn a routing preference into a broken turn.

## Decision

**1. One policy, two enforcement paths, chosen by whether the backend changes.**

`packages/engine/src/routing/policy.ts` resolves a spawn against
`Agent.subagentRouting` (per-agent) then `Session.settings.routing.subagents` (per-session), and
returns `{backend, model, sameBackend, source}` or `null`.

- `sameBackend: true` → the Claude `PreToolUse` hook rewrites `updatedInput.model`. Nothing new
  runs; capygen only re-labels the spawn, and records the decision on the `subagent` block as
  `{backend, model, delegated: false}`.
- `sameBackend: false` → the parent is given a capygen tool, **`delegate_task`**, and told in its
  session-stable prompt to use it instead of its own sub-agent tool. capygen runs the sub-agent
  itself: a short-lived harness for the routed backend/model, in the same project directory,
  through the same registry every other agent uses. Its blocks, permission cards and usage stream
  into the *parent's* turn under a `delegate:` key prefix, wrapped in a `subagent` block with
  `delegated: true`, so R13's agent tree shows it and R23 bills its tokens to the model that spent
  them. The tool returns the sub-agent's final text.

`delegate_task` is exposed per backend by whatever mechanism that backend actually has:

| Backend | Mechanism | Available |
|---|---|---|
| `claude` | `createSdkMcpServer` — an MCP server inside capygen's process, named `capygen`; the model sees `mcp__capygen__delegate_task` | yes |
| `api` | one more `ToolDefinition` in capygen's own tool registry | yes |
| `codex` | `thread/start.dynamicTools`, executed in capygen through `item/tool/call` | yes; pinned 0.153.4 loopback proof |

**2. Routing failures preserve the parent turn.**

Every failure lands on "the backend spawns its sub-agent exactly as it would have without
capygen": no rule; a rule naming what the parent already runs; a malformed rule; a resolver that
throws; a cross-backend rule on a backend that cannot be handed a tool; an SDK with no
`createSdkMcpServer`; a routed backend that will not start; a delegated turn that errors. The
tool answers with a sentence saying so and telling the caller to do the work itself; the parent's
turn is never lost. `resolveRoute` never throws — it is handed values straight out of a database
row.

This fallback concerns routing preferences. Permission denials, cancellation and local
execution restrictions are never converted into authorization to run elsewhere.

**3. Delegation is one hop, not a tree.** A delegated sub-agent is built with no delegation
extras of its own, so it cannot delegate again. It is disposed at the end of the call and its
backend session id is deliberately dropped rather than stored, so nothing resumes it later.

**4. Nothing is auto-approved.** A permission or `AskUserQuestion` request raised inside a
delegated turn is forwarded to the parent's turn and answered by the user on the harness that
asked (SPEC R27).

## Consequences

- Codex declares `delegate_task` through its experimental client-tool protocol without writing
  backend configuration. An owned loopback Responses fixture drove actual calls and proved
  declaration persistence through same-process and fresh-process resume; it did not test a
  remote model's choice to delegate. The host's explicit permission mode governs this tool;
  native sandbox settings do not authorize a host-side child.
- The tool list and MCP server list an agent is started with are fixed for the backend session:
  they are part of the request shape a provider caches on (R24), so they are chosen once in
  `harnessFor`. What stays dynamic is the *target* — `delegate_task`'s runner re-reads the routing
  rule on every call, so a rule edited in Settings applies to the next spawn without restarting
  the backend. Codex declaration additions/removals require a fresh thread. A stored schema
  signature detects changes and unknown legacy tool sets. The visible restart notice is
  accompanied by a single bounded historical quotation of recent user/assistant prose on
  the first send, without tool results, configuration or native identities. Existing history
  stays intact; unchanged declarations resume normally.
- Cancellation races child startup and stream reads; interrupt, bounded disposal and registry
  release prevent an unresponsive child from holding its caller indefinitely. Late responses
  after abandonment are ignored. The target retains its own permission configuration.
- `ApiHarness.capabilities().subagents` now keys on whether the agent actually has the tool, so
  the agent tree is never promised a sub-agent that cannot happen.
- Live "which model is this sub-agent on" is still not observable mid-run: neither `task_started`
  nor `task_notification.usage` carries a model field (spike §8 note 13). The routed model is
  recorded from capygen's own decision, and `result.modelUsage` remains the after-the-fact proof.

## Alternatives considered

- **Deny the `Task`/`Agent` call from the hook and re-issue the work as a fresh `query()`.** This
  is the documented fallback if the SDK ever stops honouring `updatedInput.model` (spike §5), and
  it is strictly worse while the lever works: it converts a two-line rewrite into capygen
  re-implementing sub-agent orchestration for one backend.
- **Route by rewriting the user's `~/.claude` / `~/.codex` config.** Rejected: capygen must not
  change a backend's own configuration to implement a capygen-only preference, and the change
  would leak into the user's CLI sessions.
- **Make routing mandatory (fail closed).** Rejected by R12 itself, and rightly: a routing
  preference that can stop work is a worse failure than a sub-agent on the wrong model.

## Reversal

Delete `packages/engine/src/routing/`, drop the two `HarnessExtras` fields wired in
`apps/desktop/src/engine/SessionRunner.ts`, and stop calling `routeSubagent`. The
`subagent_routing_json` column and `SessionSettings.routing` stay harmless; every agent then
inherits its parent's model, which is the fail-open behaviour anyway.
