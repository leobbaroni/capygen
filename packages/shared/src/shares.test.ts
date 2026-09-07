import { describe, expect, it } from "vitest";
import * as shares from "./shares.js";
import { TranscriptImportEntrySchema } from "./imports.js";

const entry = (index: number, over: Record<string, unknown> = {}) => ({
  index, at: null, label: "assistant", truncated: false,
  kind: "message", speaker: "assistant", text: `Historical reply ${index}`, ...over,
});

const counts = (over: Record<string, unknown> = {}) => ({
  entries: 1, messages: 1, thinking: 0, activities: 0, notices: 0, truncatedTexts: 0,
  droppedInteractive: 0, droppedThinking: 0, droppedWidgets: 0, droppedUsage: 0,
  redactions: 0, ...over,
});

const bundle = (over: Record<string, unknown> = {}) => ({
  kind: "capygen.share", version: 1, bundleId: "a".repeat(32),
  createdAt: "2026-09-07T10:00:00Z", appVersion: "0.1.0",
  source: {
    title: "Example session", mode: "solo", startedAt: null, endedAt: null,
    agents: [{ label: "Assistant", backend: "claude", model: "claude-opus-5" }],
  },
  entries: [entry(0)], counts: counts(), comments: [], ...over,
});

const comment = (over: Record<string, unknown> = {}) => ({
  id: "b".repeat(32), entryIndex: 0, author: "Reviewer", body: "Worth a second look",
  createdAt: "2026-09-07T11:00:00Z", replyToId: null, resolved: false, ...over,
});

const ok = (value: unknown) => shares.ShareBundleSchema.safeParse(value).success;

describe("share bundle envelope", () => {
  it("round-trips a minimal bundle unchanged", () => {
    expect(shares.ShareBundleSchema.parse(bundle())).toEqual(bundle());
  });

  it("pins the bundle kind and refuses a future or past schema version", () => {
    expect(shares.SHARE_BUNDLE_KIND).toBe("capygen.share");
    expect(shares.SHARE_SCHEMA_VERSION).toBe(1);
    expect(ok(bundle({ kind: "capygen.session" }))).toBe(false);
    expect(ok(bundle({ version: 2 }))).toBe(false);
    expect(ok(bundle({ version: 0 }))).toBe(false);
    expect(ok(bundle({ version: "1" }))).toBe(false);
  });

  it("refuses native identities, local ids, configuration and source paths", () => {
    expect(ok(bundle({ sessionId: "session-1" }))).toBe(false);
    expect(ok(bundle({ nativeId: "native-1" }))).toBe(false);
    expect(ok(bundle({ sourcePath: "C:\\selected\\history.jsonl" }))).toBe(false);
    expect(ok(bundle({ source: { ...bundle().source, cwd: "C:\\work" } }))).toBe(false);
    expect(ok(bundle({ source: { ...bundle().source, agents: [{ label: "A", backend: null, model: null, agentId: "agent-1" }] } }))).toBe(false);
    expect(ok(bundle({ source: { ...bundle().source, agents: [{ label: "A", backend: null, model: null, config: {} }] } }))).toBe(false);
    expect(ok(bundle({ comments: [{ ...comment(), authorId: "user-1" }] }))).toBe(false);
    expect(ok(bundle({ counts: { ...counts(), records: 1 } }))).toBe(false);
    expect(ok(bundle({ entries: [{ ...entry(0), toolUseId: "toolu_1" }] }))).toBe(false);
  });

  it("accepts every declared session mode and refuses anything else", () => {
    for (const mode of ["solo", "round-table", "custom"]) {
      expect(ok(bundle({ source: { ...bundle().source, mode } }))).toBe(true);
    }
    expect(ok(bundle({ source: { ...bundle().source, mode: "debate" } }))).toBe(false);
  });

  it("requires lowercase 32-hex ids and real ISO instants", () => {
    expect(ok(bundle({ bundleId: "A".repeat(32) }))).toBe(false);
    expect(ok(bundle({ bundleId: "a".repeat(31) }))).toBe(false);
    expect(ok(bundle({ createdAt: "yesterday" }))).toBe(false);
    // Date.parse rolls this over to 2026-03-02 rather than rejecting it.
    expect(ok(bundle({ createdAt: "2026-02-30T10:00:00Z" }))).toBe(false);
    expect(ok(bundle({ createdAt: "2026-13-01T10:00:00Z" }))).toBe(false);
    expect(ok(bundle({ createdAt: "2024-02-29T10:00:00Z" }))).toBe(true);
    expect(ok(bundle({ createdAt: null }))).toBe(false);
    expect(ok(bundle({ source: { ...bundle().source, startedAt: "2026-09-07T10:00:00Z" } }))).toBe(true);
    expect(ok(bundle({ source: { ...bundle().source, endedAt: "not-a-time" } }))).toBe(false);
  });
});

