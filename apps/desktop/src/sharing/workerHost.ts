/**
 * The child side of share work: a job table and the operations over it.
 *
 * The host owns every staged payload. Main never holds a decoded bundle, a
 * 32 MiB JSON string or a 96 MiB document — it holds a job id and a small
 * preview, and asks for pages, encoded text, or (once, at commit) the bundle
 * itself. That is what keeps a Zod parse, the redaction pass and the encoders
 * off the thread that draws the window.
 *
 * `createShareWorkerHost` is deliberately transport-free so `workerEntry.ts`
 * can wrap it in a process and tests can drive it directly.
 */
import type { ShareBundle, ShareComment, ShareEntry } from "@capygen/shared";
import { ShareCodecError } from "./json.js";
import {
  encodeJob,
  pageComments,
  pageEntries,
  runDecodeJob,
  runExportJob,
  type ShareJob,
} from "./workerJobs.js";
import type { ShareExportRequest } from "./buildBundle.js";
import {
  SHARE_WORKER_MAX_JOBS,
  SHARE_WORKER_PROTOCOL_VERSION,
  type ShareWorkerOp,
  type ShareWorkerRequest,
  type ShareWorkerResponse,
} from "./workerHostTypes.js";

export interface ShareWorkerHostOptions {
  /** Payloads this child may hold or be building at once. Tighten-only in tests. */
  maxJobs?: number;
  /**
   * The file-reading half of a create. The seam exists so a test can hold a
   * read open and race cancellation against it — the one lifecycle this host
   * has to get right and cannot otherwise reach deterministically. Production
   * always uses `runDecodeJob`.
   */
  decode?: typeof runDecodeJob;
}

export interface ShareWorkerHost {
  handle(request: ShareWorkerRequest): Promise<ShareWorkerResponse>;
  /**
   * Abort a job's creation and forget its payload.
   *
   * Resolves only once the work has actually stopped. A read that is still
   * running still owns its buffers, so reporting the release before it returns
   * would free the admission slot while the memory it accounted for was still
   * in use — and let a new job take an id whose predecessor was mid-flight.
   */
  release(jobId: string): Promise<boolean>;
  size(): number;
}

const failure = (id: string, op: ShareWorkerOp | "unknown", error: unknown): ShareWorkerResponse => {
  const code = error instanceof ShareCodecError ? error.code : "worker-failed";
  // The message is the codec's own, which is written for a person and never
  // quotes the input; anything else is replaced rather than forwarded. Main
  // does not print it either — it is diagnostic, not renderer-facing text.
  const message = error instanceof ShareCodecError
    ? error.message
    : "this share could not be prepared";
  return { v: SHARE_WORKER_PROTOCOL_VERSION, id, op, ok: false, code, message };
};

export function createShareWorkerHost(options: ShareWorkerHostOptions = {}): ShareWorkerHost {
  const maxJobs = Number.isSafeInteger(options.maxJobs) && options.maxJobs! > 0
    && options.maxJobs! <= SHARE_WORKER_MAX_JOBS
    ? options.maxJobs!
    : SHARE_WORKER_MAX_JOBS;
  const decodeJob = options.decode ?? runDecodeJob;
  const jobs = new Map<string, ShareJob>();
  /** In-flight creates: the reservation is this entry, and it outlives a cancel. */
  const creating = new Map<string, { controller: AbortController; settled: Promise<void> }>();

  const release = async (jobId: string): Promise<boolean> => {
    const pending = creating.get(jobId);
    if (pending) {
      pending.controller.abort();
      // Wait for the read to unwind before saying the payload is gone.
      await pending.settled;
    }
    return jobs.delete(jobId);
  };

  const job = (jobId: string): ShareJob => {
    const found = jobs.get(jobId);
    if (!found) throw new ShareCodecError("invalid-option", "this share is no longer available");
    return found;
  };

  const handle = async (request: ShareWorkerRequest): Promise<ShareWorkerResponse> => {
    const v = SHARE_WORKER_PROTOCOL_VERSION;
    if (request.v !== v) {
      return { v, id: request.id, op: "unknown", ok: false, code: "protocol",
        message: "this share worker speaks a different protocol version" };
    }
    try {
      switch (request.op) {
        case "createFromFile":
        case "createFromExport": {
          // A job in flight occupies a slot: it is already reading a file or
          // building a bundle, and counting only finished payloads would let
          // any number of them run at once under a ceiling none had reached.
          if (jobs.size + creating.size >= maxJobs) {
            throw new ShareCodecError("invalid-option", "too many shares are open at once");
          }
          // Reusing an id would strand the first payload — and overwrite the
          // controller that could still cancel it — so it is refused outright.
          if (jobs.has(request.jobId) || creating.has(request.jobId)) {
            throw new ShareCodecError("invalid-option", "that share is already being prepared");
          }
          const controller = new AbortController();
          let finish!: () => void;
          const entry = {
            controller,
            settled: new Promise<void>((resolve) => { finish = resolve; }),
          };
          creating.set(request.jobId, entry);
          try {
            const built = request.op === "createFromFile"
              ? await decodeJob({
                  filePath: request.filePath,
                  maxFileBytes: request.maxFileBytes,
                  signal: controller.signal,
                })
              : runExportJob(request.request);
            // A release that landed while this ran wins: the payload is
            // dropped rather than published to a caller that gave up on it.
            if (controller.signal.aborted) {
              throw new ShareCodecError("invalid-option", "this share was cancelled");
            }
            jobs.set(request.jobId, built);
            return { v, id: request.id, op: request.op, ok: true, preview: built.preview };
          } finally {
            // Only ever retire *this* create's reservation. The id may already
            // have been released and reused by a newer job, and deleting the
            // key blindly would evict that one's controller instead.
            if (creating.get(request.jobId) === entry) creating.delete(request.jobId);
            finish();
          }
        }
        case "entries":
          return { v, id: request.id, op: "entries", ok: true,
            entries: pageEntries(job(request.jobId), request.offset, request.limit) };
        case "comments":
          return { v, id: request.id, op: "comments", ok: true,
            comments: pageComments(job(request.jobId), request.offset, request.limit) };
        case "text": {
          const text = encodeJob(job(request.jobId), request.format);
          return { v, id: request.id, op: "text", ok: true, text,
            bytes: Buffer.byteLength(text, "utf8") };
        }
        case "bundle":
          return { v, id: request.id, op: "bundle", ok: true, bundle: job(request.jobId).bundle };
        case "release":
          return { v, id: request.id, op: "release", ok: true,
            released: await release(request.jobId) };
        default: {
          // The union is exhaustive; a request that reaches here came from a
          // sender speaking something this build does not implement.
          const unknown = request as { id?: unknown };
          return { v, id: typeof unknown.id === "string" ? unknown.id : "",
            op: "unknown", ok: false, code: "protocol", message: "unknown request" };
        }
      }
    } catch (error) {
      return failure(request.id, request.op, error);
    }
  };

  return { handle, release, size: () => jobs.size };
}
