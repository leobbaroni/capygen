/**
 * Heuristic redaction and UTF-8 clipping for everything a share bundle exports.
 *
 * Order matters and is the whole point of this module: **redact first, clip
 * second**. Clipping a secret in half does not make it safe — it leaves a
 * usable prefix in the file and hides the evidence that anything was removed.
 * So every exported string is scanned whole, then bounded.
 *
 * This is detection by shape, not proof. It catches the credential formats and
 * absolute paths that actually turn up in transcripts; it cannot promise a
 * bundle is free of secrets, and no caller may describe it that way.
 */

export const REDACTED = "«redacted»";
export const REDACTED_PATH = "«path»";
/** Marks a clipped string. Deliberately not the import parser's marker: this
 *  text ships inside a file a stranger reads, and "import limit" is a lie there. */
export const SHARE_TRUNCATION_MARKER = "… [capygen: clipped at the share limit]";

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

/** Credential shapes, most specific first so a generic rule cannot mask one. */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-proj-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
  // URL userinfo: `scheme://user:password@host`. Common in git remotes,
  // database URLs and proxy settings, and the whole credential pair goes —
  // the user half names an account as surely as the password half proves it.
  // Every quantifier here is bounded. An unbounded `[A-Za-z0-9+.-]*` before
  // `://` rescans to the end of the string from every position, which is
  // quadratic: ~4 s on 70 KB of text, and a hang on a 32 MiB bundle.
  /([A-Za-z][A-Za-z0-9+.-]{0,30}:\/\/)[^\s/@:]{1,256}:[^\s/@]{0,256}@/g,
  // `NAME_KEY=value` style assignments, in any case and with `-` or `_` word
  // separators: real configuration writes `api_key`, `Api-Token` and
  // `client_secret` at least as often as it shouts `API_KEY`. The value may
  // not already be a placeholder, so an earlier rule's output is not redacted
  // a second time.
  // Anchored on the keyword itself rather than on an optional prefix, so the
  // scan is a literal alternation: `api_key=…` matches from `key`, which is
  // enough to take the value. The bound on the value keeps it linear.
  /(?:key|token|secret|password|passwd|credentials?)\s*[=:]\s*"?[^«"\s][^"\s]{7,512}"?/gi,
];

const PATH_PATTERNS: RegExp[] = [
  // Drive-absolute and UNC Windows paths. The drive letter may not be preceded
  // by another word character, or `https://host/x` reads as drive `s:`.
  /(?:(?<![A-Za-z0-9])[A-Za-z]:[\\/]|\\\\)[^\s"'<>|]*/g,
  // POSIX-absolute paths, but never the `//` inside a URL: the character
  // before the slash may not be a scheme colon or another slash.
  /(?<![A-Za-z0-9+.\-:/])\/(?:[A-Za-z0-9._~@+-]+\/)+[A-Za-z0-9._~@+-]*/g,
];

/**
 * Characters that let text forge structure downstream: C0/C1 controls and the
 * two Unicode line separators, which break JavaScript string literals and slip
 * past a naive HTML escaper. Tab, newline and carriage return are kept — they
 * are ordinary transcript formatting.
 */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/gu;

export interface Redacted {
  text: string;
  redactions: number;
}

/** Scan one string whole. Never call this after clipping. */
export function redactText(value: string): Redacted {
  let text = value;
  let redactions = 0;
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (...args) => {
      redactions += 1;
      // A capture group means the rule keeps a harmless prefix (a URL scheme)
      // and redacts only the credential that followed it.
      const prefix = typeof args[1] === "string" ? args[1] : "";
      return prefix === "" ? REDACTED : `${prefix}${REDACTED}@`;
    });
  }
  for (const pattern of PATH_PATTERNS) {
    text = text.replace(pattern, () => {
      redactions += 1;
      return REDACTED_PATH;
    });
  }
  return { text: text.replace(CONTROL_CHARS, ""), redactions };
}

export interface Clipped {
  text: string;
  truncated: boolean;
}

/** Clip to `maxBytes` of UTF-8, never splitting a code point. */
export function clipUtf8(
  value: string,
  maxBytes: number,
  marker = SHARE_TRUNCATION_MARKER,
): Clipped {
  if (utf8Bytes(value) <= maxBytes) return { text: value, truncated: false };
  if (maxBytes <= 0) return { text: "", truncated: true };
  const suffix = utf8Bytes(marker) <= maxBytes ? marker : "";
  const budget = maxBytes - utf8Bytes(suffix);
  let used = 0;
  let out = "";
  for (const codePoint of value) {
    const size = utf8Bytes(codePoint);
    if (used + size > budget) break;
    used += size;
    out += codePoint;
  }
  return { text: `${out}${suffix}`, truncated: true };
}

export interface Sanitized extends Redacted, Clipped {}

/** The only way this codec turns untrusted text into exported text. */
export function sanitize(value: string, maxBytes: number, marker?: string): Sanitized {
  const redacted = redactText(value);
  const clipped = clipUtf8(redacted.text, maxBytes, marker);
  return { text: clipped.text, truncated: clipped.truncated, redactions: redacted.redactions };
}

/**
 * Bidi formatting characters: the marks, embeddings, overrides and isolates.
 *
 * These reorder the characters *around* them, so a label can render as text it
 * does not contain — "Reviewer<RLO>renwO" reads as an owner. A display label
 * has no legitimate need to control the direction of anything beside it, so
 * they are stripped from labels. Ordinary right-to-left letters are untouched:
 * Arabic and Hebrew script carries its own direction and is content, not
 * framing. Entry *text* keeps them, where they are part of what was written.
 */
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

/** A short display label: same rules, whitespace collapsed, ellipsis marker. */
export function sanitizeLabel(value: string, maxBytes: number): Sanitized {
  const redacted = redactText(value);
  const collapsed = redacted.text.replace(BIDI_CONTROLS, "").replace(/\s+/g, " ").trim();
  const clipped = clipUtf8(collapsed, maxBytes, "…");
  return { text: clipped.text, truncated: clipped.truncated, redactions: redacted.redactions };
}
