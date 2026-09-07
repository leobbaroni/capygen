/**
 * The wire contract between the main process and one import-parser child.
 *
 * Pure data and validation: nothing here opens a file, spawns anything or
 * imports Electron, so both sides — and a plain-Node test — can agree on the
 * shape before anyone touches the disk.
 *
 * Two rules shape it. **The child is told everything and discovers nothing**:
 * every path it may touch arrives in the request, already absolute, and a
 * malformed one is refused before any file access rather than normalized into
 * something plausible. And **the answer is small**: the normalized transcript
 * goes to a file, and the message back carries only the metadata main needs to
 * show a preview, capped at 64 KiB.
 */
// The parser only — a relative import into `@capygen/engine`'s imports module
// rather than the package barrel. The barrel pulls the harnesses, the MCP
// client and their dependencies in behind it; this worker parses a file and
// must not carry a backend runtime into its bundle.
import {
  IMPORT_LIMITS,
  ImportError,
  type ParseTranscriptOptions,
} from "../../../../packages/engine/src/imports/index.js";

/** The parser's own limit bag, named through the engine's public surface. */
export type ImportLimits = NonNullable<ParseTranscriptOptions["limits"]>;
/** The parser's own refusal codes, likewise. */
export type ImportErrorCode = ImportError["code"];

/** Bumped whenever this shape changes incompatibly. */
export const IMPORT_WORKER_PROTOCOL_VERSION = 1;

/** The hard cap on one message in either direction. */
export const MAX_WORKER_MESSAGE_BYTES = 64 * 1024;

/** Windows long-path and UNC prefixes are absolute; so is a drive or a slash. */
const ABSOLUTE_PATH_PATTERN = /^(\\\\[?.]\\|\\\\|[A-Za-z]:[\\/]|\/)/;

/** Job ids are ours: short, opaque, and safe in a file name. */
const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** What main sends, exactly once, to start the one parse this child performs. */
export interface ImportWorkerRequest {
  v: number;
  jobId: string;
  /**
   * The directory that owns every file this job may touch: the result, the
   * inert project directory and every backend home in the child's environment
   * live beneath it. Main creates it; the child only checks.
   */
  jobRoot: string;
  /** The one transcript the user selected. Never scanned for, never derived. */
  sourcePath: string;
  /** Where the normalized snapshot is written, exclusively. */
  resultPath: string;
  /** An empty directory the Claude SDK is pointed at, so it keys nothing real. */
  inertDir: string;
  /** Overrides may only *tighten* the shipped parser limits. */
  limits?: Partial<ImportLimits>;
}

/** The metadata half of a parsed snapshot — everything except its entries. */
export interface ImportWorkerSummary {
  backend: string;
  format: string;
  nativeId: string;
  title: string | null;
  cwd: string | null;
  startedAt: string | null;
  endedAt: string | null;
  sourceBytes: number;
  sourceSha256: string;
  counts: Record<string, number>;
  warnings: { code: string; message: string; count?: number }[];
  unknownTypes: { type: string; count: number }[];
  complete: boolean;
}

export interface ImportWorkerDone {
  v: number;
  jobId: string;
  ok: true;
  /** Bytes actually written to `resultPath`. */
  resultBytes: number;
  /**
   * Whether the Claude Agent SDK was loaded at all. False for a Codex parse:
   * the reconstruction boundary is lazy, so a rollout never pulls the SDK in.
   */
  sdkLoaded: boolean;
  summary: ImportWorkerSummary;
  /** Fields dropped to keep the message under the cap, if any. */
  omitted?: string[];
}

/** Failure codes: the parser's own, plus this layer's own small set. */
export type ImportWorkerFailureCode =
  | ImportErrorCode
  | "invalid-request"
  | "invalid-environment"
  | "result-exists"
  | "worker-failed";

export interface ImportWorkerFailed {
  v: number;
  jobId: string;
  ok: false;
  code: ImportWorkerFailureCode;
  /** 1-based JSONL line, when the parser attributed the failure to one. */
  line?: number;
}

export type ImportWorkerResponse = ImportWorkerDone | ImportWorkerFailed;

/** A refusal raised while validating a request. Carries no caller text. */
export class WorkerRequestError extends Error {
  readonly code: ImportWorkerFailureCode;
  constructor(code: ImportWorkerFailureCode, message: string) {
    super(message);
    this.name = "WorkerRequestError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Absolute, NUL-free, and free of `..` — this is a path the child is about to
 * open, so "looks absolute" is not enough: a traversal segment could leave the
 * job root the caller believes it granted.
 */
function checkPath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkerRequestError("invalid-request", `${field} must be a non-empty path`);
  }
  if (value.includes("\0")) {
    throw new WorkerRequestError("invalid-request", `${field} contains a NUL byte`);
  }
  // No arbitrary length cap: a legitimate Windows path can be long, and
  // `\\?\` paths exist precisely to be longer than MAX_PATH. The bound that
  // matters is the whole request's size, checked once in `parseWorkerRequest`.
  if (!ABSOLUTE_PATH_PATTERN.test(value)) {
    throw new WorkerRequestError("invalid-request", `${field} must be absolute`);
  }
  const segments = value.split(/[\\/]+/);
  if (segments.some((segment) => segment === "..")) {
    // `\\?\` paths are not normalized by Windows at all, so a traversal
    // segment there is a literal directory name or a mistake. Either way it is
    // not something this worker opens.
    throw new WorkerRequestError("invalid-request", `${field} must not contain ".."`);
  }
  return value;
}

