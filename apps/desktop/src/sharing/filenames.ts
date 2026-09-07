/**
 * Safe file names for exported bundles.
 *
 * The title is untrusted display text from a session, so the name is *built*
 * from an allowlisted slug rather than sanitized from the original: traversal
 * segments, separators, drive letters, control characters and non-ASCII cannot
 * survive a rule that only ever emits `[a-z0-9-]`. Windows device names are
 * replaced outright, because `CON.capyshare.json` is still `CON` to the OS.
 *
 * This produces a *suggestion*. Where the file lands is the native save dialog's
 * decision, never a value derived from bundle content.
 */

const MAX_SLUG_CHARS = 40;

/** Reserved DOS device names; still special with any extension attached. */
const RESERVED = new Set([
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

export function shareSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_CHARS)
    .replace(/-+$/g, "");
  if (slug === "" || RESERVED.has(slug)) return "session";
  return slug;
}

export interface ShareFileNameInput {
  title: string | null;
  /** The bundle's own ISO timestamp; only its date reaches the name. */
  createdAt: string;
  format: "json" | "html";
}

export function shareFileName({ title, createdAt, format }: ShareFileNameInput): string {
  const stamp = /^\d{4}-\d{2}-\d{2}/.test(createdAt)
    ? createdAt.slice(0, 10).replaceAll("-", "")
    : "00000000";
  return `capygen-share-${shareSlug(title ?? "")}-${stamp}.capyshare.${format}`;
}
