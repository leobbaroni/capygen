/**
 * The bounded streaming JSONL reader every import parse goes through.
 *
 * It reads exactly the one path it is handed. It never lists a directory,
 * never resolves a path recorded *inside* the file, and never follows a
 * reference to another transcript — a selected file is the whole authority for
 * one import (docs/plans/phase7-imports.md, "User flow and authority").
 *
 * Bounds are enforced while reading, not afterwards: bytes, per-line bytes and
 * record count are checked as the stream advances, so a hostile or corrupt file
 * is refused before it can be materialized. Decoding is strict UTF-8 per line —
 * a lone surrogate or a truncated multi-byte sequence fails the parse instead
 * of turning into U+FFFD and being stored as if it were the user's text.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveLimits, type ImportLimits } from "./limits.js";
import { ImportError } from "./types.js";

/** One parsed JSONL record. The raw line is not retained past the callback. */
export interface JsonlRecord {
  /** 1-based line number in the source file. */
  line: number;
  value: unknown;
}

export interface ScanJsonlOptions {
  limits?: Partial<ImportLimits>;
  /** Called once per record, in file order. Throwing aborts the scan. */
  onRecord: (record: JsonlRecord) => void;
}

export interface ScanJsonlResult {
  /** SHA-256 over the bytes this scan actually read. */
  sha256: string;
  bytes: number;
  /** Non-blank lines handed to `onRecord`. */
  records: number;
}

const READ_CHUNK_BYTES = 64 * 1024;
const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

/** Magic numbers we recognise well enough to refuse with a real reason. */
const COMPRESSED_MAGICS: ReadonlyArray<readonly number[]> = [
  [0x1f, 0x8b], // gzip
  [0x28, 0xb5, 0x2f, 0xfd], // zstd
  [0x50, 0x4b, 0x03, 0x04], // zip
  [0x42, 0x5a, 0x68], // bzip2
];

function looksCompressed(head: Buffer): boolean {
  return COMPRESSED_MAGICS.some(
    (magic) => head.length >= magic.length && magic.every((byte, i) => head[i] === byte),
  );
}

/** Strict UTF-8 for one line. Kept per line so nothing unbounded is decoded. */
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function decodeLine(bytes: Buffer, line: number): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new ImportError(
      "invalid-utf8",
      `line ${line} is not valid UTF-8, so the file cannot be read as a transcript`,
      line,
    );
  }
}

/**
 * Read `filePath` as JSONL, calling `onRecord` for each record in order.
 *
 * The caller keeps only what it projects out of each record; this function
 * retains nothing but the running hash and the counters.
 */
export async function scanJsonlFile(
  filePath: string,
  options: ScanJsonlOptions,
): Promise<ScanJsonlResult> {
  const limits = resolveLimits(options.limits);
  if (!path.isAbsolute(filePath)) {
    throw new ImportError("not-a-file", "the selected transcript must be an absolute path");
  }

  const handle = await fs.open(filePath, "r").catch(() => {
    throw new ImportError("not-a-file", "the selected transcript could not be opened");
  });

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new ImportError("not-a-file", "the selected transcript is not a regular file");
    }
    if (stat.size === 0) {
      throw new ImportError("empty", "the selected transcript is empty");
    }
    if (stat.size > limits.maxSourceBytes) {
      throw new ImportError(
        "too-large",
        `the selected transcript is larger than the ${limits.maxSourceBytes}-byte import limit`,
      );
    }

    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    /** Byte pieces of the line currently being assembled. */
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let bytes = 0;
    let lineNumber = 0;
    let records = 0;
    let firstChunk = true;

    const flushLine = (): void => {
      lineNumber += 1;
      let slice = Buffer.concat(pending, pendingBytes);
      pending = [];
      pendingBytes = 0;

      // Tolerate CRLF: a Windows-written transcript is still a transcript.
      if (slice.length > 0 && slice[slice.length - 1] === CARRIAGE_RETURN) {
        slice = slice.subarray(0, slice.length - 1);
      }
      // A UTF-8 BOM only ever leads the file; strip it so line 1 still parses.
      if (
        lineNumber === 1 &&
        slice.length >= 3 &&
        slice[0] === 0xef &&
        slice[1] === 0xbb &&
        slice[2] === 0xbf
      ) {
        slice = slice.subarray(3);
      }
      const text = decodeLine(slice, lineNumber).trim();
      if (text.length === 0) return; // blank separator lines are not records

      records += 1;
      if (records > limits.maxRecords) {
        throw new ImportError(
          "too-many-records",
          `the selected transcript has more than the ${limits.maxRecords}-record import limit`,
          lineNumber,
        );
      }
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        throw new ImportError("invalid-json", `line ${lineNumber} is not valid JSON`, lineNumber);
      }
      options.onRecord({ line: lineNumber, value });
    };

    const addPiece = (piece: Buffer): void => {
      pendingBytes += piece.length;
      if (pendingBytes > limits.maxLineBytes) {
        throw new ImportError(
          "line-too-long",
          `line ${lineNumber + 1} is longer than the ${limits.maxLineBytes}-byte import limit`,
          lineNumber + 1,
        );
      }
      if (piece.length > 0) pending.push(Buffer.from(piece));
    };

    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, READ_CHUNK_BYTES, null);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);

      if (firstChunk) {
        firstChunk = false;
        if (looksCompressed(chunk)) {
          throw new ImportError(
            "compressed",
            "the selected transcript looks compressed; capygen imports plain JSONL only",
          );
        }
      }

      bytes += bytesRead;
      if (bytes > limits.maxSourceBytes) {
        // The file grew between stat and read, or stat lied (a pipe-backed
        // path). Either way the bound is the bound.
        throw new ImportError(
          "too-large",
          `the selected transcript is larger than the ${limits.maxSourceBytes}-byte import limit`,
        );
      }
      hash.update(chunk);

      let start = 0;
      for (;;) {
        const newline = chunk.indexOf(NEWLINE, start);
        if (newline === -1) break;
        addPiece(chunk.subarray(start, newline));
        flushLine();
        start = newline + 1;
      }
      addPiece(chunk.subarray(start));
    }

    // A final line without a trailing newline is still a record.
    if (pendingBytes > 0) flushLine();

    if (records === 0) {
      throw new ImportError("empty", "the selected transcript contains no JSONL records");
    }

    return { sha256: hash.digest("hex"), bytes, records };
  } finally {
    await handle.close().catch(() => {
      // The read already produced its result or its error; a failing close is
      // not something the preview can act on.
    });
  }
}
