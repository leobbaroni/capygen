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
  backendLabel,
  buildRoundTablePrompt,
  resolveRoute,
  type RoundTableAgent,
  type RoutingDecision,
} from "@capygen/engine";
import type { Agent, Backend, CrewCapability, Session } from "@capygen/shared";

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
 * The **default** target for this agent's `delegate_task` calls, or `null` when
 * the agent cannot be handed the tool at all.
 *
 * This used to answer `null` for everything except a stored cross-backend rule,
 * which meant the tool existed only for the handful of sessions whose user had
 * been through the routing settings — and those settings no longer have a UI.
 * The tool is universal now: an agent with no rule delegates to **its own
 * backend and model**, which is a real, runnable target and the one a reader
 * expects "run this sub-task for me" to use. A rule, per-agent or per-session,
 * still wins and still points the default wherever it says — including at
 * another backend, which is the case no `PreToolUse` hook can enforce.
 *
 * `null` is reserved for "there is nothing to delegate *from*": an unknown
 * session or agent, or a backend capygen cannot hand a tool to.
 */
export function delegationTarget(
  store: CapygenStore,
  sessionId: string,
  agentId: string,
): { backend: Backend; model: string } | null {
  let agent;
  try {
    agent = store.sessions.agent(agentId);
  } catch {
    return null;
  }
  if (!agent || !canDelegateFrom(agent.backend)) return null;
  const decision = resolveSubagentRoute(store, sessionId, agentId);
  // A same-backend rule names a model the hook also rewrites native spawns to;
  // a delegated child follows the same rule rather than contradicting it.
  if (decision && decision.model) return { backend: decision.backend, model: decision.model };
  if (decision) return { backend: decision.backend, model: "" };
  return { backend: agent.backend, model: agent.model };
}

/**
 * How many model ids one backend contributes to the prompt addition. The list
 * is session-stable prompt text (R24), so it is bounded rather than however
 * long today's catalogue happens to be.
 */
const MAX_ADVERTISED_MODELS = 8;

/**
 * The `delegate_task` paragraph, built from what this installation can actually
 * run.
 *
 * Two rules it does not break: it never names a backend or a model id that is
 * not in `capabilities` (an invented id is a refused call at best and a wrong
 * charge at worst), and it says nothing about *which* backend the caller is on
 * — the tool reaches every backend from every backend, so a Codex-only caveat
 * would be false.
 */
function delegationParagraph(
  target: { backend: Backend; model: string },
  capabilities: readonly CrewCapability[],
): string {
  const lines: string[] = [];
  lines.push(
    `Sub-agents: capygen gives you the ${DELEGATE_TASK_TOOL} tool. It runs one task as a fresh ` +
      "agent in this same project directory and returns that agent's final text. The sub-agent " +
      "does not see this conversation, so put everything it needs in the prompt.",
  );
  lines.push(
    `Left alone, ${DELEGATE_TASK_TOOL} runs on ${backendLabel(target.backend)}` +
      `${target.model ? ` (${target.model})` : ""}. capygen runs the sub-agent itself, so the ` +
      "call may instead name a backend, a model and an effort — including a backend other than " +
      "your own, which your own sub-agent tool cannot reach.",
  );
  const byBackend = new Map<Backend, string[]>();
  for (const entry of capabilities) {
    const models = byBackend.get(entry.backend) ?? [];
    if (!models.includes(entry.model)) models.push(entry.model);
    byBackend.set(entry.backend, models);
  }
  if (byBackend.size > 0) {
    const offered = [...byBackend.entries()].map(([backend, models]) => {
      const shown = models.slice(0, MAX_ADVERTISED_MODELS);
      const rest = models.length - shown.length;
      return `${backend}: ${shown.join(", ")}${rest > 0 ? `, and ${rest} more` : ""}`;
    });
    lines.push(
      `This installation can run — ${offered.join("; ")}. Use those ids exactly; capygen refuses ` +
        "a backend or model it cannot run rather than substituting another one.",
    );
  } else {
    lines.push(
      "Name a backend or model only when the user asked for a specific one, and only with an id " +
        "you have actually been told exists; capygen refuses anything else rather than guessing.",
    );
  }
  return lines.join("\n");
}

/**
 * The session-stable prompt addition for one agent, or `undefined` when there
 * is nothing to say.
 *
 * `capabilities` is what this installation can run (`crewCapabilities`), and is
 * advertised verbatim so the model asks for ids that exist. Omitting it keeps
 * the paragraph, minus the list.
 */
export function promptAdditionFor(
  store: CapygenStore,
  sessionId: string,
  agentId: string,
  capabilities: readonly CrewCapability[] = [],
): string | undefined {
  const session = store.sessions.get(sessionId);
  if (!session) return undefined;
  const agents = roundTableAgents(store, sessionId);
  const self = agents.find((a) => a.id === agentId);
  if (!self) return undefined;
  if (session.mode === "custom") {
    const crew = session.settings.crew;
    const rosterId = Object.entries(session.settings.crewBindings ?? {}).find(([, id]) => id === agentId)?.[0];
    const member = crew?.roster.find((entry) => entry.id === rosterId);
    if (!member) throw new Error("The active agent has no Custom Mode roster assignment.");
    return [
      member.instructions,
      member.role === "lead"
        ? "You lead this custom crew. Delegate using delegate_task with taskKind and difficulty; the app chooses the configured worker. Do not override models or use native subagent tools. For configured core/major decisions, request crew_debate then finish your turn. Debate runs in this chat and returns to you for a decision."
        : "You are a configured debater. Discuss the requested decision; the app returns to the lead. Do not spawn agents or use mentions to dispatch peers.",
      "Crew routing policy (declarative instructions): " + JSON.stringify({ routing: crew!.routing, defaultWorker: crew!.defaultWorker, debate: crew!.debate }),
    ].filter(Boolean).join("\n\n");
  }
  const target = delegationTarget(store, sessionId, agentId);
  // `buildRoundTablePrompt`'s own delegation notice describes the narrow
  // cross-backend case ("your own sub-agent tool cannot reach it"), which is no
  // longer what the tool is. The roster half is still its job; the tool
  // paragraph is written here, once, for every backend.
  const prompt = buildRoundTablePrompt({
    self,
    agents,
    leadAgentId: session.leadAgentId,
    hopCap: session.settings.hopCap,
    // A solo session's dispatcher plans no peer hop, so the hand-off
    // paragraph would describe something that cannot happen (ADR-0002).
    mode: session.mode,
  });
  const delegation = target ? delegationParagraph(target, capabilities) : null;
  const parts = [prompt, delegation].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}
