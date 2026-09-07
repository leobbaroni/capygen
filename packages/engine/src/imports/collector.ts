/**
 * The one-record-at-a-time seam between the bounded reader and a backend
 * parser. The reader owns the file and the caps; a collector owns the meaning
 * of a record and never sees a path, a handle or the raw bytes.
 */
import type { JsonlRecord } from "./jsonl.js";
import type { ImportBackend, ImportedTranscript } from "./types.js";

/** What the reader knows about the source once the scan has finished. */
export interface CollectorSource {
  filePath: string;
  bytes: number;
  sha256: string;
}

export interface TranscriptCollector {
  backend: ImportBackend;
  /** Called in file order. Throwing an `ImportError` fails the whole preview. */
  accept(record: JsonlRecord): void;
  finish(source: CollectorSource): Promise<ImportedTranscript> | ImportedTranscript;
}
