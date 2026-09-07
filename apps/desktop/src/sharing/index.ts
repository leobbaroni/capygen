/**
 * The sharing codec: live blocks → inert bundle → JSON or an inert HTML file,
 * and back again.
 *
 * Pure functions only. Nothing here opens a dialog, touches the filesystem,
 * registers IPC or calls a model — those belong to main, and keeping them out
 * is what lets the whole codec be proved against hostile input in unit tests.
 *
 * Two independent ceilings, and the caller learns the *exact* encoded size
 * before anything is written: a bundle that is legal as JSON may still not fit
 * the HTML carrier, and discovering that after a file write would be the worst
 * possible moment.
 */
import type { ShareBundle } from "@capygen/shared";
import { SHARE_HTML_MAX_BYTES, encodeShareHtml } from "./html.js";
import { SHARE_JSON_MAX_BYTES, encodeShareJson, resolveMaxBytes } from "./json.js";

export {
  projectShareBundle,
  senderClaimedOmissions,
  type SenderClaimedOmission,
  type ShareCommentInput,
  type ShareDisplayAgent,
  type ShareDisplayMetadata,
  type ShareProjectionInput,
  type ShareProjectionOptions,
  type ShareSourceBlock,
} from "./projection.js";
export {
  REDACTED,
  REDACTED_PATH,
  SHARE_TRUNCATION_MARKER,
  clipUtf8,
  redactText,
  sanitize,
  sanitizeLabel,
  type Redacted,
  type Sanitized,
} from "./redact.js";
export {
  SHARE_JSON_MAX_BYTES,
  ShareCodecError,
  assertShareBundle,
  canonicalJson,
  decodeShareJson,
  encodeShareJson,
  type ShareCodecErrorCode,
  type ShareEncodeOptions,
  type ShareEncodeResult,
  type ShareEncoded,
  type ShareTooLarge,
} from "./json.js";
export { SHARE_HTML_MAX_BYTES, decodeShareHtml, encodeShareHtml } from "./html.js";
export { shareFileName, shareSlug, type ShareFileNameInput } from "./filenames.js";

export interface ShareFormatPreflight {
  bytes: number;
  withinLimit: boolean;
  limit: number;
}

export interface SharePreflight {
  json: ShareFormatPreflight;
  html: ShareFormatPreflight;
}

export interface SharePreflightLimits {
  maxJsonBytes?: number;
  maxHtmlBytes?: number;
}

/**
 * Encode both formats and report their exact sizes, without writing anything.
 * This is what a Save flow asks *before* opening a dialog, so an oversize
 * carrier is a choice offered up front rather than a failure discovered late.
 */
export function preflightShare(bundle: ShareBundle, limits: SharePreflightLimits = {}): SharePreflight {
  const jsonLimit = resolveMaxBytes(limits.maxJsonBytes, SHARE_JSON_MAX_BYTES, "maxJsonBytes");
  const htmlLimit = resolveMaxBytes(limits.maxHtmlBytes, SHARE_HTML_MAX_BYTES, "maxHtmlBytes");
  const json = encodeShareJson(bundle, { maxBytes: jsonLimit });
  const html = encodeShareHtml(bundle, { maxBytes: htmlLimit });
  return {
    json: { bytes: json.bytes, withinLimit: json.ok, limit: jsonLimit },
    html: { bytes: html.bytes, withinLimit: html.ok, limit: htmlLimit },
  };
}
