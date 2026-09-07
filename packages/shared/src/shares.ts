/**
 * Phase 9 sharing: the strict, versioned contract for one exported session
 * bundle (SPEC P15, `docs/plans/phases7-12.md` "Phase 9").
 *
 * This module is the schema only. Encoding, the inert HTML carrier, the
 * live-block projection and the redaction pass are separate integrations and
 * are deliberately absent here.
 *
 * What a bundle *is*: the same inert entries a transcript import produces
 * (`TranscriptImportEntrySchema`, reused verbatim so one validator and one
 * renderer serve both features), plus display-only provenance and local
 * comments. What a bundle can never be is a way to resume, re-execute or
 * reconfigure anything: there is no session, agent, turn, tool-use, request or
 * native id in this shape, no backend configuration, no permission decision, no
 * grant, and no host path. Every object is `.strict()`, so a field carrying any
 * of those is a refusal rather than an ignored extra key — that is what makes a
 * bundle from a newer or hostile writer fail closed.
 *
 * Bounds are refusal thresholds, not budgets to trim to (the same posture as
 * `IMPORT_LIMITS`), and every text bound is measured in UTF-8 bytes: a JS
 * string length would let a multibyte payload carry four times the bytes a
 * limit names.
 */
import "./zodRuntime.js";
import { z } from "zod";
import { TranscriptImportEntrySchema } from "./imports.js";

/** Discriminates a capygen bundle from any other JSON handed to the importer. */
export const SHARE_BUNDLE_KIND = "capygen.share";

/**
 * The wire version. It is matched as a literal, so a v2 bundle is refused with
 * "made by a newer capygen" rather than half-parsed into a v1 shape.
 */
export const SHARE_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// limits
// ---------------------------------------------------------------------------

export interface ShareLimits {
  /** UTF-8 bytes of the whole serialized bundle, envelope included. */
  maxBundleBytes: number;
  /**
   * UTF-8 bytes of the file a bundle travels in. Larger than `maxBundleBytes`
   * because the carrier holds the bundle twice over — once base64-encoded and
   * once as escaped display markup — so the transport ceiling cannot be derived
   * from the JSON ceiling. Nothing encodes yet; this is the contract constant
   * the carrier will be built against.
   */
  maxTransportBytes: number;
  /** Inert entries carried. Matches the import parser's own entry ceiling. */
  maxEntries: number;
  /** Comments carried. */
  maxComments: number;
  /** Agent labels described in the provenance header. */
  maxAgents: number;
  /** UTF-8 bytes of one label: title, agent label, agent model, comment author. */
  maxLabelBytes: number;
  /** UTF-8 bytes of one comment body. */
  maxCommentBytes: number;
  /** Characters of the writing app's version string. */
  maxAppVersionChars: number;
}

export const SHARE_LIMITS: ShareLimits = {
  maxBundleBytes: 32 * 1024 * 1024,
  maxTransportBytes: 96 * 1024 * 1024,
  maxEntries: 100_000,
  maxComments: 1000,
  maxAgents: 32,
  maxLabelBytes: 120,
  maxCommentBytes: 16_384,
  maxAppVersionChars: 64,
};

/**
 * Merge caller overrides onto the shipped limits, mirroring the import
 * parser's `resolveLimits`: an override may only *tighten*. Tests shrink a
 * ceiling so a fixture can reach it without building 32 MiB of JSON; nothing
 * may raise one, and a `NaN`, `Infinity` or fractional value would silently
 * disable the check it belongs to, so those are refused outright.
 */
export function resolveShareLimits(overrides?: Partial<ShareLimits>): ShareLimits {
  const limits = { ...SHARE_LIMITS };
  if (!overrides) return limits;
  for (const [key, value] of Object.entries(overrides) as Array<[keyof ShareLimits, unknown]>) {
    if (value === undefined) continue;
    const shipped = SHARE_LIMITS[key];
    if (shipped === undefined) throw new Error(`unknown share limit "${String(key)}"`);
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`the share limit "${String(key)}" must be a positive whole number`);
    }
    if (value > shipped) {
      throw new Error(`the share limit "${String(key)}" may only be tightened, not raised above ${shipped}`);
    }
    limits[key] = value;
  }
  return limits;
}

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;

/**
 * A text field bounded by UTF-8 bytes. The `.max()` is only a cheap prefilter:
 * a UTF-8 encoding is never shorter than the UTF-16 unit count, so it can
 * never reject a value the byte check would have allowed.
 */
const bounded = (limit: number, what: string) =>
  z.string().max(limit).refine((value) => utf8Bytes(value) <= limit, `${what} exceeds ${limit} bytes`);

