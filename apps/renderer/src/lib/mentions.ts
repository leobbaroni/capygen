/**
 * `@mention` parsing for round-table dispatch (ADR-0002, SPEC R11) and the
 * composer's autocomplete. Pure functions, unit-tested without React.
 *
 * Scope note: `chat.send`'s IPC contract (`packages/shared/src/ipc.ts`)
 * accepts one `agentId` per call — full multi-agent fan-out ("delivered to
 * the @-mentioned agents [plural], in mention order") is the round-table
 * dispatcher's job (PLAN.md Phase 4's separate dispatcher task), not this
 * package's. What this file gives the renderer is the part expressible
 * against today's contract: read the mentions out of a message so the store
 * can route to the *first* one (`parseMentions(...)[0]`), and drive the
 * composer's live "@" autocomplete as the user types.
 */
import type { Agent } from "@capygen/shared";

/** An `@token` preceded by start-of-string or whitespace — so `user@host` in
 *  a pasted URL is not read as a mention. */
const MENTION_TOKEN = /(?:^|\s)@([a-z0-9][a-z0-9_-]*)/gi;

/**
 * Every session agent the text `@mentions`, in first-occurrence order.
 * Matching is case-insensitive against each agent's `mentionName`; an
 * `@token` that matches no agent is plain text, not a mention.
 */
export function parseMentions(text: string, agents: readonly Agent[]): Agent[] {
  const byName = new Map(agents.map((a) => [a.mentionName.toLowerCase(), a] as const));
  const seen = new Set<string>();
  const found: Agent[] = [];
  for (const match of text.matchAll(MENTION_TOKEN)) {
    const token = match[1];
    if (!token) continue;
    const agent = byName.get(token.toLowerCase());
    if (agent && !seen.has(agent.id)) {
      seen.add(agent.id);
      found.push(agent);
    }
  }
  return found;
}

export interface MentionQuery {
  /** Index of the "@" character in the text. */
  start: number;
  /** Characters typed after "@" so far (no spaces — a space ends the token). */
  query: string;
}

/**
 * Detects an in-progress "@mention" ending exactly at `caret`, mirroring the
 * composer's slash-command detection (`Composer.tsx`'s `slashActive`) for
 * `@` instead of `/`: unlike `/`, a mention can start anywhere in the
 * message, not only at the start of a line, so this looks backward from the
 * caret rather than checking the whole string's first character.
 */
export function activeMentionQuery(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, Math.max(0, caret));
  const match = /(?:^|\s)@([a-z0-9_-]*)$/i.exec(before);
  if (!match) return null;
  const query = match[1] ?? "";
  return { start: before.length - query.length - 1, query };
}

/**
 * Replaces the in-progress "@query" the composer detected with a finished
 * "@mentionName" mention, returning the new text and where the caret belongs
 * (right after one separating space, so typing continues naturally).
 *
 * Adds that space only when `after` does not already start with one — a
 * mention completed at the end of the draft has nothing following it and
 * needs its own space, but one completed mid-message (text already typed
 * after the "@query") already has the original space right there, and
 * appending a second one would leave a visible double space.
 */
export function insertMention(
  text: string,
  query: MentionQuery,
  mentionName: string,
): { text: string; caret: number } {
  const before = text.slice(0, query.start);
  const after = text.slice(query.start + 1 + query.query.length);
  const mention = `@${mentionName}`;
  const combined = before + mention + (after.startsWith(" ") ? "" : " ") + after;
  return { text: combined, caret: before.length + mention.length + 1 };
}
