/**
 * The normalized import result: what a parsed Claude or Codex transcript looks
 * like once it is *inert* (docs/plans/phase7-imports.md).
 *
 * Inert is the whole point of these types. There is deliberately no tool-use
 * id, no pending state, no permission decision, no agent id, no native resume
 * id and no configuration value anywhere in this shape — a historical tool call
 * is a label plus bounded text, a historical speaker is a label, and nothing
 * here can be dispatched, replayed or resumed. Anything the parser cannot
 * express this way is counted and warned about, never carried through as a raw
 * payload.
 */

/** Which CLI wrote the selected file. */
export type ImportBackend = "claude" | "codex";

/** Why a parse refused. Every one of these fails the entire preview. */
export type ImportErrorCode =
  | "not-a-file"
  | "empty"
  | "compressed"
  | "too-large"
  | "line-too-long"
  | "too-many-records"
  | "normalized-too-large"
  | "invalid-utf8"
  | "invalid-json"
  | "unsupported-structure"
  | "conflicting-identity"
  | "unknown-format";

/** A refusal. Carries a machine code so the preview can explain itself. */
export class ImportError extends Error {
  readonly code: ImportErrorCode;
  /** 1-based JSONL line, when the failure belongs to one. */
  readonly line?: number;

  constructor(code: ImportErrorCode, message: string, line?: number) {
    super(message);
    this.name = "ImportError";
    this.code = code;
    this.line = line;
  }
}

/**
 * A non-fatal note about what the snapshot does *not* contain. Warnings are
 * how this parser stays honest: it never invents missing history and never
 * claims a lossless import.
 */
export interface ImportWarning {
  code: string;
  message: string;
  /** How many records provoked it, when it is a per-record condition. */
  count?: number;
}

/** One unknown record type, kept as a bounded label and a count — never a payload. */
export interface UnknownRecordTally {
  type: string;
  count: number;
}

/** Who said it. A label for display only; never a dispatchable speaker. */
export type ImportSpeaker = "user" | "assistant" | "system";

interface ImportedEntryBase {
  /** Position in the normalized transcript, 0-based and chronological. */
  index: number;
  /** ISO-8601 from the source record, when it had one. Provenance only. */
  at: string | null;
  /** Display label, e.g. "user", "assistant", "Bash (historical)". */
  label: string;
  /** True when `text` was clipped to a byte limit. */
  truncated: boolean;
}

/** Ordinary transcript prose. */
export interface ImportedMessageEntry extends ImportedEntryBase {
  kind: "message";
  speaker: ImportSpeaker;
  text: string;
}

/** Recorded reasoning/thinking text. */
export interface ImportedThinkingEntry extends ImportedEntryBase {
  kind: "thinking";
  text: string;
}

/**
 * A tool call as it happened, flattened to text. `name` is the recorded tool
 * name for the label; `text` is the bounded, escaped-by-the-renderer detail.
 * There is no call id here on purpose — nothing can be correlated back into a
 * live tool-use block or re-executed.
 */
export interface ImportedActivityEntry extends ImportedEntryBase {
  kind: "activity";
  name: string;
  text: string;
}

/** The recorded result of a tool call, likewise flattened and bounded. */
export interface ImportedActivityResultEntry extends ImportedEntryBase {
  kind: "activity-result";
  name: string;
  text: string;
  /** The source marked the call as failed, when it said so at all. */
  failed: boolean | null;
}

/** A structural note from the source (compaction boundary, rollback, …). */
export interface ImportedNoticeEntry extends ImportedEntryBase {
  kind: "notice";
  text: string;
}

export type ImportedEntry =
  | ImportedMessageEntry
  | ImportedThinkingEntry
  | ImportedActivityEntry
  | ImportedActivityResultEntry
  | ImportedNoticeEntry;

/** Everything the preview counts. Values are never retained for the dropped ones. */
export interface ImportCounts {
  /** JSONL records read (non-blank lines). */
  records: number;
  /** Entries kept in the normalized transcript. */
  entries: number;
  messages: number;
  thinking: number;
  activities: number;
  notices: number;
  /** Configuration/auth/environment records dropped without retaining values. */
  droppedConfiguration: number;
  /** Records of a type this parser does not model; see `unknownTypes`. */
  unknownRecords: number;
  /** Event echoes of text already present as a canonical item (Codex). */
  echoedEvents: number;
  /** Entries whose text hit a byte limit. */
  truncatedTexts: number;
  /** UTF-8 bytes of the complete serialized snapshot, including metadata. */
  normalizedBytes: number;
}

/**
 * The parsed snapshot. `sourceSha256` is over the bytes actually read during
 * this parse, so a later commit imports the reviewed snapshot rather than
 * whatever the file happens to contain by then.
 */
export interface ImportedTranscript {
  backend: ImportBackend;
  /** The wire format this was read as, pinned in the parser that produced it. */
  format: string;
  /** The backend's own session/thread id, validated. Provenance, never a resume id. */
  nativeId: string;
  /** Derived for display, bounded. Null when nothing usable was recorded. */
  title: string | null;
  /** The exact path that was selected. No other file was opened. */
  sourcePath: string;
  sourceBytes: number;
  sourceSha256: string;
  /** The source's own working directory, if recorded. Provenance only. */
  cwd: string | null;
  startedAt: string | null;
  endedAt: string | null;
  entries: ImportedEntry[];
  counts: ImportCounts;
  unknownTypes: UnknownRecordTally[];
  warnings: ImportWarning[];
  /**
   * False when the source itself says part of the conversation lives elsewhere
   * (a history prefix, a fork parent, a compaction that replaced history). The
   * parser never opens the referenced file to fill the gap.
   */
  complete: boolean;
}
