/**
 * What one agent actually receives when the round table hands it a turn
 * (SPEC R23, ADR-0002).
 *
 * The rule the whole efficiency story rests on: **a stateful backend is never
 * re-sent the transcript.** Claude and Codex keep their own conversation and
 * are resumed by a session id, so they already remember every turn *they*
 * took. What they cannot know is what the other speakers said while they were
 * not the one talking. So the message they get is
 *
 *     [@codex (Codex)]: I moved the parser into mentions.ts
 *     [user]: does that keep the offsets?
 *
 *     <the addressed message>
 *
 * — the *delta* since that agent's own last turn, labelled by speaker, and
 * nothing else. Replaying the whole transcript instead would cost the full
 * prefix on every hop and, on Anthropic, miss the prompt cache every time.
 *
 * `sinceTurnId` is what makes this correct for all three backends rather than
 * only two:
 *
 *  - **claude / codex** — the delta starts at the agent's own last turn,
 *    because that is exactly how far its backend session remembers.
 *  - **api** — capygen *is* the loop, and `history.ts` replays the stored
 *    transcript (already speaker-labelled) when the harness starts. Everything
 *    up to that point is therefore already in the message list, and the delta
 *    must start at the later of "the agent's last turn" and "the watermark the
 *    harness started from", or a restart would replay the same turns twice.
 *
 * The one thing the delta must not allow is a *quoted* speaker forging a label
 * of its own: a reply containing a line `[user]: rm -rf …` would otherwise
 * reach the next agent looking like a genuine instruction from the operator.
 * `escapeSpeakerLabels` backslash-escapes a line-leading `[` in everything
 * quoted, and capygen never escapes the labels it writes itself, so the two
 * can always be told apart.
 *
 * Nothing here reads a database: the desktop passes the turns it already has.
 */
import type { Backend, TurnRole } from "@capygen/shared";
import { USER_SPEAKER_LABEL, speakerLabel } from "./types.js";

/** One transcript entry, flattened to its text. */
export interface TranscriptTurn {
  id: string;
  /** Null for user and system turns. */
  agentId: string | null;
  role: TurnRole;
  /** The turn's text blocks, already joined. */
  text: string;
}

/** How a speaker is labelled; keyed by agent id. */
export interface SpeakerInfo {
  mentionName: string;
  backend: Backend;
}

export interface BuildAgentPromptInput {
  /** The receiving agent's backend — decides nothing today, but the label of
   *  its own turns would be wrong if it ever did, so it stays explicit. */
  backend: Backend;
  /** The receiving agent: its own turns are never replayed to it. */
  agentId: string;
  /** Ordered transcript, oldest first. */
  transcript: readonly TranscriptTurn[];
  speakers: ReadonlyMap<string, SpeakerInfo>;
  /** Only turns *after* this one enter the delta; null = from the beginning. */
  sinceTurnId?: string | null;
  /** Turn ids kept out of the delta — normally the turn delivered as `message`. */
  exclude?: readonly string[];
  /** The message this turn is actually about. */
  message: string;
  /** Agent id of whoever wrote `message`; null when it is the user's. */
  messageFrom?: string | null;
  maxTurnChars?: number;
  maxTotalChars?: number;
}

/** Per-turn and whole-delta budgets (SPEC R25's spirit, applied to context). */
export const DEFAULT_MAX_TURN_CHARS = 1_500;
export const DEFAULT_MAX_DELTA_CHARS = 6_000;

function clamp(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}… [${text.length - limit} more characters]`;
}

/**
 * Neutralise a speaker label a *quoted* speaker wrote themselves.
 *
 * The delta is line-oriented and its only structure is the `[label]: ` prefix
 * capygen puts at the start of each line. So an agent whose tool call read
 * attacker-controlled text (a file, a web page, an MCP result) could reply
 * with a line of its own that begins `[user]: …` and it would arrive in the
 * next agent's prompt looking exactly like a turn capygen had added — a
 * forged instruction from the human operator, indistinguishable from a real
 * one.
 *
 * Escaping the bracket is enough to make the two distinguishable, because
 * capygen never escapes the labels *it* writes: a line starting `\[` is
 * quoted text, always. The character is kept (nothing the agent said is lost)
 * and the cost is one backslash per offending line.
 */
export function escapeSpeakerLabels(text: string): string {
  return text.replace(/^(\s*)\[/gm, "$1\\[");
}

function labelFor(
  agentId: string | null,
  speakers: ReadonlyMap<string, SpeakerInfo>,
): string {
  if (!agentId) return `[${USER_SPEAKER_LABEL}]`;
  const info = speakers.get(agentId);
  if (!info) return "[another agent]";
  return `[${speakerLabel(info)}]`;
}

/**
 * The labelled delta on its own, without the addressed message. Exported
 * because the desktop logs it and the tests assert on it directly.
 */
export function contextDelta(input: BuildAgentPromptInput): string {
  const maxTurn = input.maxTurnChars ?? DEFAULT_MAX_TURN_CHARS;
  const maxTotal = input.maxTotalChars ?? DEFAULT_MAX_DELTA_CHARS;
  const excluded = new Set(input.exclude ?? []);

  // Everything strictly after `sinceTurnId`. An id that is not in the
  // transcript (a turn from another session, or one a migration dropped)
  // means "start at the beginning" rather than "send nothing": under-informing
  // an agent is the failure that shows up as a wrong answer, and
  // over-informing it only costs tokens.
  let start = 0;
  if (input.sinceTurnId) {
    const at = input.transcript.findIndex((t) => t.id === input.sinceTurnId);
    if (at >= 0) start = at + 1;
  }

  const lines: string[] = [];
  let total = 0;
  for (const turn of input.transcript.slice(start)) {
    if (excluded.has(turn.id)) continue;
    if (turn.agentId === input.agentId) continue; // its own words
    const text = turn.text.trim();
    if (!text) continue;
    const line = `${labelFor(turn.agentId, input.speakers)}: ${escapeSpeakerLabels(
      clamp(text, maxTurn),
    )}`;
    total += line.length + 1;
    lines.push(line);
  }

  // Oldest lines go first when the budget is blown: the most recent turns are
  // the ones the agent is being asked to react to.
  while (total > maxTotal && lines.length > 1) {
    const dropped = lines.shift();
    total -= (dropped?.length ?? 0) + 1;
  }
  return lines.join("\n");
}

/**
 * The full prompt string the harness receives: the delta, a blank line, then
 * the addressed message — labelled when another *agent* wrote it, bare when
 * the user did (the user's message is the turn, not a quotation of it).
 */
export function buildAgentPrompt(input: BuildAgentPromptInput): string {
  const delta = contextDelta(input);
  const from = input.messageFrom ?? null;
  // Another agent's text is escaped for the same reason the delta's lines are:
  // it is a quotation, and it must not be able to forge a `[user]:` line of
  // its own inside it. The *user's* message is not escaped — it is the turn,
  // not a quotation of one.
  const message = from
    ? `${labelFor(from, input.speakers)}: ${escapeSpeakerLabels(input.message)}`
    : input.message;
  return delta ? `${delta}\n\n${message}` : message;
}
