/**
 * Shared plumbing for `agents.describe` (SPEC R13): one small composition
 * helper plus the bits every backend's own `describe.ts` reuses, so
 * `claude/describe.ts`, `api/describe.ts` and this folder's `codex.ts` do not
 * each reinvent "capabilities → words" or "join a list like a sentence".
 *
 * What lives *here* versus next to each harness: a per-backend `describe.ts`
 * (or, for Codex, `./codex.ts` — see that file's header for why Codex did not
 * get `codex/describe.ts`) turns a **snapshot** of that backend's own state
 * into an `AgentDescribeCore`; this file turns an `AgentDescribeCore` plus the
 * two things only a database can answer (usage totals, the other agents in
 * the session) into the full `AgentDescribe` the IPC channel returns.
 */
import type {
  AgentDescribe,
  AgentDescribeOther,
  AgentUsageSummary,
} from "@capygen/shared";
import type { HarnessCapabilities } from "../harness.js";

/**
 * Everything `agents.describe` returns *except* the two fields a live harness
 * has no way to answer on its own: `usage` (a `usage_events` query) and
 * `others` (every other agent in the session). Every backend's describe
 * function returns exactly this; `composeAgentDescribe` fills in the rest.
 */
export type AgentDescribeCore = Omit<AgentDescribe, "usage" | "others">;

/** Fills in the two composed fields. The one place `agentsDescribe.ts` (and
 *  every test in this folder) turns a core into the full IPC payload, so the
 *  shape of that last step is written once. */
export function composeAgentDescribe(
  core: AgentDescribeCore,
  usage: AgentUsageSummary,
  others: AgentDescribeOther[],
): AgentDescribe {
  return { ...core, usage, others };
}

/**
 * `HarnessCapabilities` flags → the words an info card / usage paragraph can
 * use. Shared across all three backends because the flags mean the same thing
 * everywhere (SPEC R13's "capabilities" listing is explicitly "a
 * `HarnessCapabilities` flag that is true", per the domain schema's own
 * comment) — a backend earns a label by actually setting the flag, not by
 * this file guessing what it probably supports.
 */
const CAPABILITY_LABELS: Record<keyof HarnessCapabilities, string> = {
  streamingDeltas: "Streams replies as it writes them",
  permissions: "Asks before risky tool calls",
  questions: "Can ask clarifying questions",
  subagents: "Can spawn sub-agents",
  resume: "Resumable across restarts",
  interrupt: "Interruptible mid-turn",
  slashCommands: "Has its own slash commands",
};

export function capabilityLabels(caps: HarnessCapabilities): string[] {
  return (Object.keys(CAPABILITY_LABELS) as (keyof HarnessCapabilities)[])
    .filter((key) => caps[key])
    .map((key) => CAPABILITY_LABELS[key]);
}

/** "a, b and c" / "a and b" / "a" / "" — every usage-paragraph generator in
 *  this folder needs the same join, so it is written once here rather than
 *  three times slightly differently. */
export function joinWords(items: string[]): string {
  const words = items.filter((w) => w.length > 0);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0]!;
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** A one-line clamp for text that can be arbitrarily long on the wire (a
 *  sub-agent prompt, an MCP tool description) but has no business filling a
 *  usage paragraph or a card's description field. Not `clampOutput` from a
 *  harness (that keeps the *whole* value behind a stub for R25); this is for
 *  text that is display-only from the start. */
export function clampText(text: string, maxLength = 240): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 1)}…`;
}
