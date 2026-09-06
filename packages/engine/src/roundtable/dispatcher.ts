/**
 * Round-table turn-taking, as pure functions (ADR-0002, SPEC R11).
 *
 * The stateful half — creating turn rows, driving harnesses, broadcasting —
 * lives in `apps/desktop/src/engine/RoundTable.ts`, because only the desktop
 * has a database and a harness registry. Everything that decides *who speaks
 * next* is here, where it can be tested with three object literals and no fake
 * backend at all.
 *
 * The rules, in the order they apply:
 *
 *  1. An explicit target (the composer's agent picker) wins over everything.
 *  2. Otherwise the @-mentioned agents, in mention order, deduplicated.
 *  3. Otherwise the lead. A session whose lead row is gone falls back to its
 *     first agent rather than dropping the message on the floor.
 *  4. After an agent's turn, the agents *it* mentioned — never itself, however
 *     many times a model writes its own name — queue at `hopIndex + 1`.
 *  5. A hop whose index would exceed the session's `hopCap` does not happen:
 *     the chain stops, the transcript records why, and `chat.continue` is the
 *     only way past it until the user speaks again.
 */
import { parseMentions } from "./mentions.js";
import type { RoundTableAgent } from "./types.js";

export interface ResolveTargetsInput {
  text: string;
  agents: readonly RoundTableAgent[];
  leadAgentId: string | null;
  /** The composer's explicit pick; overrides mention parsing when set. */
  explicitAgentId?: string | null;
}

export interface ResolvedTargets {
  agents: RoundTableAgent[];
  /** How the targets were chosen — the reason a UI shows, and a test asserts. */
  source: "explicit" | "mentions" | "lead" | "none";
  /** @names in the text that match no agent (never silently dropped). */
  unknown: string[];
}

/**
 * Who a *user* message goes to. Never empty unless the session has no agents at
 * all, which the caller has to handle as an error rather than as "nobody".
 */
export function resolveTargets(input: ResolveTargetsInput): ResolvedTargets {
  const { agents, leadAgentId } = input;
  if (input.explicitAgentId) {
    const picked = agents.find((a) => a.id === input.explicitAgentId);
    if (picked) return { agents: [picked], source: "explicit", unknown: [] };
  }

  const parsed = parseMentions(input.text, agents);
  if (parsed.mentions.length > 0) {
    const byId = new Map(agents.map((a) => [a.id, a]));
    const targets = parsed.mentions
      .map((m) => byId.get(m.agentId))
      .filter((a): a is RoundTableAgent => a !== undefined);
    return { agents: targets, source: "mentions", unknown: parsed.unknown };
  }

  const lead = agents.find((a) => a.id === leadAgentId) ?? agents[0];
  if (!lead) return { agents: [], source: "none", unknown: parsed.unknown };
  return { agents: [lead], source: "lead", unknown: parsed.unknown };
}

/**
 * Who an *agent's* reply hands the floor to. Self-mentions are dropped: a model
 * that writes "as @claude I think…" is narrating, not delegating, and honouring
 * it would spin the hop budget on a single agent talking to itself.
 */
export function nextHopTargets(input: {
  text: string;
  speakerAgentId: string;
  agents: readonly RoundTableAgent[];
}): RoundTableAgent[] {
  const parsed = parseMentions(input.text, input.agents);
  const byId = new Map(input.agents.map((a) => [a.id, a]));
  return parsed.mentions
    .filter((m) => m.agentId !== input.speakerAgentId)
    .map((m) => byId.get(m.agentId))
    .filter((a): a is RoundTableAgent => a !== undefined);
}

/**
 * Is a turn at `hopIndex` inside the budget?
 *
 * Hop indices are absolute: a user turn is 0, the agent that answers it is 1,
 * the agent that agent mentions is 2. So "chains stop after 3 hops" is exactly
 * `hopIndex <= 3`, and a new user message — which always starts a fresh turn at
 * hop 0 — resets the count without any bookkeeping.
 */
export function hopAllowed(hopIndex: number, hopCap: number): boolean {
  return hopIndex <= hopCap;
}

/** The system turn the transcript records when a chain is cut short. */
export function chainStoppedMessage(hopCap: number): string {
  return (
    `Chain stopped after ${hopCap} hop${hopCap === 1 ? "" : "s"}. ` +
    "Press Continue to let the agents keep going, or send a message."
  );
}
