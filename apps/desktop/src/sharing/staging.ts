/**
 * Owner-bound staging for share exports and imports.
 *
 * Admission is **synchronous and happens before any work starts**. A request
 * takes its window's slot, a concurrency slot and a provisional byte allowance
 * before the first `await`; only then does the worker begin. An earlier draft
 * checked the limits and then awaited the projection, which meant four
 * simultaneous requests all passed a check none of them had yet consumed — the
 * limits were advisory. They are not advisory now.
 *
 * The payload itself lives in the worker process for the whole life of the
 * handle, and main keeps the allowance reserved for exactly that long: while a
 * job is being decoded, while it sits staged, and while a save is writing it.
 * Nothing is written to disk except the file the user explicitly saves.
 *
 * Every operation carries an abort signal and a generation. Cancelling, closing
 * the window, expiry and shutdown all abort the in-flight work rather than
 * waiting for it, and a result arriving after one of those is discarded instead
 * of published. `assertCurrent` is the gate an irreversible step calls *after*
 * its dialog and immediately before it writes anything.
 */
export type ShareStagingErrorCode =
  | "unknown-handle"
  | "not-your-handle"
  | "expired"
  | "busy"
  | "in-use"
  | "too-many-staged"
  | "staging-full"
  | "cancelled"
  | "shutdown";

/**
 * A refusal the renderer may see. Messages are written for a person and carry
 * no bundle text, no path, and nothing from the environment.
 */
export class ShareStagingError extends Error {
  readonly code: ShareStagingErrorCode;

  constructor(code: ShareStagingErrorCode, message: string) {
    super(message);
    this.name = "ShareStagingError";
    this.code = code;
  }
}

export type ShareStagingKind = "export" | "import";
/**
 * `deleting` is the state that makes a release honest: the handle is already
 * unusable, but the worker may still be holding the payload, so the budget
 * stays spent until that is confirmed.
 */
type OperationState = "reserving" | "staged" | "in-use" | "deleting" | "settled";

/** The handle's public face. The payload stays in the worker. */
export interface StagedShare<Meta> {
  handle: string;
  /** The worker's id for the payload behind this handle. */
  jobId: string;
  kind: ShareStagingKind;
  meta: Meta;
  bytes: number;
  expiresAt: number;
  /**
   * Throws unless this operation is still the live one *right now*: not
   * cancelled, not expired, its window still open, its generation unchanged.
   * Call it after every dialog and immediately before an irreversible write.
   */
  assertCurrent: () => void;
  signal: AbortSignal;
}

interface Operation<Meta> {
  handle: string;
  jobId: string;
  kind: ShareStagingKind;
  meta: Meta | null;
  ownerId: number;
  generation: number;
  /** Bytes currently charged: the provisional allowance, then the real size. */
  reserved: number;
  state: OperationState;
  controller: AbortController;
  expiresAt: number;
  /** The one in-flight settlement, so concurrent callers join it. */
  settling: Promise<void> | null;
}

export interface ShareStagingDeps {
  log: { info: (message: string) => void; warn: (message: string) => void };
  /**
   * Tell the worker to drop a payload.
   *
   * Resolving means the payload is confirmed gone. Rejecting means it may still
   * exist, and the reservation is held until a retry succeeds or `isWorkerGone`
   * reports that nothing can be holding it any more.
   */
  releaseJob: (jobId: string) => void | Promise<void>;
  /** True when no worker process is left to be holding a payload. */
  isWorkerGone?: () => boolean;
  now?: () => number;
  ttlMs?: number;
  maxConcurrent?: number;
  maxStagedBytes?: number;
  /** Charged before the real size is known: the ceiling one job could reach. */
  provisionalBytes?: number;
  newHandle?: () => string;
  newJobId?: () => string;
}

export const SHARE_STAGING_DEFAULT_TTL_MS = 10 * 60 * 1000;
export const SHARE_STAGING_DEFAULT_MAX_CONCURRENT = 4;
export const SHARE_STAGING_DEFAULT_MAX_BYTES = 160 * 1024 * 1024;
/** One bundle's JSON ceiling: what a job could still turn out to be. */
export const SHARE_STAGING_PROVISIONAL_BYTES = 32 * 1024 * 1024;

const bounded = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;

