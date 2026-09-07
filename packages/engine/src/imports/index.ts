/**
 * Phase 7 transcript imports: parse one explicitly selected Claude JSONL or
 * Codex rollout file into an inert, bounded snapshot.
 *
 * The package root exposes the parser and its inert result types. App staging,
 * IPC, persistence and the isolated Claude worker are separate integrations.
 */
export { IMPORT_LIMITS, resolveLimits, type ImportLimits } from "./limits.js";
export {
  ImportError,
  type ImportBackend,
  type ImportCounts,
  type ImportErrorCode,
  type ImportSpeaker,
  type ImportWarning,
  type ImportedActivityEntry,
  type ImportedActivityResultEntry,
  type ImportedEntry,
  type ImportedMessageEntry,
  type ImportedNoticeEntry,
  type ImportedThinkingEntry,
  type ImportedTranscript,
  type UnknownRecordTally,
} from "./types.js";
export {
  TRUNCATION_MARKER,
  clampLabel,
  clampUtf8,
  deriveTitle,
  serializedBytes,
  validTimestamp,
} from "./builder.js";
export { scanJsonlFile, type JsonlRecord, type ScanJsonlResult } from "./jsonl.js";
export { detectBackendFromRecord, parseTranscriptFile, type ParseTranscriptOptions } from "./parse.js";
export {
  CLAUDE_RECONSTRUCTION_NOTE,
  CLAUDE_TRANSCRIPT_FORMAT,
  createClaudeCollector,
  createReadOnlySessionStore,
  createSdkChainReconstructor,
  CLAUDE_MARKER_TYPES,
  type ClaudeChainReconstructor,
  type ClaudeStoreEntry,
  type GetSessionMessagesLike,
  type ProjectedBlock,
  type ProjectedMessage,
} from "./claude.js";
export { CODEX_ROLLOUT_TYPES, CODEX_TRANSCRIPT_FORMAT, createCodexCollector } from "./codex.js";
export type { CollectorSource, TranscriptCollector } from "./collector.js";
export {
  buildImportReference,
  IMPORTED_REFERENCE_SPEAKER_LABEL,
  IMPORT_REFERENCE_MAX_BYTES,
} from "./continuation.js";
