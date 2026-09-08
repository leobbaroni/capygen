/**
 * Turning a bounded description of a session into a bundle.
 *
 * Two shapes arrive here and neither is the session itself. A **live** export
 * arrives as `LiveBlockRow`s — the few fields the whitelist actually reads,
 * already clipped by the SQL that selected them, so a tool call's raw input and
 * output never enter a process at all. An **artifact** export arrives as inert
 * entries plus whatever the source disclosed about what it left out.
 *
 * Live rows are turned back into minimal blocks and pushed through the same
 * audited `projectShareBundle` whitelist rather than a second projection: one
 * place decides what is safe to export, and it is the one with the hostile-input
 * tests around it.
 */
import type {
  Block,
  ShareBundle,
  ShareComment,
  ShareCounts,
  ShareEntry,
  TurnRole,
} from "@capygen/shared";
import { ShareCodecError } from "./json.js";
import {
  projectShareBundle,
  type ShareDisplayMetadata,
  type ShareProjectionOptions,
} from "./projection.js";
import { sanitize, sanitizeLabel } from "./redact.js";

const MAX_TEXT_BYTES = 65_536;
const MAX_LABEL_BYTES = 120;
const MAX_COMMENT_BYTES = 16_384;

/**
 * One row of a live session, as selected. `text` is already clipped by SQL and
 * `textLength` is the length before that clip, so truncation is known without
 * transferring the rest. There is deliberately no field for a tool call's
 * input or output: the query does not select them.
 */
export interface LiveBlockRow {
  /** The real block id, so a note anchored to it can be re-anchored exactly. */
  blockId: string;
  kind: string;
  turnRole: TurnRole;
  createdAt: number;
  text: string | null;
  textLength: number;
  name: string | null;
  status: string | null;
}

export interface ShareLiveExportRequest {
  kind: "live";
  rows: LiveBlockRow[];
  metadata: ShareDisplayMetadata;
  options: ShareProjectionOptions;
  /** The operator's own notes, already projected into comment shape. */
  comments?: ShareComment[];
  /**
   * A note's block anchor, by note id. Resolved against the projection's own
   * source→entry map, so a note keeps its place when the block it was written
   * about survives the export, and loses it only when that block does not.
   */
  commentBlockAnchors?: ReadonlyMap<string, string>;
}

export interface ShareEntriesExportRequest {
  kind: "entries";
  /** `native` re-exports withhold recorded tool output; see below. */
  artifact: "native-transcript" | "shared-bundle";
  entries: ShareEntry[];
  comments: ShareComment[];
  metadata: ShareDisplayMetadata;
  options: ShareProjectionOptions;
  inherited?: Partial<Pick<ShareCounts,
    "droppedInteractive" | "droppedThinking" | "droppedWidgets" | "droppedUsage" | "redactions">>;
  /** What the transcript importer itself reported dropping, disclosed as a notice. */
  parserOmissions?: { droppedConfiguration: number; unknownRecords: number };
}

export type ShareExportRequest = ShareLiveExportRequest | ShareEntriesExportRequest;

/** A synthetic block carrying only the fields the whitelist reads. */
function blockOf(row: LiveBlockRow, index: number): Block {
  const base = {
    id: `row_${index}`, turnId: "row", sessionId: "row", index,
    createdAt: row.createdAt, updatedAt: row.createdAt,
  };
  const text = row.text ?? "";
  switch (row.kind) {
    case "text": return { ...base, kind: "text", text } as unknown as Block;
    case "thinking": return { ...base, kind: "thinking", text } as unknown as Block;
    case "tool_call":
      // `input`/`output` are absent because they were never selected.
      return { ...base, kind: "tool_call", name: row.name ?? "tool",
        status: row.status ?? "success" } as unknown as Block;
    case "diff": return { ...base, kind: "diff", path: "", patch: "" } as unknown as Block;
    case "permission": case "question": case "elicitation": case "widget": case "usage":
      return { ...base, kind: row.kind } as unknown as Block;
    case "error": return { ...base, kind: "error", message: text } as unknown as Block;
    case "subagent":
      return { ...base, kind: "subagent", name: row.name ?? "sub-agent",
        status: row.status ?? "done", description: "",
        agentId: null, backend: null, model: null } as unknown as Block;
    default:
      throw new ShareCodecError(
        "unsupported-block",
        "this session contains a block kind the share projection does not model yet",
      );
  }
}

