/**
 * The @-mention parser (ADR-0002, SPEC R11).
 *
 * "A user message goes to the @-mentioned agents in mention order" is only as
 * good as what counts as a mention. Three things are *not* mentions, and each
 * one was a real way to send a turn to the wrong agent:
 *
 *  - **an email address** — `leo@gmail.com` names no agent, so an `@` that
 *    follows a word character is never a mention. The same rule drops
 *    `https://x.com/@handle` (the `@` follows a `/`) and a decimal-ish
 *    `v1.2@3`;
 *  - **anything inside code** — a fenced block or an inline span is quoted
 *    text, and an agent pasting `git log --format=%an <email@host>` must not
 *    summon anyone. Code regions are blanked *in place* (same length) before
 *    scanning, so the offsets reported here still index the original string;
 *  - **a name no agent answers to** — unresolved tokens are returned
 *    separately rather than silently dropped, so a caller can say "no agent is
 *    called @claud" instead of quietly answering as the lead.
 *
 * Matching is case-insensitive (`@Codex` reaches `codex`) and order-preserving
 * with duplicates removed: "@a @b @a" dispatches to a then b, once each.
 */
import type { RoundTableAgent } from "./types.js";

/** One resolved @-mention, in the order it appeared. */
export interface ResolvedMention {
  agentId: string;
  /** The agent's canonical `mentionName`, not the raw token's casing. */
  mentionName: string;
  /** Byte offset of the `@` in the *original* text. */
  index: number;
}

export interface MentionParseResult {
  /** Resolved agents, in mention order, deduplicated by agent id. */
  mentions: ResolvedMention[];
  /** `@names` that matched no agent in the session, in order, deduplicated. */
  unknown: string[];
}

/**
 * A mention starts at an `@` that does not follow a word character, another
 * `@`, or one of the joiners that make an address or a path (`.`, `/`, `\`,
 * `-`). The name itself is `MentionNameSchema`'s alphabet.
 */
const MENTION = /(^|[^\w@./\\-])@([A-Za-z0-9][A-Za-z0-9_-]*)/g;
const FENCED_CODE = /```[\s\S]*?(?:```|$)/g;
const INLINE_CODE = /`[^`\n]*`/g;

/**
 * Replace every code region with spaces of the same length. Newlines are kept
 * so line-based tooling downstream still sees the same shape, and — the point
 * of doing it this way — every index in the blanked string is the same index in
 * the original.
 */
function blankCode(text: string): string {
  const blank = (match: string): string => match.replace(/[^\n]/g, " ");
  return text.replace(FENCED_CODE, blank).replace(INLINE_CODE, blank);
}

/**
 * Raw `@name` tokens, lowercased, with the offset of their `@`. Exported for
 * tests and for a UI that wants to highlight mentions without resolving them.
 */
export function findMentionTokens(text: string): { name: string; index: number }[] {
  const scanned = blankCode(text);
  const out: { name: string; index: number }[] = [];
  MENTION.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MENTION.exec(scanned)) !== null) {
    const lead = match[1] ?? "";
    const raw = match[2] ?? "";
    // `codex.` / `codex-` at the end of a sentence should still find `codex`.
    const name = raw.replace(/[-_]+$/, "").toLowerCase();
    if (name.length === 0) continue;
    out.push({ name, index: match.index + lead.length });
  }
  return out;
}

/**
 * Resolve `@name` tokens against the session's agents.
 *
 * Unknown names are reported rather than thrown: a message may legitimately
 * contain `@here` or `@ts-ignore`, and the dispatcher's answer to "no agent was
 * mentioned" is the lead, not an error.
 */
export function parseMentions(
  text: string,
  agents: readonly RoundTableAgent[],
): MentionParseResult {
  const byName = new Map(agents.map((a) => [a.mentionName.toLowerCase(), a]));
  const mentions: ResolvedMention[] = [];
  const unknown: string[] = [];
  const seenAgents = new Set<string>();
  const seenUnknown = new Set<string>();

  for (const token of findMentionTokens(text)) {
    const agent = byName.get(token.name);
    if (!agent) {
      if (!seenUnknown.has(token.name)) {
        seenUnknown.add(token.name);
        unknown.push(token.name);
      }
      continue;
    }
    if (seenAgents.has(agent.id)) continue;
    seenAgents.add(agent.id);
    mentions.push({ agentId: agent.id, mentionName: agent.mentionName, index: token.index });
  }

  return { mentions, unknown };
}

/** True when `text` @-addresses `agent`. */
export function mentions(text: string, agent: RoundTableAgent): boolean {
  return parseMentions(text, [agent]).mentions.length > 0;
}
