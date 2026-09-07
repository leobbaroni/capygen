/**
 * Bounded main-process client for the one-shot transcript import worker.
 *
 * The child writes inside a unique job directory. Main drains both pipes with
 * hard byte caps, waits for the child to exit, validates the response and the
 * complete result as a stream, then adopts it at the staging path with an
 * exclusive hard link. No preview path materializes the full snapshot.
 */
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import nodeFs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  TranscriptImportEntrySchema,
  TranscriptImportMetadataSchema,
  type TranscriptImportEntry,
  type TranscriptImportMetadata,
} from "@capygen/shared";
import { buildWorkerEnv, workerJobDirs } from "./workerEnv.js";
import {
  IMPORT_WORKER_PROTOCOL_VERSION,
  MAX_WORKER_MESSAGE_BYTES,
  type ImportWorkerDone,
  type ImportWorkerFailureCode,
  type ImportWorkerRequest,
  type ImportWorkerResponse,
  type ImportWorkerSummary,
} from "./workerProtocol.js";

const MAX_ACTIVE_WORKERS = 2;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const RESULT_NAME = "result.json";
const SAFE_FAILURE_CODES = new Set<ImportWorkerFailureCode>([
  "not-a-file", "empty", "compressed", "too-large", "line-too-long",
  "too-many-records", "normalized-too-large", "invalid-utf8", "invalid-json",
  "unsupported-structure", "conflicting-identity", "unknown-format",
  "invalid-request", "invalid-environment", "result-exists", "worker-failed",
]);

export type ImportWorkerClientErrorCode =
  | "invalid-option"
  | "too-many-workers"
  | "cleanup-pending"
  | "cancelled"
  | "timed-out"
  | "output-too-large"
  | "worker-failed"
  | "invalid-response"
  | "invalid-result"
  | "adoption-failed";

export class ImportWorkerClientError extends Error {
  readonly code: ImportWorkerClientErrorCode;
  readonly parseCode?: ImportWorkerFailureCode;
  constructor(code: ImportWorkerClientErrorCode, message: string, parseCode?: ImportWorkerFailureCode) {
    super(message);
    this.name = "ImportWorkerClientError";
    this.code = code;
    if (parseCode !== undefined) this.parseCode = parseCode;
  }
}

export interface UtilityProcessLike extends EventEmitter {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  pid: number | undefined;
  postMessage(message: unknown): void;
  kill(): boolean;
}

export type UtilityProcessFork = (
  modulePath: string,
  args: string[],
  options: {
    env: Record<string, string>;
    cwd: string;
    execArgv: string[];
    stdio: ["ignore", "pipe", "pipe"];
    serviceName: string;
  },
) => UtilityProcessLike;

export interface ImportWorkerClientFs {
  mkdir(dir: string, options?: { recursive?: boolean }): Promise<unknown>;
  lstat(file: string): Promise<{ isFile(): boolean; isSymbolicLink(): boolean; size: number }>;
  open(file: string, flags: string): Promise<Pick<Awaited<ReturnType<typeof nodeFs.open>>, "read" | "close">>;
  link(existing: string, destination: string): Promise<void>;
  unlink(file: string): Promise<void>;
  listDir(dir: string): Promise<Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>>;
  remove(dir: string): Promise<void>;
}

const defaultFs: ImportWorkerClientFs = {
  mkdir: (dir, options) => nodeFs.mkdir(dir, options),
  lstat: (file) => nodeFs.lstat(file),
  open: (file, flags) => nodeFs.open(file, flags),
  link: (existing, destination) => nodeFs.link(existing, destination),
  unlink: (file) => nodeFs.unlink(file),
  listDir: (dir) => nodeFs.readdir(dir, { withFileTypes: true }),
  remove: (dir) => nodeFs.rm(dir, { recursive: true, force: true }),
};