export function buildLiveBundle(request: ShareLiveExportRequest): ShareBundle {
  const blocks = request.rows.map((row, index) => ({
    block: blockOf(row, index),
    turnRole: row.turnRole,
  }));

  /**
   * A note's block anchor, resolved to the *source* position the projector
   * indexes by.
   *
   * The projector takes source positions and does the rest itself: it
   * sanitizes the author and body, counts those redactions into the bundle's
   * own tally, and maps source→entry so a withheld block leaves its note
   * unanchored rather than pointing at a neighbour. An earlier version of this
   * function ran the projection *without* comments and assigned the raw notes
   * afterwards purely to fix the anchors — which silently skipped every one of
   * those steps for live exports, so an unredacted note could leave the
   * machine. Anchors are converted before the projection now, and nothing
   * overwrites what the projector produced.
   */
  const sourceOfBlock = new Map<string, number>();
  request.rows.forEach((row, sourceIndex) => sourceOfBlock.set(row.blockId, sourceIndex));
  const anchors = request.commentBlockAnchors;
  const comments = (request.comments ?? []).map((comment) => {
    const blockId = anchors?.get(comment.id);
    const at = blockId === undefined ? undefined : sourceOfBlock.get(blockId);
    return { ...comment, entryIndex: at ?? null };
  });

  let entryOfSource: ReadonlyMap<number, number> = new Map();
  const bundle = projectShareBundle({
    blocks,
    metadata: request.metadata,
    options: request.options,
    ...(comments.length > 0 ? { comments } : {}),
    onEntryMap: (map) => { entryOfSource = map; },
  });

  // SQL clipped some rows before they were transferred; the flag must say so —
  // on the entry that row actually became. Indexing `rows` by the *entry*
  // position was wrong the moment anything was withheld: one dropped reasoning
  // block shifts every later entry, and the flag then landed on a neighbour.
  let truncated = 0;
  request.rows.forEach((row, sourceIndex) => {
    const at = entryOfSource.get(sourceIndex);
    if (at === undefined) return;
    const entry = bundle.entries[at];
    if (entry && row.textLength > (row.text?.length ?? 0)) entry.truncated = true;
  });
  for (const entry of bundle.entries) if (entry.truncated) truncated += 1;
  bundle.counts.truncatedTexts = truncated;
  return bundle;
}

/**
 * Re-project already-inert entries.
 *
 * Three things this does that a straight copy would not. A **native** transcript
 * keeps a tool call's label but not its recorded output: the share whitelist
 * never exports tool results, and a transcript imported from a CLI is full of
 * them. What the importer itself dropped is **disclosed as a notice** rather
 * than lost, because "configuration records were dropped" is information the
 * reader should have. And received **comments are carried**, re-anchored
 * through the same source→entry mapping the live projection uses, so opting
 * reasoning out cannot silently move a note onto a different message.
 */
