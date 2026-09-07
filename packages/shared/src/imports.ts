import "./zodRuntime.js";
import { z } from "zod";

// Mirrors the pinned parser's shipped bounds. These contracts contain historical
// data only: no active blocks, backend configuration, grants or resume identities.
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const text = z.string().max(65_536).refine((value) => bytes(value) <= 65_536, "Text exceeds 64 KiB");
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.string().max(40)
  .regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})?$/)
  .refine((value) => !Number.isNaN(Date.parse(value)), "Invalid timestamp").nullable();
const entryBase = {
  index: z.number().int().min(0).max(99_999), at: timestamp,
  label: z.string().max(120), truncated: z.boolean(), text,
};

export const TranscriptImportEntrySchema = z.discriminatedUnion("kind", [
  z.object({ ...entryBase, kind: z.literal("message"), speaker: z.enum(["user", "assistant", "system"]) }).strict(),
  z.object({ ...entryBase, kind: z.literal("thinking") }).strict(),
  z.object({ ...entryBase, kind: z.literal("activity"), name: z.string().max(120) }).strict(),
  z.object({ ...entryBase, kind: z.literal("activity-result"), name: z.string().max(120), failed: z.boolean().nullable() }).strict(),
  z.object({ ...entryBase, kind: z.literal("notice") }).strict(),
]);
export type TranscriptImportEntry = z.infer<typeof TranscriptImportEntrySchema>;

export const TranscriptImportCountsSchema = z.object({
  records: count.max(100_000), entries: count.max(100_000), messages: count.max(100_000),
  thinking: count.max(100_000), activities: count.max(100_000), notices: count.max(100_000),
  droppedConfiguration: count, unknownRecords: count, echoedEvents: count,
  truncatedTexts: count.max(100_000), normalizedBytes: count.max(256 * 1024 * 1024),
}).strict();

export const TranscriptImportMetadataSchema = z.object({
  backend: z.enum(["claude", "codex"]), format: z.string().min(1).max(256),
  nativeId: z.string().min(1).max(512), title: z.string().max(120).nullable(),
  sourcePath: z.string().min(1).max(32_768), sourceBytes: count.max(256 * 1024 * 1024),
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/), cwd: z.string().max(1024).nullable(),
  startedAt: timestamp, endedAt: timestamp, counts: TranscriptImportCountsSchema,
  unknownTypes: z.array(z.object({ type: z.string().max(64), count }).strict()).max(64),
  warnings: z.array(z.object({ code: z.string().max(128), message: z.string().max(4096), count: count.optional() }).strict()).max(128),
  complete: z.boolean(),
}).strict();
export type TranscriptImportMetadata = z.infer<typeof TranscriptImportMetadataSchema>;

export const TranscriptImportPreviewSchema = TranscriptImportMetadataSchema.extend({
  handle: z.string().regex(/^[0-9a-f]{32}$/),
  destinationProjectId: z.string().min(1),
  expiresAt: count,
  existingSessionId: z.string().min(1).optional(),
  changedSnapshot: z.boolean().optional(),
});
export type TranscriptImportPreview = z.infer<typeof TranscriptImportPreviewSchema>;

export const TranscriptImportRecordSchema = TranscriptImportMetadataSchema.extend({
  sessionId: z.string().min(1), importedAt: count,
});
export type TranscriptImportRecord = z.infer<typeof TranscriptImportRecordSchema>;

export const TranscriptImportSnapshotSchema = TranscriptImportMetadataSchema.extend({
  entries: z.array(TranscriptImportEntrySchema).max(100_000),
}).superRefine((snapshot, context) => {
  if (snapshot.entries.length !== snapshot.counts.entries) {
    context.addIssue({ code: "custom", path: ["counts", "entries"], message: "Entry count does not match snapshot" });
  }
  const totals = { messages: 0, thinking: 0, activities: 0, notices: 0, truncatedTexts: 0 };
  snapshot.entries.forEach((entry, index) => {
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
    if (totals[key] !== snapshot.counts[key]) {
      context.addIssue({ code: "custom", path: ["counts", key], message: "Entry kind count does not match snapshot" });
    }
  }
});
export type TranscriptImportSnapshot = z.infer<typeof TranscriptImportSnapshotSchema>;
