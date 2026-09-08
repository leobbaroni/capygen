/**
 * What the renderer is allowed to know about a staged share.
 *
 * These are the *previews*, not the bundle: a preview names counts, labels and
 * sizes, and never carries a filesystem path, the file's bytes, an owner claim
 * or a project the renderer chose after the fact. Main captures window and
 * project identity when the operation starts and re-checks it at commit, so
 * nothing here needs to be trusted back.
 *
 * The bundle contract itself lives in `shares.ts` and is unchanged.
 */
import "./zodRuntime.js";
import { z } from "zod";
import { ShareCountsSchema, ShareEntrySchema, ShareCommentSchema, ShareSourceSchema } from "./shares.js";

const handle = z.string().regex(/^[0-9a-f]{32}$/);
const bytes = z.number().int().nonnegative();

/** What a bundle says it left out. Always the sender's claim, never verified. */
export const ShareOmissionClaimSchema = z.object({
  kind: z.enum(["thinking", "interactive", "widgets", "usage", "redactions"]),
  count: bytes,
  claimed: z.literal(true),
  description: z.string().max(200),
}).strict();
export type ShareOmissionClaim = z.infer<typeof ShareOmissionClaimSchema>;

/** Exact encoded size of one format, measured by encoding it. */
export const ShareFormatSizeSchema = z.object({
  bytes,
  withinLimit: z.boolean(),
  limit: bytes,
  /** The name a save dialog should suggest. Derived, never from a path. */
  suggestedFileName: z.string().min(1).max(120),
}).strict();
export type ShareFormatSize = z.infer<typeof ShareFormatSizeSchema>;

/**
 * A pinned export. The snapshot behind `handle` is immutable: it was projected,
 * redacted and validated once, and later edits to the session do not change
 * what this handle will save.
 */
export const ShareExportPreviewSchema = z.object({
  handle,
  sessionId: z.string().min(1),
  /** Which artifact the export was taken from, for honest labelling. */
  origin: z.enum(["live", "native-transcript", "shared-bundle"]),
  source: ShareSourceSchema,
  counts: ShareCountsSchema,
  omissions: z.array(ShareOmissionClaimSchema).max(8),
  entryCount: bytes,
  commentCount: bytes,
  includesReasoning: z.boolean(),
  json: ShareFormatSizeSchema,
  html: ShareFormatSizeSchema,
  /** Epoch millis; the handle is refused at or after this instant. */
  expiresAt: bytes,
}).strict();
export type ShareExportPreview = z.infer<typeof ShareExportPreviewSchema>;

/**
 * A decoded, validated incoming bundle, staged and awaiting confirmation.
 * Deliberately without the file's path or bytes: the renderer confirms an
 * opaque handle, and main still owns which file and which window it came from.
 */
export const ShareImportPreviewSchema = z.object({
  handle,
  bundleId: z.string().regex(/^[0-9a-f]{32}$/),
  createdAt: z.string().max(40),
  appVersion: z.string().max(64),
  source: ShareSourceSchema,
  counts: ShareCountsSchema,
  omissions: z.array(ShareOmissionClaimSchema).max(8),
  entryCount: bytes,
  commentCount: bytes,
  destinationProjectId: z.string().min(1),
  /** Set when this exact bundle is already imported: committing is a no-op. */
  existingSessionId: z.string().min(1).optional(),
  /** Set when the id is taken by *different* content; committing is refused. */
  conflictingBundleId: z.boolean().optional(),
  expiresAt: bytes,
}).strict();
export type ShareImportPreview = z.infer<typeof ShareImportPreviewSchema>;

/** A written file, reported without leaking the directory it went to. */
export const ShareSaveResultSchema = z.object({
  format: z.enum(["json", "html"]),
  fileName: z.string().min(1).max(120),
  bytes,
}).strict();
export type ShareSaveResult = z.infer<typeof ShareSaveResultSchema>;

