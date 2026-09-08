/**
 * Main's side of the share worker: one child at a time, correlated requests,
 * and the three ways a child can fail that main must survive — it hangs, it
 * dies, or the user cancels while it is still working.
 *
 * **Everything is scoped to a child generation.** A child owns its own pending
 * requests, and its exit, its messages and its deadlines reach only those. An
 * earlier draft kept one pending map for the client, so a killed child's exit —
 * which can arrive long after the kill, once a replacement is already serving
 * traffic — rejected the replacement's in-flight requests too. Generations are
 * what make a dead child's late paperwork inert.
 *
 * Replies are validated, never trusted. A message must name this protocol
 * version, an id this client is actually waiting on, the operation that id was
 * sent for, and a result of that operation's shape. Anything else is a generic
 * refusal: a child's own words never reach the renderer, because a compromised
 * or confused child must not be able to choose the text a person reads.
 */
import {
  SHARE_LIMITS,
  ShareCommentSchema,
  ShareCountsSchema,
  ShareEntrySchema,
  ShareSourceSchema,
  type ShareBundle,
  type ShareComment,
  type ShareEntry,
} from "@capygen/shared";
import { SHARE_JSON_MAX_BYTES, ShareCodecError } from "./json.js";
import { SHARE_HTML_MAX_BYTES } from "./html.js";
import type { ShareExportRequest } from "./buildBundle.js";
import { z } from "zod";
import {
  SHARE_WORKER_PROTOCOL_VERSION,
  type ShareJobPreview,
  type ShareWorkerOp,
  type ShareWorkerRequest,
} from "./workerHostTypes.js";

/** The child, as main needs it. Electron's `utilityProcess` satisfies this. */
export interface ShareWorkerProcessLike {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: unknown) => void): void;
  on(event: "exit", listener: (code: number) => void): void;
  kill(): boolean;
}

export interface ShareWorkerClientOptions {
  fork: () => ShareWorkerProcessLike;
  /** Per-request deadline. A child that misses it is killed. */
  timeoutMs?: number;
  log?: { warn: (message: string) => void };
}

export const SHARE_WORKER_DEFAULT_TIMEOUT_MS = 60_000;

/** Distributes over the union, so each op keeps its own fields. */
type ShareWorkerRequestBody =
  ShareWorkerRequest extends infer R ? R extends ShareWorkerRequest ? Omit<R, "v" | "id"> : never : never;

