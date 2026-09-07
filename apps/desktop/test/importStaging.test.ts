/**
 * Import preview staging (docs/plans/phase7-imports.md §Staging and persistence).
 *
 * Every asynchronous boundary the service crosses — project validation, parse,
 * snapshot write, snapshot read — is individually deferrable here, so a test
 * can suspend the service *inside* a stage, change the world, and assert what
 * happens when the stage resumes. No timing sleeps: a deferral is released by
 * the test, not by a clock.
 *
 * The filesystem is injected too. Most tests use a real temp directory through
 * the shipping `nodeStagingFs`; the race tests wrap it so one call can be held
 * open. The parser is always synthetic — its content semantics belong to its
 * owner, and this service only has to be correct about custody.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportError, type ImportedTranscript } from "@capygen/engine";
import {
  DEFAULT_MAX_SNAPSHOT_BYTES,
  DEFAULT_MAX_STAGED_BYTES,
  DEFAULT_TTL_MS,
  OPTION_CEILINGS,
  ImportStagingError,
  ImportStagingService,
  nodeStagingFs,
  type ParseTranscript,
  type StageTranscript,
  type StagingFs,
} from "../src/imports/staging.js";

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `capygen-${tag}-`));
  created.push(dir);
  return dir;
}

/**
 * A suspension point a test drives by hand.
 *
 * `entered` resolves when the service reaches the stage, and `open` releases
 * it. Waiting on `entered` is what makes these tests deterministic: a fixed
 * number of `await Promise.resolve()` would only guess how many microtasks a
 * stage happens to sit behind today.
 */
interface Gate<T = void> {
  /** Awaited by the seam; resolves when the test calls `open`. */
  wait: Promise<T>;
  /** Resolves once the seam has reached this gate. */
  entered: Promise<void>;
  enter: () => void;
  open: (value: T) => void;
}

