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
 *  - `codex` — **no**. `codex app-server` takes MCP servers from the user's
 *    `config.toml`, not from a client, and capygen refuses to write a server
 *    into a user's config behind their back. A Codex agent whose routing rule
 *    crosses backends therefore fails open: it spawns its own sub-agent on its
 *    own model, which is exactly what R12 promises when a policy cannot be
 *    applied. Recorded in docs/adr/0004-subagent-routing.md as the follow-up.
 */
export function canDelegateFrom(backend: Backend): boolean {
  return backend === "claude" || backend === "api";
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
    ...(target ? { delegation: { ...target, toolName: DELEGATE_TASK_TOOL } } : {}),
  });
  return prompt ?? undefined;
}