const hex32 = z.string().regex(/^[0-9a-f]{32}$/, "expected 32 lowercase hex characters");

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/**
 * An ISO-8601 instant. The regex pins the shape; `Date.parse` rejects what is
 * shaped right but unparseable.
 *
 * Neither is enough on its own: V8's `Date.parse` *rolls over* an impossible
 * calendar date rather than refusing it, so "2026-02-30T10:00:00Z" would be
 * accepted as March 2nd and a bundle could carry a date no clock produced.
 * The day is therefore checked against the month it claims.
 */
const realCalendarDate = (value: string): boolean => {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  return day <= days;
};

const instant = z.string().max(40)
  .regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})?$/)
  .refine((value) => realCalendarDate(value) && !Number.isNaN(Date.parse(value)), "Invalid timestamp");

// ---------------------------------------------------------------------------
// schemas
// ---------------------------------------------------------------------------

/**
 * Which display modes a bundle may name. `custom` is accepted now, for display
 * only, so a bundle written once Custom Mode lands (Phase 9C) still reads here
 * without a version bump; it carries no mode definition or policy.
 */
export const ShareSessionModeSchema = z.enum(["solo", "round-table", "custom"]);
export type ShareSessionMode = z.infer<typeof ShareSessionModeSchema>;

/**
 * Build the schema set under one limit set. Types are inferred from what this
 * actually constructs, so a field added or renamed here is a type error at
 * every consumer rather than a shape TypeScript was told to assume.
 */
function buildShareSchemas(limits: ShareLimits) {
  const label = bounded(limits.maxLabelBytes, "Label");

  /**
   * The inert import entry, reused verbatim, with the byte bounds a share adds.
   *
   * `TranscriptImportEntrySchema` caps `label` and an activity's `name` at 120
   * *UTF-16 units*, so 40 four-byte code points pass there at 160 bytes. A
   * bundle is a file that travels, and every other text bound in it is counted
   * in UTF-8; leaving these two on the JS length would let a multibyte label
   * carry more than the limit names. Checked on top of the import schema rather
   * than inside it: the import parser's own behaviour must not change, and its
   * historical snapshots keep passing exactly as before.
   */
  const Entry = TranscriptImportEntrySchema.superRefine((entry, context) => {
    if (utf8Bytes(entry.label) > limits.maxLabelBytes) {
      context.addIssue({ code: "custom", path: ["label"],
        message: `Label exceeds ${limits.maxLabelBytes} bytes` });
    }
    if ((entry.kind === "activity" || entry.kind === "activity-result")
      && utf8Bytes(entry.name) > limits.maxLabelBytes) {
      context.addIssue({ code: "custom", path: ["name"],
        message: `Activity name exceeds ${limits.maxLabelBytes} bytes` });
    }
  });

  /**
   * One participant, as a label. No agent id, no config, no provider, no key:
   * a reader sees who spoke, and nothing here can select or configure a
   * backend on import.
   */
  const Agent = z.object({
    label,
    backend: z.enum(["claude", "codex", "api"]).nullable(),
    model: bounded(limits.maxLabelBytes, "Model").nullable(),
  }).strict();

  /** Display-only provenance. Deliberately without project path, cwd or ids. */
  const Source = z.object({
    title: bounded(limits.maxLabelBytes, "Title").nullable(),
    mode: ShareSessionModeSchema,
    startedAt: instant.nullable(),
    endedAt: instant.nullable(),
    agents: z.array(Agent).max(limits.maxAgents),
  }).strict();

  /**
   * What the bundle contains and what it left out. The first six are re-derived
   * from `entries` below, so a bundle cannot misrepresent its own transcript.
   * The `dropped*` and `redactions` tallies describe content that is *not*
   * here and therefore cannot be checked — they are honesty about the export,
   * not a claim the validator can verify.
   *
   * `droppedThinking` exists because reasoning is opt-in on export. Without it,
   * withheld reasoning would be the one omission expressed purely by absence,
   * and a reader could not tell a session that recorded no reasoning from one
   * whose reasoning was held back.
   */
  const Counts = z.object({
    entries: count.max(limits.maxEntries),
    messages: count.max(limits.maxEntries),
    thinking: count.max(limits.maxEntries),
    activities: count.max(limits.maxEntries),
    notices: count.max(limits.maxEntries),
    truncatedTexts: count.max(limits.maxEntries),
    droppedInteractive: count,
    droppedThinking: count,
    droppedWidgets: count,
    droppedUsage: count,
    redactions: count,
  }).strict();

  /**
   * A local note on the transcript. `author` is a free display label the writer
   * typed: it is not an account, not verified, and must never be presented as
   * an authenticated identity.
   */
  const Comment = z.object({
    id: hex32,
    /** The entry this is anchored to, or null for a comment on the session. */
    entryIndex: z.number().int().nonnegative().max(limits.maxEntries).nullable(),
    author: label,
    body: bounded(limits.maxCommentBytes, "Comment body"),
    createdAt: instant,
    replyToId: hex32.nullable(),
    resolved: z.boolean(),
  }).strict();

  const Bundle = z.object({
    kind: z.literal(SHARE_BUNDLE_KIND),
    version: z.literal(SHARE_SCHEMA_VERSION),
    bundleId: hex32,
    createdAt: instant,
    appVersion: z.string().max(limits.maxAppVersionChars),
    source: Source,
    entries: z.array(Entry).max(limits.maxEntries),
    counts: Counts,
    comments: z.array(Comment).max(limits.maxComments),
  }).strict().superRefine((bundle, context) => {
    // --- entries are contiguous and the counts are the actual tallies -------
    if (bundle.entries.length !== bundle.counts.entries) {
      context.addIssue({ code: "custom", path: ["counts", "entries"], message: "Entry count does not match the bundle" });
    }
    const totals = { messages: 0, thinking: 0, activities: 0, notices: 0, truncatedTexts: 0 };
    bundle.entries.forEach((entry, index) => {
      if (entry.index !== index) {
        context.addIssue({ code: "custom", path: ["entries", index, "index"], message: "Entries must have contiguous chronological indexes" });
      }
      if (entry.kind === "message") totals.messages++;
      else if (entry.kind === "thinking") totals.thinking++;
      else if (entry.kind === "notice") totals.notices++;
      else totals.activities++;
      if (entry.truncated) totals.truncatedTexts++;
    });
    for (const key of Object.keys(totals) as Array<keyof typeof totals>) {
      if (totals[key] !== bundle.counts[key]) {
        context.addIssue({ code: "custom", path: ["counts", key], message: "Entry kind count does not match the bundle" });
      }
    }

    // --- comments are unique, anchored in range, and cannot thread a cycle --
    const seen = new Set<string>();
    bundle.comments.forEach((comment, index) => {
      if (seen.has(comment.id)) {
        context.addIssue({ code: "custom", path: ["comments", index, "id"], message: "Comment ids must be unique" });
      }
      if (comment.entryIndex !== null && comment.entryIndex >= bundle.entries.length) {
        context.addIssue({ code: "custom", path: ["comments", index, "entryIndex"], message: "Comment is anchored to an entry the bundle does not carry" });
      }
      // A reply may only name a comment already seen. Ordering does the work a
      // cycle check would: a self-reference, a forward reference and any loop
      // are all unreachable, with no graph walk on untrusted input.
      if (comment.replyToId !== null && !seen.has(comment.replyToId)) {
        context.addIssue({ code: "custom", path: ["comments", index, "replyToId"], message: "A reply must name an earlier comment in the bundle" });
      }
      seen.add(comment.id);
    });

    // --- the whole envelope fits ------------------------------------------
    // Measured on the parsed value in UTF-8, so a multibyte transcript is
    // charged the bytes it will actually occupy rather than its JS length.
    const bytes = utf8Bytes(JSON.stringify(bundle));
    if (bytes > limits.maxBundleBytes) {
      context.addIssue({ code: "custom", path: [], message: `Bundle is ${bytes} bytes, over the ${limits.maxBundleBytes} byte limit` });
    }
  });

  return { Entry, Agent, Source, Counts, Comment, Bundle };
}