export interface ImportWorkerClientOptions {
  workerPath: string;
  jobsDirectory: string;
  fork: UtilityProcessFork;
  fs?: Partial<ImportWorkerClientFs>;
  envBase?: Record<string, string | undefined>;
  timeoutMs?: number;
  maxActive?: number;
  maxOutputBytes?: number;
  maxSnapshotBytes?: number;
  newJobId?: () => string;
}

export interface ParseToFileOptions {
  signal?: AbortSignal;
  onAdopted?: () => void;
}

export interface ImportWorkerCompleted {
  resultBytes: number;
  sdkLoaded: boolean;
  summary: ImportWorkerSummary;
}

interface JobFailure { code: ImportWorkerClientErrorCode; }
interface ActiveJob {
  controller: AbortController;
  done: Promise<void>;
  finish: () => void;
}

function positive(value: number | undefined, fallback: number, ceiling: number, name: string): number {
  const picked = value ?? fallback;
  if (!Number.isSafeInteger(picked) || picked <= 0 || picked > ceiling) {
    throw new ImportWorkerClientError("invalid-option", `${name} is outside its supported bound`);
  }
  return picked;
}

function absolute(value: string, name: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw new ImportWorkerClientError("invalid-option", `${name} must be an absolute path`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseResponse(value: unknown, jobId: string, sourcePath: string): ImportWorkerResponse {
  let encoded: string;
  try { encoded = JSON.stringify(value) ?? ""; }
  catch { throw new ImportWorkerClientError("invalid-response", "the import worker returned an invalid response"); }
  if (Buffer.byteLength(encoded, "utf8") > MAX_WORKER_MESSAGE_BYTES || !isRecord(value)) {
    throw new ImportWorkerClientError("invalid-response", "the import worker returned an invalid response");
  }
  if (value.v !== IMPORT_WORKER_PROTOCOL_VERSION || value.jobId !== jobId || typeof value.ok !== "boolean") {
    throw new ImportWorkerClientError("invalid-response", "the import worker returned an invalid response");
  }
  if (!value.ok) {
    if (typeof value.code !== "string" || !SAFE_FAILURE_CODES.has(value.code as ImportWorkerFailureCode)) {
      throw new ImportWorkerClientError("invalid-response", "the import worker returned an invalid response");
    }
    return value as unknown as ImportWorkerResponse;
  }
  if (!Number.isSafeInteger(value.resultBytes) || (value.resultBytes as number) <= 0 || typeof value.sdkLoaded !== "boolean") {
    throw new ImportWorkerClientError("invalid-response", "the import worker returned an invalid response");
  }
  if (value.omitted !== undefined && (
    !Array.isArray(value.omitted)
    || value.omitted.some((field) => typeof field !== "string")
  )) {
    throw new ImportWorkerClientError("invalid-response", "the import worker returned an invalid response");
  }
  const metadata = TranscriptImportMetadataSchema.safeParse({ ...(value.summary as object), sourcePath });
  if (!metadata.success) {
    throw new ImportWorkerClientError("invalid-response", "the import worker returned invalid metadata");
  }
  return value as unknown as ImportWorkerDone;
}

function outputGuard(
  stream: NodeJS.ReadableStream | null,
  cap: number,
  fail: (failure: JobFailure) => void,
): () => void {
  if (!stream) return () => undefined;
  let bytes = 0;
  const onData = (chunk: string | Buffer): void => {
    bytes += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk);
    if (bytes > cap) fail({ code: "output-too-large" });
  };
  const onError = (): void => fail({ code: "worker-failed" });
  stream.on("data", onData);
  stream.on("error", onError);
  stream.resume();
  return () => { stream.off("data", onData); stream.off("error", onError); };
}

/** Validate the exact worker serialization incrementally. */
async function validateResult(
  fs: ImportWorkerClientFs,
  file: string,
  response: ImportWorkerDone,
  sourcePath: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<void> {
  const cancelled = (): never => {
    throw new ImportWorkerClientError("cancelled", "the import was cancelled");
  };
  if (signal.aborted) cancelled();
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== response.resultBytes || stat.size > maxBytes) {
    throw new ImportWorkerClientError("invalid-result", "the import worker produced an invalid result");
  }
  // The worker writes the metadata object followed by entries as its final
  // field. Keep only the bounded metadata prefix and the current bounded
  // entry in memory; a maximal transcript never becomes a second string.
  const marker = ',"entries":[';
  let prefix = "";
  let markerSearch = 0;
  let metadata: TranscriptImportMetadata | null = null;
  let entry = "";
  let entryBytes = 0;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let count = 0;
  const totals = { messages: 0, thinking: 0, activities: 0, notices: 0, truncatedTexts: 0 };
  let state: "entry-or-end" | "entry-required" | "entry" | "separator" | "object-end" | "done" = "entry-or-end";

  const invalid = (message = "the import worker produced an invalid result"): never => {
    throw new ImportWorkerClientError("invalid-result", message);
  };
  const acceptEntry = (): void => {
    let raw: unknown;
    try { raw = JSON.parse(entry); } catch { invalid("the import worker produced an invalid entry"); }
    const parsedEntry: TranscriptImportEntry = (() => {
      try { return TranscriptImportEntrySchema.parse(raw); }
      catch { return invalid("the import worker produced an invalid entry"); }
    })();
    if (parsedEntry.index !== count) invalid("the import worker produced an invalid entry");
    if (parsedEntry.kind === "message") totals.messages += 1;
    else if (parsedEntry.kind === "thinking") totals.thinking += 1;
    else if (parsedEntry.kind === "notice") totals.notices += 1;
    else totals.activities += 1;
    if (parsedEntry.truncated) totals.truncatedTexts += 1;
    count += 1;
    entry = "";
    entryBytes = 0;
    state = "separator";
  };
  const feedEntries = (chunk: string): void => {
    for (const char of chunk) {
      if (state === "done") { if (!/\s/.test(char)) invalid(); continue; }
      if (state === "object-end") {
        if (/\s/.test(char)) continue;
        if (char !== "}") invalid();
        state = "done";
        continue;
      }
      if (state === "separator") {
        if (/\s/.test(char)) continue;
        if (char === ",") { state = "entry-required"; continue; }
        if (char === "]") { state = "object-end"; continue; }
        invalid();
      }
      if (state === "entry-or-end" || state === "entry-required") {
        if (/\s/.test(char)) continue;
        if (char === "]" && state === "entry-or-end") { state = "object-end"; continue; }
        if (char !== "{") invalid("the import worker produced an invalid entry");
        state = "entry";
        depth = 1;
        entry = "{";
        entryBytes = 1;
        continue;
      }
      entry += char;
      entryBytes += Buffer.byteLength(char, "utf8");
      if (entryBytes > 512 * 1024) invalid("the import worker produced an invalid entry");
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{" || char === "[") depth += 1;
      else if (char === "}" || char === "]") {
        depth -= 1;
        if (depth === 0) acceptEntry();
        else if (depth < 0) invalid("the import worker produced an invalid entry");
      }
    }
  };
  const feed = (chunk: string): void => {
    if (metadata) { feedEntries(chunk); return; }
    prefix += chunk;
    // Shared metadata permits bounded warning/path strings whose worst JSON
    // control-character escaping is larger than their UTF-8 value size.
    if (Buffer.byteLength(prefix, "utf8") > 4 * 1024 * 1024) invalid();
    let markerAt = prefix.indexOf(marker, markerSearch);
    while (markerAt >= 0) {
      try {
        const candidate = JSON.parse(`${prefix.slice(0, markerAt)}}`) as unknown;
        const parsed = TranscriptImportMetadataSchema.safeParse(candidate);
        if (parsed.success) {
          metadata = parsed.data;
          const remainder = prefix.slice(markerAt + marker.length);
          prefix = "";
          feedEntries(remainder);
          return;
        }
      } catch { /* a marker embedded in a JSON string */ }
      markerSearch = markerAt + marker.length;
      markerAt = prefix.indexOf(marker, markerSearch);
    }
    markerSearch = Math.max(markerSearch, prefix.length - marker.length + 1);
  };

  const handle = await fs.open(file, "r");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  try {
    while (position < stat.size) {
      if (signal.aborted) cancelled();
      const length = Math.min(buffer.byteLength, stat.size - position);
      const read = await handle.read(buffer, 0, length, position);
      if (signal.aborted) cancelled();
      if (read.bytesRead <= 0) invalid();
      position += read.bytesRead;
      feed(decoder.decode(buffer.subarray(0, read.bytesRead), { stream: position < stat.size }));
    }
    feed(decoder.decode());
  } catch (error) {
    if (error instanceof ImportWorkerClientError) throw error;
    invalid();
  } finally {
    await handle.close();
  }

  const finalMetadata = metadata as TranscriptImportMetadata | null;
  const finalState = state as string;
  const acceptedMetadata = finalMetadata ?? invalid();
  if (finalState !== "done" || count !== acceptedMetadata.counts.entries) invalid();
  for (const key of Object.keys(totals) as Array<keyof typeof totals>) {
    if (totals[key] !== acceptedMetadata.counts[key]) invalid();
  }
  const expected = TranscriptImportMetadataSchema.parse({ ...response.summary, sourcePath });
  const omitted = new Set(response.omitted ?? []);
  const comparableActual = { ...acceptedMetadata } as Record<string, unknown>;
  const comparableExpected = { ...expected } as Record<string, unknown>;
  for (const field of omitted) {
    if (!new Set(["unknownTypes", "warnings", "title", "cwd"]).has(field)) invalid();
    delete comparableActual[field];
    delete comparableExpected[field];
  }
  if (!isDeepStrictEqual(comparableActual, comparableExpected)) {
    invalid("the import worker result did not match its preview metadata");
  }
}

export class ImportWorkerClient {
  private readonly workerPath: string;
  private readonly jobsDirectory: string;
  private readonly fork: UtilityProcessFork;
  private readonly fs: ImportWorkerClientFs;
  private readonly base: Record<string, string | undefined>;
  private readonly timeoutMs: number;
  private readonly maxActive: number;
  private readonly maxOutputBytes: number;
  private readonly maxSnapshotBytes: number;
  private readonly makeJobId: () => string;
  private activeCount = 0;
  private readonly ownedRoots = new Set<string>();
  private readonly cleanupFailed = new Set<string>();
  private readonly activeJobs = new Set<ActiveJob>();
  private initializing = false;
  private initialized = false;
  private disposed = false;

  constructor(options: ImportWorkerClientOptions) {
    this.workerPath = absolute(options.workerPath, "workerPath");
    this.jobsDirectory = absolute(options.jobsDirectory, "jobsDirectory");
    this.fork = options.fork;
    this.fs = { ...defaultFs, ...options.fs };
    this.base = options.envBase ?? process.env;
    this.timeoutMs = positive(options.timeoutMs, DEFAULT_TIMEOUT_MS, 24 * 60 * 60 * 1000, "timeoutMs");
    this.maxActive = positive(options.maxActive, MAX_ACTIVE_WORKERS, MAX_ACTIVE_WORKERS, "maxActive");
    this.maxOutputBytes = positive(options.maxOutputBytes, DEFAULT_OUTPUT_BYTES, MAX_WORKER_MESSAGE_BYTES, "maxOutputBytes");
    this.maxSnapshotBytes = positive(options.maxSnapshotBytes, DEFAULT_SNAPSHOT_BYTES, DEFAULT_SNAPSHOT_BYTES, "maxSnapshotBytes");
    this.makeJobId = options.newJobId ?? (() => randomUUID().replaceAll("-", ""));
  }

  active(): number { return this.activeCount; }
  orphaned(): number { return this.cleanupFailed.size; }

  async initialize(): Promise<number> {
    if (this.disposed) throw new ImportWorkerClientError("cancelled", "the import worker client is shut down");
    if (this.initializing || this.initialized || this.activeCount > 0) {
      throw new ImportWorkerClientError("invalid-option", "the import worker client is already initialized");
    }
    this.initializing = true;
    let removed = 0;
    try {
      await this.fs.mkdir(this.jobsDirectory, { recursive: true });
      const entries = await this.fs.listDir(this.jobsDirectory);
      for (const entry of entries) {
        if (!/^job-[A-Za-z0-9_-]{1,64}$/.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
        const dir = path.join(this.jobsDirectory, entry.name);
        this.ownedRoots.add(dir);
        const before = this.ownedRoots.size;
        await this.cleanup(dir);
        if (this.ownedRoots.size < before) removed += 1;
      }
      this.initialized = true;
      return removed;
    } finally {
      this.initializing = false;
    }
  }

  async retryCleanup(): Promise<void> {
    for (const dir of [...this.cleanupFailed]) await this.cleanup(dir);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const job of this.activeJobs) job.controller.abort();
    await Promise.allSettled([...this.activeJobs].map((job) => job.done));
    await this.retryCleanup();
  }

  /** Adapter with the exact shape `ImportStagingService` expects. */
  stageTranscript(
    sourcePath: string,
    destinationPath: string,
    options: { signal: AbortSignal; onCreated: () => void },
  ): Promise<ImportWorkerCompleted> {
    return this.parseToFile(sourcePath, destinationPath, {
      signal: options.signal,
      onAdopted: options.onCreated,
    });
  }

  async parseToFile(
    sourcePath: string,
    destinationPath: string,
    options: ParseToFileOptions = {},
  ): Promise<ImportWorkerCompleted> {
    if (this.disposed) throw new ImportWorkerClientError("cancelled", "the import worker client is shut down");
    if (!this.initialized) throw new ImportWorkerClientError("invalid-option", "the import worker client is not initialized");
    if (this.cleanupFailed.size > 0) {
      throw new ImportWorkerClientError(
        "cleanup-pending",
        "an earlier import job still needs cleanup",
      );
    }
    absolute(sourcePath, "sourcePath");
    absolute(destinationPath, "destinationPath");
    if (this.activeCount >= this.maxActive) {
      throw new ImportWorkerClientError("too-many-workers", "two transcript imports are already running");
    }
    this.activeCount += 1;
    const jobId = this.makeJobId();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(jobId)) {
      this.activeCount -= 1;
      throw new ImportWorkerClientError("invalid-option", "the import worker job id is invalid");
    }
    const jobRoot = path.join(this.jobsDirectory, `job-${jobId}`);
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    let finishJob!: () => void;
    const job: ActiveJob = {
      controller,
      done: new Promise<void>((resolve) => { finishJob = resolve; }),
      finish: () => finishJob(),
    };
    this.activeJobs.add(job);
    let ownsJobRoot = false;
    let child: UtilityProcessLike | null = null;
    try {
      if (signal.aborted) throw new ImportWorkerClientError("cancelled", "the import was cancelled");
      await this.fs.mkdir(this.jobsDirectory, { recursive: true });
      if (signal.aborted) throw new ImportWorkerClientError("cancelled", "the import was cancelled");
      await this.fs.mkdir(jobRoot);
      ownsJobRoot = true;
      this.ownedRoots.add(jobRoot);
      const dirs = workerJobDirs(jobRoot);
      await Promise.all(Object.values(dirs).map((dir) => this.fs.mkdir(dir, { recursive: true })));
      if (signal.aborted) throw new ImportWorkerClientError("cancelled", "the import was cancelled");
      const resultPath = path.join(jobRoot, RESULT_NAME);
      const request: ImportWorkerRequest = {
        v: IMPORT_WORKER_PROTOCOL_VERSION,
        jobId,
        jobRoot,
        sourcePath,
        resultPath,
        inertDir: dirs.inertDir,
      };
      child = this.fork(this.workerPath, [], {
        env: buildWorkerEnv({ jobRoot, base: this.base }),
        cwd: dirs.inertDir,
        execArgv: [],
        stdio: ["ignore", "pipe", "pipe"],
        serviceName: "capygen transcript import",
      });
      const response = await this.runChild(child, request, signal);
      const parsed = parseResponse(response, jobId, sourcePath);
      if (!parsed.ok) {
        throw new ImportWorkerClientError("worker-failed", "the transcript worker refused the selected file", parsed.code);
      }
      if (parsed.resultBytes > this.maxSnapshotBytes) {
        throw new ImportWorkerClientError("invalid-result", "the import worker result exceeded its bound");
      }
      await validateResult(this.fs, resultPath, parsed, sourcePath, this.maxSnapshotBytes, signal);
      if (signal.aborted) throw new ImportWorkerClientError("cancelled", "the import was cancelled");
      try {
        await this.fs.link(resultPath, destinationPath);
      } catch {
        throw new ImportWorkerClientError("adoption-failed", "the import snapshot could not be adopted");
      }
      this.ownedRoots.add(destinationPath);
      try {
        options.onAdopted?.();
        if (signal.aborted) {
          throw new ImportWorkerClientError("cancelled", "the import was cancelled");
        }
      } catch (error) {
        await this.cleanup(destinationPath);
        if (error instanceof ImportWorkerClientError) throw error;
        throw new ImportWorkerClientError("adoption-failed", "the import snapshot could not be adopted");
      }
      // Custody now belongs to the staging operation/caller.
      this.ownedRoots.delete(destinationPath);
      this.cleanupFailed.delete(destinationPath);
      return { resultBytes: parsed.resultBytes, sdkLoaded: parsed.sdkLoaded, summary: parsed.summary };
    } finally {
      this.activeCount -= 1;
      if (ownsJobRoot) await this.cleanup(jobRoot);
      this.activeJobs.delete(job);
      job.finish();
      void child;
    }
  }

  private runChild(
    child: UtilityProcessLike,
    request: ImportWorkerRequest,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let response: unknown;
      let failure: JobFailure | null = null;
      let killed = false;
      const kill = (): void => {
        if (killed) return;
        killed = true;
        try { child.kill(); } catch { /* exit remains the cleanup barrier */ }
      };
      const fail = (next: JobFailure): void => { if (!failure) failure = next; kill(); };
      const stopOut = outputGuard(child.stdout, this.maxOutputBytes, fail);
      const stopErr = outputGuard(child.stderr, this.maxOutputBytes, fail);
      const onAbort = (): void => fail({ code: "cancelled" });
      const timer = setTimeout(() => fail({ code: "timed-out" }), this.timeoutMs);
      const onMessage = (value: unknown): void => { if (response === undefined) response = value; kill(); };
      const onError = (): void => fail({ code: "worker-failed" });
      const onExit = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        stopOut(); stopErr();
        child.off("message", onMessage);
        child.off("error", onError);
        if (failure) {
          reject(new ImportWorkerClientError(failure.code, "the transcript worker did not complete"));
        } else if (response === undefined) {
          reject(new ImportWorkerClientError("worker-failed", "the transcript worker exited without a response"));
        } else {
          resolve(response);
        }
      };
      child.once("exit", onExit);
      child.on("message", onMessage);
      child.on("error", onError);
      signal?.addEventListener("abort", onAbort, { once: true });
      try { child.postMessage(request); }
      catch { fail({ code: "worker-failed" }); }
      if (signal?.aborted) onAbort();
    });
  }

  private async cleanup(dir: string): Promise<void> {
    try {
      await this.fs.remove(dir);
      this.ownedRoots.delete(dir);
      this.cleanupFailed.delete(dir);
    } catch {
      // Keep ownership/accounting so a later maintenance pass can retry.
      if (this.ownedRoots.has(dir)) this.cleanupFailed.add(dir);
    }
  }
}