describe("share bundle byte limits", () => {
  it("measures labels in UTF-8 bytes rather than JavaScript length", () => {
    const source = bundle().source;
    expect(ok(bundle({ source: { ...source, title: "a".repeat(120) } }))).toBe(true);
    expect(ok(bundle({ source: { ...source, title: "a".repeat(121) } }))).toBe(false);
    // 40 four-byte code points are 40 UTF-16 units but 160 bytes.
    expect(ok(bundle({ source: { ...source, title: "😀".repeat(40) } }))).toBe(false);
    expect(ok(bundle({ source: { ...source, title: "😀".repeat(30) } }))).toBe(true);
    expect(ok(bundle({ source: { ...source, agents: [{ label: "😀".repeat(40), backend: null, model: null }] } }))).toBe(false);
    expect(ok(bundle({ source: { ...source, agents: [{ label: "A", backend: null, model: "😀".repeat(40) }] } }))).toBe(false);
    expect(ok(bundle({ appVersion: "v".repeat(65) }))).toBe(false);
  });

  it("bounds entry labels and activity names by UTF-8 bytes, which the import entry does not", () => {
    // The import parser caps `label` and `name` at 120 UTF-16 units, so 40
    // four-byte code points (160 bytes) pass there and must not pass here.
    const wide = entry(0, { label: "😀".repeat(40) });
    expect(TranscriptImportEntrySchema.safeParse(wide).success).toBe(true);
    expect(ok(bundle({ entries: [wide] }))).toBe(false);
    expect(ok(bundle({ entries: [entry(0, { label: "😀".repeat(30) })] }))).toBe(true);
    expect(ok(bundle({ entries: [entry(0, { label: "a".repeat(120) })] }))).toBe(true);

    const activity = (over: Record<string, unknown> = {}) => ({
      index: 0, at: null, label: "Bash (historical)", truncated: false,
      kind: "activity", name: "Bash", text: "ls", ...over,
    });
    const activityCounts = counts({ messages: 0, activities: 1 });
    expect(ok(bundle({ entries: [activity()], counts: activityCounts }))).toBe(true);
    const wideName = activity({ name: "😀".repeat(40) });
    expect(TranscriptImportEntrySchema.safeParse(wideName).success).toBe(true);
    expect(ok(bundle({ entries: [wideName], counts: activityCounts }))).toBe(false);
    expect(ok(bundle({ entries: [activity({ kind: "activity-result", failed: null, name: "😀".repeat(40) })],
      counts: activityCounts }))).toBe(false);
  });

  it("applies a tightened label limit to entries without changing the import entry", () => {
    const Schema = shares.createShareBundleSchema({ maxLabelBytes: 8 });
    // A tightened label limit binds every label in the bundle, so the fixture
    // keeps the title and agent inside it and varies only the entry.
    const tight = (entries: unknown[]) => bundle({ entries,
      source: { title: "Ex", mode: "solo", startedAt: null, endedAt: null,
        agents: [{ label: "Agent", backend: null, model: null }] } });
    const long = entry(0, { label: "assistant-lead" });
    expect(TranscriptImportEntrySchema.safeParse(long).success).toBe(true);
    expect(Schema.safeParse(tight([long])).success).toBe(false);
    expect(Schema.safeParse(tight([entry(0, { label: "agent" })])).success).toBe(true);
    expect(ok(tight([long]))).toBe(true);
  });

  it("bounds comment bodies by UTF-8 bytes", () => {
    const within = (body: string) => ok(bundle({ comments: [comment({ body })] }));
    expect(within("a".repeat(16_384))).toBe(true);
    expect(within("a".repeat(16_385))).toBe(false);
    expect(within("😀".repeat(4097))).toBe(false);
    expect(ok(bundle({ comments: [comment({ author: "😀".repeat(40) })] }))).toBe(false);
  });

  it("refuses a serialized envelope over the JSON limit, counting UTF-8 bytes", () => {
    const Schema = shares.createShareBundleSchema({ maxBundleBytes: 2048 });
    expect(Schema.safeParse(bundle()).success).toBe(true);
    const fat = bundle({ entries: [entry(0, { text: "a".repeat(4096) })] });
    expect(Schema.safeParse(fat).success).toBe(false);
    // Same JS length, four times the bytes: the multibyte body must also fail.
    const wide = bundle({ entries: [entry(0, { text: "😀".repeat(512) })] });
    expect(Schema.safeParse(wide).success).toBe(false);
    expect(shares.SHARE_LIMITS.maxBundleBytes).toBe(32 * 1024 * 1024);
    expect(shares.SHARE_LIMITS.maxTransportBytes).toBe(96 * 1024 * 1024);
  });

  it("caps collection sizes", () => {
    const Schema = shares.createShareBundleSchema({ maxEntries: 2, maxComments: 1, maxAgents: 1 });
    const entries = [entry(0), entry(1), entry(2)];
    expect(Schema.safeParse(bundle({ entries, counts: counts({ entries: 3, messages: 3 }) })).success).toBe(false);
    expect(Schema.safeParse(bundle({ comments: [comment(), comment({ id: "c".repeat(32) })] })).success).toBe(false);
    expect(ok(bundle({ source: { ...bundle().source,
      agents: Array.from({ length: 33 }, () => ({ label: "A", backend: null, model: null })) } }))).toBe(false);
  });

  it("supports tighten-only limit overrides", () => {
    expect(shares.resolveShareLimits().maxComments).toBe(1000);
    expect(shares.resolveShareLimits({ maxComments: 10 }).maxComments).toBe(10);
    expect(() => shares.resolveShareLimits({ maxComments: 1001 })).toThrow();
    expect(() => shares.resolveShareLimits({ maxBundleBytes: Number.NaN })).toThrow();
    expect(() => shares.resolveShareLimits({ maxEntries: 1.5 })).toThrow();
    expect(() => shares.resolveShareLimits({ maxEntries: 0 })).toThrow();
    expect(() => shares.resolveShareLimits({ maxNothing: 1 } as never)).toThrow();
  });
});

