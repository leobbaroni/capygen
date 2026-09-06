/**
 * The round table's own view of an agent (ADR-0002, SPEC R10-R13).
 *
 * Deliberately *not* `@capygen/shared`'s `Agent`: the dispatcher needs a name,
 * a backend and a model and nothing else, and taking the full row would drag
 * `createdAt`, `config` and the database's shape into a module whose whole job
 * is text. The desktop narrows an `Agent` to this in one line.
 */
import type { Backend } from "@capygen/shared";

export interface RoundTableAgent {
  id: string;
  /** The `@name` dispatch parses against — lowercase, unique per session. */
  mentionName: string;
  /** Human label for the speaker header and the participant list. */
  displayName: string;
  backend: Backend;
  model: string;
  role: "lead" | "member";
}

/**
 * How a backend is named *to a model*. "claude"/"codex"/"api" are capygen's
 * internal ids; an agent reading `[@alice (Claude Code)]:` needs the product
 * name, because that is what tells it whose conventions the other speaker
 * follows.
 */
export function backendLabel(backend: Backend): string {
  switch (backend) {
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "api":
      return "API model";
    default:
      return backend;
  }
}

/**
 * The speaker header used everywhere a turn is attributed — the stored
 * `Turn.speakerLabel`, the labelled context delta (SPEC R23) and the round
 * table's own prompt addition. One function so the three can never drift.
 */
export function speakerLabel(agent: Pick<RoundTableAgent, "mentionName" | "backend">): string {
  return `@${agent.mentionName} (${backendLabel(agent.backend)})`;
}

/** The label a user turn carries in a labelled delta. */
export const USER_SPEAKER_LABEL = "user";