export class ShareStagingService<Meta = unknown> {
  private readonly log: ShareStagingDeps["log"];
  private readonly releaseJob: ShareStagingDeps["releaseJob"];
  private readonly isWorkerGone: () => boolean;
  private readonly clock: () => number;
  private readonly ttlMs: number;
  private readonly maxConcurrent: number;
  private readonly maxStagedBytes: number;
  private readonly provisionalBytes: number;
  private readonly makeHandle: () => string;
  private readonly makeJobId: () => string;

  private readonly operations = new Map<string, Operation<Meta>>();
  /** ownerId → the one operation that window has, in any state. */
  private readonly byOwner = new Map<number, Operation<Meta>>();
  private readonly generations = new Map<number, number>();
  /** Settled handles whose payload the worker has not confirmed dropping. */
  private readonly deleting = new Set<Operation<Meta>>();
  private stagedBytes = 0;
  private disposed = false;

  constructor(deps: ShareStagingDeps) {
    this.log = deps.log;
    this.releaseJob = deps.releaseJob;
    this.isWorkerGone = deps.isWorkerGone ?? (() => false);
    this.clock = deps.now ?? Date.now;
    this.ttlMs = bounded(deps.ttlMs, SHARE_STAGING_DEFAULT_TTL_MS);
    this.maxConcurrent = bounded(deps.maxConcurrent, SHARE_STAGING_DEFAULT_MAX_CONCURRENT);
    this.maxStagedBytes = bounded(deps.maxStagedBytes, SHARE_STAGING_DEFAULT_MAX_BYTES);
    this.provisionalBytes = bounded(deps.provisionalBytes, SHARE_STAGING_PROVISIONAL_BYTES);
    let jobs = 0;
    this.makeHandle = deps.newHandle ?? randomHex;
    this.makeJobId = deps.newJobId ?? (() => `job_${(jobs += 1)}_${randomHex()}`);
  }

  /**
   * Reserve, then work.
   *
   * Everything up to the first `await` is admission: the window's slot, a
   * concurrency slot and a provisional allowance are all taken before `produce`
   * is called, so simultaneous requests contend for real resources rather than
   * all observing the same free ones.
   */
  async stage(args: {
    ownerId: number;
    kind: ShareStagingKind;
    /** Receives the worker job id it must fill, and the abort signal. */
    produce: (jobId: string, signal: AbortSignal) => Promise<{ bytes: number; meta: Meta }>;
  }): Promise<StagedShare<Meta>> {
    this.assertRunning();
    this.sweep();

    // --- synchronous admission; nothing awaits before it completes ---------
    const busy = this.byOwner.get(args.ownerId);
    if (busy) {
      // A window gets one share at a time. Silently replacing a *pending* one
      // would leave its worker job running with nothing watching it.
      throw new ShareStagingError("busy", busy.state === "reserving"
        ? "this window is already preparing a share; cancel it first"
        : "this window already has a share open; finish or cancel it first");
    }
    // A payload awaiting release still occupies the worker, so it counts.
    if (this.operations.size + this.deleting.size + 1 > this.maxConcurrent) {
      throw new ShareStagingError(
        "too-many-staged",
        "too many shares are open at once; finish or cancel one first",
      );
    }
    if (this.stagedBytes + this.provisionalBytes > this.maxStagedBytes) {
      throw new ShareStagingError(
        "staging-full",
        "there is not enough room to prepare another share right now",
      );
    }

    const operation: Operation<Meta> = {
      handle: this.makeHandle(),
      jobId: this.makeJobId(),
      kind: args.kind,
      meta: null,
      ownerId: args.ownerId,
      generation: this.generationOf(args.ownerId),
      reserved: this.provisionalBytes,
      state: "reserving",
      controller: new AbortController(),
      expiresAt: this.clock() + this.ttlMs,
      settling: null,
    };
    this.operations.set(operation.handle, operation);
    this.byOwner.set(args.ownerId, operation);
    this.stagedBytes += this.provisionalBytes;
    // --- admission done; the budget is committed for the whole life --------

    try {
      const produced = await args.produce(operation.jobId, operation.controller.signal);
      // A cancel, a closed window or a shutdown during the work wins: the
      // payload is released rather than published to a caller that gave up.
      if (operation.state === "settled" || operation.controller.signal.aborted
        || this.generationOf(args.ownerId) !== operation.generation) {
        await this.settle(operation);
        throw this.cancelled();
      }
      if (produced.bytes > this.provisionalBytes) {
        await this.settle(operation);
        throw new ShareStagingError("staging-full", "that share is larger than one bundle may be");
      }
      // Swap the provisional allowance for the real size, freeing the rest.
      this.stagedBytes -= operation.reserved - produced.bytes;
      operation.reserved = produced.bytes;
      operation.meta = produced.meta;
      operation.state = "staged";
      operation.expiresAt = this.clock() + this.ttlMs;
      return this.face(operation);
    } catch (error) {
      await this.settle(operation);
      throw error;
    }
  }

