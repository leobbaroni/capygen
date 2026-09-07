/**
 * The shared normalization surface both parsers write through.
 *
 * Having exactly one place that appends an entry is what makes the caps
 * enforceable. Three things happen here and nowhere else:
 *
 *   - every retained string is clamped — the text, but also the label, the tool
 *     name, the timestamp. A 1 MiB tool name repeated across 50,000 tiny blocks
 *     would otherwise walk straight past a text-only budget;
 *   - the byte total is the *serialized* size: each entry is measured as the
 *     JSON it will become (escaping included — one control character costs the
 *     six bytes of `\u0001`, not one), plus its separator, and the finished
 *     snapshot is sealed against the same cap with its envelope — title, cwd,
 *     counts, warnings, unknown-type tallies — counted too;
 *   - the entry count is capped independently of the record count, because one
 *     record can expand into many entries.
 */
import type { ImportLimits } from "./limits.js";
import {
  ImportError,
  type ImportCounts,
  type ImportSpeaker,
  type ImportWarning,
  type ImportedEntry,
  type UnknownRecordTally,
} from "./types.js";

export interface ClampedText {
  text: string;
  truncated: boolean;
}

/** Marks a clip so a reader never mistakes a bounded excerpt for the whole thing. */
export const TRUNCATION_MARKER = "\n… [capygen: truncated at the import limit]";
/** The marker used when even the full marker would not fit inside the budget. */
const SHORT_MARKER = "…";

const MARKER_BYTES = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
const SHORT_MARKER_BYTES = Buffer.byteLength(SHORT_MARKER, "utf8");

/** UTF-8 length. */
export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * The UTF-8 size of a value *as JSON* — what it actually costs once stored or
 * sent, escaping and punctuation included. Measured per field rather than by
 * serializing the whole snapshot at once, so nothing has to allocate a copy of
 * a large transcript to find out how large it is.
 */
/** The bytes `,"entries":` costs in the finished snapshot. */
const ENTRIES_KEY_BYTES = utf8Bytes(',"entries":');

export function serializedBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value) ?? "null");
}

/**
 * Clip `value` to `maxBytes` of UTF-8 without splitting a code point, and
 * without the marker pushing the result back over the bound.
 *
 * A byte slice would happily cut a multi-byte sequence in half and hand the
 * renderer a lone half-character, so this walks code points. When the budget is
 * smaller than the marker itself (a deliberately tiny test override), the marker
 * degrades to `…` and then to nothing rather than overflowing: the postcondition
 * `utf8Bytes(result) <= maxBytes` holds for every input.
 */
export function clampUtf8(value: string, maxBytes: number): ClampedText {
  if (utf8Bytes(value) <= maxBytes) return { text: value, truncated: false };
  if (maxBytes <= 0) return { text: "", truncated: true };

  const marker =
    MARKER_BYTES <= maxBytes
      ? TRUNCATION_MARKER
      : SHORT_MARKER_BYTES <= maxBytes
        ? SHORT_MARKER
        : "";
  const budget = maxBytes - utf8Bytes(marker);

  let used = 0;
  let out = "";
  for (const codePoint of value) {
    const size = utf8Bytes(codePoint);
    if (used + size > budget) break;
    used += size;
    out += codePoint;
  }
  return { text: `${out}${marker}`, truncated: true };
}

/** A label or tool name, bounded by characters *and* by the byte clamp. */
export function clampLabel(value: string, maxChars: number): string {
  const trimmed = value.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
  const sliced = trimmed.length > maxChars ? `${trimmed.slice(0, maxChars - 1)}…` : trimmed;
  return sliced.length > 0 ? sliced : "unnamed";
}

/**
 * ISO-8601 or nothing. A timestamp is retained text like any other, and a
 * transcript we did not write can put anything in that field.
 */
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})?$/;

export function validTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40 || !TIMESTAMP_PATTERN.test(value)) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

function emptyCounts(): ImportCounts {
  return {
    records: 0,
    entries: 0,
    messages: 0,
    thinking: 0,
    activities: 0,
    notices: 0,
    droppedConfiguration: 0,
    unknownRecords: 0,
    echoedEvents: 0,
    truncatedTexts: 0,
    normalizedBytes: 0,
  };
}

/**
 * Text that was already clipped upstream (the Claude projection bounds blocks
 * before the SDK ever sees them) carries its truncation forward, so the entry
 * and `counts.truncatedTexts` stay truthful even when the final clamp finds
 * nothing left to do.
 */
interface AppendCommon {
  preTruncated?: boolean;
}

export interface AppendMessage extends AppendCommon {
  kind: "message";
  speaker: ImportSpeaker;
  label?: string;
  text: string;
  at: string | null;
}

export interface AppendThinking extends AppendCommon {
  kind: "thinking";
  label?: string;
  text: string;
  at: string | null;
}

export interface AppendActivity extends AppendCommon {
  kind: "activity";
  name: string;
  text: string;
  at: string | null;
}

export interface AppendActivityResult extends AppendCommon {
  kind: "activity-result";
  name: string;
  text: string;
  failed?: boolean | null;
  at: string | null;
}