/** Overrides may only tighten; anything else is a programming error, refused. */
function checkLimits(value: unknown): Partial<ImportLimits> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new WorkerRequestError("invalid-request", "limits must be an object");
  }
  const limits: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    const shipped = (IMPORT_LIMITS as unknown as Record<string, number>)[key];
    if (typeof shipped !== "number") {
      throw new WorkerRequestError("invalid-request", "limits names an unknown bound");
    }
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0 || raw > shipped) {
      throw new WorkerRequestError(
        "invalid-request",
        "a limit must be a positive whole number no larger than the shipped one",
      );
    }
    limits[key] = raw;
  }
  return limits as Partial<ImportLimits>;
}

/** Validate a message from main. Throws `WorkerRequestError`; never guesses. */
export function parseWorkerRequest(value: unknown): ImportWorkerRequest {
  if (!isRecord(value)) throw new WorkerRequestError("invalid-request", "request must be an object");
  // The cap applies in both directions, and this is where the inbound half is
  // actually enforced — before any field is read, let alone opened.
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? "";
  } catch {
    throw new WorkerRequestError("invalid-request", "request is not serializable");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_WORKER_MESSAGE_BYTES) {
    throw new WorkerRequestError("invalid-request", "request is larger than the message cap");
  }
  if (value.v !== IMPORT_WORKER_PROTOCOL_VERSION) {
    throw new WorkerRequestError("invalid-request", "unsupported protocol version");
  }
  const jobId = value.jobId;
  if (typeof jobId !== "string" || !JOB_ID_PATTERN.test(jobId)) {
    throw new WorkerRequestError("invalid-request", "jobId must be a short opaque token");
  }
  const jobRoot = checkPath(value.jobRoot, "jobRoot");
  const request: ImportWorkerRequest = {
    v: IMPORT_WORKER_PROTOCOL_VERSION,
    jobId,
    jobRoot,
    sourcePath: checkPath(value.sourcePath, "sourcePath"),
    resultPath: checkPath(value.resultPath, "resultPath"),
    inertDir: checkPath(value.inertDir, "inertDir"),
  };
  const limits = checkLimits(value.limits);
  if (limits) request.limits = limits;
  return request;
}

/**
 * Path comparison, with the platform's own case rule: Windows paths compare
 * case-insensitively, POSIX paths do not — folding case on POSIX would treat
 * `/job/Home` and `/job/home` as the same directory when they are not.
 */
function normalizePath(value: string, caseInsensitive: boolean): string {
  const flat = value.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  return caseInsensitive ? flat.toLowerCase() : flat;
}

/** True when `child` is `parent` itself or lives beneath it. */
export function isWithin(
  parent: string,
  child: string,
  caseInsensitive: boolean = process.platform === "win32",
): boolean {
  const base = normalizePath(parent, caseInsensitive);
  const target = normalizePath(child, caseInsensitive);
  return target === base || target.startsWith(`${base}/`);
}

/** True when two paths name the same location under the platform's case rule. */
export function samePath(
  a: string,
  b: string,
  caseInsensitive: boolean = process.platform === "win32",
): boolean {
  return normalizePath(a, caseInsensitive) === normalizePath(b, caseInsensitive);
}

/**
 * Trim a done message to the cap, dropping the least load-bearing fields first
 * and saying which ones went. Nothing here can grow the message: entries and
 * the source path are never in it to begin with.
 */
export function capDoneMessage(done: ImportWorkerDone): ImportWorkerDone {
  const size = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  if (size(done) <= MAX_WORKER_MESSAGE_BYTES) return done;

  const omitted: string[] = [];
  let trimmed: ImportWorkerDone = done;
  for (const field of ["unknownTypes", "warnings", "title"] as const) {
    omitted.push(field);
    const summary: ImportWorkerSummary = {
      ...trimmed.summary,
      ...(field === "unknownTypes" ? { unknownTypes: [] } : {}),
      ...(field === "warnings" ? { warnings: [] } : {}),
      ...(field === "title" ? { title: null } : {}),
    };
    trimmed = { ...trimmed, summary, omitted: [...omitted] };
    if (size(trimmed) <= MAX_WORKER_MESSAGE_BYTES) return trimmed;
  }
  // Nothing optional is left: report the shape without its variable parts.
  return {
    v: done.v,
    jobId: done.jobId,
    ok: true,
    resultBytes: done.resultBytes,
    sdkLoaded: done.sdkLoaded,
    summary: {
      ...trimmed.summary,
      title: null,
      cwd: null,
      warnings: [],
      unknownTypes: [],
    },
    omitted: [...omitted, "cwd"],
  };
}