describe("share bundle internal consistency", () => {
  it("requires contiguous chronological entry indexes", () => {
    expect(ok(bundle({ entries: [entry(1)] }))).toBe(false);
    expect(ok(bundle({ entries: [entry(0), entry(2)], counts: counts({ entries: 2, messages: 2 }) }))).toBe(false);
    expect(ok(bundle({ entries: [entry(1), entry(0)], counts: counts({ entries: 2, messages: 2 }) }))).toBe(false);
  });

  it("requires the counts to be the actual tallies", () => {
    expect(ok(bundle({ counts: counts({ entries: 2 }) }))).toBe(false);
    expect(ok(bundle({ counts: counts({ messages: 0, notices: 1 }) }))).toBe(false);
    const mixed = [
      entry(0),
      { index: 1, at: null, label: "assistant", truncated: false, kind: "thinking", text: "reasoning" },
      { index: 2, at: null, label: "Bash (historical)", truncated: true, kind: "activity", name: "Bash", text: "ls" },
      { index: 3, at: null, label: "Bash (historical)", truncated: false, kind: "activity-result", name: "Bash", text: "out", failed: null },
      { index: 4, at: null, label: "notice", truncated: false, kind: "notice", text: "compacted" },
    ];
    const tallied = bundle({ entries: mixed, counts: counts({ entries: 5, messages: 1, thinking: 1, activities: 2, notices: 1, truncatedTexts: 1 }) });
    expect(ok(tallied)).toBe(true);
    expect(ok({ ...tallied, counts: { ...tallied.counts, activities: 1, notices: 2 } })).toBe(false);
    expect(ok({ ...tallied, counts: { ...tallied.counts, truncatedTexts: 0 } })).toBe(false);
  });

  it("keeps the excluded-content tallies as non-negative integers it cannot re-derive", () => {
    expect(ok(bundle({ counts: counts({ droppedWidgets: 3, droppedInteractive: 2,
      droppedThinking: 5, droppedUsage: 7, redactions: 9 }) }))).toBe(true);
    expect(ok(bundle({ counts: counts({ redactions: -1 }) }))).toBe(false);
    expect(ok(bundle({ counts: counts({ droppedWidgets: 1.5 }) }))).toBe(false);
    expect(ok(bundle({ counts: counts({ droppedThinking: -1 }) }))).toBe(false);
    expect(ok(bundle({ counts: counts({ droppedThinking: 2.5 }) }))).toBe(false);
    expect(ok(bundle({ counts: counts({ droppedThinking: Number.MAX_SAFE_INTEGER }) }))).toBe(true);
    expect(ok(bundle({ counts: counts({ droppedThinking: Number.MAX_SAFE_INTEGER + 2 }) }))).toBe(false);
  });

  it("requires the withheld-reasoning tally, so opt-in reasoning is never expressed by absence alone", () => {
    const { droppedThinking, ...missing } = counts();
    expect(droppedThinking).toBe(0);
    expect(ok(bundle({ counts: missing }))).toBe(false);
    // Reasoning withheld reads differently from a session that recorded none.
    expect(ok(bundle({ counts: counts({ thinking: 0, droppedThinking: 4 }) }))).toBe(true);
  });
});

