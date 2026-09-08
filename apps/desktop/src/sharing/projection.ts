/**
 * Live session blocks → an inert share bundle.
 *
 * This is a **whitelist**, not a filter. Every exported entry is built field by
 * field from a named source field; nothing is copied wholesale and nothing
 * unknown falls through. That is the only shape that survives the block union
 * growing: a block kind this file has not been taught about is a refusal, not a
 * quiet omission, because no tally could honestly describe it.
 *
 * Cardinality caps refuse too. `ShareLimits` marks them as refusal thresholds,
 * and only the per-string byte bound clips — visibly, flagged on the entry and
 * counted in `truncatedTexts`. Nothing here drops an entry, an agent or a
 * comment on the floor.
 *
 * What never leaves, by default and by construction: raw tool inputs and
 * results, diff patches and their paths, permission decisions, question and
 * elicitation answers, widget HTML, agent configuration, and every id capygen
 * or a backend minted (block, turn, session, agent, tool-use, request). A tool
 * call becomes its name and nothing else. Reasoning is opt-in, and when it is
 * withheld the bundle says so through `droppedThinking` rather than by silence.
 */
import {
  resolveShareLimits,
  type Backend,
  type Block,
  type ShareBundle,
  type ShareComment,
  type ShareEntry,
  type ShareLimits,
  type TurnRole,
} from "@capygen/shared";
import { ShareCodecError } from "./json.js";
import { sanitize, sanitizeLabel } from "./redact.js";

/**
 * The inert entry schema's own text bound. It is not part of `ShareLimits`
 * because it is the one cap the contract marks as *clipping* rather than
 * refusal: over-long text is exported truncated and flagged, and counted in
 * `truncatedTexts`. Every cardinality cap below behaves the opposite way.
 */
const MAX_TEXT_BYTES = 65_536;

export interface ShareSourceBlock {
  block: Block;
  /** The role of the turn the block belongs to; the only speaker source. */
  turnRole: TurnRole;
}

export interface ShareDisplayAgent {
  label: string;
  backend: Backend | null;
  model: string | null;
}

export interface ShareDisplayMetadata {
  title: string | null;
  mode: "solo" | "round-table" | "custom";
  startedAt: string | null;
  endedAt: string | null;
  agents: ShareDisplayAgent[];
}

/** A local comment as the app holds it, before redaction and bounding. */
export interface ShareCommentInput {
  id: string;
  /**
   * Index into `ShareProjectionInput.blocks` — the *source* block this comment
   * was written on, never a projected entry index.
   *
   * The two differ whenever anything is withheld: drop one reasoning block and
   * every later entry shifts down by one, so a projected index copied straight
   * through would silently point at a neighbouring message. The projection maps
   * source position to entry position instead. `null` means the comment is on
   * the session rather than on any one block.
   */
  entryIndex: number | null;
  author: string;
  body: string;
  createdAt: string;
  replyToId: string | null;
  resolved: boolean;
}

export interface ShareProjectionOptions {
  bundleId: string;
  appVersion: string;
  createdAt: string;
  /**
   * Export recorded reasoning. Off by default: thinking text is the most
   * likely place for a model to have restated something the user would not
   * choose to publish.
   */
  includeReasoning?: boolean;
  /**
   * Tighten-only overrides of the shared `SHARE_LIMITS`. Nothing may raise a
   * cap; tests shrink one so a fixture can reach it without building 100,000
   * entries.
   */
  limits?: Partial<ShareLimits>;
}

export interface ShareProjectionInput {
  blocks: ShareSourceBlock[];
  metadata: ShareDisplayMetadata;
  comments?: ShareCommentInput[];
  options: ShareProjectionOptions;
  /**
   * Receives "source block position → the entry it became", for callers that
   * must re-anchor something of their own against this projection.
   *
   * An out-parameter rather than a widened return type: every existing caller
   * and every test that pins this function's result stays exactly as it is,
   * and a caller that does not need the mapping cannot accidentally depend on
   * it. A position absent from the map was withheld and has no entry.
   */
  onEntryMap?: (entryOfSource: ReadonlyMap<number, number>) => void;
}

const speakerOf = (role: TurnRole): "user" | "assistant" | "system" =>
  role === "user" ? "user" : role === "system" ? "system" : "assistant";

const isoOf = (ms: number): string | null => {
  const at = new Date(ms);
  return Number.isFinite(at.getTime()) ? at.toISOString() : null;
};

interface Draft {
  entry: ShareEntry;
  redactions: number;
}

