/**
 * The desktop's half of sub-agent routing (SPEC R12) and of the round table's
 * session-stable prompt addition (ADR-0002, SPEC R23/R24).
 *
 * `packages/engine`'s `routing/policy.ts` decides *where* a sub-agent runs from
 * two plain objects. This file is what reads those two objects out of SQLite —
 * `Agent.subagentRouting` and `Session.settings.routing.subagents` — and what
 * knows the one fact the policy cannot: which backends capygen can actually
 * delegate *to a tool* on, which is a property of the harness, not of the rule.
 *
 * Every function here is a pure read. Nothing is cached: a routing rule the
 * user changes in Settings has to take effect on the next spawn, and the read
 * is two indexed row lookups.
 */
import type { CapygenStore } from "@capygen/db";
import {
  DELEGATE_TASK_TOOL,
  buildRoundTablePrompt,
  resolveRoute,
  type RoundTableAgent,
  type RoutingDecision,
} from "@capygen/engine";
import type { Agent, Backend, Session } from "@capygen/shared";

/** `Agent` narrowed to what the round table needs (order preserved). */
export function toRoundTableAgent(agent: Agent): RoundTableAgent {
  return {
    id: agent.id,
    mentionName: agent.mentionName,
    displayName: agent.displayName,
    backend: agent.backend,
    model: agent.model,
    role: agent.role,
  };
}

export function roundTableAgents(store: CapygenStore, sessionId: string): RoundTableAgent[] {
  return store.sessions.agents(sessionId).map(toRoundTableAgent);
}

/**
 * Can capygen hand *this* backend a `delegate_task` tool?
 *
 *  - `claude` — yes, through the SDK's in-process MCP server
 *    (`routing/sdkMcp.ts`);
 *  - `api` — yes, it is capygen's own tool loop, so the tool is one more
 *    `ToolDefinition`;
 *  - `codex` — **yes, since the dynamic-tools bridge**. ADR-0004 recorded a
 *    "no" here, and its reasoning was about *MCP servers*: `codex app-server`
 *    takes those from the user's `config.toml`, and capygen will not write into
 *    a user's config behind their back. That reasoning still holds, and it is
 *    not the only way to hand Codex a tool. The pinned 0.153.4 binary carries
 *    `ThreadStartParams.dynamicTools` — client-hosted tools declared per thread
 *    and called back over `item/tool/call` — which touches no file the user's
 *    own CLI reads. `packages/engine/scripts/probe-codex-dynamic-tools.ts`
 *    proves against that binary that a declared tool is routed back to the
 *    client, and that the declaration survives a resume in a fresh app-server
 *    process. The field is gated behind the `experimentalApi` capability, which
 *    capygen already declares; a binary that stops accepting it fails
 *    `thread/start`, and `CodexHarness.dynamicToolsActive()` then reports the
 *    tools as absent rather than pretending otherwise.
 */
export function canDelegateFrom(_backend: Backend): boolean {
  return true;
}

/**
 * Where `agent`'s sub-agents should run, or `null` for "inherit" (fail open).
 * `null` is also what a missing session or agent gives: a routing lookup is
 * never a reason to fail a turn.
 */
export function resolveSubagentRoute(
  store: CapygenStore,
  sessionId: string,
  agentId: string,
): RoutingDecision | null {
  try {
    const session: Session | null = store.sessions.get(sessionId);
    const agent = store.sessions.agent(agentId);
    if (!session || !agent) return null;
    return resolveRoute({
      agent: agent.subagentRouting ?? null,
      session: session.settings.routing?.subagents ?? null,
      parent: { backend: agent.backend, model: agent.model },
    });
  } catch {
    return null;
  }
}

/**
 * The cross-backend route this agent needs `delegate_task` for, or `null` when
 * it has none — either because there is no rule, because the rule keeps it on
 * its own backend (the `PreToolUse` hook handles that), or because its backend
 * cannot be handed a tool at all.
 */
export function delegationTarget(
  store: CapygenStore,
  sessionId: string,
  agentId: string,
): { backend: Backend; model: string } | null {
  const decision = resolveSubagentRoute(store, sessionId, agentId);
  if (!decision || decision.sameBackend) return null;
  const agent = store.sessions.agent(agentId);
  if (!agent || !canDelegateFrom(agent.backend)) return null;
  return { backend: decision.backend, model: decision.model };
}

/**
 * The session-stable prompt addition for one agent, or `undefined` when there
 * is nothing to say (a solo session with no routing override) — see
 * `buildRoundTablePrompt`, and note that `undefined` keeps such a session's
 * backend prompt byte-identical to Phase 2's.
 */
export function promptAdditionFor(
  store: CapygenStore,
  sessionId: string,
  agentId: string,
): string | undefined {
  const session = store.sessions.get(sessionId);
  if (!session) return undefined;
  const agents = roundTableAgents(store, sessionId);
  const self = agents.find((a) => a.id === agentId);
  if (!self) return undefined;
  const target = delegationTarget(store, sessionId, agentId);
  const prompt = buildRoundTablePrompt({
    self,
    agents,
    leadAgentId: session.leadAgentId,
    hopCap: session.settings.hopCap,
    // A solo session's dispatcher plans no peer hop, so the hand-off
    // paragraph would describe something that cannot happen (ADR-0002).
    mode: session.mode,
    ...(target ? { delegation: { ...target, toolName: DELEGATE_TASK_TOOL } } : {}),
  });
  return prompt ?? undefined;
}
