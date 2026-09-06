/**
 * The one prompt addition a round-table agent gets — built **once, at harness
 * start**, and never rebuilt (SPEC R23/R24, ADR-0002).
 *
 * It answers three questions no backend can work out for itself: who else is in
 * this conversation, what `[@name (Backend)]:` in an incoming message means,
 * and — when the routing policy sends sub-agents to another backend — that
 * `delegate_task` exists and is the way to reach it.
 *
 * Two disciplines are load-bearing:
 *
 *  - **Session-stable.** No turn number, no hop counter, no "the user just
 *    said…". Claude receives it as `systemPrompt.append` on a preset whose
 *    prefix the API caches; Codex as `thread/start.developerInstructions`; the
 *    `api` backend as `buildSystemPrompt({extra})`. All three are set once per
 *    backend session, so a string that changed per turn would invalidate the
 *    cached prefix on every single turn — the exact failure R24 exists to stop.
 *  - **Absent when it says nothing.** A solo session with one agent and no
 *    routing override gets `null`, not a paragraph explaining a round table of
 *    one. That keeps a solo session's prompt byte-identical to Phase 2's.
 *
 * The consequence of "once at start" is that an agent added mid-session does
 * not appear in an already-running agent's roster line. It still reaches that
 * agent: its turns arrive labelled in the context delta, and dispatch is
 * capygen's, not the backend's. Restarting a harness to refresh the roster
 * would throw away the backend session — a much worse trade than a stale list.
 */
import type { Backend } from "@capygen/shared";
import { backendLabel, speakerLabel, type RoundTableAgent } from "./types.js";

/** Where this agent's sub-agents must run when it cannot spawn them itself. */
export interface DelegationNotice {
  backend: Backend;
  model: string;
  /** The tool the agent should call; `DELEGATE_TASK_TOOL` unless overridden. */
  toolName: string;
}

export interface RoundTablePromptInput {
  self: RoundTableAgent;
  /** Every top-level agent in the session, `self` included, in display order. */
  agents: readonly RoundTableAgent[];
  leadAgentId: string | null;
  hopCap: number;
  /** Omitted when sub-agents run natively on this agent's own backend. */
  delegation?: DelegationNotice | null;
}

/**
 * `null` when there is nothing worth spending prompt tokens on: one agent, no
 * cross-backend delegation.
 */
export function buildRoundTablePrompt(input: RoundTablePromptInput): string | null {
  const others = input.agents.filter((a) => a.id !== input.self.id);
  const delegation = input.delegation ?? null;
  if (others.length === 0 && !delegation) return null;

  const lead = input.agents.find((a) => a.id === input.leadAgentId) ?? null;
  const lines: string[] = [];

  lines.push("## capygen round table");
  lines.push("");
  lines.push(
    `You are ${speakerLabel(input.self)} in a capygen session where several agents share one transcript.`,
  );

  if (others.length > 0) {
    lines.push("");
    lines.push("The other participants are:");
    for (const agent of others) {
      const role = agent.id === input.leadAgentId ? ", lead" : "";
      lines.push(`- ${speakerLabel(agent)} — ${agent.displayName}, ${agent.model}${role}`);
    }
    lines.push("");
    lines.push(
      "Write @name in your reply to address one of them: capygen delivers your message to that agent " +
        "and posts their answer in this same thread. Do not @-mention yourself.",
    );
    lines.push(
      `A message with no @name goes to the lead${lead ? ` (@${lead.mentionName})` : ""}.`,
    );
    lines.push(
      `Agent-to-agent chains stop after ${input.hopCap} hop${input.hopCap === 1 ? "" : "s"}; ` +
        "the user resumes them with Continue. Say what you need in one turn rather than " +
        "spending hops on acknowledgements.",
    );
    lines.push(
      'A line like "[@name (Backend)]: …" at the top of a message is another participant speaking, ' +
        "not the user.",
    );
  }

  if (delegation) {
    lines.push("");
    lines.push(
      `Sub-agents: capygen's routing policy runs your sub-agents on ${backendLabel(delegation.backend)} ` +
        `(${delegation.model}), which your own sub-agent tool cannot reach. When you would spawn one, ` +
        `call the ${delegation.toolName} tool instead — it runs the task on that model in this same ` +
        "project and returns the result. The sub-agent does not see this conversation, so put " +
        "everything it needs in the prompt.",
    );
  }

  return lines.join("\n");
}
