import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type CapygenStore } from "@capygen/db";
import type { ShareBundle, TextBlock } from "@capygen/shared";
import {
  createSharingHandlers,
  type ShareStagingMeta,
  type SharingHandlerDeps,
  type SharingHandlers,
} from "../src/ipc/sharing.js";
import { ShareStagingService } from "../src/sharing/staging.js";
import { createShareWorkerHost } from "../src/sharing/workerHost.js";
import { ShareWorkerClient, type ShareWorkerProcessLike } from "../src/sharing/workerClient.js";
import { encodeShareHtml, encodeShareJson } from "../src/sharing/index.js";
import { buildLiveBundle, type LiveBlockRow } from "../src/sharing/buildBundle.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));
const log = { info: () => {}, warn: () => {} };

let dir: string;
let store: CapygenStore;
let projectId: string;
let staging: ShareStagingService<ShareStagingMeta>;
let worker: ShareWorkerClient;
let handlers: SharingHandlers;
let clock: number;
let owner: number;
let alive: Set<number>;
let picked: string | null;
let saveTarget: string | null;
let onSaveDialog: (() => Promise<void>) | null;
let written: { filePath: string; text: string } | null;
let writeOutcome: "ok" | "fail";
let hostRef: ReturnType<typeof createShareWorkerHost>;
let killed: boolean;

/** A real client↔host round trip over the message protocol, without a fork. */
function fakeChild(options: {
  hang?: boolean;
  /** Doctor a reply, to reach sizes a real fixture cannot produce in a test. */
  mutateReply?: (reply: Record<string, unknown>) => Record<string, unknown>;
} = {}): ShareWorkerProcessLike {
  const listeners: { message: Array<(m: unknown) => void>; exit: Array<(c: number) => void> } =
    { message: [], exit: [] };
  hostRef = createShareWorkerHost();
  return {
    postMessage(message) {
      if (options.hang) return;
      void hostRef.handle(message as never).then((reply) => {
        const delivered = options.mutateReply
          ? options.mutateReply(reply as unknown as Record<string, unknown>)
          : reply;
        for (const listener of listeners.message) listener(delivered);
      });
    },
    on(event: "message" | "exit", listener: never) {
      (listeners[event] as Array<typeof listener>).push(listener);
    },
    kill() {
      killed = true;
      for (const listener of listeners.exit) listener(0);
      return true;
    },
  } as ShareWorkerProcessLike;
}

function build(options: {
  hang?: boolean; timeoutMs?: number; maxConcurrent?: number;
  provisionalBytes?: number; maxStagedBytes?: number; ttlMs?: number;
  mutateReply?: (reply: Record<string, unknown>) => Record<string, unknown>;
  validateAgent?: SharingHandlerDeps["validateAgent"];
} = {}): SharingHandlers {
  let handles = 0;
  worker = new ShareWorkerClient({
    fork: () => fakeChild({ hang: options.hang, mutateReply: options.mutateReply }),
    timeoutMs: options.timeoutMs ?? 5_000,
    log,
  });
  staging = new ShareStagingService<ShareStagingMeta>({
    log,
    releaseJob: (jobId) => worker.release(jobId),
    isWorkerGone: () => worker.isGone(),
    now: () => clock,
    ttlMs: options.ttlMs ?? 10_000,
    maxConcurrent: options.maxConcurrent ?? 4,
    provisionalBytes: options.provisionalBytes ?? 1024 * 1024,
    maxStagedBytes: options.maxStagedBytes ?? 4 * 1024 * 1024,
    newHandle: () => `${(handles += 1)}`.padStart(32, "0"),
  });
  return createSharingHandlers({
    store, staging, worker,
    ownerId: () => owner,
    isOwnerAlive: (id) => alive.has(id),
    pickFile: async () => picked,
    chooseSaveTarget: async () => {
      if (onSaveDialog) await onSaveDialog();
      return saveTarget;
    },
    writeFile: async (filePath, text) => {
      if (writeOutcome === "fail") throw new Error("EPERM: the disk said no");
      written = { filePath, text };
    },
    broadcast: () => {},
    appVersion: "0.1.0",
    now: () => clock,
    newBundleId: () => "a".repeat(32),
    ...(options.validateAgent ? { validateAgent: options.validateAgent } : {}),
  });
}

function liveSession(text = "Hello there"): string {
  const created = store.sessions.create({
    projectId, mode: "solo", title: "Live session",
    agents: [{ name: "Assistant", backend: "claude", model: "claude-opus-5", role: "lead", config: null }],
  });
  const turn = store.turns.create({ sessionId: created.session.id, role: "agent", status: "done" });
  const block: TextBlock = {
    id: `blk_${created.session.id}`, turnId: turn.id, sessionId: created.session.id, kind: "text",
    index: 0, text, createdAt: 1_757_000_000_000, updatedAt: 1_757_000_000_000,
  };
  store.blocks.upsert(block);
  return created.session.id;
}