describe("share comments", () => {
  it("accepts a session-level comment and a threaded reply to an earlier comment", () => {
    const thread = [comment(), comment({ id: "c".repeat(32), entryIndex: null, replyToId: "b".repeat(32), resolved: true })];
    expect(ok(bundle({ comments: thread }))).toBe(true);
  });

  it("refuses duplicate comment ids", () => {
    expect(ok(bundle({ comments: [comment(), comment({ entryIndex: null })] }))).toBe(false);
  });

  it("refuses replies to unknown, later or self ids so a thread cannot cycle", () => {
    expect(ok(bundle({ comments: [comment({ replyToId: "f".repeat(32) })] }))).toBe(false);
    expect(ok(bundle({ comments: [comment({ replyToId: "b".repeat(32) })] }))).toBe(false);
    expect(ok(bundle({ comments: [
      comment({ id: "b".repeat(32), replyToId: "c".repeat(32) }),
      comment({ id: "c".repeat(32) }),
    ] }))).toBe(false);
  });

  it("binds an anchored comment to a real entry index", () => {
    expect(ok(bundle({ comments: [comment({ entryIndex: 1 })] }))).toBe(false);
    expect(ok(bundle({ comments: [comment({ entryIndex: -1 })] }))).toBe(false);
    expect(ok(bundle({ comments: [comment({ entryIndex: 0.5 })] }))).toBe(false);
    expect(ok(bundle({ comments: [comment({ entryIndex: null })] }))).toBe(true);
  });

  it("keeps the author an unauthenticated display label", () => {
    expect(ok(bundle({ comments: [comment({ author: { label: "Reviewer" } })] }))).toBe(false);
    expect(ok(bundle({ comments: [comment({ resolved: "false" })] }))).toBe(false);
    expect(ok(bundle({ comments: [comment({ createdAt: null })] }))).toBe(false);
  });
});