  /** Read a staged handle without consuming it. Refuses one that is in use. */
  get(handle: string, ownerId: number): StagedShare<Meta> {
    this.assertRunning();
    return this.face(this.claim(handle, ownerId));
  }

  /**
   * Borrow the handle for one operation. It stays staged afterwards, so an
   * export can save the second format from the same reviewed snapshot.
   */
  async use<T>(
    handle: string,
    ownerId: number,
    fn: (staged: StagedShare<Meta>) => T | Promise<T>,
  ): Promise<T> {
    this.assertRunning();
    const operation = this.claim(handle, ownerId);
    operation.state = "in-use";
    try {
      return await fn(this.face(operation));
    } finally {
      // A cancel during the call already settled it; do not resurrect it.
      if (operation.state === "in-use") operation.state = "staged";
    }
  }

  /** Borrow it and settle it afterwards, whatever the outcome. */
  async consume<T>(
    handle: string,
    ownerId: number,
    fn: (staged: StagedShare<Meta>) => T | Promise<T>,
  ): Promise<T> {
    this.assertRunning();
    const operation = this.claim(handle, ownerId);
    operation.state = "in-use";
    try {
      return await fn(this.face(operation));
    } finally {
      await this.settle(operation);
    }
  }

  async cancel(handle: string, ownerId: number): Promise<boolean> {
    if (this.disposed) return false;
    const operation = this.operations.get(handle);
    if (!operation) return false;
    if (operation.ownerId !== ownerId) {
      throw new ShareStagingError("not-your-handle", "this share belongs to another window");
    }
    await this.settle(operation);
    return true;
  }

  /** Cancel whatever a window has, including work that has not finished. */
  async cancelPending(ownerId: number): Promise<boolean> {
    const operation = this.byOwner.get(ownerId);
    if (!operation) return false;
    await this.settle(operation);
    return true;
  }

  /** Drop everything a closed window owns and orphan its in-flight work. */
  async releaseWindow(ownerId: number): Promise<void> {
    this.generations.set(ownerId, this.generationOf(ownerId) + 1);
    for (const operation of [...this.operations.values()]) {
      if (operation.ownerId === ownerId) await this.settle(operation);
    }
  }