/**
 * A shared-bundle artifact that is already stored.
 *
 * Distinct from `ShareImportPreview`, which describes a *staged* file awaiting
 * confirmation. This one describes a committed read-only session, and it is
 * what a reader opens: provenance the sender supplied, the tallies they
 * claimed, and nothing else. No file path (none is stored), no bytes, and no
 * resume identity — a bundle can restart nothing.
 *
 * `source` and `counts` are the sender's own words. They are shown as claims,
 * never as facts this machine verified.
 */
export const ShareArtifactSchema = z.object({
  sessionId: z.string().min(1),
  bundleId: z.string().regex(/^[0-9a-f]{32}$/),
  /** Canonical hash of the validated bundle — the artifact's content identity. */
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  schemaVersion: z.number().int().nonnegative(),
  appVersion: z.string().max(64),
  /** The writer's own timestamp, kept as the ISO string the bundle carried. */
  bundleCreatedAt: z.string().max(40),
  importedAt: bytes,
  source: ShareSourceSchema,
  counts: ShareCountsSchema,
  entryCount: bytes,
  commentCount: bytes,
}).strict();
export type ShareArtifact = z.infer<typeof ShareArtifactSchema>;

export const SharePagedEntriesSchema = z.array(ShareEntrySchema).max(100);

export const SharePagedCommentsSchema = z.array(ShareCommentSchema).max(100);

// -- Locally authored notes ---------------------------------------------------

/**
 * A note this machine wrote on a session (P15).
 *
 * Separate from `ShareComment`, which is what a *bundle* carries. A note is
 * local, editable and never part of an artifact's identity: writing one cannot
 * change whether a re-import of the same file is a duplicate or a conflict.
 *
 * `authorLabel` is a display label the operator typed. It is not an account and
 * must never be presented as a verified identity — the same rule that governs
 * an execution profile's label.
 */
export const LocalNoteAnchorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("block"), blockId: z.string().min(1).max(256) }).strict(),
  z.object({ kind: z.literal("entry"), entryIndex: bytes }).strict(),
  z.object({ kind: z.literal("session") }).strict(),
]);
export type LocalNoteAnchorDto = z.infer<typeof LocalNoteAnchorSchema>;

const noteId = z.string().min(1).max(256);
/** UTF-8 bounds, matching the share format the note may later be exported into. */
const noteBody = z.string().min(1).refine(
  (value) => new TextEncoder().encode(value).byteLength <= 16_384,
  "A note is at most 16384 bytes",
);
const noteLabel = z.string().min(1).refine(
  (value) => value.trim().length > 0 && new TextEncoder().encode(value).byteLength <= 120,
  "A note's author label is 1 to 120 bytes",
);

export const LocalNoteSchema = z.object({
  id: noteId,
  sessionId: z.string().min(1),
  anchor: LocalNoteAnchorSchema,
  authorLabel: noteLabel,
  body: noteBody,
  resolved: z.boolean(),
  replyToId: noteId.nullable(),
  /** A received comment this note replies to, by its bundle-local id. */
  replyToReceivedId: z.string().max(256).nullable(),
  createdAt: bytes,
  updatedAt: bytes,
}).strict();
export type LocalNoteDto = z.infer<typeof LocalNoteSchema>;

export const LocalNoteCreateSchema = z.object({
  sessionId: z.string().min(1),
  anchor: LocalNoteAnchorSchema,
  body: noteBody,
  replyToId: noteId.nullish().transform((value) => value ?? null),
  replyToReceivedId: z.string().max(256).nullish().transform((value) => value ?? null),
}).strict();

export const LocalNoteUpdateSchema = z.object({
  noteId,
  body: noteBody.optional(),
  resolved: z.boolean().optional(),
  anchor: LocalNoteAnchorSchema.optional(),
}).strict();

export const LocalNotePageSchema = z.object({
  notes: z.array(LocalNoteSchema).max(100),
  total: bytes,
}).strict();