export interface AppendNotice extends AppendCommon {
  kind: "notice";
  label?: string;
  text: string;
  at: string | null;
}

export type AppendInput =
  | AppendMessage
  | AppendThinking
  | AppendActivity
  | AppendActivityResult
  | AppendNotice;

/**
 * How an entry that merely *echoes* other text is tagged, so `resolveEchoes`
 * can decide at the end whether a canonical copy made it redundant — without
 * having to move it out of its place in the source order.
 */
export interface EchoTag {
  speaker: ImportSpeaker;
  text: string;
}

/**
 * Accumulates one normalized transcript. Not exported from the package root —
 * parsers own it, consumers see only the finished `ImportedTranscript`.
 */
export class TranscriptBuilder {
  readonly counts: ImportCounts = emptyCounts();

  private entries: ImportedEntry[] = [];
  /** Retained bytes charged for `entries[i]`, so a removal can refund exactly. */
  private entryBytes: number[] = [];
  /** `echoTags[i]` is set when `entries[i]` came from an echo event. */
  private echoTags: Array<EchoTag | null> = [];
  private readonly warnings = new Map<string, ImportWarning>();
  private readonly unknown = new Map<string, number>();
  private unknownOverflow = 0;

  constructor(private readonly limits: ImportLimits) {}

  /** Add `bytes` to the running total, refusing once the cap is passed. */
  private charge(bytes: number): void {
    this.counts.normalizedBytes += bytes;
    if (this.counts.normalizedBytes > this.limits.maxNormalizedBytes) {
      throw new ImportError(
        "normalized-too-large",
        `the transcript normalizes to more than the ${this.limits.maxNormalizedBytes}-byte import limit`,
      );
    }
  }

  /** An entry's cost: the JSON it becomes, plus the comma that will join it. */
  private costOf(entry: ImportedEntry): number {
    return serializedBytes(entry) + 1;
  }

  append(input: AppendInput, echo: EchoTag | null = null): void {
    if (this.entries.length >= this.limits.maxEntries) {
      throw new ImportError(
        "too-many-records",
        `the transcript normalizes to more than the ${this.limits.maxEntries}-entry import limit`,
      );
    }

    const maxBytes =
      input.kind === "activity" || input.kind === "activity-result"
        ? this.limits.maxToolTextBytes
        : this.limits.maxMessageBytes;
    const clamped = clampUtf8(input.text, maxBytes);
    const text = clamped.text;
    const truncated = clamped.truncated || input.preTruncated === true;
    const at = validTimestamp(input.at);
    if (input.at !== null && at === null) {
      this.warn(
        "import.invalid-timestamp",
        "some records carried a timestamp that is not ISO-8601; those entries have no time",
      );
    }
    const name =
      input.kind === "activity" || input.kind === "activity-result"
        ? clampLabel(input.name, this.limits.maxLabelChars)
        : null;
    const label = clampLabel(
      input.kind === "message"
        ? (input.label ?? input.speaker)
        : input.kind === "thinking"
          ? (input.label ?? "thinking (historical)")
          : input.kind === "notice"
            ? (input.label ?? "notice")
            : input.kind === "activity"
              ? `${name} (historical)`
              : `${name} result (historical)`,
      this.limits.maxLabelChars,
    );

    const index = this.entries.length;
    const common = { index, at, label, truncated, text };
    let entry: ImportedEntry;
    switch (input.kind) {
      case "message":
        entry = { kind: "message", ...common, speaker: input.speaker };
        break;
      case "thinking":
        entry = { kind: "thinking", ...common };
        break;
      case "activity":
        entry = { kind: "activity", ...common, name: name ?? "unnamed" };
        break;
      case "activity-result":
        entry = {
          kind: "activity-result",
          ...common,
          name: name ?? "unnamed",
          failed: input.failed ?? null,
        };
        break;
      case "notice":
        entry = { kind: "notice", ...common };
        break;
    }

    // Charged before it is kept: a refusal leaves no half-counted entry behind.
    const bytes = this.costOf(entry);
    this.charge(bytes);

    this.entries.push(entry);
    this.entryBytes.push(bytes);
    this.echoTags.push(echo);
    if (truncated) this.counts.truncatedTexts += 1;
    switch (entry.kind) {
      case "message":
        this.counts.messages += 1;
        break;
      case "thinking":
        this.counts.thinking += 1;
        break;
      case "activity":
      case "activity-result":
        this.counts.activities += 1;
        break;
      case "notice":
        this.counts.notices += 1;
        break;
    }
    this.counts.entries = this.entries.length;
  }

  /** The entries so far, read-only. */
  list(): ReadonlyArray<ImportedEntry> {
    return this.entries;
  }

  /** Every echo entry's tag, in source order, for the parser's dedup decision. */
  echoTagList(): ReadonlyArray<EchoTag | null> {
    return this.echoTags;
  }