/** Project one session. Pure: no model call, no I/O, no clock. */
export function projectShareBundle(input: ShareProjectionInput): ShareBundle {
  const limits = resolveShareLimits(input.options.limits);
  let redactions = 0;
  const entries: ShareEntry[] = [];
  const dropped = { thinking: 0, interactive: 0, widgets: 0, usage: 0 };
  /** Source block position → the entry it became. Absent means withheld. */
  const entryOfSource = new Map<number, number>();

  const push = (sourceIndex: number, draft: Draft | null): void => {
    if (!draft) return;
    redactions += draft.redactions;
    if (entries.length >= limits.maxEntries) {
      // A cardinality cap is a refusal threshold, not a budget to trim to
      // (`ShareLimits`). Dropping the tail here would produce a bundle whose
      // own counts agree with themselves while silently missing the end of
      // the conversation — undetectable to whoever receives it.
      throw new ShareCodecError(
        "over-limit",
        `this session projects more than ${limits.maxEntries} entries and cannot be shared as one bundle`,
      );
    }
    entryOfSource.set(sourceIndex, entries.length);
    entries.push({ ...draft.entry, index: entries.length });
  };

  for (const [sourceIndex, { block, turnRole }] of input.blocks.entries()) {
    const at = isoOf(block.createdAt);
    switch (block.kind) {
      case "text": {
        const text = sanitize(block.text, MAX_TEXT_BYTES);
        const speaker = speakerOf(turnRole);
        push(sourceIndex, { redactions: text.redactions, entry: {
          index: 0, at, label: speaker, truncated: text.truncated,
          kind: "message", speaker, text: text.text } });
        break;
      }
      case "thinking": {
        if (!input.options.includeReasoning) { dropped.thinking += 1; break; }
        const text = sanitize(block.text, MAX_TEXT_BYTES);
        push(sourceIndex, { redactions: text.redactions, entry: {
          index: 0, at, label: "assistant", truncated: text.truncated,
          kind: "thinking", text: text.text } });
        break;
      }
      case "tool_call": {
        // The name only. `input`, `output`, `fullOutput`, `outputRef`,
        // `toolUseId` and `serverName` are never read here.
        const name = sanitizeLabel(block.name, limits.maxLabelBytes);
        push(sourceIndex, { redactions: name.redactions, entry: {
          index: 0, at, label: name.text, truncated: false,
          kind: "activity", name: name.text, text: "" } });
        break;
      }
      case "diff": {
        // A diff happened; neither its patch nor the file it touched travels.
        push(sourceIndex, { redactions: 0, entry: {
          index: 0, at, label: "Edit", truncated: false,
          kind: "activity", name: "Edit", text: "" } });
        break;
      }
      case "permission":
      case "question":
      case "elicitation": {
        // The prompt, the decision and the answer are all withheld: a decision
        // is authority-shaped and an answer is whatever the user typed.
        dropped.interactive += 1;
        break;
      }
      case "widget": {
        // `html` is third-party markup from an MCP server. It never travels,
        // in any form, escaped or not.
        dropped.widgets += 1;
        break;
      }
      case "usage": {
        dropped.usage += 1;
        break;
      }
      case "error": {
        const text = sanitize(block.message, MAX_TEXT_BYTES);
        push(sourceIndex, { redactions: text.redactions, entry: {
          index: 0, at, label: "error", truncated: text.truncated,
          kind: "notice", text: text.text } });
        break;
      }
      case "subagent": {
        const name = sanitizeLabel(block.name, limits.maxLabelBytes);
        const text = sanitize(`Sub-agent ${name.text} (${block.status})`, MAX_TEXT_BYTES);
        push(sourceIndex, { redactions: name.redactions + text.redactions, entry: {
          index: 0, at, label: "notice", truncated: text.truncated,
          kind: "notice", text: text.text } });
        break;
      }
      default: {
        // A kind added after this file was written. It cannot be exported
        // (nothing here knows what is safe about it) and it cannot honestly be
        // counted as omitted either, because none of the `dropped*` tallies
        // describes it. Claiming a complete projection would be the lie; the
        // refusal names no value from the block, so it cannot echo content.
        throw new ShareCodecError(
          "unsupported-block",
          "this session contains a block kind the share projection does not model yet",
        );
      }
    }
  }

  const title =
    input.metadata.title === null ? null : sanitizeLabel(input.metadata.title, limits.maxLabelBytes);
  if (title) redactions += title.redactions;

  if (input.metadata.agents.length > limits.maxAgents) {
    throw new ShareCodecError(
      "over-limit",
      `this session names more than ${limits.maxAgents} agents and cannot be shared as one bundle`,
    );
  }
  const agents = input.metadata.agents.map((agent) => {
    const label = sanitizeLabel(agent.label, limits.maxLabelBytes);
    const model = agent.model === null ? null : sanitizeLabel(agent.model, limits.maxLabelBytes);
    redactions += label.redactions + (model?.redactions ?? 0);
    return { label: label.text, backend: agent.backend, model: model === null ? null : model.text };
  });

  const supplied = input.comments ?? [];
  if (supplied.length > limits.maxComments) {
    throw new ShareCodecError(
      "over-limit",
      `this session has more than ${limits.maxComments} comments and cannot be shared as one bundle`,
    );
  }
  const seen = new Set<string>();
  const comments: ShareComment[] = [];
  for (const comment of supplied) {
    // Both of these would otherwise be silent edits to what the caller asked
    // to publish: a dropped comment, or a reply quietly cut loose from the
    // thread it belongs to. Neither has a tally, so neither may happen quietly.
    if (seen.has(comment.id)) {
      throw new ShareCodecError("over-limit", "two comments share one id, so the bundle cannot carry both");
    }
    if (comment.replyToId !== null && !seen.has(comment.replyToId)) {
      throw new ShareCodecError(
        "over-limit",
        "a comment replies to one that does not appear earlier in the session",
      );
    }
    // An anchor names a source block, so it is validated against the blocks
    // that were supplied — a value outside that range is a caller bug and is
    // refused rather than quietly re-pointed at something else.
    if (comment.entryIndex !== null
      && (!Number.isInteger(comment.entryIndex)
        || comment.entryIndex < 0
        || comment.entryIndex >= input.blocks.length)) {
      throw new ShareCodecError(
        "invalid-anchor",
        "a comment is anchored to a block this session does not contain",
      );
    }
    const author = sanitizeLabel(comment.author, limits.maxLabelBytes);
    const body = sanitize(comment.body, limits.maxCommentBytes);
    redactions += author.redactions + body.redactions;
    comments.push({
      id: comment.id,
      // Source position → entry position. A comment on a block this projection
      // withheld has no entry to point at, so it becomes a session-level
      // comment: preserved whole, just unanchored. The alternative — refusing
      // the export — would make comments unusable on any session with withheld
      // reasoning.
      entryIndex:
        comment.entryIndex === null ? null : entryOfSource.get(comment.entryIndex) ?? null,
      author: author.text,
      body: body.text,
      createdAt: comment.createdAt,
      replyToId: comment.replyToId,
      resolved: comment.resolved,
    });
    seen.add(comment.id);
  }

  const counts = {
    entries: entries.length,
    messages: entries.filter((entry) => entry.kind === "message").length,
    thinking: entries.filter((entry) => entry.kind === "thinking").length,
    activities: entries.filter(
      (entry) => entry.kind === "activity" || entry.kind === "activity-result",
    ).length,
    notices: entries.filter((entry) => entry.kind === "notice").length,
    truncatedTexts: entries.filter((entry) => entry.truncated).length,
    droppedInteractive: dropped.interactive,
    droppedThinking: dropped.thinking,
    droppedWidgets: dropped.widgets,
    droppedUsage: dropped.usage,
    redactions,
  };

  input.onEntryMap?.(entryOfSource);

  return {
    kind: "capygen.share",
    version: 1,
    bundleId: input.options.bundleId,
    createdAt: input.options.createdAt,
    appVersion: input.options.appVersion,
    source: {
      title: title === null ? null : title.text,
      mode: input.metadata.mode,
      startedAt: input.metadata.startedAt,
      endedAt: input.metadata.endedAt,
      agents,
    },
    entries,
    counts,
    comments,
  };
}

