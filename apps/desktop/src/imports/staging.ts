/**
 * Main-process staging for transcript-import previews
 * (docs/plans/phase7-imports.md §Staging and persistence).
 *
 *   renderer → asks for a preview of an absolute path main already has
 *            ← receives an opaque handle plus counts/warnings, never entries
 *   renderer → asks to commit that handle
 *            ← main reads its own staged snapshot and hands it to the caller
 *
 * The renderer never supplies file contents, a normalized object, an owner or
 * a destination project at commit time: everything authoritative is recorded
 * when the preview is created and read back from main's own staging file.
 *
 * ## The state machine
 *
 * Custody is one `Operation` moving through one sequence of states, rather
 * than a handful of booleans that can disagree:
 *
 *   reserved → writing → staged → consuming → deleting → settled
 *                                     ↘ deleting ↗   ↘ orphaned
 *
 * Three rules follow from it and are what the tests hold this to:
 *
 *  - **Claims are taken before the first `await` and released only at
 *    `settled`.** The byte reservation, the handle and the staging filename
 *    belong to the operation until its file is confirmed gone. A failed
 *    unlink parks it in `orphaned`, still counted and still holding its
 *    budget — freeing a claim whose bytes are still on disk is how a quota
 *    silently becomes a lie.
 *  - **Every unsettled operation counts**, whether or not anyone still wants
 *    it. A cancelled parse that ignores its abort signal is still consuming a
 *    slot, so cancel-and-retry cannot be used to exceed the concurrency cap.
 *  - **Liveness is a synchronous predicate checked immediately before the
 *    irreversible step** — publication and the commit callback. An `async`
 *    check yields between the answer and its use, which is exactly the window
 *    a release needs to slip through.
 *
 * `parse`, `fs` and the staging `directory` are injected; nothing here parses,
 * spawns, or opens a backend home. Deliberately unwired: no IPC, no database.
 */
import crypto from "node:crypto";
import nodeFs from "node:fs/promises";
import path from "node:path";
import { ImportError, type ImportedTranscript } from "@capygen/engine";
import type { EngineLogger } from "../engine/types.js";

/**
 * The one filename shape this service creates and may delete. There is no
 * temporary variant: a snapshot is created exclusively at its final name, so
 * a crash leaves a file matching exactly this pattern and nothing else.
 */
const STAGED_NAME = /^import-[0-9a-f]{32}\.snapshot\.json$/;
const stagedName = (handle: string): string => `import-${handle}.snapshot.json`;

/** Unlink attempts before an operation is parked as `orphaned`. */
const UNLINK_ATTEMPTS = 3;

export const DEFAULT_TTL_MS = 10 * 60 * 1000;
/** Unsettled operations across every window. */
export const DEFAULT_MAX_CONCURRENT = 4;
/** Ceiling on one snapshot, and on everything staged at once: admission is
 *  bounded by disk, so one maximal snapshot excludes any other. */
export const DEFAULT_MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
export const DEFAULT_MAX_STAGED_BYTES = 256 * 1024 * 1024;

/** Upper bounds on the injected options, so a caller cannot ask for the moon. */
export const OPTION_CEILINGS = {
  ttlMs: 24 * 60 * 60 * 1000,
  maxConcurrent: 64,
  maxSnapshotBytes: 4 * 1024 * 1024 * 1024,
  maxStagedBytes: 4 * 1024 * 1024 * 1024,
} as const;

/**
 * Parser refusal codes allowed to cross the boundary. An allowlist, not a
 * pass-through: an `err.code` from anywhere else is arbitrary text from an
 * external failure and must not reach the renderer.
 */
const PARSE_CODES = new Set([
  "not-a-file", "empty", "compressed", "too-large", "line-too-long",
  "too-many-records", "normalized-too-large", "invalid-utf8", "invalid-json",
  "unsupported-structure", "conflicting-identity", "unknown-format",
]);

/** OS error codes safe to name in a main-process log line. */
const SAFE_OS_CODES = new Set([
  "EACCES", "EEXIST", "EISDIR", "EMFILE", "ENFILE", "ENOENT", "ENOSPC",
  "ENOTDIR", "EPERM", "EROFS", "EBUSY", "EDQUOT", "EIO",
]);

