/**
 * The hard bounds every import parse runs under (docs/plans/phase7-imports.md,
 * "Parsing and limits").
 *
 * These are refusal thresholds, not budgets to trim to: exceeding one fails the
 * whole preview rather than importing a silently partial transcript. They exist
 * because the selected file is user-chosen and otherwise unbounded — a 4 GiB
 * rollout, a single 900 MiB JSON line, or a transcript that normalizes into
 * more memory than the machine has are all reachable by accident.
 */
import { ImportError } from "./types.js";

export interface ImportLimits {
  /** Bytes read from the selected file before the parse refuses. */
  maxSourceBytes: number;
  /** Bytes in one JSONL line, measured before decoding. */
  maxLineBytes: number;
  /** JSONL records (non-blank lines) considered. */
  maxRecords: number;
  /**
   * Normalized entries produced. Independent of `maxRecords` on purpose: one
   * source record can expand into many entries (a message with a dozen content
   * blocks), so the record cap alone does not bound the result.
   */
  maxEntries: number;
  /** UTF-8 bytes of the complete serialized snapshot, including metadata. */
  maxNormalizedBytes: number;
  /** UTF-8 bytes kept for one historical tool call or result. */
  maxToolTextBytes: number;
  /** UTF-8 bytes kept for one historical message. */
  maxMessageBytes: number;
  /** Distinct unknown record-type labels tracked (each with a count only). */
  maxUnknownTypes: number;
  /** Characters of a record-type label retained for the unknown-type tally. */
  maxTypeLabelChars: number;
  /** Characters of a derived title. */
  maxTitleChars: number;
  /** Characters of a retained label or tool name. */
  maxLabelChars: number;
  /** Characters of a retained path (the source `cwd`). */
  maxPathChars: number;
}

export const IMPORT_LIMITS: ImportLimits = {
  maxSourceBytes: 256 * 1024 * 1024,
  maxLineBytes: 1024 * 1024,
  maxRecords: 100_000,
  maxEntries: 100_000,
  maxNormalizedBytes: 256 * 1024 * 1024,
  maxToolTextBytes: 64 * 1024,
  maxMessageBytes: 64 * 1024,
  maxUnknownTypes: 64,
  maxTypeLabelChars: 64,
  maxTitleChars: 120,
  maxLabelChars: 120,
  maxPathChars: 1024,
};

/**
 * Merge caller overrides onto the shipped limits.
 *
 * An override may only *tighten*: every value must be a finite positive integer
 * no larger than the shipped one. Tests use this to shrink a cap to something
 * a fixture can reach; nothing may use it to raise a bound, and a `NaN`,
 * `Infinity` or fractional value would silently disable the check it belongs
 * to, so those are refused outright.
 */
export function resolveLimits(overrides?: Partial<ImportLimits>): ImportLimits {
  const limits = { ...IMPORT_LIMITS };
  if (!overrides) return limits;
  for (const [key, value] of Object.entries(overrides) as Array<[keyof ImportLimits, unknown]>) {
    if (value === undefined) continue;
    const shipped = IMPORT_LIMITS[key];
    if (shipped === undefined) {
      throw new ImportError("unsupported-structure", `unknown import limit "${String(key)}"`);
    }
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      throw new ImportError(
        "unsupported-structure",
        `the import limit "${String(key)}" must be a positive whole number`,
      );
    }
    if (value > shipped) {
      throw new ImportError(
        "unsupported-structure",
        `the import limit "${String(key)}" may only be tightened, not raised above ${shipped}`,
      );
    }
    limits[key] = value;
  }
  return limits;
}