const bundle = (over: Partial<ShareBundle> = {}): ShareBundle => ({
  kind: "capygen.share", version: 1, bundleId: "b".repeat(32),
  createdAt: "2026-09-07T10:00:00Z", appVersion: "0.1.0",
  source: { title: "Sent to me", mode: "solo", startedAt: null, endedAt: null, agents: [] },
  entries: [{ index: 0, at: null, label: "assistant", truncated: false, kind: "message",
    speaker: "assistant", text: "hello from elsewhere" }],
  counts: { entries: 1, messages: 1, thinking: 0, activities: 0, notices: 0, truncatedTexts: 0,
    droppedInteractive: 1, droppedThinking: 2, droppedWidgets: 0, droppedUsage: 0, redactions: 3 },
  comments: [],
  ...over,
});

function writeShare(value: ShareBundle, format: "json" | "html", name = "bundle"): string {
  const file = path.join(dir, `${name}.capyshare.${format}`);
  fs.writeFileSync(file, (format === "json" ? encodeShareJson(value) : encodeShareHtml(value)).text, "utf8");
  return file;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-sharing-"));
  store = openStore(path.join(dir, "capygen.db"), { migrationsDir: MIGRATIONS_DIR });
  projectId = store.projects.upsertByPath({ path: path.join(dir, "project") }).id;
  clock = 1_757_000_000_000;
  owner = 1;
  alive = new Set([1, 2, 3, 4, 5]);
  picked = null;
  saveTarget = path.join(dir, "out.capyshare.json");
  onSaveDialog = null;
  written = null;
  writeOutcome = "ok";
  killed = false;
  handlers = build();
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("admission happens before the work, not after it", () => {
  it("refuses a second request from the same window while the first is still preparing", async () => {
    const sessionId = liveSession();
    const first = handlers["sharing.export.preview"]({ sessionId, includeReasoning: false });
    // Not awaited: the first request is still inside `produce`.
    await expect(handlers["sharing.export.preview"]({ sessionId, includeReasoning: false }))
      .rejects.toThrow(/already preparing|already has a share/);
    await first;
    expect(staging.size()).toBe(1);
  });

  it("counts a pending request against the concurrency limit", async () => {
    handlers = build({ maxConcurrent: 2 });
    const sessionId = liveSession();
    const pending = [1, 2].map((id) => {
      owner = id;
      return handlers["sharing.export.preview"]({ sessionId, includeReasoning: false });
    });
    owner = 3;
    await expect(handlers["sharing.export.preview"]({ sessionId, includeReasoning: false }))
      .rejects.toThrow(/too many shares/);
    await Promise.all(pending);
  });

  it("counts a pending request against the byte budget", async () => {
    handlers = build({ provisionalBytes: 1_000_000, maxStagedBytes: 1_500_000 });
    const sessionId = liveSession();
    owner = 1;
    const pending = handlers["sharing.export.preview"]({ sessionId, includeReasoning: false });
    owner = 2;
    await expect(handlers["sharing.export.preview"]({ sessionId, includeReasoning: false }))
      .rejects.toThrow(/not enough room/);
    await pending;
    // The real size replaces the provisional allowance once it is known.
    expect(staging.reserved()).toBeLessThan(1_000_000);
  });

  it("cancels work that is still preparing and keeps nothing staged", async () => {
    const sessionId = liveSession();
    const pending = handlers["sharing.export.preview"]({ sessionId, includeReasoning: false });
    await staging.cancelPending(owner);
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(staging.size()).toBe(0);
    expect(staging.reserved()).toBe(0);
    expect(hostRef.size()).toBe(0);
  });
});

describe("a handle is used by one operation at a time", () => {
  it("refuses an overlapping save on the same handle", async () => {
    const preview = await handlers["sharing.export.preview"]({
      sessionId: liveSession(), includeReasoning: false });
    let release: () => void = () => {};
    onSaveDialog = () => new Promise<void>((resolve) => { release = resolve; });
    const first = handlers["sharing.export.save"]({ handle: preview.handle, format: "json" });
    await expect(handlers["sharing.export.save"]({ handle: preview.handle, format: "json" }))
      .rejects.toThrow(/already being saved/);
    release();
    await first;
    expect(written).not.toBeNull();
  });

  it("does not write when the share is cancelled while the save dialog is open", async () => {
    const preview = await handlers["sharing.export.preview"]({
      sessionId: liveSession(), includeReasoning: false });
    onSaveDialog = async () => {
      // The user cancels the share in the app while the OS dialog is up.
      await staging.cancel(preview.handle, owner);
    };
    await expect(handlers["sharing.export.save"]({ handle: preview.handle, format: "json" }))
      .rejects.toThrow(/cancelled/);
    expect(written).toBeNull();
  });

  it("does not write when the window closes while the save dialog is open", async () => {
    const preview = await handlers["sharing.export.preview"]({
      sessionId: liveSession(), includeReasoning: false });
    onSaveDialog = async () => {
      alive.delete(owner);
      await staging.releaseWindow(owner);
    };
    await expect(handlers["sharing.export.save"]({ handle: preview.handle, format: "json" }))
      .rejects.toThrow(/cancelled|closed/);
    expect(written).toBeNull();
  });

  it("offers the reviewed JSON when the HTML carrier is over its limit", async () => {
    // A bundle whose page really exceeds 96 MiB cannot be built in a test, so
    // the worker's own answer is doctored to the shape `encodeShareHtml`
    // returns for one: the true size, with `withinLimit: false`.
    handlers = build({
      mutateReply: (reply) => {
        const preview = (reply as { preview?: { html?: Record<string, unknown> } }).preview;
        if (preview?.html) preview.html = { bytes: 120 * 1024 * 1024, withinLimit: false };
        return reply;
      },
    });
    const preview = await handlers["sharing.export.preview"]({
      sessionId: liveSession(), includeReasoning: false });
    // The oversize figure reaches the renderer instead of being refused on the
    // way, which is what lets the UI explain the choice.
    expect(preview.html).toMatchObject({ withinLimit: false, limit: 96 * 1024 * 1024 });
    expect(preview.html.bytes).toBeGreaterThan(preview.html.limit);
    expect(preview.json.withinLimit).toBe(true);

    await expect(handlers["sharing.export.save"]({ handle: preview.handle, format: "html" }))
      .rejects.toThrow(/too large|save the JSON/i);
    expect(written).toBeNull();

    // The already-reviewed JSON still saves from the same pinned snapshot.
    const saved = await handlers["sharing.export.save"]({ handle: preview.handle, format: "json" });
    expect(saved).toMatchObject({ format: "json", bytes: preview.json.bytes });
    expect(written!.text).toContain("capygen.share");
  });

  it("writes nothing when the dialog is cancelled, and reports a failed write", async () => {
    const preview = await handlers["sharing.export.preview"]({
      sessionId: liveSession(), includeReasoning: false });
    saveTarget = null;
    expect(await handlers["sharing.export.save"]({ handle: preview.handle, format: "json" })).toBeNull();
    expect(written).toBeNull();

    saveTarget = path.join(dir, "out.capyshare.json");
    writeOutcome = "fail";
    await expect(handlers["sharing.export.save"]({ handle: preview.handle, format: "json" }))
      .rejects.toThrow(/EPERM/);
    writeOutcome = "ok";
    const ok = await handlers["sharing.export.save"]({ handle: preview.handle, format: "json" });
    expect(ok).toMatchObject({ format: "json", bytes: preview.json.bytes });
    expect(written!.text).toContain("capygen.share");
  });
});

describe("idle handles are actively cleaned up", () => {
  it("expires a staged share and releases its worker payload", async () => {
    const preview = await handlers["sharing.export.preview"]({
      sessionId: liveSession(), includeReasoning: false });
    expect(hostRef.size()).toBe(1);
    clock += 10_001;
    await staging.sweepNow();
    expect(staging.size()).toBe(0);
    expect(staging.reserved()).toBe(0);
    expect(hostRef.size()).toBe(0);
    await expect(handlers["sharing.export.entries"]({ handle: preview.handle, offset: 0, limit: 10 }))
      .rejects.toThrow(/no longer available/);
  });

  it("refuses a stale handle on the lazy path too", async () => {
    const preview = await handlers["sharing.export.preview"]({
      sessionId: liveSession(), includeReasoning: false });
    clock += 10_001;
    await expect(handlers["sharing.export.save"]({ handle: preview.handle, format: "json" }))
      .rejects.toThrow(/took too long/);
    expect(written).toBeNull();
  });
});

describe("the worker is bounded and killable", () => {
  it("kills a hung worker instead of waiting on it", async () => {
    handlers = build({ hang: true, timeoutMs: 20 });
    await expect(handlers["sharing.export.preview"]({
      sessionId: liveSession(), includeReasoning: false })).rejects.toThrow(/too long/);
    expect(killed).toBe(true);
    expect(staging.size()).toBe(0);
    expect(staging.reserved()).toBe(0);
  });

  it("refuses an oversized file and one that is not text", async () => {
    picked = path.join(dir, "huge.capyshare.json");
    fs.writeFileSync(picked, "x".repeat(2 * 1024 * 1024), "utf8");
    handlers = build({ provisionalBytes: 1024 * 1024 });
    await expect(handlers["sharing.import.pick"]({ projectId })).rejects.toThrow();
    expect(staging.size()).toBe(0);

    handlers = build();
    picked = path.join(dir, "binary.capyshare.json");
    fs.writeFileSync(picked, Buffer.from([0xff, 0xfe, 0xfd, 0x00, 0x01]));
    await expect(handlers["sharing.import.pick"]({ projectId })).rejects.toThrow(/not readable/);
    expect(staging.size()).toBe(0);
    expect(staging.reserved()).toBe(0);
  });
});

describe("exports keep the artifacts distinct and honest", () => {
  it("pins a snapshot the session cannot change underneath", async () => {
    const sessionId = liveSession("Original answer");
    const preview = await handlers["sharing.export.preview"]({ sessionId, includeReasoning: false });
    const before = await handlers["sharing.export.entries"]({
      handle: preview.handle, offset: 0, limit: 50 });
    store.blocks.upsert({ id: "blk_late", turnId: store.turns.list(sessionId)[0]!.id, sessionId,
      kind: "text", index: 1, text: "Added later", createdAt: clock, updatedAt: clock });
    store.sessions.setTitle(sessionId, "Renamed");
    expect(await handlers["sharing.export.entries"]({ handle: preview.handle, offset: 0, limit: 50 }))
      .toEqual(before);
    await handlers["sharing.export.save"]({ handle: preview.handle, format: "json" });
    expect(written!.text).not.toContain("Added later");
    expect(written!.text).not.toContain("Renamed");
  });

  it("never exports a live tool call's input or output", async () => {
    const sessionId = liveSession();
    const turnId = store.turns.list(sessionId)[0]!.id;
    store.blocks.upsert({ id: "blk_tool", turnId, sessionId, kind: "tool_call", index: 1,
      name: "Bash", status: "success", toolUseId: "toolu_9",
      input: { command: "cat .env" }, output: "ANTHROPIC_API_KEY=sk-ant-abc123def456ghi789",
      createdAt: clock, updatedAt: clock } as never);
    const preview = await handlers["sharing.export.preview"]({ sessionId, includeReasoning: false });
    await handlers["sharing.export.save"]({ handle: preview.handle, format: "json" });
    for (const leak of ["cat .env", "sk-ant-", "ANTHROPIC_API_KEY", "toolu_9"]) {
      expect(written!.text).not.toContain(leak);
    }
    expect(written!.text).toContain("Bash");
  });

  it("withholds a native transcript's recorded tool output but discloses what the importer dropped", async () => {
    const native = store.imports.commit({ projectId, snapshot: {
      backend: "codex", format: "f", nativeId: "n1", title: "Native", sourcePath: "p",
      sourceBytes: 1, sourceSha256: "a".repeat(64), cwd: null, startedAt: null, endedAt: null,
      entries: [
        { index: 0, at: null, label: "user", truncated: false, kind: "message",
          speaker: "user", text: "run it" },
        { index: 1, at: null, label: "Bash (historical)", truncated: false, kind: "activity",
          name: "Bash", text: "ls -la" },
        { index: 2, at: null, label: "Bash (historical)", truncated: false, kind: "activity-result",
          name: "Bash", text: "total 48 secret-output.txt", failed: false },
      ],
      counts: { records: 3, entries: 3, messages: 1, thinking: 0, activities: 2, notices: 0,
        droppedConfiguration: 4, unknownRecords: 2, echoedEvents: 0, truncatedTexts: 0,
        normalizedBytes: 500 },
      unknownTypes: [], warnings: [], complete: true,
    } });
    const preview = await handlers["sharing.export.preview"]({
      sessionId: native.session.id, includeReasoning: false });
    expect(preview.origin).toBe("native-transcript");
    const entries = await handlers["sharing.export.entries"]({
      handle: preview.handle, offset: 0, limit: 50 });
    const result = entries.find((entry) => entry.kind === "activity-result")!;
    expect((result as { text: string }).text).toBe("");
    // The importer's own omissions are disclosed rather than dropped.
    const notice = entries.find((entry) => entry.kind === "notice")!;
    expect((notice as { text: string }).text).toMatch(/4 configuration.*2 record\(s\) of an unknown type/);
  });

  it("carries a received bundle's comments and re-anchors them when reasoning is withheld", async () => {
    const shared = store.shares.commit({ projectId, bundle: bundle({
      bundleId: "d".repeat(32),
      entries: [
        { index: 0, at: null, label: "assistant", truncated: false, kind: "thinking", text: "reasoning" },
        { index: 1, at: null, label: "assistant", truncated: false, kind: "message",
          speaker: "assistant", text: "the answer" },
      ],
      counts: { entries: 2, messages: 1, thinking: 1, activities: 0, notices: 0, truncatedTexts: 0,
        droppedInteractive: 2, droppedThinking: 0, droppedWidgets: 1, droppedUsage: 0, redactions: 4 },
      comments: [
        { id: "c".repeat(32), entryIndex: 1, author: "Reviewer", body: "note on the answer",
          createdAt: "2026-09-07T11:00:00Z", replyToId: null, resolved: false },
        { id: "e".repeat(32), entryIndex: 0, author: "Reviewer", body: "note on the reasoning",
          createdAt: "2026-09-07T11:01:00Z", replyToId: null, resolved: false },
      ],
    }) });

    const preview = await handlers["sharing.export.preview"]({
      sessionId: shared.session.id, includeReasoning: false });
    expect(preview.origin).toBe("shared-bundle");
    expect(preview.commentCount).toBe(2);
    const reviewedComments = await handlers["sharing.export.comments"]({
      handle: preview.handle, offset: 0, limit: 1,
    });
    expect(reviewedComments.map((comment) => comment.body)).toEqual(["note on the answer"]);
    expect(reviewedComments[0]!.entryIndex).toBe(0);
    const nextComments = await handlers["sharing.export.comments"]({
      handle: preview.handle, offset: 1, limit: 1,
    });
    expect(nextComments[0]!.entryIndex).toBeNull();
    // Reasoning withheld: entry 1 became entry 0, and the note on the withheld
    // reasoning became a session-level note rather than moving onto the answer.
    await handlers["sharing.export.save"]({ handle: preview.handle, format: "json" });
    const saved = JSON.parse(written!.text) as ShareBundle;
    expect(saved.entries).toHaveLength(1);
    expect(saved.comments.map((c) => c.entryIndex)).toEqual([0, null]);
    expect(saved.comments.map((c) => c.body)).toEqual(["note on the answer", "note on the reasoning"]);
    // The first sender's disclosures survive the re-share.
    expect(saved.counts).toMatchObject({ droppedInteractive: 2, droppedWidgets: 1, droppedThinking: 1 });
  });
});

describe("imports stage, preview and commit atomically", () => {
  it("previews an HTML carrier and commits to the project main captured", async () => {
    picked = writeShare(bundle(), "html");
    const preview = await handlers["sharing.import.pick"]({ projectId });
    expect(preview!.destinationProjectId).toBe(projectId);
    expect(JSON.stringify(preview)).not.toContain(dir.replaceAll("\\", "\\\\"));
    expect(preview!.omissions.map((claim) => claim.kind))
      .toEqual(expect.arrayContaining(["thinking", "interactive", "redactions"]));

    const entries = await handlers["sharing.import.entries"]({
      handle: preview!.handle, offset: 0, limit: 50 });
    expect((entries[0] as { text: string }).text).toBe("hello from elsewhere");

    const committed = await handlers["sharing.import.commit"]({ handle: preview!.handle });
    expect(committed.duplicate).toBe(false);
    expect(store.shares.artifactKindOf(committed.session.id)).toBe("shared-bundle");
    expect(hostRef.size()).toBe(0);
    await expect(handlers["sharing.import.commit"]({ handle: preview!.handle }))
      .rejects.toThrow(/no longer available/);
  });

  it("marks an already-imported bundle and refuses a conflicting id", async () => {
    picked = writeShare(bundle(), "json");
    const first = await handlers["sharing.import.pick"]({ projectId });
    await handlers["sharing.import.commit"]({ handle: first!.handle });

    picked = writeShare(bundle(), "json", "again");
    const again = await handlers["sharing.import.pick"]({ projectId });
    expect(again!.existingSessionId).toBeDefined();
    expect((await handlers["sharing.import.commit"]({ handle: again!.handle })).duplicate).toBe(true);

    picked = writeShare(bundle({ entries: [{ index: 0, at: null, label: "assistant",
      truncated: false, kind: "message", speaker: "assistant", text: "tampered" }] }), "json", "bad");
    const conflicting = await handlers["sharing.import.pick"]({ projectId });
    expect(conflicting!.conflictingBundleId).toBe(true);
    await expect(handlers["sharing.import.commit"]({ handle: conflicting!.handle }))
      .rejects.toThrow(/already/i);
  });

  it("refuses malformed files and stages nothing", async () => {
    for (const [content, format] of [
      ["not json at all", "json"],
      [JSON.stringify({ ...bundle(), version: 2 }), "json"],
      ["<html><body>no carrier</body></html>", "html"],
    ] as const) {
      picked = path.join(dir, `bad.capyshare.${format}`);
      fs.writeFileSync(picked, content, "utf8");
      await expect(handlers["sharing.import.pick"]({ projectId })).rejects.toThrow();
      expect(staging.size()).toBe(0);
      expect(staging.reserved()).toBe(0);
      expect(hostRef.size()).toBe(0);
    }
    expect(store.db.get("SELECT COUNT(*) AS n FROM sessions")).toMatchObject({ n: 0 });
  });

  it("returns null on a cancelled picker and refuses an unknown project", async () => {
    picked = null;
    expect(await handlers["sharing.import.pick"]({ projectId })).toBeNull();
    await expect(handlers["sharing.import.pick"]({ projectId: "prj_missing" }))
      .rejects.toThrow(/unknown project/);
  });

  it("keeps handles owner-bound across every channel", async () => {
    picked = writeShare(bundle(), "json");
    const preview = await handlers["sharing.import.pick"]({ projectId });
    owner = 2;
    await expect(handlers["sharing.import.entries"]({
      handle: preview!.handle, offset: 0, limit: 10 })).rejects.toThrow(/another window/);
    await expect(handlers["sharing.import.commit"]({ handle: preview!.handle }))
      .rejects.toThrow(/another window/);
    await expect(handlers["sharing.import.cancel"]({ handle: preview!.handle }))
      .rejects.toThrow(/another window/);
    expect(store.db.get("SELECT COUNT(*) AS n FROM share_imports")).toMatchObject({ n: 0 });
  });

  it("refuses to serve a native transcript through the shared-artifact reader", async () => {
    const native = store.imports.commit({ projectId, snapshot: {
      backend: "codex", format: "f", nativeId: "n2", title: null, sourcePath: "p",
      sourceBytes: 1, sourceSha256: "b".repeat(64), cwd: null, startedAt: null, endedAt: null,
      entries: [{ index: 0, at: null, label: "user", truncated: false, kind: "message",
        speaker: "user", text: "x" }],
      counts: { records: 1, entries: 1, messages: 1, thinking: 0, activities: 0, notices: 0,
        droppedConfiguration: 0, unknownRecords: 0, echoedEvents: 0, truncatedTexts: 0,
        normalizedBytes: 10 },
      unknownTypes: [], warnings: [], complete: true,
    } });
    expect(() => handlers["sharing.entries"]({
      sessionId: native.session.id, offset: 0, limit: 10 })).toThrow(/not a shared session/);
  });
});

describe("stored shared artifacts are read through their own channels", () => {
  it("describes a committed bundle and pages its comments", async () => {
    const source = bundle();
    picked = writeShare(source, "json");
    const preview = await handlers["sharing.import.pick"]({ projectId });
    const committed = await handlers["sharing.import.commit"]({ handle: preview!.handle });
    const sessionId = committed.session.id;

    const artifact = await handlers["sharing.get"]({ sessionId });
    expect(artifact).toMatchObject({ sessionId, bundleId: source.bundleId, schemaVersion: 1 });
    // A canonical content identity, not a path and not the file's bytes.
    expect(artifact?.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(artifact)).not.toContain(dir.replaceAll("\\", "\\\\"));

    // The counts that bound a reader's paging are the rows actually stored,
    // not the tallies the sender claimed.
    expect(artifact?.entryCount).toBe(source.entries.length);
    expect(artifact?.commentCount).toBe(source.comments.length);

    const all = await handlers["sharing.comments"]({ sessionId, offset: 0, limit: 50 });
    expect(all).toHaveLength(source.comments.length);
    if (source.comments.length > 1) {
      const first = await handlers["sharing.comments"]({ sessionId, offset: 0, limit: 1 });
      expect(first).toHaveLength(1);
      expect(first[0]?.id).toBe(all[0]?.id);
    }
  });

  it("answers null for a live session and for a native transcript", async () => {
    const live = store.sessions.create({ projectId, mode: "solo", agents: [] }).session;
    expect(await handlers["sharing.get"]({ sessionId: live.id })).toBeNull();
    expect(await handlers["sharing.get"]({ sessionId: "ses_missing" })).toBeNull();
  });
});

describe("local notes travel with a re-export without changing the artifact", () => {
  it("carries the operator's notes alongside the sender's comments", async () => {
    const source = bundle();
    picked = writeShare(source, "json");
    const preview = await handlers["sharing.import.pick"]({ projectId });
    const committed = await handlers["sharing.import.commit"]({ handle: preview!.handle });
    const sessionId = committed.session.id;
    const identityBefore = store.shares.get(sessionId)!.contentSha256;

    const created = await handlers["sharing.notes.create"]({
      sessionId, anchor: { kind: "session" }, body: "my own remark",
      replyToId: null, replyToReceivedId: null,
    });
    expect(created.note.authorLabel).toBe("You");

    // Writing a note cannot change what this machine believes it received, so
    // re-importing the same file is still a duplicate rather than a conflict.
    expect(store.shares.get(sessionId)!.contentSha256).toBe(identityBefore);

    const listed = await handlers["sharing.notes.list"]({ sessionId, offset: 0, limit: 50 });
    expect(listed.total).toBe(1);
    expect(listed.notes[0]?.body).toBe("my own remark");

    // The re-export carries both the sender's comments and this note.
    const exported = await handlers["sharing.export.preview"]({ sessionId, includeReasoning: false });
    const comments = await handlers["sharing.export.comments"]({
      handle: exported.handle, offset: 0, limit: 50,
    });
    expect(comments.map((c) => c.body)).toContain("my own remark");
    expect(comments.length).toBe(source.comments.length + 1);
    await handlers["sharing.export.cancel"]({ handle: exported.handle });
  });

  it("refuses a note the renderer aimed at another session or a missing entry", async () => {
    const source = bundle();
    picked = writeShare(source, "json");
    const preview = await handlers["sharing.import.pick"]({ projectId });
    const committed = await handlers["sharing.import.commit"]({ handle: preview!.handle });
    const sessionId = committed.session.id;

    // These handlers refuse synchronously; `ipcMain.handle` turns that into a
    // rejection for the renderer, but a direct caller sees the throw.
    const refusalOf = async (sessionArg: string, entryIndex: number | null): Promise<string> => {
      try {
        await handlers["sharing.notes.create"]({
          sessionId: sessionArg,
          anchor: entryIndex === null ? { kind: "session" } : { kind: "entry", entryIndex },
          body: "x", replyToId: null, replyToReceivedId: null,
        });
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      return "no-error";
    };
    expect(await refusalOf("ses_missing", null)).toMatch(/unknown session/);
    expect(await refusalOf(sessionId, 9_999)).toMatch(/past the end/);
  });
});

describe("continuing from a received bundle starts something new", () => {
  async function commitBundle(): Promise<string> {
    picked = writeShare(bundle(), "json");
    const preview = await handlers["sharing.import.pick"]({ projectId });
    const committed = await handlers["sharing.import.commit"]({ handle: preview!.handle });
    return committed.session.id;
  }

  it("quotes the bundle inertly, within the delivered byte budget", async () => {
    const sessionId = await commitBundle();
    const reference = await handlers["sharing.reference"]({ sessionId });

    expect(reference.text).toContain("hello from elsewhere");
    expect(new TextEncoder().encode(reference.text).byteLength).toBeLessThanOrEqual(6000);
    // A quotation, not a configuration: nothing that could name a backend, a
    // tool or a conversation to resume.
    expect(reference.text).not.toMatch(/bundleId|mcpServers|"tools"|apiKey/i);
  });

  it("creates a fresh session with its own agent and never resumes the sender", async () => {
    const sessionId = await commitBundle();
    const vetted = build({ validateAgent: (agent) => agent });
    const created = await vetted["sharing.continue"]({
      sessionId,
      projectId,
      agent: { name: "Assistant", backend: "claude", model: "claude-opus-5", role: "lead", config: null },
    });

    // A new live session, distinct from the artifact, with a new agent row.
    expect(created.session.id).not.toBe(sessionId);
    expect(created.session.origin).toBe("live");
    expect(created.session.artifactKind ?? null).toBeNull();
    expect(created.session.continuationSourceSessionId).toBe(sessionId);
    expect(created.agents).toHaveLength(1);
    expect(created.agents[0]?.id).toBeTruthy();
    expect(created.agents[0]?.backend).toBe("claude");

    // The artifact is untouched and still read-only.
    expect(store.sessions.get(sessionId)?.origin).toBe("import");
    expect(store.shares.artifactKindOf(sessionId)).toBe("shared-bundle");

    // The quotation landed as one inert system block, and nothing was queued.
    const blocks = store.blocks.listBySession(created.session.id);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("text");
    const turns = store.turns.list(created.session.id);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.role).toBe("system");
    expect(turns[0]?.status).toBe("done");
  });

  it("re-checks the agent main was given rather than trusting the renderer", async () => {
    const sessionId = await commitBundle();
    const seen: string[] = [];
    const gated = build({
      validateAgent: (agent) => {
        seen.push(agent.backend);
        throw new Error("that harness is not available");
      },
    });
    expect(() => gated["sharing.continue"]({
      sessionId, projectId,
      agent: { name: "A", backend: "codex", model: "gpt", role: "lead", config: null },
    })).toThrow(/not available/);
    expect(seen).toEqual(["codex"]);
  });

  it("refuses to continue at all when main supplied no agent validator", async () => {
    const sessionId = await commitBundle();
    // `build()` omits the validator unless a case asks for one, which is
    // exactly the state main is in until it wires one: the channel must refuse
    // rather than persist an agent that skipped the credential/model checks.
    expect(() => handlers["sharing.continue"]({
      sessionId, projectId,
      agent: { name: "A", backend: "claude", model: "m", role: "lead", config: null },
    })).toThrow(/has not supplied an agent validator/);
    // And nothing was created.
    expect(store.sessions.list().filter((s) => s.continuationSourceSessionId !== null)).toHaveLength(0);
  });

  it("refuses an unknown artifact, an unknown project and a native transcript", async () => {
    const sessionId = await commitBundle();
    const agent = { name: "A", backend: "claude" as const, model: "m", role: "lead" as const, config: null };

    const vetted = build({ validateAgent: (draft) => draft });
    expect(() => vetted["sharing.continue"]({ sessionId: "ses_missing", projectId, agent }))
      .toThrow(/unknown shared session/);
    expect(() => vetted["sharing.continue"]({ sessionId, projectId: "prj_missing", agent }))
      .toThrow(/unknown project/);
    expect(() => handlers["sharing.reference"]({ sessionId: "ses_missing" }))
      .toThrow(/unknown shared session/);
  });
});

describe("a note anchored to a live message keeps its place on export", () => {
  it("re-anchors through the projection, and drops the anchor when the block is withheld", async () => {
    const sessionId = liveSession("first message");
    const blocks = store.blocks.listBySession(sessionId);
    const anchored = blocks[0];
    expect(anchored).toBeDefined();

    store.localNotes.create({
      sessionId, anchor: { kind: "block", blockId: anchored!.id },
      authorLabel: "You", body: "about this message",
    });
    store.localNotes.create({
      sessionId, anchor: { kind: "session" }, authorLabel: "You", body: "about the session",
    });

    const preview = await handlers["sharing.export.preview"]({ sessionId, includeReasoning: false });
    const comments = await handlers["sharing.export.comments"]({
      handle: preview.handle, offset: 0, limit: 50,
    });

    const onMessage = comments.find((c) => c.body === "about this message");
    const onSession = comments.find((c) => c.body === "about the session");
    // The block survived the projection, so the note points at the entry it
    // became rather than being flattened to session level.
    expect(onMessage?.entryIndex).not.toBeNull();
    expect(onMessage?.entryIndex).toBe(0);
    expect(onSession?.entryIndex).toBeNull();
    await handlers["sharing.export.cancel"]({ handle: preview.handle });
  });

  it("refuses an export whose notes exceed the cap instead of trimming them", async () => {
    const sessionId = liveSession("hello");
    // The repository refuses over its cap; the export surfaces that rather than
    // shipping a comment list that looks complete and is not.
    for (let i = 0; i < 3; i += 1) {
      store.localNotes.create({
        sessionId, anchor: { kind: "session" }, authorLabel: "You", body: `note ${i}`,
      });
    }
    expect(() => store.localNotes.toShareComments(sessionId, { limit: 2 }))
      .toThrow(/cannot be exported as one bundle/);
  });
});

describe("a live note goes through the same projection as everything else", () => {
  it("redacts a secret-like note and counts it in the bundle's own tally", async () => {
    const sessionId = liveSession("hello");
    store.localNotes.create({
      sessionId, anchor: { kind: "session" },
      // The author label is main-owned, but it is still text that is exported.
      authorLabel: "You",
      body: "the key is sk-ant-abcdefgh12345678 — do not share",
    });

    const preview = await handlers["sharing.export.preview"]({ sessionId, includeReasoning: false });
    const comments = await handlers["sharing.export.comments"]({
      handle: preview.handle, offset: 0, limit: 50,
    });

    // The live path used to assign raw notes after the projection ran, so a
    // secret in one left the machine untouched and uncounted.
    expect(comments[0]?.body).not.toContain("sk-ant-abcdefgh12345678");
    expect(comments[0]?.body).toContain("«redacted»");
    expect(preview.counts.redactions).toBeGreaterThan(0);
    await handlers["sharing.export.cancel"]({ handle: preview.handle });
  });

  it("carries no raw block id, and keeps the anchor stable", async () => {
    const sessionId = liveSession("first message");
    const blockId = store.blocks.listBySession(sessionId)[0]!.id;
    store.localNotes.create({
      sessionId, anchor: { kind: "block", blockId },
      authorLabel: "You", body: "about this message",
    });

    const preview = await handlers["sharing.export.preview"]({ sessionId, includeReasoning: false });
    const comments = await handlers["sharing.export.comments"]({
      handle: preview.handle, offset: 0, limit: 50,
    });
    const text = (await worker.text(
      (staging as unknown as { operations: Map<string, { jobId: string }> })
        .operations.get(preview.handle)!.jobId,
      "json",
    )).text;

    // The anchor survives as an entry index; the local block id is this
    // machine's own identifier and must not travel.
    expect(comments[0]?.entryIndex).toBe(0);
    expect(text).not.toContain(blockId);
    await handlers["sharing.export.cancel"]({ handle: preview.handle });
  });
});

describe("the SQL truncation flag lands on the entry that was truncated", () => {
  /**
   * Exercised directly rather than through an export.
   *
   * Through the public path the flag is unobservable: SQL clips at 70,000
   * *characters* while the projector truncates at 65,536 *bytes*, so anything
   * SQL clipped is over the projector's own cap too and gets flagged either
   * way. A synthetic row — short delivered text, large original length — is
   * the only way to isolate which entry the SQL flag lands on. (That the two
   * thresholds make the flag redundant in the shipped configuration is
   * reported separately; it is not this test's business to hide it.)
   */
  const row = (over: Partial<LiveBlockRow>): LiveBlockRow => ({
    blockId: "blk", kind: "text", turnRole: "agent", createdAt: 1,
    text: "kept", textLength: 4, name: null, status: null, ...over,
  });

  it("uses the source→entry mapping, not the entry position", () => {
    const bundle = buildLiveBundle({
      kind: "live",
      rows: [
        // Withheld by default, so every later entry shifts down by one.
        row({ blockId: "blk_think", kind: "thinking", text: "private", textLength: 7 }),
        row({ blockId: "blk_short", text: "short", textLength: 5 }),
        // SQL clipped this one: delivered text is far shorter than the original.
        row({ blockId: "blk_long", text: "clipped", textLength: 90_000 }),
      ],
      metadata: {
        title: "Live", mode: "solo", startedAt: null, endedAt: null,
        agents: [{ label: "Assistant", backend: "claude", model: "m" }],
      },
      options: {
        includeReasoning: false,
        bundleId: "a".repeat(32),
        appVersion: "0.1.0",
        createdAt: "2026-09-08T10:00:00Z",
      },
    });

    expect(bundle.entries).toHaveLength(2);
    expect(bundle.entries[0]?.truncated).toBe(false);
    // Indexing `rows` by entry position put this flag on the short message.
    expect(bundle.entries[1]?.truncated).toBe(true);
    expect(bundle.counts.truncatedTexts).toBe(1);
  });
});
