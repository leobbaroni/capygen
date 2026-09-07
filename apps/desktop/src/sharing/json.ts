/**
 * The JSON side of the share codec: canonical encode, strict decode, and the
 * size ceiling both are measured against.
 *
 * Canonical means byte-identical output for the same bundle: object keys sorted
 * recursively, array order preserved (position is meaning — entry order, reply
 * order), and **no Unicode normalization**, because normalizing would make two
 * different strings share one identity. This mirrors the canonical form
 * `@capygen/db` hashes with; it is reimplemented rather than imported so the
 * codec stays free of the database package and its native SQLite binding.
 */
import { ShareBundleSchema, type ShareBundle } from "@capygen/shared";
import type { ZodError } from "zod";

/** UTF-8 bytes of the canonical JSON document. */
export const SHARE_JSON_MAX_BYTES = 32 * 1024 * 1024;

export type ShareCodecErrorCode =
  | "invalid-json"
  | "schema"
  | "too-large"
  | "carrier-missing"
  | "carrier-duplicate"
  | "carrier-malformed"
  | "identity-mismatch"
  | "invalid-option"
  /** A cardinality the bundle contract refuses to carry, or input it could not
   *  represent faithfully. Never a quiet truncation. */
  | "over-limit"
  /** A block kind this projection does not model, so it can neither export it
   *  nor honestly count it as omitted. */
  | "unsupported-block"
  /** A comment anchored to a source block that does not exist. */
  | "invalid-anchor";

export class ShareCodecError extends Error {
  readonly code: ShareCodecErrorCode;

  constructor(code: ShareCodecErrorCode, message: string) {
    super(message);
    this.name = "ShareCodecError";
    this.code = code;
  }
}

export const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

/**
 * A field path is safe to report; a field *value* never is.
 *
 * Zod's own messages and `JSON.parse`'s quote the input — a refused bundle
 * would otherwise copy whatever the sender wrote (a key, a token, a whole
 * value) into an error that reaches IPC, a toast and the log. So refusals
 * carry a stable code, a fixed sentence, and at most a few path segments that
 * came from *this* schema rather than from the document.
 */
const SAFE_SEGMENT = /^[A-Za-z][A-Za-z0-9]{0,30}$/;
const MAX_REPORTED_PATHS = 4;

function safePaths(error: ZodError): string {
  const paths: string[] = [];
  for (const issue of error.issues) {
    const segments: string[] = [];
    for (const segment of issue.path) {
      if (typeof segment === "number") segments.push(String(segment));
      else if (typeof segment === "string" && SAFE_SEGMENT.test(segment)) segments.push(segment);
      else { segments.length = 0; break; }
    }
    const path = segments.join(".");
    if (path !== "" && !paths.includes(path)) paths.push(path);
    if (paths.length >= MAX_REPORTED_PATHS) break;
  }
  return paths.length === 0 ? "the bundle envelope" : paths.join(", ");
}

/**
 * Validate a bundle at runtime, whatever its static type says.
 *
 * A `ShareBundle` is only a compiler claim: one `as` cast upstream and a
 * `number` field is a string that an encoder would interpolate. Both encoders
 * start here, so nothing reaches serialization or markup unvalidated.
 */
export function assertShareBundle(bundle: ShareBundle): ShareBundle {
  const result = ShareBundleSchema.safeParse(bundle);
  if (!result.success) {
    throw new ShareCodecError("schema", `this bundle does not match the share contract (at ${safePaths(result.error)})`);
  }
  return result.data;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const parts: string[] = [];
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(item)}`);
  }
  return `{${parts.join(",")}}`;
}

export interface ShareEncoded {
  ok: true;
  format: "json" | "html";
  text: string;
  /** Exact UTF-8 size of `text` — what a file write would produce. */
  bytes: number;
}

export interface ShareTooLarge {
  ok: false;
  format: "json" | "html";
  reason: "too-large";
  bytes: number;
  limit: number;
  /**
   * The already-reviewed JSON, encoded, offered instead. It carries the exact
   * text rather than an instruction to re-encode: the user reviewed *this*
   * bundle, and a second pass over a mutable object could serialize something
   * else. `bytes` is that text's own size, not an estimate.
   */
  fallback: { format: "json"; text: string; bytes: number; withinLimit: boolean };
}

export type ShareEncodeResult = ShareEncoded | ShareTooLarge;

export interface ShareEncodeOptions {
  /** Tighten-only: never above the shipped cap. */
  maxBytes?: number;
}

export function resolveMaxBytes(limit: number | undefined, shipped: number, what: string): number {
  if (limit === undefined) return shipped;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new ShareCodecError("invalid-option", `${what} must be a positive whole number`);
  }
  if (limit > shipped) {
    throw new ShareCodecError(
      "invalid-option",
      `${what} may only be tightened, not raised above ${shipped}`,
    );
  }
  return limit;
}

export function encodeShareJson(bundle: ShareBundle): ShareEncoded;
export function encodeShareJson(bundle: ShareBundle, options: ShareEncodeOptions): ShareEncodeResult;
export function encodeShareJson(
  bundle: ShareBundle,
  options?: ShareEncodeOptions,
): ShareEncodeResult {
  const limit = resolveMaxBytes(options?.maxBytes, SHARE_JSON_MAX_BYTES, "maxBytes");
  const text = canonicalJson(assertShareBundle(bundle));
  const bytes = utf8Bytes(text);
  if (bytes <= limit) return { ok: true, format: "json", text, bytes };
  if (options === undefined) {
    throw new ShareCodecError("too-large", `the bundle is ${bytes} bytes, over the ${limit} byte JSON limit`);
  }
  return {
    ok: false, format: "json", reason: "too-large", bytes, limit,
    fallback: { format: "json", text, bytes, withinLimit: false },
  };
}

/**
 * Parse one bundle document strictly.
 *
 * The text came from a file another machine wrote, so the schema is the only
 * boundary: an unknown field, a future version or an inconsistent count is a
 * refusal, never a best-effort parse.
 */
export function decodeShareJson(text: string, options: { maxBytes?: number } = {}): ShareBundle {
  const limit = resolveMaxBytes(options.maxBytes, SHARE_JSON_MAX_BYTES, "maxBytes");
  // The cap is on the bytes actually received, checked *before* `JSON.parse`
  // allocates anything. Canonical size is not a defence: a document can be
  // megabytes of whitespace around a tiny bundle, and the parser would have
  // walked all of it first.
  const bytes = utf8Bytes(text);
  if (bytes > limit) {
    throw new ShareCodecError("too-large", `the share bundle is ${bytes} bytes, over the ${limit} byte JSON limit`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ShareCodecError("invalid-json", "this file is not valid JSON");
  }
  const result = ShareBundleSchema.safeParse(parsed);
  if (!result.success) {
    throw new ShareCodecError("schema", `this file does not match the share contract (at ${safePaths(result.error)})`);
  }
  return result.data;
}
