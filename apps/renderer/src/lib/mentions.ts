/**
 * `@mention` parsing for round-table dispatch (ADR-0002, SPEC R11) and the
 * composer's autocomplete. Pure functions, unit-tested without React.
 *
 * Scope note (updated in [C], the Phase 4 integration): dispatch itself is
 * **not** this file's job. `chat.send` carries the raw text, and the main
 * process's round-table dispatcher parses it again — with code-fence and
 * `user@host` handling this simpler regex does not have — to fan the message
 * out to every mentioned agent in order (`packages/engine/src/roundtable/`).
 * A renderer-side "route to the first mention" would *narrow* that to one
 * agent, because `chat.send`'s `agentId` means "the composer explicitly
 * picked this one", which overrides mention parsing.
 *
 * What is left here is the UI half, which is genuinely the renderer's: the
 * composer's live "@" autocomplete, and a read of the mentions for anything
 * that wants to show who a draft message will reach.
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
