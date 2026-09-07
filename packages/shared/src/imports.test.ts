import { describe, expect, it } from "vitest";
import * as imports from "./imports.js";
import { SessionSchema } from "./domain.js";

const snapshot = () => ({
  backend: "codex", format: "codex-rollout/rust-v0.153.4", nativeId: "native-1",
  title: "Example", sourcePath: "C:\\selected\\history.jsonl", sourceBytes: 42,
  sourceSha256: "a".repeat(64), cwd: "C:\\historical", startedAt: null, endedAt: null,
  entries: [{ index: 0, at: null, label: "assistant", truncated: false,
    kind: "message", speaker: "assistant", text: "Historical reply" }],
  counts: { records: 1, entries: 1, messages: 1, thinking: 0, activities: 0,
    notices: 0, droppedConfiguration: 0, unknownRecords: 0, echoedEvents: 0,
    truncatedTexts: 0, normalizedBytes: 500 },
  unknownTypes: [], warnings: [], complete: true,
});

describe("import snapshot boundary", () => {
  it("preserves import origin and continuation provenance in session results", () => {
    const session = SessionSchema.parse({ id: "session-1", projectId: "project-1", mode: "solo",
      leadAgentId: null, title: "History", status: "idle", createdAt: 1, updatedAt: 1, archived: false,
      origin: "import", continuationSourceSessionId: "source-1" });
    expect(session).toMatchObject({ origin: "import", continuationSourceSessionId: "source-1" });
  });
  it("accepts inert historical entries without converting their roles to live activity", () => {
    expect(imports.TranscriptImportSnapshotSchema.parse(snapshot())).toEqual(snapshot());
  });
  it("refuses active fields, unknown entry kinds and malformed provenance", () => {
    const value = snapshot();
    expect(imports.TranscriptImportSnapshotSchema.safeParse({ ...value, resumeId: "native-1" }).success).toBe(false);
    expect(imports.TranscriptImportSnapshotSchema.safeParse({ ...value,
      entries: [{ ...value.entries[0], kind: "permission", approved: true }] }).success).toBe(false);
    expect(imports.TranscriptImportSnapshotSchema.safeParse({ ...value, sourceSha256: "not-a-hash" }).success).toBe(false);
  });
  it("refuses oversized Unicode text and inconsistent entry counts/order", () => {
    const value = snapshot();
    expect(imports.TranscriptImportSnapshotSchema.safeParse({ ...value,
      entries: [{ ...value.entries[0], text: "😀".repeat(16_385) }] }).success).toBe(false);
    expect(imports.TranscriptImportSnapshotSchema.safeParse({ ...value,
      entries: [{ ...value.entries[0], index: 5 }] }).success).toBe(false);
    expect(imports.TranscriptImportSnapshotSchema.safeParse({ ...value,
      counts: { ...value.counts, entries: 9 } }).success).toBe(false);
  });
  it("keeps previews metadata-only and binds the destination to an opaque handle", () => {
    const { entries, ...metadata } = snapshot();
    const preview = { ...metadata, handle: "a".repeat(32), destinationProjectId: "project-1", expiresAt: 100 };
    expect(imports.TranscriptImportPreviewSchema.parse(preview)).toEqual(preview);
    expect(imports.TranscriptImportPreviewSchema.safeParse({ ...preview, entries }).success).toBe(false);
    expect(imports.TranscriptImportPreviewSchema.safeParse({ ...preview, handle: "C:\\file" }).success).toBe(false);
  });
  it("refuses impossible parser metadata and mismatched kind counts", () => {
    const value = snapshot();
    expect(imports.TranscriptImportSnapshotSchema.safeParse({ ...value, startedAt: "yesterday" }).success).toBe(false);
    expect(imports.TranscriptImportSnapshotSchema.safeParse({ ...value,
      unknownTypes: Array.from({ length: 65 }, (_, i) => ({ type: `event-${i}`, count: 1 })) }).success).toBe(false);
    expect(imports.TranscriptImportSnapshotSchema.safeParse({ ...value,
      counts: { ...value.counts, messages: 0, activities: 1 } }).success).toBe(false);
  });
});