export interface SenderClaimedOmission {
  kind: "thinking" | "interactive" | "widgets" | "usage" | "redactions";
  count: number;
  /** Always true. These figures come from the file, not from this app. */
  claimed: true;
  description: string;
}

/**
 * What the bundle says it left out.
 *
 * Nothing here is verifiable: the tallies describe content that is not in the
 * file, so a reader can only be told what the sender claims. Rendering must
 * carry that framing through — an omission count is a claim, never a fact this
 * app checked.
 */
export function senderClaimedOmissions(bundle: ShareBundle): SenderClaimedOmission[] {
  const claims: Array<[SenderClaimedOmission["kind"], number, string]> = [
    ["thinking", bundle.counts.droppedThinking, "reasoning blocks the sender says were withheld"],
    ["interactive", bundle.counts.droppedInteractive, "approvals and questions the sender says were withheld"],
    ["widgets", bundle.counts.droppedWidgets, "app widgets the sender says were withheld"],
    ["usage", bundle.counts.droppedUsage, "usage records the sender says were withheld"],
    ["redactions", bundle.counts.redactions, "spans the sender says were redacted"],
  ];
  return claims
    .filter(([, count]) => count > 0)
    .map(([kind, count, description]) => ({ kind, count, claimed: true as const, description }));
}