export type ImportStagingErrorCode =
  | "not-initialized"
  | "no-staging-directory"
  | "invalid-option"
  | "unknown-handle"
  | "not-your-handle"
  | "expired"
  | "busy"
  | "too-many-previews"
  | "staging-full"
  | "snapshot-too-large"
  | "unknown-project"
  | "parse-failed"
  | "staging-failed"
  | "cancelled";

/**
 * A refusal the renderer may see. The message is written for a person and
 * carries no transcript text, no external error text, no staging path and
 * nothing from the environment. `parseCode` is an allowlisted machine token.
 */
export class ImportStagingError extends Error {
  readonly code: ImportStagingErrorCode;
  readonly parseCode?: string;

  constructor(code: ImportStagingErrorCode, message: string, parseCode?: string) {
    super(message);
    this.name = "ImportStagingError";
    this.code = code;
    if (parseCode !== undefined) this.parseCode = parseCode;
  }
}

/** Exactly what the renderer is allowed to see about a staged preview. */
export interface ImportPreview {
  handle: string;
  backend: ImportedTranscript["backend"];
  format: string;
  nativeId: string;
  title: string | null;
  sourcePath: string;
  sourceBytes: number;
  sourceSha256: string;
  cwd: string | null;
  startedAt: string | null;
  endedAt: string | null;
  destinationProjectId: string;
  counts: ImportedTranscript["counts"];
  unknownTypes: ImportedTranscript["unknownTypes"];
  warnings: ImportedTranscript["warnings"];
  complete: boolean;
  /** Epoch millis; the handle is refused at or after this instant. */
  expiresAt: number;
}

/** The parse this service is given. `signal` is best-effort: a parser that
 *  ignores it still cannot publish, because liveness is re-checked. */
export type ParseTranscript = (
  filePath: string,
  options: { signal: AbortSignal },
) => Promise<ImportedTranscript>;

/** Metadata returned by a worker after it has validated and adopted the
 * normalized snapshot at `resultPath`. It deliberately omits entries. */
export type StagedTranscriptSummary = Omit<ImportedTranscript, "entries" | "sourcePath">;

/**
 * File-producing alternative to the legacy in-process parser seam. The
 * producer must create `resultPath` exclusively and call `onCreated` at the
 * instant it takes ownership. Preview then publishes metadata without loading
 * or serializing the transcript again.
 */
export type StageTranscript = (
  sourcePath: string,
  resultPath: string,
  options: { signal: AbortSignal; onCreated: () => void },
) => Promise<{ resultBytes: number; summary: StagedTranscriptSummary }>;

export interface StagingDirEntry {
  name: string;
  isFile: boolean;
  isSymbolicLink: boolean;
}

export interface StagingFs {
  ensureDir(dir: string): Promise<void>;
  /**
   * Create the file exclusively, then write it.
   *
   * `onCreated` must be called as soon as the exclusive create succeeds and
   * **before** any write — that is the instant this service becomes the owner
   * of the path. A write or close that fails afterwards leaves a partial file
   * that must be cleaned up; a create that fails (`EEXIST`) leaves someone
   * else's file that must not be touched. One callback separates the two.
   */
  createExclusive(file: string, body: Buffer, onCreated: () => void): Promise<void>;
  readFile(file: string): Promise<string>;
  unlink(file: string): Promise<void>;
  listDir(dir: string): Promise<StagingDirEntry[]>;
}

export const nodeStagingFs: StagingFs = {
  async ensureDir(dir) {
    await nodeFs.mkdir(dir, { recursive: true });
  },
  async createExclusive(file, body, onCreated) {
    // `wx` fails when the path exists, so a snapshot never overwrites one.
    const handle = await nodeFs.open(file, "wx", 0o600);
    onCreated();
    try {
      await handle.writeFile(body);
    } finally {
      await handle.close();
    }
  },
  readFile: (file) => nodeFs.readFile(file, "utf8"),
  unlink: (file) => nodeFs.unlink(file),
  async listDir(dir) {
    const entries = await nodeFs.readdir(dir, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isSymbolicLink: entry.isSymbolicLink(),
    }));
  },
};

export interface ImportStagingDeps {
  /** The app-owned staging directory. Required, absolute, never derived. */
  directory: string;
  /** Legacy/test seam. Production supplies `stage`. Exactly one is required. */
  parse?: ParseTranscript;
  /** Worker-backed seam which adopts a validated snapshot file directly. */
  stage?: StageTranscript;
  projectExists: (projectId: string) => boolean | Promise<boolean>;
  log: EngineLogger;
  fs?: StagingFs;
  now?: () => number;
  ttlMs?: number;
  maxConcurrent?: number;
  maxSnapshotBytes?: number;
  maxStagedBytes?: number;
  newHandle?: () => string;
}

