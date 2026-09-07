/**
 * The entry point: one selected path in, one inert snapshot out.
 *
 * Backend detection is structural, and it does not have to succeed on the very
 * first line: a real Claude transcript can open with a `file-history-snapshot`
 * or a queue marker before any conversation record, so undecided leading
 * records are held (bounded) and replayed into the collector once the backend
 * is known. The file is still read exactly once — nothing re-opens it, and no
 * second pass can see a different file than the one that was hashed.
 */
import { scanJsonlFile, type JsonlRecord } from "./jsonl.js";
import { resolveLimits, type ImportLimits } from "./limits.js";
import {
  CLAUDE_MARKER_TYPES,
  createClaudeCollector,
  type ClaudeChainReconstructor,
} from "./claude.js";
import { CODEX_ROLLOUT_TYPES, createCodexCollector } from "./codex.js";
import type { TranscriptCollector } from "./collector.js";
import { ImportError, type ImportBackend, type ImportedTranscript } from "./types.js";

/** How many undecided leading records are held before the file is refused. */
const MAX_UNDECIDED_RECORDS = 32;

/** Fields that only a Claude transcript record carries. */
const CLAUDE_FIELDS = ["uuid", "parentUuid", "sessionId", "leafUuid", "isSidechain", "message"];

/**
 * Which backend wrote a record, judged only by its shape — never by the path.
 *
 * A Codex rollout line is `{ timestamp, ordinal?, type, payload }` where `type`
 * is one of the `RolloutItemWire` tags; requiring a *known* tag keeps "some
 * object with a timestamp and a payload" from being read as Codex. A Claude
 * line is a record with one of the CLI's own types, or one carrying the chain
 * fields. Anything else is undecided, not a verdict.
 */
export function detectBackendFromRecord(value: unknown): ImportBackend | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const type = record.type;
  if (typeof type !== "string") return null;

  const payload = record.payload;
  const hasPayloadObject =
    typeof payload === "object" && payload !== null && !Array.isArray(payload);
  if (typeof record.timestamp === "string" && hasPayloadObject && CODEX_ROLLOUT_TYPES.has(type)) {
    return "codex";
  }
  if (hasPayloadObject) return null;
  if (CLAUDE_MARKER_TYPES.has(type)) return "claude";
  if (CLAUDE_FIELDS.some((field) => field in record)) return "claude";
  return null;
}

export interface ParseTranscriptOptions {
  limits?: Partial<ImportLimits>;
  /**
   * Required for Claude files: the canonical parent chain comes from the
   * installed SDK through a read-only store (see `claude.ts`). Codex files do
   * not use it.
   */
  reconstruct?: ClaudeChainReconstructor;
}

/**
 * Parse the one file at `filePath`. Never scans a directory, never follows a
 * path recorded inside the file, never spawns a backend and never writes.
 */
export async function parseTranscriptFile(
  filePath: string,
  options: ParseTranscriptOptions = {},
): Promise<ImportedTranscript> {
  const limits = resolveLimits(options.limits);
  let collector: TranscriptCollector | null = null;
  let undecided: JsonlRecord[] = [];

  const start = (backend: ImportBackend, line: number): TranscriptCollector => {
    if (backend === "claude") {
      if (!options.reconstruct) {
        throw new ImportError(
          "unsupported-structure",
          "a Claude transcript needs an injected chain reconstructor to be imported",
          line,
        );
      }
      return createClaudeCollector({ limits, reconstruct: options.reconstruct });
    }
    return createCodexCollector({ limits });
  };

  const onRecord = (record: JsonlRecord): void => {
    if (collector) {
      collector.accept(record);
      return;
    }
    const backend = detectBackendFromRecord(record.value);
    if (backend === null) {
      undecided.push(record);
      if (undecided.length > MAX_UNDECIDED_RECORDS) {
        throw new ImportError(
          "unknown-format",
          "the selected file is not a Claude transcript or a Codex rollout",
          record.line,
        );
      }
      return;
    }
    const started = start(backend, record.line);
    collector = started;
    // Replay what was held back, in order, so nothing is skipped or reordered.
    for (const held of undecided) started.accept(held);
    undecided = [];
    started.accept(record);
  };

  const scan = await scanJsonlFile(filePath, { limits: options.limits, onRecord });
  if (!collector) {
    throw new ImportError(
      "unknown-format",
      "the selected file is not a Claude transcript or a Codex rollout",
    );
  }
  return await (collector as TranscriptCollector).finish({
    filePath,
    bytes: scan.bytes,
    sha256: scan.sha256,
  });
}