interface Pending {
  op: ShareWorkerOp;
  /** What was asked, so the answer can be checked against it. */
  limit?: number;
  format?: "json" | "html";
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** One forked child and everything that belongs to it. */
interface Generation {
  child: ShareWorkerProcessLike;
  id: number;
  pending: Map<string, Pending>;
  /**
   * `live` serves requests; `retiring` has been told to stop but has not
   * confirmed it; `exited` is gone for certain. Only an `exited` child has
   * definitely released its memory, which is why `retiring` still counts.
   */
  state: "live" | "retiring" | "exited";
  /** Set when `kill()` refused or threw: this child may never go away. */
  unkillable: boolean;
}

/** Children that were told to stop but have not confirmed it. */
const MAX_RETIRING = 1;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * What each operation's answer must look like — checked against what was
 * actually asked, not merely against a type.
 *
 * A page may not be longer than the limit that was requested, and its elements
 * must parse as the inert entry/comment shapes: a child that answered `entries`
 * with a live tool-call block would otherwise put un-projected content into the
 * renderer. A byte count must be the text's real UTF-8 length and inside the
 * format's cap, so the number a save reports cannot disagree with the bytes it
 * writes. The preview is parsed strictly, since it is the one payload the
 * renderer sees whole.
 */
const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

const finiteCount = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;

/**
 * The largest byte count a preview may report.
 *
 * A size *over* a format's cap is legitimate and load-bearing: `encodeShareHtml`
 * returns the carrier's real size with `withinLimit: false` precisely so the
 * export flow can say "too large for the page, here is the reviewed JSON". So
 * the bound cannot be the cap itself. It is instead the largest string the
 * worker could have measured — V8 refuses to build one beyond roughly half a
 * gigabyte, so anything past this is a number the child made up.
 */
const MAX_REPORTED_BYTES = 1024 * 1024 * 1024;

/** A format's reported size, checked against the ceiling it claims to respect. */
const formatSize = (cap: number) => z.object({
  bytes: z.number().int().nonnegative().max(MAX_REPORTED_BYTES),
  withinLimit: z.boolean(),
}).strict().refine(
  (value) => value.withinLimit === (value.bytes <= cap),
  "the reported size disagrees with the limit it claims",
);

/**
 * Source and counts are validated with the **shared** schemas, not local
 * look-alikes: those carry the UTF-8 byte bounds and the bidi-control rules
 * that a hand-written `z.string().max()` here would silently drop.
 */
const PreviewSchema = z.object({
  source: ShareSourceSchema,
  counts: ShareCountsSchema,
  bundleId: z.string().regex(/^[0-9a-f]{32}$/),
  createdAt: z.string().max(40),
  appVersion: z.string().max(SHARE_LIMITS.maxAppVersionChars),
  entryCount: z.number().int().nonnegative().max(SHARE_LIMITS.maxEntries),
  commentCount: z.number().int().nonnegative().max(SHARE_LIMITS.maxComments),
  json: formatSize(SHARE_JSON_MAX_BYTES),
  html: formatSize(SHARE_HTML_MAX_BYTES),
  /** Canonical content identity, computed by the side that holds the bundle. */
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

function validResult(value: Record<string, unknown>, pending: Pending): boolean {
  switch (pending.op) {
    case "createFromFile":
    case "createFromExport":
      return PreviewSchema.safeParse(value.preview).success;
    case "entries": {
      const entries = value.entries;
      if (!Array.isArray(entries)) return false;
      if (entries.length > (pending.limit ?? 0)) return false;
      return entries.every((entry) => ShareEntrySchema.safeParse(entry).success);
    }
    case "comments": {
      const comments = value.comments;
      if (!Array.isArray(comments)) return false;
      if (comments.length > (pending.limit ?? 0)) return false;
      return comments.every((comment) => ShareCommentSchema.safeParse(comment).success);
    }
    case "text": {
      const cap = pending.format === "html" ? SHARE_HTML_MAX_BYTES : SHARE_JSON_MAX_BYTES;
      if (typeof value.text !== "string") return false;
      if (!finiteCount(value.bytes, cap)) return false;
      return value.bytes === utf8Bytes(value.text);
    }
    case "bundle": {
      // Structural only: `SharesRepo.commit` re-parses the whole bundle against
      // its schema inside the transaction that stores it, and repeating that
      // here would put the parse this worker exists to avoid back on main.
      // The collection sizes are still checked, because they are the one thing
      // that is cheap to test and expensive to discover mid-transaction.
      const bundle = value.bundle as
        { kind?: unknown; version?: unknown; entries?: unknown; comments?: unknown };
      if (!isRecord(value.bundle)) return false;
      if (bundle.kind !== "capygen.share" || bundle.version !== 1) return false;
      if (!Array.isArray(bundle.entries) || bundle.entries.length > SHARE_LIMITS.maxEntries) return false;
      return Array.isArray(bundle.comments) && bundle.comments.length <= SHARE_LIMITS.maxComments;
    }
    case "release":
      return typeof value.released === "boolean";
    default:
      return false;
  }
}

/**
 * Refusals main is willing to repeat, and the words it uses for them.
 *
 * The child's `code` is consulted; the child's `message` never is. A code
 * outside this table — or one attached to the wrong operation — becomes the
 * generic failure, so a confused or compromised child can pick from a fixed
 * menu of sentences at worst. It can never choose the text a person reads, or
 * smuggle a path or a secret into it.
 */
const REFUSALS: Record<string, string> = {
  "invalid-json": "that file is not valid JSON",
  schema: "that file does not match the share contract",
  "too-large": "that share is too large",
  "carrier-missing": "no capygen share bundle was found in that file",
  "carrier-duplicate": "that file carries more than one share bundle",
  "carrier-malformed": "that file's share bundle is not readable",
  "identity-mismatch": "that file's share bundle does not match its own declared version",
  "over-limit": "that session is too large to share as one bundle",
  "unsupported-block": "that session contains something the share projection does not model yet",
  "invalid-anchor": "a comment in that session points at something it cannot",
};

export class ShareWorkerClient {
  private generation: Generation | null = null;
  /** Children told to stop that have not confirmed exit. They still hold memory. */
  private readonly retiring = new Set<Generation>();
  /** jobId → the generation whose process actually holds that payload. */
  private readonly jobOwners = new Map<string, Generation>();
  /** jobId → the release in flight for it, so concurrent callers join one. */
  private readonly releasing = new Map<string, Promise<void>>();
  private readonly timeoutMs: number;
  private readonly log: NonNullable<ShareWorkerClientOptions["log"]>;
  private sequence = 0;
  private generations = 0;
  private disposed = false;

  constructor(private readonly options: ShareWorkerClientOptions) {
    // A zero, negative, fractional, NaN or infinite deadline would either fire
    // before the child could answer or never fire at all; neither is a deadline.
    const requested = options.timeoutMs;
    this.timeoutMs = typeof requested === "number" && Number.isSafeInteger(requested) && requested > 0
      ? requested
      : SHARE_WORKER_DEFAULT_TIMEOUT_MS;
    this.log = options.log ?? { warn: () => {} };
  }

  async createFromFile(jobId: string, filePath: string, maxFileBytes: number): Promise<ShareJobPreview> {
    const { value } = await this.send(
      { op: "createFromFile", jobId, filePath, maxFileBytes }, { owns: jobId });
    return (value as { preview: ShareJobPreview }).preview;
  }

  async createFromExport(jobId: string, request: ShareExportRequest): Promise<ShareJobPreview> {
    const { value } = await this.send({ op: "createFromExport", jobId, request }, { owns: jobId });
    return (value as { preview: ShareJobPreview }).preview;
  }

  async entries(jobId: string, offset: number, limit: number): Promise<ShareEntry[]> {
    const { value } = await this.send({ op: "entries", jobId, offset, limit }, { limit });
    return (value as { entries: ShareEntry[] }).entries;
  }

  async comments(jobId: string, offset: number, limit: number): Promise<ShareComment[]> {
    const { value } = await this.send({ op: "comments", jobId, offset, limit }, { limit });
    return (value as { comments: ShareComment[] }).comments;
  }

  async text(jobId: string, format: "json" | "html"): Promise<{ text: string; bytes: number }> {
    const { value } = await this.send({ op: "text", jobId, format }, { format });
    const result = value as { text: string; bytes: number };
    return { text: result.text, bytes: result.bytes };
  }

  async bundle(jobId: string): Promise<ShareBundle> {
    const { value } = await this.send({ op: "bundle", jobId });
    return (value as { bundle: ShareBundle }).bundle;
  }

  /**
   * Drop a payload the worker is holding.
   *
   * Resolves only when the child has acknowledged the release, or when there is
   * no child left to hold it. It **rejects** when the message could not be
   * delivered to a child that is still running: staging keeps the payload's
   * budget reserved on that signal, so a failed release is never mistaken for a
   * freed one.
   */
  /**
   * Drop a payload the worker is holding.
   *
   * Resolving means the memory is genuinely gone: either the owning child
   * acknowledged the release, or that child has confirmed exit and took the
   * payload with it. Anything else **rejects**, and the ownership record is
   * kept so a retry can ask again. Reporting success early — after a failed
   * send, or because the owner is merely retiring — would let staging return a
   * budget that the still-running child is spending.
   */
  async release(jobId: string): Promise<void> {
    const owner = this.jobOwners.get(jobId);
    // No owner, or an owner whose process is confirmed gone: nothing can still
    // be holding it. The exit handler already forgets that child's jobs, so an
    // unknown id is genuinely unowned rather than merely unrecorded.
    if (!owner || owner.state === "exited") {
      this.jobOwners.delete(jobId);
      return;
    }
    const inFlight = this.releasing.get(jobId);
    if (inFlight) return inFlight;
    if (owner.state !== "live") {
      // Retiring: told to stop, has not proved it. A caller that must stop
      // waiting (shutdown) can give up, but it may not call this freed.
      throw new ShareCodecError(
        "invalid-option",
        "the share worker has not confirmed it stopped holding this share",
      );
    }
    const attempt = (async () => {
      await this.send({ op: "release", jobId }, {}, owner);
      // Only now is the payload provably gone.
      this.jobOwners.delete(jobId);
    })();
    const tracked = attempt.finally(() => {
      this.releasing.delete(jobId);
    });
    this.releasing.set(jobId, tracked);
    return tracked;
  }

  /**
   * True when no process can still be holding a payload.
   *
   * A killed child that has not confirmed exit is *not* gone: its memory is
   * still charged to this app, and reporting otherwise would let staging hand
   * out the budget twice.
   */
  isGone(): boolean {
    if (this.retiring.size > 0) return false;
    return this.generation === null || this.generation.state === "exited";
  }

  dispose(): void {
    this.disposed = true;
    this.retire(this.generation, new ShareCodecError("invalid-option", "the app is shutting down"), true);
  }

  private failed(): Error {
    return new ShareCodecError("invalid-option", "the share worker could not prepare this share");
  }

  private send(
    body: ShareWorkerRequestBody,
    asked: { limit?: number; format?: "json" | "html"; owns?: string } = {},
    target?: Generation,
  ): Promise<{ value: unknown; generation: Generation }> {
    if (this.disposed) {
      return Promise.reject(new ShareCodecError("invalid-option", "the app is shutting down"));
    }
    const generation = target ?? this.ensureGeneration();
    if (generation.state !== "live") {
      return Promise.reject(new ShareCodecError("invalid-option", "the share worker is no longer available"));
    }
    // Ownership is recorded the moment the create is *sent*, not when it
    // returns. A cancel that lands while the child is still building the
    // payload must still know which process to tell, or the child keeps it
    // forever with nothing left pointing at it.
    if (asked.owns !== undefined) this.jobOwners.set(asked.owns, generation);
    const id = `${(this.sequence += 1)}`;
    const request = { ...body, v: SHARE_WORKER_PROTOCOL_VERSION, id } as ShareWorkerRequest;
    return new Promise<{ value: unknown; generation: Generation }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.log.warn(`[sharing] worker request ${request.op} timed out; killing that child`);
        // Only this child dies. A replacement forked in the meantime keeps its
        // own pending work.
        this.retire(generation, new ShareCodecError("invalid-option", "preparing this share took too long"), true);
      }, this.timeoutMs);
      generation.pending.set(id, {
        op: request.op, limit: asked.limit, format: asked.format,
        resolve: (value) => resolve({ value, generation }),
        reject, timer,
      });
      try {
        generation.child.postMessage(request);
      } catch {
        this.settle(generation, id, null, this.failed());
      }
    });
  }

  private ensureGeneration(): Generation {
    if (this.generation && this.generation.state === "live") return this.generation;
    // A child that was told to stop but has not confirmed it still owns its
    // memory. Forking past it would run two workers against a budget sized for
    // one, so this fails closed until the old one is really gone.
    if (this.retiring.size >= MAX_RETIRING) {
      throw new ShareCodecError(
        "invalid-option",
        "the previous share worker has not stopped yet; try again in a moment",
      );
    }
    const generation: Generation = {
      child: this.options.fork(),
      id: (this.generations += 1),
      pending: new Map(),
      state: "live",
      unkillable: false,
    };
    // Both handlers close over *this* generation, so a stale child can only
    // ever settle or reject requests that were sent to it.
    generation.child.on("message", (message) => this.receive(generation, message));
    generation.child.on("exit", () => {
      this.retire(generation, new ShareCodecError("invalid-option", "the share worker stopped unexpectedly"), false);
      // Confirmed gone: its memory is released and a replacement may start.
      generation.state = "exited";
      this.retiring.delete(generation);
      for (const [jobId, owner] of [...this.jobOwners]) {
        if (owner === generation) this.jobOwners.delete(jobId);
      }
    });
    this.generation = generation;
    return generation;
  }

  private receive(generation: Generation, message: unknown): void {
    if (generation.state !== "live") return;
    if (!isRecord(message)) return;
    if (message.v !== SHARE_WORKER_PROTOCOL_VERSION) {
      this.rejectFor(generation, message, this.failed());
      return;
    }
    const id = message.id;
    if (typeof id !== "string") return;
    const pending = generation.pending.get(id);
    // An id this child was never asked about — including one belonging to a
    // different child — is dropped rather than allowed to settle anything.
    if (!pending) return;

    if (message.ok === false) {
      // A refusal has to answer the question that was asked, like any other
      // reply — otherwise a child could retire the wrong request with a
      // plausible-looking excuse. The child's own text is never repeated: its
      // `code` only selects one of main's sentences, and an unrecognised code
      // (or a mismatched op) selects the generic one.
      const code = typeof message.code === "string" ? message.code : "";
      const known = message.op === pending.op && Object.hasOwn(REFUSALS, code);
      this.settle(generation, id, null, known
        ? new ShareCodecError(code as ShareCodecError["code"], REFUSALS[code]!)
        : this.failed());
      return;
    }
    if (message.ok !== true || message.op !== pending.op || !validResult(message, pending)) {
      this.settle(generation, id, null, this.failed());
      return;
    }
    this.settle(generation, id, message, null);
  }

  /** Reject the one request a malformed message claims to answer, if any. */
  private rejectFor(generation: Generation, message: Record<string, unknown>, error: Error): void {
    const id = message.id;
    if (typeof id === "string" && generation.pending.has(id)) {
      this.settle(generation, id, null, error);
    }
  }

  private settle(
    generation: Generation,
    id: string,
    value: unknown,
    error: Error | null,
  ): void {
    const pending = generation.pending.get(id);
    if (!pending) return;
    generation.pending.delete(id);
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(value);
  }

  /**
   * End one generation: reject what it still owed, and optionally kill it.
   *
   * Rejecting before the kill matters — the exit that follows would otherwise
   * report "stopped unexpectedly" and hide the deadline that actually caused
   * it. A generation that is already dead is left alone, so a late exit after a
   * kill changes nothing.
   */
  private retire(generation: Generation | null, error: Error, kill: boolean): void {
    if (!generation || generation.state !== "live") return;
    generation.state = "retiring";
    if (this.generation === generation) this.generation = null;
    for (const [id, pending] of [...generation.pending]) {
      generation.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    if (!kill) {
      // An exit event is already on its way; the handler marks it exited.
      this.retiring.add(generation);
      return;
    }
    let stopping = false;
    try {
      stopping = generation.child.kill();
    } catch {
      // A kill that throws is a kill that did not happen.
      stopping = false;
    }
    if (!stopping) {
      generation.unkillable = true;
      this.log.warn("[sharing] a share worker could not be stopped; not starting another");
    }
    // Either way it stays counted until an exit event proves it is gone. The
    // synchronous `kill()` above may already have delivered that event, in
    // which case the handler has removed it again.
    if (generation.state === "retiring") this.retiring.add(generation);
  }
}