  /**
   * Drop the echo entries `shouldKeep` rejects, keeping the rest exactly where
   * the source put them. Refunds their bytes and counts so a suppressed echo
   * costs nothing, then re-indexes.
   */
  resolveEchoes(shouldKeep: (tag: EchoTag) => boolean): number {
    let dropped = 0;
    const entries: ImportedEntry[] = [];
    const entryBytes: number[] = [];
    const echoTags: Array<EchoTag | null> = [];

    this.entries.forEach((entry, i) => {
      const tag = this.echoTags[i] ?? null;
      if (tag && !shouldKeep(tag)) {
        dropped += 1;
        this.counts.normalizedBytes -= this.entryBytes[i] ?? 0;
        if (entry.kind === "message") this.counts.messages -= 1;
        if (entry.truncated) this.counts.truncatedTexts -= 1;
        return;
      }
      // Re-index changes the entry's own JSON, so it is re-measured rather
      // than carrying the pre-removal cost forward.
      const reindexed = { ...entry, index: entries.length };
      const cost = this.costOf(reindexed);
      this.counts.normalizedBytes += cost - (this.entryBytes[i] ?? 0);
      entries.push(reindexed);
      entryBytes.push(cost);
      echoTags.push(tag);
    });

    this.entries = entries;
    this.entryBytes = entryBytes;
    this.echoTags = echoTags;
    this.counts.entries = entries.length;
    this.counts.echoedEvents = dropped;
    return dropped;
  }

  /** A record whose values are configuration/auth/environment: counted, never kept. */
  dropConfiguration(count = 1): void {
    this.counts.droppedConfiguration += count;
  }

  /**
   * A record type this parser does not model. Only a sanitized label and a
   * count survive — never the payload, which may be anything at all.
   */
  countUnknown(rawType: unknown): void {
    this.counts.unknownRecords += 1;
    const label = sanitizeTypeLabel(rawType, this.limits.maxTypeLabelChars);
    const existing = this.unknown.get(label);
    if (existing !== undefined) {
      this.unknown.set(label, existing + 1);
      return;
    }
    if (this.unknown.size >= this.limits.maxUnknownTypes) {
      this.unknownOverflow += 1;
      return;
    }
    this.unknown.set(label, 1);
  }

  warn(code: string, message: string, count = 1): void {
    const existing = this.warnings.get(code);
    if (existing) {
      existing.count = (existing.count ?? 0) + count;
      return;
    }
    this.warnings.set(code, { code, message, count });
  }

  /**
   * Check the finished snapshot — entries *and* envelope — against the byte
   * cap, and leave `counts.normalizedBytes` equal to what was measured.
   *
   * The envelope is serialized on its own (it is small) and added to the
   * running entry total, so a full copy of the transcript is never built just
   * to size it. The result is exact for `{...envelope, entries}`:
   * `counts.normalizedBytes === utf8Bytes(JSON.stringify(transcript))`.
   * That number lives inside the envelope it is measuring, so the measurement
   * iterates to a fixed point — writing a longer number can make the envelope
   * a byte or two longer.
   */
  sealEnvelope(envelope: Record<string, unknown>): number {
    const n = this.entries.length;
    // `entryBytes` carries a +1 separator per entry for the incremental check;
    // an array of n entries really has n - 1 commas, plus its two brackets.
    const entriesBytes =
      this.entryBytes.reduce((sum, bytes) => sum + bytes, 0) - n + Math.max(0, n - 1) + 2;
    let total = 0;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const measured =
        serializedBytes({ ...envelope, counts: this.counts }) + ENTRIES_KEY_BYTES + entriesBytes;
      if (measured === total) break;
      total = measured;
      this.counts.normalizedBytes = measured;
    }
    if (total > this.limits.maxNormalizedBytes) {
      throw new ImportError(
        "normalized-too-large",
        `the transcript normalizes to more than the ${this.limits.maxNormalizedBytes}-byte import limit`,
      );
    }
    return total;
  }

  finish(): {
    entries: ImportedEntry[];
    warnings: ImportWarning[];
    unknownTypes: UnknownRecordTally[];
  } {
    if (this.unknownOverflow > 0) {
      this.warn(
        "import.unknown-type-overflow",
        `more than ${this.limits.maxUnknownTypes} distinct unrecognized record types appeared; the rest are counted only`,
        this.unknownOverflow,
      );
    }
    const unknownTypes = [...this.unknown.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
    return {
      entries: this.entries,
      warnings: [...this.warnings.values()],
      unknownTypes,
    };
  }
}

/**
 * A record's `type` is attacker-influenced text from a file we did not write.
 * Only a short, boring label survives — no control characters, no newlines, no
 * unbounded length, and a fixed placeholder when it is not a string at all.
 */
export function sanitizeTypeLabel(rawType: unknown, maxChars: number): string {
  if (typeof rawType !== "string") return "(non-string type)";
  const cleaned = rawType.replace(/[^A-Za-z0-9_.:/-]+/g, "-").slice(0, maxChars);
  return cleaned.length > 0 ? cleaned : "(empty type)";
}

/** First non-empty line of `text`, bounded — the display title fallback. */
export function deriveTitle(text: string, maxChars: number): string | null {
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (!line) return null;
  return line.length > maxChars ? `${line.slice(0, maxChars - 1)}…` : line;
}