/** A byte reservation, released exactly once, only at `settled`. */
interface Reservation {
  bytes: number;
  released: boolean;
}

type OperationState =
  | "reserved"
  | "writing"
  | "staged"
  | "consuming"
  | "deleting"
  /** Cleanup failed; still counted and still holding its budget. */
  | "orphaned"
  | "settled";

interface Operation {
  ownerId: number;
  /** The window's generation when this started; a release bumps it. */
  generation: number;
  handle: string;
  file: string;
  state: OperationState;
  reservation: Reservation | null;
  controller: AbortController;
  cancelled: boolean;
  /** True once the exclusive create succeeded: the only file we may unlink. */
  fileCreated: boolean;
  settling: Promise<void> | null;
  /** Resolves after this operation's active preview/consume path has reached
   * its cleanup barrier. Shutdown awaits it before the worker is disposed. */
  completion: Promise<void>;
  complete: () => void;
  destinationProjectId: string;
  preview: ImportPreview | null;
  expiresAt: number;
}

export class ImportStagingService {
  private readonly directory: string;
  private readonly parse: ParseTranscript | null;
  private readonly stage: StageTranscript | null;
  private readonly projectExists: ImportStagingDeps["projectExists"];
  private readonly log: EngineLogger;
  private readonly fs: StagingFs;
  private readonly clock: () => number;
  private readonly ttlMs: number;
  private readonly maxConcurrent: number;
  private readonly maxSnapshotBytes: number;
  private readonly maxStagedBytes: number;
  private readonly makeHandle: () => string;

  /** Every operation that has not reached `settled`. The accounting set. */
  private readonly operations = new Set<Operation>();
  /** ownerId → its one operation that is not yet published. */
  private readonly inFlight = new Map<number, Operation>();
  /** handle → its published operation. */
  private readonly published = new Map<string, Operation>();
  /** ownerId → generation, bumped by `releaseWindow`. */
  private readonly generations = new Map<number, number>();
  private reservedBytes = 0;
  private initializing = false;
  private initialized = false;
  private disposed = false;