export type ShareSchemas = ReturnType<typeof buildShareSchemas>;

/**
 * The schema set under a limit set. `createShareBundleSchema` is the usual
 * entry point; the pieces are exposed for callers that validate one part of a
 * bundle (a single comment being added, say) without the whole envelope.
 */
export function createShareSchemas(overrides?: Partial<ShareLimits>): ShareSchemas {
  return buildShareSchemas(resolveShareLimits(overrides));
}

/** The bundle schema under a tightened limit set. */
export function createShareBundleSchema(overrides?: Partial<ShareLimits>): ShareSchemas["Bundle"] {
  return createShareSchemas(overrides).Bundle;
}

const defaults = buildShareSchemas(SHARE_LIMITS);

export const ShareEntrySchema = defaults.Entry;
export const ShareAgentSchema = defaults.Agent;
export const ShareSourceSchema = defaults.Source;
export const ShareCountsSchema = defaults.Counts;
export const ShareCommentSchema = defaults.Comment;
export const ShareBundleSchema = defaults.Bundle;

export type ShareEntry = z.infer<typeof ShareEntrySchema>;
export type ShareAgent = z.infer<typeof ShareAgentSchema>;
export type ShareSource = z.infer<typeof ShareSourceSchema>;
export type ShareCounts = z.infer<typeof ShareCountsSchema>;
export type ShareComment = z.infer<typeof ShareCommentSchema>;
export type ShareBundle = z.infer<typeof ShareBundleSchema>;