export function buildEntriesBundle(request: ShareEntriesExportRequest): ShareBundle {
  const omitResultText = request.artifact === "native-transcript";
  let redactions = 0;
  let droppedThinking = 0;
  const entries: ShareEntry[] = [];
  const entryOfSource = new Map<number, number>();

  request.entries.forEach((entry, sourceIndex) => {
    if (entry.kind === "thinking" && !request.options.includeReasoning) {
      droppedThinking += 1;
      return;
    }
    const label = sanitizeLabel(entry.label, MAX_LABEL_BYTES);
    const raw = "text" in entry ? entry.text : "";
    const hide = omitResultText && entry.kind === "activity-result";
    const text = hide ? { text: "", redactions: 0, truncated: false } : sanitize(raw, MAX_TEXT_BYTES);
    redactions += label.redactions + text.redactions;
    const common = {
      index: entries.length,
      at: entry.at,
      label: label.text,
      truncated: hide ? false : entry.truncated || text.truncated,
    };
    entryOfSource.set(sourceIndex, entries.length);
    if (entry.kind === "activity" || entry.kind === "activity-result") {
      const name = sanitizeLabel(entry.name, MAX_LABEL_BYTES);
      redactions += name.redactions;
      entries.push(entry.kind === "activity"
        ? { ...common, kind: "activity", name: name.text, text: text.text }
        : { ...common, kind: "activity-result", name: name.text, text: text.text, failed: entry.failed });
    } else if (entry.kind === "message") {
      entries.push({ ...common, kind: "message", speaker: entry.speaker, text: text.text });
    } else if (entry.kind === "thinking") {
      entries.push({ ...common, kind: "thinking", text: text.text });
    } else {
      entries.push({ ...common, kind: "notice", text: text.text });
    }
  });

  // The importer's own omissions, disclosed rather than dropped. They have no
  // counterpart in a share's tallies, so they are stated in words instead of
  // being mapped onto a counter that means something else.
  const parser = request.parserOmissions;
  if (parser && (parser.droppedConfiguration > 0 || parser.unknownRecords > 0)) {
    const parts: string[] = [];
    if (parser.droppedConfiguration > 0) {
      parts.push(`${parser.droppedConfiguration} configuration or environment record(s)`);
    }
    if (parser.unknownRecords > 0) parts.push(`${parser.unknownRecords} record(s) of an unknown type`);
    entries.push({
      index: entries.length, at: null, label: "notice", truncated: false, kind: "notice",
      text: `When this transcript was imported, capygen's parser did not carry over ${parts.join(" and ")}.`,
    });
  }

  const title = request.metadata.title === null
    ? null : sanitizeLabel(request.metadata.title, MAX_LABEL_BYTES);
  if (title) redactions += title.redactions;
  const agents = request.metadata.agents.map((agent) => {
    const label = sanitizeLabel(agent.label, MAX_LABEL_BYTES);
    const model = agent.model === null ? null : sanitizeLabel(agent.model, MAX_LABEL_BYTES);
    redactions += label.redactions + (model?.redactions ?? 0);
    return { label: label.text, backend: agent.backend, model: model === null ? null : model.text };
  });

  const seen = new Set<string>();
  const comments: ShareComment[] = [];
  for (const comment of request.comments) {
    if (seen.has(comment.id)) continue;
    const author = sanitizeLabel(comment.author, MAX_LABEL_BYTES);
    const body = sanitize(comment.body, MAX_COMMENT_BYTES);
    redactions += author.redactions + body.redactions;
    comments.push({
      id: comment.id,
      // Re-anchored, never copied: withholding reasoning shifts every later
      // entry, and a copied index would point at a different message.
      entryIndex: comment.entryIndex === null
        ? null
        : entryOfSource.get(comment.entryIndex) ?? null,
      author: author.text,
      body: body.text,
      createdAt: comment.createdAt,
      replyToId: comment.replyToId !== null && seen.has(comment.replyToId) ? comment.replyToId : null,
      resolved: comment.resolved,
    });
    seen.add(comment.id);
  }

  const inherited = request.inherited ?? {};
  return {
    kind: "capygen.share",
    version: 1,
    bundleId: request.options.bundleId,
    createdAt: request.options.createdAt,
    appVersion: request.options.appVersion,
    source: {
      title: title === null ? null : title.text,
      mode: request.metadata.mode,
      startedAt: request.metadata.startedAt,
      endedAt: request.metadata.endedAt,
      agents,
    },
    entries,
    counts: {
      entries: entries.length,
      messages: entries.filter((e) => e.kind === "message").length,
      thinking: entries.filter((e) => e.kind === "thinking").length,
      activities: entries.filter((e) => e.kind === "activity" || e.kind === "activity-result").length,
      notices: entries.filter((e) => e.kind === "notice").length,
      truncatedTexts: entries.filter((e) => e.truncated).length,
      droppedInteractive: inherited.droppedInteractive ?? 0,
      droppedThinking: droppedThinking + (inherited.droppedThinking ?? 0),
      droppedWidgets: inherited.droppedWidgets ?? 0,
      droppedUsage: inherited.droppedUsage ?? 0,
      redactions: redactions + (inherited.redactions ?? 0),
    },
    comments,
  };
}