function gate<T = void>(): Gate<T> {
  let open!: (value: T) => void;
  let enter!: () => void;
  const wait = new Promise<T>((resolve) => {
    open = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  return { wait, entered, enter, open };
}

/** A synthetic inert snapshot. Shaped like the parser's output, invented here. */
function snapshot(overrides: Partial<ImportedTranscript> = {}): ImportedTranscript {
  return {
    backend: "claude",
    format: "claude-jsonl-v1",
    nativeId: "ses_synthetic",
    title: "synthetic fixture",
    sourcePath: "C:/picked/transcript.jsonl",
    sourceBytes: 1234,
    sourceSha256: "a".repeat(64),
    cwd: "C:/picked",
    startedAt: "2026-09-07T00:00:00.000Z",
    endedAt: "2026-09-07T00:01:00.000Z",
    // Distinctive prose, so "no transcript text crossed the boundary" is a
    // real assertion rather than a substring accident.
    entries: [
      { kind: "message", index: 0, at: null, label: "user", truncated: false, speaker: "user", text: "PROSE-USER-9f3a" },
      { kind: "message", index: 1, at: null, label: "assistant", truncated: false, speaker: "assistant", text: "PROSE-ASSISTANT-71c2" },
    ],
    counts: {
      records: 2, entries: 2, messages: 2, thinking: 0, activities: 0, notices: 0,
      droppedConfiguration: 3, unknownRecords: 1, echoedEvents: 0, truncatedTexts: 0,
      normalizedBytes: 256,
    },
    unknownTypes: [{ type: "some_future_event", count: 1 }],
    warnings: [{ code: "incomplete-history", message: "history prefix not opened", count: 1 }],
    complete: false,
    ...overrides,
  };
}

/** Every call the service makes, individually suspendable. */
interface Controls {
  /** Held at each seam; null means "do not hold". */
  holdWrite: { gate: Gate | null };
  holdRead: { gate: Gate | null };
  holdProject: { gate: Gate | null };
  /** Suspends the unlink, which is how maintenance is held open. */
  holdUnlink: { gate: Gate | null };
  /** Makes the next N unlinks fail with EBUSY, to manufacture an orphan. */
  failUnlinks: { count: number };
  writes: string[];
  unlinks: string[];
  reads: string[];
}

interface Harness {
  dir: string;
  service: ImportStagingService;
  clock: { value: number };
  parse: ReturnType<typeof vi.fn>;
  projects: Set<string>;
  log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  /** Everything written to the log, joined — for leak assertions. */
  logged: () => string;
  files: () => string[];
  controls: Controls;
}

async function harness(
  options: {
    parse?: ParseTranscript;
    ttlMs?: number;
    maxConcurrent?: number;
    maxSnapshotBytes?: number;
    maxStagedBytes?: number;
    fs?: (real: StagingFs, controls: Controls) => StagingFs;
    tag?: string;
    initialize?: boolean;
  } = {},
): Promise<Harness> {
  const dir = tempDir(options.tag ?? "staging");
  const clock = { value: 1_000_000 };
  const projects = new Set(["proj-1", "proj-2"]);
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const controls: Controls = {
    holdWrite: { gate: null },
    holdRead: { gate: null },
    holdProject: { gate: null },
    holdUnlink: { gate: null },
    failUnlinks: { count: 0 },
    writes: [],
    unlinks: [],
    reads: [],
  };

  const base: StagingFs = {
    ensureDir: (d) => nodeStagingFs.ensureDir(d),
    createExclusive: async (file, body, onCreated) => {
      if (controls.holdWrite.gate) {
        controls.holdWrite.gate.enter();
        await controls.holdWrite.gate.wait;
      }
      controls.writes.push(path.basename(file));
      await nodeStagingFs.createExclusive(file, body, onCreated);
    },
    readFile: async (file) => {
      if (controls.holdRead.gate) {
        controls.holdRead.gate.enter();
        await controls.holdRead.gate.wait;
      }
      controls.reads.push(path.basename(file));
      return nodeStagingFs.readFile(file);
    },
    unlink: async (file) => {
      if (controls.holdUnlink.gate) {
        controls.holdUnlink.gate.enter();
        await controls.holdUnlink.gate.wait;
      }
      controls.unlinks.push(path.basename(file));
      if (controls.failUnlinks.count > 0) {
        controls.failUnlinks.count -= 1;
        const err = new Error("EBUSY: file is locked");
        (err as { code?: string }).code = "EBUSY";
        throw err;
      }
      await nodeStagingFs.unlink(file);
    },
    listDir: (d) => nodeStagingFs.listDir(d),
  };

  const service = new ImportStagingService({
    directory: dir,
    parse: (options.parse ?? (async () => snapshot())) as ParseTranscript,
    projectExists: async (id) => {
      if (controls.holdProject.gate) {
        controls.holdProject.gate.enter();
        await controls.holdProject.gate.wait;
      }
      return projects.has(id);
    },
    log,
    fs: options.fs ? options.fs(base, controls) : base,
    now: () => clock.value,
    ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
    ...(options.maxConcurrent !== undefined ? { maxConcurrent: options.maxConcurrent } : {}),
    // Explicit small bounds by default: the shipped defaults reserve the
    // worst case per preview, which deliberately admits only one at a time
    // (see the "shipped defaults" test).
    maxSnapshotBytes: options.maxSnapshotBytes ?? 8_000,
    maxStagedBytes: options.maxStagedBytes ?? 200_000,
  });
  if (options.initialize !== false) await service.initialize();

  const parse = vi.fn();
  return {
    dir,
    service,
    clock,
    parse,
    projects,
    log,
    logged: () =>
      [...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls]
        .flat()
        .map(String)
        .join("\n"),
    files: () => fs.readdirSync(dir).sort(),
    controls,
  };
}

/** The refusal a call produced; fails the test if it resolved. */
async function rejection(work: Promise<unknown>): Promise<ImportStagingError> {
  try {
    await work;
  } catch (err) {
    return err as ImportStagingError;
  }
  throw new Error("expected the call to be refused, but it resolved");
}

function thrown(work: () => unknown): ImportStagingError {
  try {
    work();
  } catch (err) {
    return err as ImportStagingError;
  }
  throw new Error("expected the call to throw, but it returned");
}

const PREVIEW = { sourcePath: "C:/picked/transcript.jsonl", destinationProjectId: "proj-1" };

// ---------------------------------------------------------------------------
// construction and initialization
// ---------------------------------------------------------------------------

describe("construction", () => {
  const ok = { parse: async () => snapshot(), projectExists: () => true, log: console };

  it("refuses a missing, blank or relative staging directory", () => {
    for (const directory of ["", "   ", undefined as unknown as string, "relative/staging"]) {
      expect(
        () => new ImportStagingService({ ...ok, directory } as never),
        JSON.stringify(directory),
      ).toThrow(ImportStagingError);
    }
  });

  it("refuses bounds that are not safe positive integers", () => {
    const dir = tempDir("bounds");
    for (const patch of [
      { ttlMs: 0 },
      { ttlMs: Number.NaN },
      { ttlMs: 1.5 },
      { maxConcurrent: -1 },
      { maxConcurrent: 2.5 },
      { maxSnapshotBytes: Number.POSITIVE_INFINITY },
      { maxSnapshotBytes: Number.MAX_SAFE_INTEGER + 2 },
      { maxStagedBytes: 0 },
    ]) {
      expect(
        () => new ImportStagingService({ ...ok, directory: dir, ...patch } as never),
        JSON.stringify(patch),
      ).toThrow(/positive whole number/);
    }
    // Ceilings, so a caller cannot ask for the moon.
    for (const patch of [
      { ttlMs: OPTION_CEILINGS.ttlMs + 1 },
      { maxConcurrent: OPTION_CEILINGS.maxConcurrent + 1 },
      { maxStagedBytes: OPTION_CEILINGS.maxStagedBytes + 1 },
    ]) {
      expect(
        () => new ImportStagingService({ ...ok, directory: dir, ...patch } as never),
        JSON.stringify(patch),
      ).toThrow(/must be at most/);
    }
    // A per-snapshot cap above the total budget can never be satisfied.
    expect(
      () =>
        new ImportStagingService({
          ...ok,
          directory: dir,
          maxSnapshotBytes: 100,
          maxStagedBytes: 10,
        } as never),
    ).toThrow(/cannot exceed/);
  });

  it("refuses every operation until it is initialized", async () => {
    const h = await harness({ initialize: false });
    expect((await rejection(h.service.preview({ ownerId: 1, ...PREVIEW }))).code).toBe(
      "not-initialized",
    );
    expect(thrown(() => h.service.get("x", 1)).code).toBe("not-initialized");
  });

  it("initializes once, and refuses to re-run cleanup while previews exist", async () => {
    const h = await harness();
    await h.service.preview({ ownerId: 1, ...PREVIEW });
    expect((await rejection(h.service.initialize())).code).toBe("invalid-option");
    expect(h.files()).toHaveLength(1);
  });
});

describe("startup cleanup", () => {
  it("removes only its own abandoned snapshots, matching real crash names", async () => {
    const dir = tempDir("cleanup");
    const owned = `import-${"1".repeat(32)}.snapshot.json`;
    const alsoOwned = `import-${"2".repeat(32)}.snapshot.json`;
    const stranger = "someone-elses.json";
    const nearMiss = "import-short.snapshot.json";
    // The old draft wrote `<final>.<hex>.tmp` and its cleanup pattern did not
    // match; there is no temporary variant now, so a crash leaves exactly the
    // final name and cleanup finds it.
    const oldStyleTemp = `import-${"5".repeat(32)}.snapshot.json.abcdef123456.tmp`;
    for (const name of [owned, alsoOwned, stranger, nearMiss, oldStyleTemp]) {
      fs.writeFileSync(path.join(dir, name), "{}");
    }
    fs.mkdirSync(path.join(dir, `import-${"3".repeat(32)}.snapshot.json.d`));

    const service = new ImportStagingService({
      directory: dir,
      parse: async () => snapshot(),
      projectExists: () => true,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    expect(await service.initialize()).toBe(2);
    expect(fs.readdirSync(dir).sort()).toEqual(
      [stranger, nearMiss, oldStyleTemp, `import-${"3".repeat(32)}.snapshot.json.d`].sort(),
    );
  });

  it("does not follow a symlink that matches the owned pattern", async () => {
    const dir = tempDir("symlink");
    const outside = tempDir("outside");
    const victim = path.join(outside, "precious.txt");
    fs.writeFileSync(victim, "must survive");
    const link = path.join(dir, `import-${"4".repeat(32)}.snapshot.json`);
    try {
      fs.symlinkSync(victim, link, "file");
    } catch {
      return; // symlink creation needs privilege on Windows
    }

    const service = new ImportStagingService({
      directory: dir,
      parse: async () => snapshot(),
      projectExists: () => true,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    await service.initialize();
    expect(fs.readFileSync(victim, "utf8")).toBe("must survive");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("creates the staging directory when it does not exist yet", async () => {
    const dir = path.join(tempDir("mkdir"), "nested", "staging");
    const service = new ImportStagingService({
      directory: dir,
      parse: async () => snapshot(),
      projectExists: () => true,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    expect(await service.initialize()).toBe(0);
    expect(fs.existsSync(dir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// preview
// ---------------------------------------------------------------------------

describe("preview", () => {
  it("returns metadata only — never transcript entries", async () => {
    const h = await harness();
    const preview = await h.service.preview({ ownerId: 1, ...PREVIEW });

    expect(preview.handle).toMatch(/^[0-9a-f]{32}$/);
    expect(preview.counts.droppedConfiguration).toBe(3);
    expect(preview.complete).toBe(false);
    expect(preview.expiresAt).toBe(h.clock.value + DEFAULT_TTL_MS);

    const serialized = JSON.stringify(preview);
    expect(serialized).not.toContain("PROSE-USER-9f3a");
    expect(serialized).not.toContain("PROSE-ASSISTANT-71c2");
    expect(Object.keys(preview)).not.toContain("entries");
  });

  it("stages one owned file at its final name, never a temporary one", async () => {
    const h = await harness();
    await h.service.preview({ ownerId: 1, ...PREVIEW });
    expect(h.files()).toHaveLength(1);
    expect(h.files()[0]).toMatch(/^import-[0-9a-f]{32}\.snapshot\.json$/);
    expect(h.controls.writes).toEqual(h.files());
  });

  it("refuses an unknown destination before parsing anything", async () => {
    const parse = vi.fn(async () => snapshot());
    const h = await harness({ parse: parse as unknown as ParseTranscript });
    expect(
      (await rejection(
        h.service.preview({ ownerId: 1, sourcePath: "C:/x", destinationProjectId: "nope" }),
      )).code,
    ).toBe("unknown-project");
    expect(parse).not.toHaveBeenCalled();
    expect(h.files()).toEqual([]);
    expect(h.service.reserved()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// finding 1 + 3: reservations taken before any await
// ---------------------------------------------------------------------------

describe("slot and quota reservations", () => {
  it("refuses a second preview from a window suspended in project validation", async () => {
    const h = await harness();
    const held = gate();
    h.controls.holdProject.gate = held;

    const first = h.service.preview({ ownerId: 1, ...PREVIEW });
    await held.entered;
    // The slot was taken before the await, so the second call sees it.
    expect((await rejection(h.service.preview({ ownerId: 1, ...PREVIEW }))).code).toBe("busy");

    held.open();
    await first;
    expect(h.service.size()).toBe(1);
  });

  it("counts a window suspended in project validation against the global cap", async () => {
    const h = await harness({ maxConcurrent: 2 });
    const held = gate();
    h.controls.holdProject.gate = held;

    const a = h.service.preview({ ownerId: 1, ...PREVIEW });
    const b = h.service.preview({ ownerId: 2, ...PREVIEW });
    await held.entered;
    expect((await rejection(h.service.preview({ ownerId: 3, ...PREVIEW }))).code).toBe(
      "too-many-previews",
    );

    held.open();
    await Promise.all([a, b]);
  });

  it("reserves the worst case before parsing, so two writers cannot both fit", async () => {
    // Snapshot size is unknown until the parse returns, so the budget is
    // claimed at the worst case before the parse starts. Two windows must not
    // both pass a free-space check and only then discover they do not fit.
    const parseGate = gate<ImportedTranscript>();
    const h = await harness({
      maxSnapshotBytes: 4000,
      maxStagedBytes: 5000,
      parse: () => {
        parseGate.enter();
        return parseGate.wait;
      },
    });

    const first = h.service.preview({ ownerId: 1, ...PREVIEW });
    await parseGate.entered;
    expect(h.service.reserved()).toBe(4000);
    expect((await rejection(h.service.preview({ ownerId: 2, ...PREVIEW }))).code).toBe(
      "staging-full",
    );

    parseGate.open(snapshot());
    await first;
  });

  it("uses a bounded aggregate by default: one worst-case preview at a time", async () => {
    // Deliberate consequence of the 256 MiB aggregate matching the 256 MiB
    // single-snapshot ceiling — admission is bounded by disk, not by slots.
    expect(DEFAULT_MAX_STAGED_BYTES).toBe(DEFAULT_MAX_SNAPSHOT_BYTES);
    const h = await harness({
      maxSnapshotBytes: DEFAULT_MAX_SNAPSHOT_BYTES,
      maxStagedBytes: DEFAULT_MAX_STAGED_BYTES,
    });
    await h.service.preview({ ownerId: 1, ...PREVIEW });
    expect((await rejection(h.service.preview({ ownerId: 2, ...PREVIEW }))).code).toBe(
      "staging-full",
    );
  });

  it("shrinks the reservation to the real snapshot size once it is known", async () => {
    const h = await harness({ maxSnapshotBytes: 4000, maxStagedBytes: 5000 });
    const held = gate();
    h.controls.holdWrite.gate = held;

    const pending = h.service.preview({ ownerId: 1, ...PREVIEW });
    await held.entered;
    // By the time the bytes exist the worst case is no longer needed, but the
    // budget is still held — it is never released before the file is gone.
    const atWrite = h.service.reserved();
    expect(atWrite).toBeGreaterThan(0);
    expect(atWrite).toBeLessThan(4000);

    held.open();
    const preview = await pending;
    expect(h.service.reserved()).toBe(atWrite);

    await h.service.cancel(preview.handle, 1);
    expect(h.service.reserved()).toBe(0);
  });

  it("holds quota until the file is really gone, then releases it exactly once", async () => {
    const h = await harness();
    const preview = await h.service.preview({ ownerId: 1, ...PREVIEW });
    expect(h.service.reserved()).toBeGreaterThan(0);

    await h.service.cancel(preview.handle, 1);
    expect(h.service.reserved()).toBe(0);
    expect(h.files()).toEqual([]);
    // A second cancel must not double-release the budget into negative space.
    await h.service.cancel(preview.handle, 1);
    expect(h.service.reserved()).toBe(0);
  });

  it("refuses a snapshot larger than the per-preview ceiling", async () => {
    const h = await harness({ maxSnapshotBytes: 64, maxStagedBytes: 128 });
    expect((await rejection(h.service.preview({ ownerId: 1, ...PREVIEW }))).code).toBe(
      "snapshot-too-large",
    );
    expect(h.files()).toEqual([]);
    expect(h.service.reserved()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// finding 2: no late publish, no cross-eviction
// ---------------------------------------------------------------------------

describe("late results never publish", () => {
  it("does not parse at all when the window is released during project validation", async () => {
    const parse = vi.fn(async () => snapshot());
    const h = await harness({ parse: parse as unknown as ParseTranscript });
    const held = gate();
    h.controls.holdProject.gate = held;

    const pending = h.service.preview({ ownerId: 7, ...PREVIEW });
    await held.entered;
    await h.service.releaseWindow(7);
    held.open();

    expect((await rejection(pending)).code).toBe("cancelled");
    // The stage after the release is never entered: no parse, no file, no quota.
    expect(parse).not.toHaveBeenCalled();
    expect(h.files()).toEqual([]);
    expect(h.service.reserved()).toBe(0);
  });

  it("discards a parse that returns after the window was released", async () => {
    const parseGate = gate<ImportedTranscript>();
    const h = await harness({
      parse: () => {
        parseGate.enter();
        return parseGate.wait;
      },
    });
    const pending = h.service.preview({ ownerId: 7, ...PREVIEW });
    await parseGate.entered;

    await h.service.releaseWindow(7);
    parseGate.open(snapshot());

    expect((await rejection(pending)).code).toBe("cancelled");
    expect(h.service.size()).toBe(0);
    expect(h.files()).toEqual([]);
    expect(h.service.reserved()).toBe(0);
  });

  it("discards a write that completes after the window was released", async () => {
    const h = await harness();
    const held = gate();
    h.controls.holdWrite.gate = held;

    const pending = h.service.preview({ ownerId: 7, ...PREVIEW });
    await held.entered;
    await h.service.releaseWindow(7);
    held.open();

    expect((await rejection(pending)).code).toBe("cancelled");
    expect(h.service.size()).toBe(0);
    // The file this operation created is removed rather than left orphaned.
    expect(h.files()).toEqual([]);
    expect(h.controls.writes).toHaveLength(1);
    expect(h.controls.unlinks).toEqual(h.controls.writes);
    expect(h.service.reserved()).toBe(0);
  });

  it("discards a write that completes after dispose", async () => {
    const h = await harness();
    const held = gate();
    h.controls.holdWrite.gate = held;
    const pending = h.service.preview({ ownerId: 1, ...PREVIEW });
    await held.entered;

    let disposed = false;
    const disposing = h.service.dispose().then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);
    held.open();

    await disposing;
    expect((await rejection(pending)).code).toBe("cancelled");
    expect(h.files()).toEqual([]);
  });

  it("A cancelled, B replaces it: A's late failure leaves B tracked", async () => {
    const parseA = gate<ImportedTranscript>();
    const parseB = gate<ImportedTranscript>();
    const queue = [parseA, parseB];
    const h = await harness({
      parse: () => {
        const next = queue.shift()!;
        next.enter();
        return next.wait;
      },
    });

    const a = h.service.preview({ ownerId: 1, ...PREVIEW });
    await parseA.entered; // A is genuinely inside its parse
    // Addressed by window: `cancel(handle, owner)` targets a published
    // capability and would not touch an unpublished request.
    expect(h.service.cancelPending(1)).toBe(true);

    const b = h.service.preview({ ownerId: 1, ...PREVIEW });
    await parseB.entered; // B has taken the slot A gave up

    // A answers late. Its cleanup must not evict B's slot.
    parseA.open(snapshot({ nativeId: "ses_A" }));
    expect((await rejection(a)).code).toBe("cancelled");

    parseB.open(snapshot({ nativeId: "ses_B" }));
    const published = await b;
    expect(published.nativeId).toBe("ses_B");
    expect(h.service.get(published.handle, 1).nativeId).toBe("ses_B");
    expect(h.files()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// finding 4: the old preview goes at the start of the new one
// ---------------------------------------------------------------------------

describe("one retained preview per window", () => {
  it("revokes the old preview when the new parse starts, not when it finishes", async () => {
    const parseGate = gate<ImportedTranscript>();
    let first = true;
    const h = await harness({
      parse: () => {
        if (first) {
          first = false;
          return Promise.resolve(snapshot({ nativeId: "ses_first" }));
        }
        parseGate.enter();
        return parseGate.wait;
      },
    });

    const old = await h.service.preview({ ownerId: 1, ...PREVIEW });
    expect(h.service.get(old.handle, 1).nativeId).toBe("ses_first");

    const second = h.service.preview({ ownerId: 1, ...PREVIEW });
    await parseGate.entered;
    // The new source is still parsing, and the old handle is already dead.
    expect(thrown(() => h.service.get(old.handle, 1)).code).toBe("unknown-handle");
    expect(
      (await rejection(h.service.consume(old.handle, 1, () => "no"))).code,
    ).toBe("unknown-handle");

    parseGate.open(snapshot({ nativeId: "ses_second" }));
    const published = await second;
    expect(published.nativeId).toBe("ses_second");
    expect(h.files()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// ownership and expiry
// ---------------------------------------------------------------------------

describe("ownership", () => {
  it("refuses another window's handle and says nothing about existence", async () => {
    const h = await harness();
    const preview = await h.service.preview({ ownerId: 1, ...PREVIEW });
    const foreign = thrown(() => h.service.get(preview.handle, 2));
    const missing = thrown(() => h.service.get("f".repeat(32), 2));

    expect(foreign.code).toBe("not-your-handle");
    expect(missing.code).toBe("unknown-handle");
    expect(foreign.message).toBe(missing.message);
    expect(h.service.get(preview.handle, 1).handle).toBe(preview.handle);
  });

  it("does not let one window cancel or consume another's preview", async () => {
    const h = await harness();
    const preview = await h.service.preview({ ownerId: 1, ...PREVIEW });
    await h.service.cancel(preview.handle, 2);
    expect(h.service.get(preview.handle, 1).handle).toBe(preview.handle);
    expect((await rejection(h.service.consume(preview.handle, 2, () => "no"))).code).toBe(
      "not-your-handle",
    );
    expect(h.files()).toHaveLength(1);
  });

  it("releaseWindow drops only that window's preview", async () => {
    const h = await harness();
    const mine = await h.service.preview({ ownerId: 1, ...PREVIEW });
    const theirs = await h.service.preview({ ownerId: 2, ...PREVIEW });
    await h.service.releaseWindow(1);
    expect(thrown(() => h.service.get(mine.handle, 1)).code).toBe("unknown-handle");
    expect(h.service.get(theirs.handle, 2).handle).toBe(theirs.handle);
    expect(h.files()).toHaveLength(1);
  });
});

describe("expiry", () => {
  it("reports expiry rather than pretending the handle never existed", async () => {
    const h = await harness({ ttlMs: 1000 });
    const preview = await h.service.preview({ ownerId: 1, ...PREVIEW });

    h.clock.value += 999;
    expect(h.service.get(preview.handle, 1).handle).toBe(preview.handle);
    h.clock.value += 1;
    expect(thrown(() => h.service.get(preview.handle, 1)).code).toBe("expired");
    // Both the unlink and the quota release happen on the discard's own
    // continuation, so poll rather than asserting on the next microtask.
    await vi.waitFor(() => {
      expect(h.files()).toEqual([]);
      expect(h.service.reserved()).toBe(0);
    });
  });

  it("re-checks the TTL after the read, before the commit callback", async () => {
    const h = await harness({ ttlMs: 1000 });
    const preview = await h.service.preview({ ownerId: 1, ...PREVIEW });
    const held = gate();
    h.controls.holdRead.gate = held;

    const commit = vi.fn();
    const pending = h.service.consume(preview.handle, 1, commit);
    await held.entered;
    // The preview expires while the snapshot read is in flight.
    h.clock.value += 5000;
    held.open();

    expect((await rejection(pending)).code).toBe("cancelled");
    expect(commit).not.toHaveBeenCalled();
    expect(h.files()).toEqual([]);
    expect(h.service.reserved()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// finding 5: consume stays owned across its awaits
// ---------------------------------------------------------------------------

describe("consume", () => {
  it("hands over the staged snapshot with its recorded destination", async () => {
    const h = await harness();
    const preview = await h.service.preview({
      ownerId: 1,
      sourcePath: "C:/a",
      destinationProjectId: "proj-2",
    });

    const seen: { destinationProjectId: string; transcript: ImportedTranscript }[] = [];
    const result = await h.service.consume(preview.handle, 1, (staged) => {
      seen.push(staged);
      return staged.transcript.entries.length;
    });

    expect(result).toBe(2);
    // The destination came from the preview record; `consume` has no argument
    // that could have changed it.
    expect(seen[0]!.destinationProjectId).toBe("proj-2");
    expect(seen[0]!.transcript.entries[0]).toMatchObject({ text: "PROSE-USER-9f3a" });
    expect(h.files()).toEqual([]);
    expect(h.service.reserved()).toBe(0);
  });

  it("revokes the handle before the callback runs", async () => {
    const h = await harness();
    const preview = await h.service.preview({ ownerId: 1, ...PREVIEW });
    const seen: ImportStagingError[] = [];
    await h.service.consume(preview.handle, 1, () => {
      seen.push(thrown(() => h.service.get(preview.handle, 1)));
      return "done";
    });
    expect(seen[0]!.code).toBe("unknown-handle");
  });

  it("runs the callback once when two consumes race", async () => {
    const h = await harness();
    const preview = await h.service.preview({ ownerId: 1, ...PREVIEW });
    const held = gate();
    h.controls.holdRead.gate = held;

    let calls = 0;
    const commit = (): string => {
      calls += 1;
      return "committed";
    };
    const first = h.service.consume(preview.handle, 1, commit);
    const second = h.service.consume(preview.handle, 1, commit);
    held.open();

    const results = await Promise.allSettled([first, second]);
    expect(calls).toBe(1);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as ImportStagingError).code).toBe("unknown-handle");
    expect(h.files()).toEqual([]);
  });

  it("does not start the callback when the window is released during validation", async () => {
    const h = await harness();
    const preview = await h.service.preview({ ownerId: 1, ...PREVIEW });
    const held = gate();
    h.controls.holdProject.gate = held;

    const commit = vi.fn();
    const pending = h.service.consume(preview.handle, 1, commit);
    await held.entered;
    await h.service.releaseWindow(1);
    held.open();

    expect((await rejection(pending)).code).toBe("cancelled");
    expect(commit).not.toHaveBeenCalled();
    expect(h.files()).toEqual([]);
    expect(h.service.reserved()).toBe(0);
  });

  it("does not start the callback when the service is disposed during the read", async () => {
    const h = await harness();
    const preview = await h.service.preview({ ownerId: 1, ...PREVIEW });
    const held = gate();
    h.controls.holdRead.gate = held;

    const commit = vi.fn();
    const pending = h.service.consume(preview.handle, 1, commit);
    await held.entered;
    let disposed = false;
    const disposing = h.service.dispose().then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);
    held.open();

    await disposing;
    expect((await rejection(pending)).code).toBe("cancelled");
    expect(commit).not.toHaveBeenCalled();
    expect(h.files()).toEqual([]);
  });

  it("waits for a commit already in progress before completing dispose", async () => {
    const h = await harness();
    const preview = await h.service.preview({ ownerId: 1, ...PREVIEW });
    const held = gate<string>();
    const pending = h.service.consume(preview.handle, 1, () => {
      held.enter();
      return held.wait;
    });
    await held.entered;

    let disposed = false;
    const disposing = h.service.dispose().then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);
    held.open("committed");

    expect(await pending).toBe("committed");
    await disposing;
    expect(h.files()).toEqual([]);
    expect(h.service.outstanding()).toBe(0);
  });

  it("refuses when the destination disappeared between preview and commit", async () => {
    const h = await harness();
    const preview = await h.service.preview({
      ownerId: 1,
      sourcePath: "C:/a",
      destinationProjectId: "proj-2",
    });
    h.projects.delete("proj-2");
    const commit = vi.fn();
    expect((await rejection(h.service.consume(preview.handle, 1, commit))).code).toBe(
      "unknown-project",
    );
    expect(commit).not.toHaveBeenCalled();
    expect(h.files()).toEqual([]);
  });

  it("cleans up and propagates when the commit callback throws", async () => {
    const h = await harness();
    const preview = await h.service.preview({ ownerId: 1, ...PREVIEW });
    await expect(
      h.service.consume(preview.handle, 1, () => {
        throw new Error("transaction rolled back");
      }),
    ).rejects.toThrow(/transaction rolled back/);
    expect(h.files()).toEqual([]);
    expect(h.service.reserved()).toBe(0);
    expect(thrown(() => h.service.get(preview.handle, 1)).code).toBe("unknown-handle");
  });

  it("reports a read failure as a service error, not the filesystem's", async () => {
    const h = await harness({
      fs: (real) => ({
        ...real,
        readFile: async () => {
          const err = new Error("EACCES: permission denied, open 'C:/staging/secret.json'");
          (err as { code?: string }).code = "EACCES";
          throw err;
        },
      }),
    });
    const preview = await h.service.preview({ ownerId: 1, ...PREVIEW });
    const error = await rejection(h.service.consume(preview.handle, 1, () => "no"));
    expect(error.code).toBe("staging-failed");
    expect(error.message).not.toContain("EACCES");
    expect(error.message).not.toContain("secret.json");
    expect(h.files()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// finding 6: exclusive creation, own files only
// ---------------------------------------------------------------------------

describe("filesystem exclusivity", () => {
  it("never replaces an existing file at the snapshot's name", async () => {
    const handle = "9".repeat(32);
    const h = await harness({ tag: "exclusive" });
    const occupied = path.join(h.dir, `import-${handle}.snapshot.json`);
    fs.writeFileSync(occupied, "PRE-EXISTING");

    // Force the service onto that exact name.
    const service = new ImportStagingService({
      directory: h.dir,
      parse: async () => snapshot(),
      projectExists: () => true,
      log: h.log,
      newHandle: () => handle,
    });
    await service.initialize();
    // initialize() removed it as an abandoned snapshot; put it back to test
    // the write path itself rather than the cleanup path.
    fs.writeFileSync(occupied, "PRE-EXISTING");

    const error = await rejection(service.preview({ ownerId: 1, ...PREVIEW }));
    expect(error.code).toBe("staging-failed");
    // The pre-existing file is untouched: `wx` failed instead of truncating.
    expect(fs.readFileSync(occupied, "utf8")).toBe("PRE-EXISTING");
  });

  it("does not unlink a file it failed to create", async () => {
    const handle = "8".repeat(32);
    const dir = tempDir("noclobber");
    const victim = path.join(dir, `import-${handle}.snapshot.json`);
    const unlinks: string[] = [];
    const service = new ImportStagingService({
      directory: dir,
      parse: async () => snapshot(),
      projectExists: () => true,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      newHandle: () => handle,
      fs: {
        ...nodeStagingFs,
        unlink: async (file) => {
          unlinks.push(path.basename(file));
          await nodeStagingFs.unlink(file);
        },
      },
    });
    await service.initialize();
    fs.writeFileSync(victim, "SOMEONE ELSE'S");

    await rejection(service.preview({ ownerId: 1, ...PREVIEW }));
    expect(unlinks).toEqual([]);
    expect(fs.readFileSync(victim, "utf8")).toBe("SOMEONE ELSE'S");
  });
});

// ---------------------------------------------------------------------------
// finding 8: nothing external reaches the renderer or the log
// ---------------------------------------------------------------------------

describe("error and log hygiene", () => {
  it("passes through an allowlisted parser code and logs only the code", async () => {
    const h = await harness({
      parse: async () => {
        throw new ImportError(
          "invalid-json",
          "line 42 of C:/secret/path.jsonl: bad token near 'sk-live-abc'",
          42,
        );
      },
    });
    const error = await rejection(h.service.preview({ ownerId: 1, ...PREVIEW }));
    expect(error.code).toBe("parse-failed");
    expect(error.parseCode).toBe("invalid-json");
    expect(error.message).not.toContain("sk-live-abc");

    const logged = h.logged();
    expect(logged).toContain("code=invalid-json");
    // The parser's own text never reaches the main-process log either.
    expect(logged).not.toContain("sk-live-abc");
    expect(logged).not.toContain("C:/secret/path.jsonl");
  });

  it("refuses to forward a code from a foreign error object", async () => {
    const h = await harness({
      parse: async () => {
        const err = new Error("boom near 'sk-live-abc'");
        (err as { code?: string }).code = "arbitrary-attacker-code";
        throw err;
      },
    });
    const error = await rejection(h.service.preview({ ownerId: 1, ...PREVIEW }));
    expect(error.parseCode).toBeUndefined();
    expect(h.logged()).toContain("code=unknown");
    expect(h.logged()).not.toContain("arbitrary-attacker-code");
    expect(h.logged()).not.toContain("sk-live-abc");
  });

  it("refuses to forward an unallowlisted ImportError code", async () => {
    const h = await harness({
      parse: async () => {
        const err = new ImportError("invalid-json", "x");
        (err as { code: string }).code = "made-up";
        throw err;
      },
    });
    expect((await rejection(h.service.preview({ ownerId: 1, ...PREVIEW }))).parseCode).toBeUndefined();
  });

  it("never puts the staging location into an error or a log line", async () => {
    const h = await harness({
      fs: (real) => ({
        ...real,
        createExclusive: async () => {
          const err = new Error(`ENOSPC: no space left on device, open '${"X".repeat(8)}'`);
          (err as { code?: string }).code = "ENOSPC";
          throw err;
        },
      }),
    });
    const error = await rejection(h.service.preview({ ownerId: 1, ...PREVIEW }));
    expect(error.code).toBe("staging-failed");
    expect(error.message).not.toContain(h.dir);
    expect(error.message).not.toContain("ENOSPC");
    // The log may name the OS code, and nothing else from the error.
    expect(h.logged()).toContain("ENOSPC");
    expect(h.logged()).not.toContain(h.dir);
    expect(h.logged()).not.toContain("no space left on device");
  });
});

// ---------------------------------------------------------------------------
// snapshot immutability and teardown
// ---------------------------------------------------------------------------

describe("snapshot immutability", () => {
  it("commits what was previewed, and never reopens the source", async () => {
    let answer = snapshot({ title: "as previewed", nativeId: "ses_original" });
    const parse = vi.fn(async () => answer);
    const h = await harness({ parse: parse as unknown as ParseTranscript });
    const preview = await h.service.preview({ ownerId: 1, ...PREVIEW });
    expect(preview.title).toBe("as previewed");

    answer = snapshot({ title: "changed on disk", nativeId: "ses_other" });
    const staged = await h.service.consume(preview.handle, 1, (s) => s.transcript);

    expect(staged.title).toBe("as previewed");
    expect(staged.nativeId).toBe("ses_original");
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("keeps the parser's own hash of the selected bytes", async () => {
    const h = await harness({ parse: async () => snapshot({ sourceSha256: "b".repeat(64) }) });
    const preview = await h.service.preview({ ownerId: 1, ...PREVIEW });
    expect(preview.sourceSha256).toBe("b".repeat(64));
    expect((await h.service.consume(preview.handle, 1, (s) => s.transcript)).sourceSha256).toBe(
      "b".repeat(64),
    );
  });
});

describe("teardown", () => {
  it("dispose clears every window and refuses further work", async () => {
    const h = await harness();
    await h.service.preview({ ownerId: 1, ...PREVIEW });
    await h.service.preview({ ownerId: 2, ...PREVIEW });
    await h.service.dispose();

    expect(h.files()).toEqual([]);
    expect(h.service.reserved()).toBe(0);
    expect((await rejection(h.service.preview({ ownerId: 1, ...PREVIEW }))).code).toBe("cancelled");
  });

  it("hands out opaque unique handles that say nothing about the source", async () => {
    const h = await harness({ maxConcurrent: 10 });
    const handles = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const preview = await h.service.preview({ ownerId: i, ...PREVIEW });
      expect(preview.handle).toMatch(/^[0-9a-f]{32}$/);
      expect(preview.handle).not.toContain("transcript");
      handles.add(preview.handle);
    }
    expect(handles.size).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// finding 1: a partial write is owned; an EEXIST is not
// ---------------------------------------------------------------------------

describe("partial write ownership", () => {
  it("cleans up a file it created when the write itself fails", async () => {
    const unlinks: string[] = [];
    const h = await harness({
      fs: (real) => ({
        ...real,
        // Creates the file for real, then fails — exactly the case a create
        // seam that rejects before creating anything would never reach.
        createExclusive: async (file, _body, onCreated) => {
          await nodeStagingFs.createExclusive(file, Buffer.from("PARTIAL"), onCreated);
          const err = new Error("EIO: write failed");
          (err as { code?: string }).code = "EIO";
          throw err;
        },
        unlink: async (file) => {
          unlinks.push(path.basename(file));
          await nodeStagingFs.unlink(file);
        },
      }),
    });

    const error = await rejection(h.service.preview({ ownerId: 1, ...PREVIEW }));
    expect(error.code).toBe("staging-failed");
    // The partial file is owned and removed; no leak, and the budget is back.
    expect(unlinks).toHaveLength(1);
    expect(h.files()).toEqual([]);
    expect(h.service.reserved()).toBe(0);
    expect(h.service.outstanding()).toBe(0);
  });

  it("never unlinks a path whose exclusive create failed", async () => {
    const handle = "8".repeat(32);
    const dir = tempDir("eexist");
    const victim = path.join(dir, `import-${handle}.snapshot.json`);
    const unlinks: string[] = [];
    const service = new ImportStagingService({
      directory: dir,
      parse: async () => snapshot(),
      projectExists: () => true,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      newHandle: () => handle,
      maxSnapshotBytes: 8_000,
      maxStagedBytes: 200_000,
      fs: {
        ...nodeStagingFs,
        unlink: async (file) => {
          unlinks.push(path.basename(file));
          await nodeStagingFs.unlink(file);
        },
      },
    });
    await service.initialize();
    fs.writeFileSync(victim, "SOMEONE ELSE'S");

    expect((await rejection(service.preview({ ownerId: 1, ...PREVIEW }))).code).toBe(
      "staging-failed",
    );
    expect(unlinks).toEqual([]);
    expect(fs.readFileSync(victim, "utf8")).toBe("SOMEONE ELSE'S");
  });
});

// ---------------------------------------------------------------------------
// finding 2: a claim outlives a failed deletion
// ---------------------------------------------------------------------------

describe("pending deletion accounting", () => {
  it("keeps the budget and the operation while the file is still on disk", async () => {
    let failUnlink = true;
    const h = await harness({
      fs: (real) => ({
        ...real,
        unlink: async (file) => {
          if (failUnlink) {
            const err = new Error("EBUSY: file is locked");
            (err as { code?: string }).code = "EBUSY";
            throw err;
          }
          await real.unlink(file);
        },
      }),
    });
    const preview = await h.service.preview({ ownerId: 1, ...PREVIEW });
    const held = h.service.reserved();
    expect(held).toBeGreaterThan(0);

    await h.service.cancel(preview.handle, 1);
    // Deletion failed, so nothing is released: the bytes are still there.
    expect(h.service.orphaned()).toBe(1);
    expect(h.service.outstanding()).toBe(1);
    expect(h.service.reserved()).toBe(held);
    expect(h.files()).toHaveLength(1);
    // The capability is gone even though the file is not.
    expect(thrown(() => h.service.get(preview.handle, 1)).code).toBe("unknown-handle");

    // A later attempt succeeds and only then is everything released. The
    // retry happens on the next request, so a transient lock does not strand
    // the budget until the window closes.
    failUnlink = false;
    await h.service.preview({ ownerId: 2, ...PREVIEW });
    expect(h.service.orphaned()).toBe(0);
    expect(fs.readdirSync(h.dir)).toHaveLength(1); // only window 2's snapshot

    await h.service.releaseWindow(2);
    await vi.waitFor(() => {
      expect(h.service.reserved()).toBe(0);
      expect(h.files()).toEqual([]);
    });
  });

  it("frees the handle after a successful consume so it can be reissued", async () => {
    const handles = ["a".repeat(32), "b".repeat(32), "a".repeat(32)];
    let index = 0;
    const dir = tempDir("reissue");
    const service = new ImportStagingService({
      directory: dir,
      parse: async () => snapshot(),
      projectExists: () => true,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      newHandle: () => handles[index++]!,
      maxSnapshotBytes: 8_000,
      maxStagedBytes: 200_000,
    });
    await service.initialize();

    const first = await service.preview({ ownerId: 1, ...PREVIEW });
    await service.consume(first.handle, 1, () => "ok");
    // A consumed operation released its handle, so the generator may hand the
    // same value out again without colliding.
    await service.preview({ ownerId: 2, ...PREVIEW });
    const third = await service.preview({ ownerId: 3, ...PREVIEW });
    expect(third.handle).toBe("a".repeat(32));
  });
});

// ---------------------------------------------------------------------------
// finding 5 + 6: cancelled work still counts; replacement still works
// ---------------------------------------------------------------------------

describe("concurrency accounting", () => {
  it("still counts a cancelled parse that has not returned", async () => {
    const parseGate = gate<ImportedTranscript>();
    const h = await harness({
      maxConcurrent: 1,
      parse: () => {
        parseGate.enter();
        return parseGate.wait;
      },
    });

    const first = h.service.preview({ ownerId: 1, ...PREVIEW });
    await parseGate.entered;
    expect(h.service.cancelPending(1)).toBe(true);

    // The parse is still running, so the slot is still taken: cancel-and-retry
    // cannot be used to exceed the cap.
    expect((await rejection(h.service.preview({ ownerId: 1, ...PREVIEW }))).code).toBe(
      "too-many-previews",
    );
    expect(h.service.outstanding()).toBe(1);

    parseGate.open(snapshot());
    expect((await rejection(first)).code).toBe("cancelled");
    await vi.waitFor(() => expect(h.service.outstanding()).toBe(0));
    // Once it has actually settled, the slot is available again.
    await h.service.preview({ ownerId: 1, ...PREVIEW });
  });

  it("replaces a window's own preview even at the concurrency ceiling", async () => {
    const h = await harness({ maxConcurrent: 1 });
    const old = await h.service.preview({ ownerId: 1, ...PREVIEW });
    // The replaced preview is not counted against its own replacement.
    const next = await h.service.preview({ ownerId: 1, ...PREVIEW });

    expect(next.handle).not.toBe(old.handle);
    expect(thrown(() => h.service.get(old.handle, 1)).code).toBe("unknown-handle");
    expect(h.service.size()).toBe(1);
    expect(h.files()).toHaveLength(1);
  });

  it("replaces a window's own preview even at the byte ceiling", async () => {
    // Exactly one worst-case reservation fits.
    const h = await harness({ maxSnapshotBytes: 4_000, maxStagedBytes: 4_000 });
    const old = await h.service.preview({ ownerId: 1, ...PREVIEW });
    const next = await h.service.preview({ ownerId: 1, ...PREVIEW });
    expect(next.handle).not.toBe(old.handle);
    expect(h.files()).toHaveLength(1);
  });

  it("does not let a replacement steal another window's slot", async () => {
    const h = await harness({ maxConcurrent: 1 });
    await h.service.preview({ ownerId: 1, ...PREVIEW });
    expect((await rejection(h.service.preview({ ownerId: 2, ...PREVIEW }))).code).toBe(
      "too-many-previews",
    );
  });
});

// ---------------------------------------------------------------------------
// finding 8: cancellation targets exactly one capability
// ---------------------------------------------------------------------------

describe("cancellation is capability-exact", () => {
  it("an unknown handle cancels nothing, including a newer pending preview", async () => {
    const parseGate = gate<ImportedTranscript>();
    const h = await harness({
      parse: () => {
        parseGate.enter();
        return parseGate.wait;
      },
    });

    const pending = h.service.preview({ ownerId: 1, ...PREVIEW });
    await parseGate.entered;
    // A stale renderer message about a handle this window no longer has.
    await h.service.cancel("c".repeat(32), 1);

    parseGate.open(snapshot({ nativeId: "ses_survivor" }));
    const preview = await pending;
    expect(preview.nativeId).toBe("ses_survivor");
    expect(h.service.get(preview.handle, 1).handle).toBe(preview.handle);
  });

  it("cancelPending reports whether there was anything to cancel", async () => {
    const h = await harness();
    expect(h.service.cancelPending(1)).toBe(false);
    const preview = await h.service.preview({ ownerId: 1, ...PREVIEW });
    // A published preview is not a pending request.
    expect(h.service.cancelPending(1)).toBe(false);
    expect(h.service.get(preview.handle, 1).handle).toBe(preview.handle);
  });
});

// ---------------------------------------------------------------------------
// finding 4: initialization is reserved before its first await
// ---------------------------------------------------------------------------

describe("initialization", () => {
  it("refuses a second concurrent initialize", async () => {
    const listGate = gate<void>();
    const dir = tempDir("init-race");
    const service = new ImportStagingService({
      directory: dir,
      parse: async () => snapshot(),
      projectExists: () => true,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      fs: {
        ...nodeStagingFs,
        listDir: async (d) => {
          listGate.enter();
          await listGate.wait;
          return nodeStagingFs.listDir(d);
        },
      },
    });

    const first = service.initialize();
    await listGate.entered;
    // The second call must not enter cleanup, and must not mark the service
    // usable while the first is still deleting.
    expect((await rejection(service.initialize())).code).toBe("invalid-option");
    expect((await rejection(service.preview({ ownerId: 1, ...PREVIEW }))).code).toBe(
      "not-initialized",
    );

    listGate.open();
    await first;
  });

  it("does not become usable when disposed during initialization", async () => {
    const listGate = gate<void>();
    const dir = tempDir("init-dispose");
    const service = new ImportStagingService({
      directory: dir,
      parse: async () => snapshot(),
      projectExists: () => true,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      fs: {
        ...nodeStagingFs,
        listDir: async (d) => {
          listGate.enter();
          await listGate.wait;
          return nodeStagingFs.listDir(d);
        },
      },
    });

    const pending = service.initialize();
    await listGate.entered;
    await service.dispose();
    listGate.open();

    expect((await rejection(pending)).code).toBe("cancelled");
    expect((await rejection(service.preview({ ownerId: 1, ...PREVIEW }))).code).toBe("cancelled");
  });

  it("refuses to become usable when an owned file cannot be removed", async () => {
    const dir = tempDir("init-locked");
    fs.writeFileSync(path.join(dir, `import-${"7".repeat(32)}.snapshot.json`), "{}");
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const service = new ImportStagingService({
      directory: dir,
      parse: async () => snapshot(),
      projectExists: () => true,
      log,
      fs: {
        ...nodeStagingFs,
        unlink: async () => {
          const err = new Error("EPERM: operation not permitted");
          (err as { code?: string }).code = "EPERM";
          throw err;
        },
      },
    });

    // Bytes outside any reservation would make the quota untrue, so the
    // service stays unusable rather than admitting previews.
    expect((await rejection(service.initialize())).code).toBe("staging-failed");
    expect((await rejection(service.preview({ ownerId: 1, ...PREVIEW }))).code).toBe(
      "not-initialized",
    );
    const logged = log.warn.mock.calls.flat().map(String).join("\n");
    expect(logged).toContain("EPERM");
    expect(logged).not.toContain("operation not permitted");
  });

  it("reports a directory-creation failure without naming the path", async () => {
    const dir = path.join(tempDir("init-mkdir"), "child");
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const service = new ImportStagingService({
      directory: dir,
      parse: async () => snapshot(),
      projectExists: () => true,
      log,
      fs: {
        ...nodeStagingFs,
        ensureDir: async () => {
          const err = new Error(`EACCES: permission denied, mkdir '${dir}'`);
          (err as { code?: string }).code = "EACCES";
          throw err;
        },
      },
    });

    const error = await rejection(service.initialize());
    expect(error.code).toBe("staging-failed");
    expect(error.message).not.toContain(dir);
    expect(log.warn.mock.calls.flat().map(String).join("\n")).not.toContain(dir);
  });
});

describe("request ownership during staging maintenance", () => {
  it("does not adopt a released window's new generation after the initial maintenance await", async () => {
    const h = await harness();
    const pending = h.service.preview({ ownerId: 1, sourcePath: "C:/picked/a.jsonl", destinationProjectId: "proj-1" });
    const outcome = pending.then(() => "published", (error: ImportStagingError) => error.code);
    await h.service.releaseWindow(1);
    expect(await outcome).toBe("cancelled");
    expect(h.service.size()).toBe(0);
    expect(h.files()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// requests waiting inside maintenance are owned, cancellable and accounted for
// ---------------------------------------------------------------------------

/** Leave one orphaned operation behind, so the next request's maintenance
 *  has a deletion to retry — and can be suspended in it. */
async function withOrphan(h: Harness): Promise<void> {
  // Three attempts, so the retry loop exhausts and parks the operation.
  h.controls.failUnlinks.count = 3;
  const preview = await h.service.preview({ ownerId: 99, ...PREVIEW });
  await h.service.cancel(preview.handle, 99);
  expect(h.service.orphaned()).toBe(1);
  h.controls.unlinks.length = 0;
}

describe("a request suspended in maintenance", () => {
  it("is cancelled by releaseWindow and leaves nothing behind", async () => {
    const h = await harness();
    await withOrphan(h);

    const held = gate();
    h.controls.holdUnlink.gate = held; // suspend the orphan retry inside maintain()
    const pending = h.service.preview({ ownerId: 1, ...PREVIEW });
    const outcome = pending.then(
      () => "published",
      (error: ImportStagingError) => error.code,
    );
    await held.entered;

    await h.service.releaseWindow(1);
    held.open();

    expect(await outcome).toBe("cancelled");
    expect(h.service.size()).toBe(0);
    // The cancelled request left no snapshot of its own; only the orphan's
    // file, now retried, is accounted for.
    expect(h.files()).toEqual([]);
    await vi.waitFor(() => expect(h.service.outstanding()).toBe(0));
  });

  it("is cancelled by cancelPending, which can find it while it waits", async () => {
    const h = await harness();
    await withOrphan(h);

    const held = gate();
    h.controls.holdUnlink.gate = held;
    const pending = h.service.preview({ ownerId: 1, ...PREVIEW });
    const outcome = pending.then(
      () => "published",
      (error: ImportStagingError) => error.code,
    );
    await held.entered;

    // The request is registered before the first await, so it is addressable.
    expect(h.service.cancelPending(1)).toBe(true);
    held.open();

    expect(await outcome).toBe("cancelled");
    expect(h.files()).toEqual([]);
  });

  it("holds its window's slot: a second request from it is refused as busy", async () => {
    const h = await harness();
    await withOrphan(h);

    const held = gate();
    h.controls.holdUnlink.gate = held;
    const first = h.service.preview({ ownerId: 1, ...PREVIEW });
    await held.entered;

    expect((await rejection(h.service.preview({ ownerId: 1, ...PREVIEW }))).code).toBe("busy");

    held.open();
    await first;
  });

  it("counts against the concurrency cap while it waits", async () => {
    // Room for the orphan plus the waiting request, and nothing more — the
    // orphan is itself an unsettled operation and counts too.
    const h = await harness({ maxConcurrent: 2 });
    await withOrphan(h);

    const held = gate();
    h.controls.holdUnlink.gate = held;
    const first = h.service.preview({ ownerId: 1, ...PREVIEW });
    await held.entered;

    // Another window must not slip past the cap during the wait.
    expect((await rejection(h.service.preview({ ownerId: 2, ...PREVIEW }))).code).toBe(
      "too-many-previews",
    );

    held.open();
    await first;
  });

  it("keeps the generation it was created with, not the one it wakes into", async () => {
    const h = await harness();
    await withOrphan(h);

    const held = gate();
    h.controls.holdUnlink.gate = held;
    const pending = h.service.preview({ ownerId: 1, ...PREVIEW });
    const outcome = pending.then(
      () => "published",
      (error: ImportStagingError) => error.code,
    );
    await held.entered;

    // Two releases: the request must compare against the generation it
    // captured, not whatever the window has reached by the time it resumes.
    await h.service.releaseWindow(1);
    await h.service.releaseWindow(1);
    held.open();

    expect(await outcome).toBe("cancelled");
    expect(h.service.size()).toBe(0);
  });
});

describe("cleanup when admission is full", () => {
  it("retries stranded deletion even when the orphan occupies the last slot", async () => {
    const h = await harness({ maxConcurrent: 1 });
    await withOrphan(h);
    await expect(h.service.preview({ ownerId: 1, ...PREVIEW })).rejects.toMatchObject({ code: "too-many-previews" });
    expect(h.service.orphaned()).toBe(0);
    expect(h.service.reserved()).toBe(0);
    const retry = await h.service.preview({ ownerId: 1, ...PREVIEW });
    expect(h.service.get(retry.handle, 1)).toEqual(retry);
    await h.service.releaseWindow(1);
  });
});

describe("worker-produced staged files", () => {
  it("waits for an in-flight worker adoption to settle during dispose", async () => {
    const dir = tempDir("worker-dispose-adoption");
    const held = gate();
    let signal: AbortSignal | null = null;
    const body = JSON.stringify(snapshot());
    const stage: StageTranscript = async (_source, resultPath, options) => {
      signal = options.signal;
      fs.writeFileSync(resultPath, body, { flag: "wx" });
      options.onCreated();
      held.enter();
      await held.wait;
      return {
        resultBytes: Buffer.byteLength(body),
        summary: {
          backend: "claude", format: "claude-jsonl-v1", nativeId: "ses_synthetic",
          title: "synthetic fixture", cwd: "C:/picked", startedAt: null, endedAt: null,
          sourceBytes: 1234, sourceSha256: "a".repeat(64), counts: snapshot().counts,
          unknownTypes: [], warnings: [], complete: true,
        },
      };
    };
    const service = new ImportStagingService({
      directory: dir,
      stage,
      projectExists: () => true,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      maxSnapshotBytes: 8_000,
      maxStagedBytes: 8_000,
    });
    await service.initialize();

    const pending = service.preview({ ownerId: 1, ...PREVIEW });
    await held.entered;
    let disposed = false;
    const disposing = service.dispose().then(() => { disposed = true; });
    expect((signal as unknown as AbortSignal).aborted).toBe(true);
    await Promise.resolve();
    expect(disposed).toBe(false);
    held.open();

    expect((await rejection(pending)).code).toBe("cancelled");
    await disposing;
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(service.outstanding()).toBe(0);
  });

  it("publishes worker metadata without reading or reserializing the snapshot during preview", async () => {
    const dir = tempDir("worker-adoption");
    const sourcePath = path.join(dir, "selected.jsonl");
    const body = JSON.stringify(snapshot());
    const readFile = vi.fn(nodeStagingFs.readFile);
    const createExclusive = vi.fn(nodeStagingFs.createExclusive);
    const stage: StageTranscript = async (_source, resultPath, options) => {
      fs.writeFileSync(resultPath, body, { flag: "wx" });
      options.onCreated();
      return {
        resultBytes: Buffer.byteLength(body),
        summary: {
          backend: "claude", format: "claude-jsonl-v1", nativeId: "ses_synthetic",
          title: "synthetic fixture", cwd: "C:/picked", startedAt: "2026-09-07T00:00:00.000Z",
          endedAt: "2026-09-07T00:01:00.000Z", sourceBytes: 1234,
          sourceSha256: "a".repeat(64), counts: snapshot().counts,
          unknownTypes: snapshot().unknownTypes, warnings: snapshot().warnings, complete: false,
        },
      };
    };
    const service = new ImportStagingService({
      directory: dir,
      stage,
      projectExists: () => true,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      fs: { ...nodeStagingFs, readFile, createExclusive },
      maxSnapshotBytes: 8_000,
      maxStagedBytes: 8_000,
    });
    await service.initialize();

    const preview = await service.preview({ ownerId: 1, sourcePath, destinationProjectId: "proj-1" });
    expect(preview.nativeId).toBe("ses_synthetic");
    expect(preview.sourcePath).toBe(sourcePath);
    expect(readFile).not.toHaveBeenCalled();
    expect(createExclusive).not.toHaveBeenCalled();
    expect(service.reserved()).toBe(Buffer.byteLength(body));

    await service.consume(preview.handle, 1, ({ transcript }) => expect(transcript.entries).toHaveLength(2));
    expect(readFile).toHaveBeenCalledTimes(1);
  });
});