  /**
   * Expire idle handles, abort anything still working on them, and retry any
   * release that did not land — a stranded payload would otherwise hold its
   * budget for the life of the process.
   */
  async sweepNow(): Promise<void> {
    const now = this.clock();
    for (const operation of [...this.operations.values()]) {
      if (now >= operation.expiresAt) {
        this.log.info(`[sharing] expiring an idle share (${operation.kind})`);
        await this.settle(operation);
      }
    }
    for (const operation of [...this.deleting]) {
      if (operation.settling === null) {
        operation.settling = this.finishRelease(operation);
        await operation.settling;
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const operation of [...this.operations.values()]) await this.settle(operation);
    // On the way down the worker goes too, so anything still awaiting a
    // release is gone with it; holding its budget would strand the accounting.
    for (const operation of [...this.deleting]) this.forget(operation);
  }

  /** Usable handles. Payloads awaiting release are not among them. */
  size(): number {
    return this.operations.size;
  }

  /** Payloads the worker has not yet confirmed dropping. */
  pendingRelease(): number {
    return this.deleting.size;
  }

  reserved(): number {
    return this.stagedBytes;
  }

  // -------------------------------------------------------------------------

  private face(operation: Operation<Meta>): StagedShare<Meta> {
    return {
      handle: operation.handle,
      jobId: operation.jobId,
      kind: operation.kind,
      meta: operation.meta as Meta,
      bytes: operation.reserved,
      expiresAt: operation.expiresAt,
      signal: operation.controller.signal,
      assertCurrent: () => {
        if (this.disposed) throw this.shutdown();
        if (operation.state === "settled" || operation.controller.signal.aborted) {
          throw this.cancelled();
        }
        if (this.generationOf(operation.ownerId) !== operation.generation) throw this.cancelled();
        if (this.clock() >= operation.expiresAt) {
          void this.settle(operation);
          throw new ShareStagingError("expired", "this share took too long to confirm; prepare it again");
        }
      },
    };
  }

  private claim(handle: string, ownerId: number): Operation<Meta> {
    // Look the handle up before sweeping: sweeping first would delete an
    // expired operation and then report it as unknown, telling the user to look
    // for something gone rather than to prepare it again.
    const operation = this.operations.get(handle);
    if (!operation) {
      this.sweep();
      throw new ShareStagingError("unknown-handle", "this share is no longer available");
    }
    // Ownership before expiry, so a wrong-owner probe cannot learn whether a
    // handle merely timed out.
    if (operation.ownerId !== ownerId) {
      throw new ShareStagingError("not-your-handle", "this share belongs to another window");
    }
    if (operation.state === "reserving") {
      throw new ShareStagingError("busy", "this share is still being prepared");
    }
    if (operation.state === "in-use") {
      // Two saves, or a save and a commit, would otherwise overlap on one
      // payload — and the second could still be writing when the first settles.
      throw new ShareStagingError("in-use", "this share is already being saved or imported");
    }
    if (operation.state === "settled" || this.clock() >= operation.expiresAt) {
      void this.settle(operation);
      throw new ShareStagingError("expired", "this share took too long to confirm; prepare it again");
    }
    return operation;
  }

  private sweep(): void {
    const now = this.clock();
    for (const operation of [...this.operations.values()]) {
      if (now >= operation.expiresAt) void this.settle(operation);
    }
  }

  /**
   * Retire a handle and drop the worker's copy of its payload.
   *
   * The handle becomes unusable immediately, but the **budget is not returned
   * until the payload is confirmed gone**. Returning it at the top of this
   * method — as an earlier draft did — let repeated cancellation admit fresh
   * work against memory the worker was still holding, which is precisely the
   * accounting the budget exists to prevent.
   *
   * Concurrent callers (a cancel racing a window close) join the same
   * completion rather than one of them returning early on a half-done state.
   */
  private async settle(operation: Operation<Meta>): Promise<void> {
    if (operation.state === "settled") return;
    if (operation.settling) return operation.settling;

    operation.state = "deleting";
    operation.controller.abort();
    this.operations.delete(operation.handle);
    if (this.byOwner.get(operation.ownerId) === operation) this.byOwner.delete(operation.ownerId);
    this.deleting.add(operation);

    const settling = this.finishRelease(operation);
    operation.settling = settling;
    return settling;
  }

  /** Ask the worker to drop the payload; free the budget only once it is gone. */
  private async finishRelease(operation: Operation<Meta>): Promise<void> {
    try {
      await this.releaseJob(operation.jobId);
    } catch {
      // The release did not land. If no worker is left, nothing can still be
      // holding the payload and the budget is genuinely free; otherwise it
      // stays charged and `sweepNow` will try again.
      if (!this.isWorkerGone()) {
        this.log.warn("[sharing] a staged payload could not be released yet; keeping its budget");
        operation.settling = null;
        return;
      }
    }
    this.forget(operation);
  }

  /** The payload is confirmed gone: return its budget, once. */
  private forget(operation: Operation<Meta>): void {
    if (operation.state === "settled") return;
    operation.state = "settled";
    operation.settling = null;
    this.deleting.delete(operation);
    this.stagedBytes -= operation.reserved;
    if (this.stagedBytes < 0) this.stagedBytes = 0;
  }

  private generationOf(ownerId: number): number {
    return this.generations.get(ownerId) ?? 0;
  }

  private assertRunning(): void {
    if (this.disposed) throw this.shutdown();
  }

  private shutdown(): ShareStagingError {
    return new ShareStagingError("shutdown", "the app is shutting down");
  }

  private cancelled(): ShareStagingError {
    return new ShareStagingError("cancelled", "this share was cancelled");
  }
}

function randomHex(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