  constructor(deps: ImportStagingDeps) {
    if (typeof deps.directory !== "string" || deps.directory.trim() === "") {
      throw new ImportStagingError(
        "no-staging-directory",
        "the import staging service needs an explicit app-owned directory",
      );
    }
    if (!path.isAbsolute(deps.directory)) {
      throw new ImportStagingError(
        "no-staging-directory",
        "the import staging directory must be an absolute path",
      );
    }
    this.directory = deps.directory;
    if ((typeof deps.parse === "function") === (typeof deps.stage === "function")) {
      throw new ImportStagingError(
        "invalid-option",
        "the import staging service needs exactly one parser or file producer",
      );
    }
    this.parse = deps.parse ?? null;
    this.stage = deps.stage ?? null;
    this.projectExists = deps.projectExists;
    this.log = deps.log;
    this.fs = deps.fs ?? nodeStagingFs;
    this.clock = deps.now ?? Date.now;
    this.ttlMs = bounded(deps.ttlMs, DEFAULT_TTL_MS, OPTION_CEILINGS.ttlMs, "ttlMs");
    this.maxConcurrent = bounded(
      deps.maxConcurrent,
      DEFAULT_MAX_CONCURRENT,
      OPTION_CEILINGS.maxConcurrent,
      "maxConcurrent",
    );
    this.maxSnapshotBytes = bounded(
      deps.maxSnapshotBytes,
      DEFAULT_MAX_SNAPSHOT_BYTES,
      OPTION_CEILINGS.maxSnapshotBytes,
      "maxSnapshotBytes",
    );
    this.maxStagedBytes = bounded(
      deps.maxStagedBytes,
      DEFAULT_MAX_STAGED_BYTES,
      OPTION_CEILINGS.maxStagedBytes,
      "maxStagedBytes",
    );
    if (this.maxSnapshotBytes > this.maxStagedBytes) {
      throw new ImportStagingError(
        "invalid-option",
        "maxSnapshotBytes cannot exceed maxStagedBytes",
      );
    }
    this.makeHandle = deps.newHandle ?? (() => crypto.randomBytes(16).toString("hex"));
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  /**
   * Create the staging directory and remove snapshots abandoned by a previous
   * run. Initialization-only, and reserved synchronously so two concurrent
   * calls cannot both sweep — one would otherwise enable `preview` while the
   * other was still deleting.
   *
   * An owned file that cannot be removed leaves the service **uninitialized**:
   * its bytes are on disk and outside any reservation, so admitting previews
   * would make the quota untrue.
   */
  async initialize(): Promise<number> {
    if (this.disposed) throw this.shutdown();
    if (this.initialized || this.initializing) {
      throw new ImportStagingError(
        "invalid-option",
        "the import staging service is already initialized",
      );
    }
    if (this.operations.size > 0) {
      throw new ImportStagingError(
        "busy",
        "import staging cannot be initialized while operations are in flight",
      );
    }
    this.initializing = true;
    try {
      try {
        await this.fs.ensureDir(this.directory);
      } catch (err) {
        this.log.warn(`[import] staging directory could not be created (${osCode(err)})`);
        throw new ImportStagingError(
          "staging-failed",
          "the import staging area could not be prepared",
        );
      }

      let entries: StagingDirEntry[];
      try {
        entries = await this.fs.listDir(this.directory);
      } catch (err) {
        this.log.warn(`[import] staging directory could not be listed (${osCode(err)})`);
        throw new ImportStagingError(
          "staging-failed",
          "the import staging area could not be prepared",
        );
      }

      let removed = 0;
      for (const entry of entries) {
        // Only real files with a name this service creates. A symlink or a
        // directory matching the pattern is skipped, never followed.
        if (!entry.isFile || entry.isSymbolicLink) continue;
        if (!STAGED_NAME.test(entry.name)) continue;
        try {
          await this.fs.unlink(path.join(this.directory, entry.name));
          removed += 1;
        } catch (err) {
          const code = osCode(err);
          if (code === "ENOENT") continue;
          this.log.warn(`[import] abandoned snapshot could not be removed (${code})`);
          throw new ImportStagingError(
            "staging-failed",
            "the import staging area could not be prepared",
          );
        }
      }
      if (this.disposed) throw this.shutdown();
      this.initialized = true;
      if (removed > 0) this.log.info(`[import] removed ${removed} abandoned staged snapshot(s)`);
      return removed;
    } finally {
      this.initializing = false;
    }
  }

  /** Abandon everything for one window: its in-flight work and its snapshot. */
  async releaseWindow(ownerId: number): Promise<void> {
    this.generations.set(ownerId, this.generationOf(ownerId) + 1);
    const settles: Promise<void>[] = [];
    for (const op of [...this.operations]) {
      if (op.ownerId !== ownerId) continue;
      this.revoke(op);
      // An operation still inside `parse`, a write or a commit settles itself
      // when it returns; published work and earlier failed deletions are
      // settled (or retried) here.
      if (op.state === "staged" || op.state === "orphaned") settles.push(this.settle(op));
    }
    await Promise.all(settles);
  }

  /** Abandon every window. The service refuses further work afterwards. */
  async dispose(): Promise<void> {
    this.disposed = true;
    const tracked = [...this.operations];
    const settles: Promise<void>[] = [];
    for (const op of tracked) {
      this.revoke(op);
      if (op.state === "staged" || op.state === "orphaned") settles.push(this.settle(op));
    }
    // Writing and consuming operations own their files until their own
    // continuations enter settle(). Waiting only for already-staged files lets
    // main tear the worker down and close the profile while those paths are
    // still adopting, reading or committing. Their completion barriers are
    // resolved by settle after cleanup succeeds or exhausts its bounded retry.
    await Promise.all([...settles, ...tracked.map((op) => op.completion)]);
  }

  /**
   * Housekeeping run before admission: settle expired previews and retry any
   * deletion that failed earlier, so a transient lock frees its budget on the
   * next request rather than only when the window closes.
   *
   * Safe to await here because nothing has been claimed yet; the admission
   * block that follows is entirely synchronous.
   */
  private async maintain(): Promise<void> {
    const now = this.clock();
    const settles: Promise<void>[] = [];
    for (const op of [...this.operations]) {
      if (op.state === "orphaned") {
        settles.push(this.settle(op));
        continue;
      }
      if (op.state === "staged" && now >= op.expiresAt) {
        this.revoke(op);
        settles.push(this.settle(op));
      }
    }
    await Promise.all(settles);
  }

  // -------------------------------------------------------------------------
  // preview
  // -------------------------------------------------------------------------

  /**
   * Parse `sourcePath` and stage the result for `ownerId`.
   *
   * A window's previous preview is revoked here, before the parse starts, and
   * its disk is freed before this one asks for any — so replacing a preview
   * works even when the caller is already at the concurrency or byte ceiling.
   * Other windows' operations still count in full.
   */
  async preview(args: {
    ownerId: number;
    sourcePath: string;
    destinationProjectId: string;
  }): Promise<ImportPreview> {
    this.assertRunning();

    // --- synchronous admission: nothing may await before this completes ---
    //
    // The request is registered here, before *any* await — including the
    // housekeeping one below. An earlier draft ran maintenance first and only
    // then called `open()`, so a `releaseWindow` during that await bumped the
    // generation and the request adopted the *new* one, publishing a preview
    // for a window that had already closed. Capturing the generation with the
    // slot is what ties the request to the window it was made for.
    //
    // Registering first also means the wait is covered by admission: a second
    // request from the same window sees `busy`, another window's counts
    // against the concurrency cap, and `cancelPending` can find this one.
    if (this.inFlight.has(args.ownerId)) {
      throw new ImportStagingError("busy", "this window is already previewing an import");
    }
    const replacing = this.publishedOf(args.ownerId);
    // The preview being replaced is not counted against the caller: it is
    // about to be settled. Everything else unsettled is, including work that
    // was cancelled but has not finished.
    let others = 0;
    for (const op of this.operations) if (op !== replacing) others += 1;
    if (others + 1 > this.maxConcurrent) {
      // Admission is refused regardless of cleanup's result, so no request
      // can be resurrected across this await. Still retry stranded deletes:
      // otherwise an orphan occupying the last slot prevents every future
      // request from ever reaching maintenance. A subsequent retry can use
      // the released slot once cleanup succeeds.
      await this.maintain();
      throw new ImportStagingError(
        "too-many-previews",
        "too many imports are open at once; finish or cancel one first",
      );
    }
    // The capability dies now, not when the new parse finishes.
    if (replacing) this.revoke(replacing);
    const op = this.open(args.ownerId, args.destinationProjectId);
    // --- awaits begin; the operation is registered and counted throughout --

    try {
      // Housekeeping: expire stale previews and retry earlier failed
      // deletions, so a transient lock frees its budget before this request
      // asks for any. The request already owns its slot and generation.
      await this.maintain();
      if (!this.isLive(op)) throw this.cancelled();

      // Free the replaced preview's disk before asking for any.
      if (replacing) await this.settle(replacing);

      if (!this.isLive(op)) throw this.cancelled();
      if (!(await this.projectExists(args.destinationProjectId))) {
        throw new ImportStagingError("unknown-project", "the destination project no longer exists");
      }
      if (!this.isLive(op)) throw this.cancelled();

      if (!this.reserve(op, this.maxSnapshotBytes)) {
        throw new ImportStagingError(
          "staging-full",
          "there is not enough import staging space; finish or cancel another import first",
        );
      }

      let previewSource: ImportedTranscript | StagedTranscriptSummary;
      if (this.stage) {
        op.state = "writing";
        const staged = await this.runStage(op, args.sourcePath);
        if (!this.isLive(op)) throw this.cancelled();
        if (!op.fileCreated) {
          throw new ImportStagingError("staging-failed", "the import preview could not be stored");
        }
        if (!Number.isSafeInteger(staged.resultBytes) || staged.resultBytes <= 0 || staged.resultBytes > this.maxSnapshotBytes) {
          throw new ImportStagingError(
            "snapshot-too-large",
            "this transcript is too large to stage for import",
          );
        }
        this.shrink(op, staged.resultBytes);
        previewSource = staged.summary;
      } else {
        const transcript = await this.runParse(op, args.sourcePath);
        if (!this.isLive(op)) throw this.cancelled();

        const body = Buffer.from(JSON.stringify(transcript), "utf8");
        if (body.byteLength > this.maxSnapshotBytes) {
          throw new ImportStagingError(
            "snapshot-too-large",
            "this transcript is too large to stage for import",
          );
        }
        this.shrink(op, body.byteLength);

        op.state = "writing";
        try {
          // `fileCreated` flips the instant the exclusive create succeeds, so a
          // failure during the write still leaves an owned partial file to
          // clean up, while an `EEXIST` leaves nothing of ours to touch.
          await this.fs.createExclusive(op.file, body, () => {
            op.fileCreated = true;
          });
        } catch (err) {
          this.log.warn(`[import] snapshot could not be written (${osCode(err)})`);
          throw new ImportStagingError("staging-failed", "the import preview could not be stored");
        }
        previewSource = transcript;
      }

      // Synchronous from here to publication: no await may separate the
      // liveness answer from its use.
      if (!this.isLive(op)) throw this.cancelled();
      const expiresAt = this.clock() + this.ttlMs;
      const preview = toPreview(previewSource, args.sourcePath, op.handle, args.destinationProjectId, expiresAt);
      op.preview = preview;
      op.expiresAt = expiresAt;
      op.state = "staged";
      this.inFlight.delete(op.ownerId);
      this.published.set(op.handle, op);
      return preview;
    } catch (err) {
      await this.settle(op);
      throw err;
    }
  }

  /** The preview metadata again, for a re-render. Expiry is re-checked. */
  get(handle: string, ownerId: number): ImportPreview {
    this.assertRunning();
    return this.claim(handle, ownerId).preview!;
  }

  /**
   * Cancel one published preview. Targets **only** the named handle: an
   * unknown handle cancels nothing, so a stale renderer message cannot kill a
   * newer preview the window has since started.
   */
  async cancel(handle: string, ownerId: number): Promise<void> {
    this.assertRunning();
    const op = this.published.get(handle);
    if (!op || op.ownerId !== ownerId) return;
    this.revoke(op);
    await this.settle(op);
  }

  /**
   * Cancel a window's not-yet-published request. Separate from {@link cancel}
   * because it is addressed by window rather than by capability.
   */
  cancelPending(ownerId: number): boolean {
    this.assertRunning();
    const op = this.inFlight.get(ownerId);
    if (!op) return false;
    this.revoke(op);
    return true;
  }

  // -------------------------------------------------------------------------
  // consume
  // -------------------------------------------------------------------------

  /**
   * Hand the staged snapshot to `commit` exactly once.
   *
   * The handle leaves the lookup synchronously, so a second consume cannot
   * claim it, while the operation keeps its file, its handle and its byte
   * reservation until cleanup confirms the file is gone. Liveness and TTL are
   * re-checked synchronously immediately before the callback, so a window
   * closing mid-consume prevents it from starting at all.
   *
   * Once `commit` has been entered it is never abandoned: a callback that has
   * already committed cannot be un-run. `commit` is expected to be one
   * transactional unit; deduplication and rollback belong to it, not here.
   */
  async consume<T>(
    handle: string,
    ownerId: number,
    commit: (staged: {
      transcript: ImportedTranscript;
      destinationProjectId: string;
      preview: ImportPreview;
    }) => T | Promise<T>,
  ): Promise<T> {
    this.assertRunning();
    const op = this.claim(handle, ownerId);
    this.published.delete(handle);
    op.state = "consuming";

    try {
      if (!this.isLive(op)) throw this.cancelled();
      if (!(await this.projectExists(op.destinationProjectId))) {
        throw new ImportStagingError("unknown-project", "the destination project no longer exists");
      }
      if (!this.isLive(op)) throw this.cancelled();

      let transcript: ImportedTranscript;
      try {
        transcript = JSON.parse(await this.fs.readFile(op.file)) as ImportedTranscript;
      } catch (err) {
        this.log.warn(`[import] staged snapshot could not be read (${osCode(err)})`);
        throw new ImportStagingError("staging-failed", "the staged import could not be read");
      }

      // Synchronous gate: nothing may await between this and the callback.
      if (!this.isLive(op) || this.clock() >= op.expiresAt) throw this.cancelled();
      return await commit({
        transcript,
        destinationProjectId: op.destinationProjectId,
        preview: op.preview!,
      });
    } finally {
      await this.settle(op);
    }
  }

  // -------------------------------------------------------------------------
  // diagnostics
  // -------------------------------------------------------------------------

  /** Published, committable previews. */
  size(): number {
    return this.published.size;
  }

  /** Operations that have not reached `settled`, including orphans. */
  outstanding(): number {
    return this.operations.size;
  }

  /** Bytes reserved across every unsettled operation. */
  reserved(): number {
    return this.reservedBytes;
  }

  /** Operations whose staging file could not be deleted. */
  orphaned(): number {
    let count = 0;
    for (const op of this.operations) if (op.state === "orphaned") count += 1;
    return count;
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private assertRunning(): void {
    if (this.disposed) throw this.shutdown();
    if (!this.initialized) {
      throw new ImportStagingError(
        "not-initialized",
        "the import staging service has not been initialized",
      );
    }
  }

  private shutdown(): ImportStagingError {
    return new ImportStagingError("cancelled", "the import staging service has been shut down");
  }

  private cancelled(): ImportStagingError {
    return new ImportStagingError("cancelled", "the import preview was cancelled");
  }

  private generationOf(ownerId: number): number {
    return this.generations.get(ownerId) ?? 0;
  }

  private publishedOf(ownerId: number): Operation | null {
    for (const op of this.published.values()) if (op.ownerId === ownerId) return op;
    return null;
  }

  private open(ownerId: number, destinationProjectId: string): Operation {
    const handle = this.newHandle();
    let complete!: () => void;
    const completion = new Promise<void>((resolve) => { complete = resolve; });
    const op: Operation = {
      ownerId,
      generation: this.generationOf(ownerId),
      handle,
      file: path.join(this.directory, stagedName(handle)),
      state: "reserved",
      reservation: null,
      controller: new AbortController(),
      cancelled: false,
      fileCreated: false,
      settling: null,
      completion,
      complete,
      destinationProjectId,
      preview: null,
      expiresAt: Number.POSITIVE_INFINITY,
    };
    this.operations.add(op);
    this.inFlight.set(ownerId, op);
    return op;
  }

  /**
   * Withdraw the capability without settling. The operation stays in
   * `operations` — and so keeps counting and holding its budget — because a
   * parse that ignores its abort signal is still running.
   */
  private revoke(op: Operation): void {
    if (op.cancelled) return;
    op.cancelled = true;
    op.controller.abort();
    this.published.delete(op.handle);
    if (this.inFlight.get(op.ownerId) === op) this.inFlight.delete(op.ownerId);
  }

  /** Synchronous by design: an `async` predicate yields between the answer
   *  and its use, which is the window a release slips through. */
  private isLive(op: Operation): boolean {
    return (
      !this.disposed &&
      !op.cancelled &&
      op.state !== "orphaned" &&
      op.state !== "settled" &&
      op.generation === this.generationOf(op.ownerId)
    );
  }

  /**
   * End an operation: remove its file, then release the handle and the bytes.
   * If the file cannot be removed the operation is parked as `orphaned` —
   * still registered, still holding its reservation — because its bytes are
   * still on disk.
   */
  private settle(op: Operation): Promise<void> {
    if (op.state === "settled") return Promise.resolve();
    if (op.settling) return op.settling;
    op.settling = (async () => {
      const previous = op.state;
      op.state = "deleting";
      let removed = !op.fileCreated;
      if (op.fileCreated) {
        for (let attempt = 0; attempt < UNLINK_ATTEMPTS && !removed; attempt += 1) {
          try {
            await this.fs.unlink(op.file);
            removed = true;
          } catch (err) {
            const code = osCode(err);
            // Already gone is success; anything else is worth one more try.
            if (code === "ENOENT") removed = true;
            else if (attempt === UNLINK_ATTEMPTS - 1) {
              this.log.warn(`[import] staged snapshot not removed (${code})`);
            }
          }
        }
      }
      if (!removed) {
        op.state = "orphaned";
        op.settling = null; // a later attempt may still succeed
        op.complete();
        return;
      }
      op.state = "settled";
      this.operations.delete(op);
      this.published.delete(op.handle);
      if (this.inFlight.get(op.ownerId) === op) this.inFlight.delete(op.ownerId);
      this.releaseReservation(op);
      op.complete();
      void previous;
    })();
    return op.settling;
  }

  /** Resolve a handle for an owner, refusing every other case by name. */
  private claim(handle: string, ownerId: number): Operation {
    const op = this.published.get(handle);
    if (!op) {
      throw new ImportStagingError("unknown-handle", "this import preview is no longer available");
    }
    if (op.ownerId !== ownerId) {
      // Distinct code, identical message: a caller cannot probe for existence.
      throw new ImportStagingError("not-your-handle", "this import preview is no longer available");
    }
    if (this.clock() >= op.expiresAt) {
      // Not swept before the lookup: sweeping first would report
      // `unknown-handle` and tell the user their preview never existed.
      this.revoke(op);
      void this.settle(op);
      throw new ImportStagingError("expired", "this import preview has expired; preview it again");
    }
    return op;
  }

  private async runParse(op: Operation, sourcePath: string): Promise<ImportedTranscript> {
    try {
      return await this.parse!(sourcePath, { signal: op.controller.signal });
    } catch (err) {
      // Never the parser's own message: it may quote the file's contents or
      // the source path. Only an allowlisted machine code crosses out.
      const code = err instanceof ImportError && PARSE_CODES.has(err.code) ? err.code : undefined;
      this.log.warn(`[import] parse refused (code=${code ?? "unknown"})`);
      throw new ImportStagingError(
        "parse-failed",
        "this file could not be read as a supported transcript",
        code,
      );
    }
  }

  private async runStage(
    op: Operation,
    sourcePath: string,
  ): Promise<{ resultBytes: number; summary: StagedTranscriptSummary }> {
    try {
      return await this.stage!(sourcePath, op.file, {
        signal: op.controller.signal,
        onCreated: () => { op.fileCreated = true; },
      });
    } catch (err) {
      if (!this.isLive(op)) throw this.cancelled();
      const rawCode = (err as { parseCode?: unknown; code?: unknown } | null)?.parseCode
        ?? (err as { code?: unknown } | null)?.code;
      const code = typeof rawCode === "string" && PARSE_CODES.has(rawCode) ? rawCode : undefined;
      this.log.warn(`[import] worker refused (code=${code ?? "unknown"})`);
      if (!code) {
        throw new ImportStagingError(
          "staging-failed",
          "the import preview could not be stored",
        );
      }
      throw new ImportStagingError(
        "parse-failed",
        "this file could not be read as a supported transcript",
        code,
      );
    }
  }

  private reserve(op: Operation, bytes: number): boolean {
    if (this.reservedBytes + bytes > this.maxStagedBytes) return false;
    this.reservedBytes += bytes;
    op.reservation = { bytes, released: false };
    return true;
  }

  private shrink(op: Operation, bytes: number): void {
    const reservation = op.reservation;
    if (!reservation || reservation.released || bytes >= reservation.bytes) return;
    this.reservedBytes -= reservation.bytes - bytes;
    reservation.bytes = bytes;
  }

  /** Released exactly once, and only from `settled`. */
  private releaseReservation(op: Operation): void {
    const reservation = op.reservation;
    if (!reservation || reservation.released) return;
    reservation.released = true;
    this.reservedBytes -= reservation.bytes;
  }

  private newHandle(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const handle = this.makeHandle();
      let taken = false;
      for (const op of this.operations) {
        if (op.handle === handle) {
          taken = true;
          break;
        }
      }
      if (!taken) return handle;
    }
    throw new ImportStagingError("staging-failed", "the import preview could not be stored");
  }
}

function toPreview(
  transcript: ImportedTranscript | StagedTranscriptSummary,
  sourcePath: string,
  handle: string,
  destinationProjectId: string,
  expiresAt: number,
): ImportPreview {
  return {
    handle,
    backend: transcript.backend,
    format: transcript.format,
    nativeId: transcript.nativeId,
    title: transcript.title,
    sourcePath,
    sourceBytes: transcript.sourceBytes,
    sourceSha256: transcript.sourceSha256,
    cwd: transcript.cwd,
    startedAt: transcript.startedAt,
    endedAt: transcript.endedAt,
    destinationProjectId,
    counts: transcript.counts,
    unknownTypes: transcript.unknownTypes,
    warnings: transcript.warnings,
    complete: transcript.complete,
    expiresAt,
  };
}

/** A safe positive integer, at most `ceiling`. */
function bounded(
  value: number | undefined,
  fallback: number,
  ceiling: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ImportStagingError("invalid-option", `${name} must be a positive whole number`);
  }
  if (value > ceiling) {
    throw new ImportStagingError("invalid-option", `${name} must be at most ${ceiling}`);
  }
  return value;
}

/** An OS error code safe to log, or a placeholder. Never the error's message. */
function osCode(err: unknown): string {
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && SAFE_OS_CODES.has(code) ? code : "unknown";
}
