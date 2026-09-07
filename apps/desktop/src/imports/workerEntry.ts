/**
 * The import-parser child: one process, one parse, one answer.
 *
 * It never imports Electron. Main runs it as an Electron utility process
 * (`process.parentPort`) and a test runs it as a plain `child_process.fork`
 * (`process.send`); a two-method transport adapter is the whole difference, and
 * everything below it is ordinary Node. That is deliberate — the isolation this
 * file provides has to be testable without an Electron harness to trust it.
 *
 * The order of operations is the security property:
 *
 *   1. accept exactly one message, and validate its shape before touching disk;
 *   2. verify the environment really is job-owned — every home variable points
 *      beneath the job root and exists — *before* any backend library loads;
 *   3. parse the one selected file with the accepted engine parser, pulling the
 *      Claude SDK in lazily, inside the reconstruction callback, so a Codex
 *      rollout never loads it at all;
 *   4. write the normalized snapshot to an exclusively created file and answer
 *      with metadata only.
 *
 * Nothing here spawns a CLI, calls a model, runs a tool or reads a personal
 * config. Errors leaving this process are reduced to a code and a line number:
 * a raw message could carry a path, a credential or a chunk of the transcript.
 */
import fs from "node:fs";
// The parser only, by relative source path: the `@capygen/engine` barrel would
// bundle the Claude/Codex harnesses and the MCP client into a process whose
// whole job is to read one file. The worker's bundle is asserted against that
// in `test/importWorker.test.ts`.
import {
  ImportError,
  createSdkChainReconstructor,
  parseTranscriptFile,
  type ClaudeChainReconstructor,
  type ImportedTranscript,
} from "../../../../packages/engine/src/imports/index.js";
import { workerJobDirs } from "./workerEnv.js";
import {
  IMPORT_WORKER_PROTOCOL_VERSION,
  WorkerRequestError,
  capDoneMessage,
  isWithin,
  parseWorkerRequest,
  samePath,
  type ImportWorkerFailureCode,
  type ImportWorkerRequest,
  type ImportWorkerResponse,
} from "./workerProtocol.js";

/** The two calls this worker needs from whatever channel it was started on. */
export interface WorkerTransport {
  onMessage(handler: (message: unknown) => void): void;
  send(message: ImportWorkerResponse): void;
}

/** Electron's utility-process channel, when this runs as one. */
interface ParentPortLike {
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

/**
 * The narrow adapter. Electron's utility process wraps every message in
 * `{ data }`; `child_process.fork` does not. Nothing else differs, and neither
 * branch imports anything.
 */
export function detectTransport(): WorkerTransport | null {
  const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
  if (parentPort && typeof parentPort.postMessage === "function") {
    return {
      onMessage: (handler) => parentPort.on("message", (event) => handler(event?.data)),
      send: (message) => parentPort.postMessage(message),
    };
  }
  if (typeof process.send === "function") {
    const send = process.send.bind(process);
    return {
      onMessage: (handler) => process.on("message", (message) => handler(message)),
      send: (message) => void send(message),
    };
  }
  return null;
}

/**
 * The environment must be *exactly* the one this job generated, and every
 * directory in it must already exist.
 *
 * "Inside the job root" is not enough: the point of the allowlist is that each
 * variable names a specific generated directory, so each is compared to the
 * value `workerJobDirs` would produce and then stat-ed. `HOMEDRIVE`/`HOMEPATH`
 * are checked as a pair against `USERPROFILE`, because a mismatched pair is
 * exactly how a library reassembles a path that was never granted.
 *
 * This is a confinement *check*, not a filesystem sandbox: it verifies what the
 * parent passed, and nothing here can stop a process that ignores those
 * variables. It never looks at a personal home to make the comparison.
 */
function verifyOwnedEnvironment(request: ImportWorkerRequest, env: NodeJS.ProcessEnv): void {
  const fail = (): never => {
    throw new WorkerRequestError(
      "invalid-environment",
      "the worker environment is not confined to this job's directory",
    );
  };
  if (!isWithin(request.jobRoot, request.inertDir)) fail();
  if (!isWithin(request.jobRoot, request.resultPath)) fail();

  const dirs = workerJobDirs(request.jobRoot);
  if (!samePath(dirs.inertDir, request.inertDir)) fail();

  const expected: Array<[string, string]> = [
    ["HOME", dirs.home],
    ["USERPROFILE", dirs.home],
    ["APPDATA", dirs.appData],
    ["LOCALAPPDATA", dirs.localAppData],
    ["TEMP", dirs.temp],
    ["TMP", dirs.temp],
    ["CLAUDE_CONFIG_DIR", dirs.claudeHome],
    ["CLAUDE_SECURESTORAGE_CONFIG_DIR", dirs.claudeSecureStorage],
    ["CODEX_HOME", dirs.codexHome],
  ];
  for (const [key, want] of expected) {
    const value = env[key];
    if (!value || !samePath(value, want)) fail();
  }
  // The drive-relative pair must reassemble into the same home and nothing else.
  const drive = env.HOMEDRIVE ?? "";
  const homePath = env.HOMEPATH ?? "";
  if (!samePath(`${drive}${homePath}`, dirs.home)) fail();

  // Every generated directory, not a sample of them.
  for (const dir of [request.jobRoot, ...Object.values(dirs)]) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(dir);
    } catch {
      return fail();
    }
    if (!stat.isDirectory()) fail();
  }
  // The source is deliberately *not* required to be inside the job root: it is
  // the user's own selected file. Only what this worker writes is confined.
}

/**
 * The Claude reconstruction boundary, loaded on demand.
 *
 * The dynamic import lives inside the returned callback, so a Codex rollout —
 * which never calls a reconstructor — never loads the SDK. `sdkLoaded` records
 * whether it happened, which is what the tests assert on.
 */
function lazyReconstructor(inertDir: string, state: { sdkLoaded: boolean }): ClaudeChainReconstructor {
  return async (input) => {
    // The same bare-specifier dynamic import the Claude harness uses: the SDK
    // stays external in the bundle so it keeps its own directory layout.
    const sdk = (await import("@anthropic-ai/claude-agent-sdk")) as {
      getSessionMessages?: unknown;
    };
    if (typeof sdk.getSessionMessages !== "function") {
      throw new ImportError(
        "unsupported-structure",
        "the installed Claude Agent SDK exposes no getSessionMessages",
      );
    }
    state.sdkLoaded = true;
    const reconstruct = createSdkChainReconstructor(
      sdk.getSessionMessages as Parameters<typeof createSdkChainReconstructor>[0],
      { dir: inertDir },
    );
    return reconstruct(input);
  };
}

/**
 * The snapshot as JSON, one bounded piece at a time: the envelope, then each
 * entry, then the closing bracket. The entries field moves to the end, so the
 * values and UTF-8 byte count match JSON.stringify(transcript), while property
 * order can differ. No second complete transcript string is allocated.
 */
function* serializeTranscript(transcript: ImportedTranscript): Generator<string> {
  const { entries, ...envelope } = transcript;
  const head = JSON.stringify(envelope);
  // `{...}` → `{...,"entries":[`; an envelope is never empty, so there is
  // always a preceding field to separate from.
  yield `${head.slice(0, -1)},"entries":[`;
  for (let i = 0; i < entries.length; i += 1) {
    yield `${i === 0 ? "" : ","}${JSON.stringify(entries[i])}`;
  }
  yield "]}";
}

/** Every failure leaves as a code, never as text. */
function failureCode(error: unknown): { code: ImportWorkerFailureCode; line?: number } {
  if (error instanceof WorkerRequestError) return { code: error.code };
  if (error instanceof ImportError) {
    return error.line === undefined ? { code: error.code } : { code: error.code, line: error.line };
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "EEXIST") return { code: "result-exists" };
  return { code: "worker-failed" };
}

/**
 * Run one job. Exported for the tests that drive it in-process; the built entry
 * calls it once with the detected transport.
 */
export async function runImportJob(
  request: ImportWorkerRequest,
  env: NodeJS.ProcessEnv,
): Promise<ImportWorkerResponse> {
  const state = { sdkLoaded: false };
  /** Only a file this run created may be cleaned up on failure. */
  let created: string | null = null;
  try {
    verifyOwnedEnvironment(request, env);

    const transcript = await parseTranscriptFile(request.sourcePath, {
      ...(request.limits ? { limits: request.limits } : {}),
      reconstruct: lazyReconstructor(request.inertDir, state),
    });

    // Written in bounded pieces rather than as one big string: the whole
    // snapshot is already in memory as an object, and materializing a second
    // full-size copy (string, then buffer) on top of it is the avoidable part.
    // Property order can change; the values and serialized byte count do not.
    const fd = fs.openSync(request.resultPath, "wx", 0o600);
    created = request.resultPath;
    let resultBytes = 0;
    try {
      const write = (chunk: string): void => {
        // Encode one bounded piece, then finish every short write by byte
        // offset. A filesystem write is allowed to consume fewer bytes than
        // requested, including part of a multibyte character.
        const body = Buffer.from(chunk, "utf8");
        let offset = 0;
        while (offset < body.byteLength) {
          const written = fs.writeSync(fd, body, offset, body.byteLength - offset, null);
          if (written <= 0) throw new Error("import result write made no progress");
          offset += written;
        }
        resultBytes += body.byteLength;
      };
      for (const chunk of serializeTranscript(transcript)) write(chunk);
    } finally {
      fs.closeSync(fd);
    }

    return capDoneMessage({
      v: IMPORT_WORKER_PROTOCOL_VERSION,
      jobId: request.jobId,
      ok: true,
      resultBytes,
      sdkLoaded: state.sdkLoaded,
      summary: {
        backend: transcript.backend,
        format: transcript.format,
        nativeId: transcript.nativeId,
        title: transcript.title,
        cwd: transcript.cwd,
        startedAt: transcript.startedAt,
        endedAt: transcript.endedAt,
        sourceBytes: transcript.sourceBytes,
        sourceSha256: transcript.sourceSha256,
        counts: { ...transcript.counts },
        warnings: transcript.warnings.map((warning) => ({ ...warning })),
        unknownTypes: transcript.unknownTypes.map((tally) => ({ ...tally })),
        complete: transcript.complete,
      },
    });
  } catch (error) {
    if (created) {
      try {
        fs.rmSync(created, { force: true });
      } catch {
        // Best effort: the answer below is what the caller acts on, and the
        // client removes the job directory anyway.
      }
    }
    const { code, line } = failureCode(error);
    return {
      v: IMPORT_WORKER_PROTOCOL_VERSION,
      jobId: request.jobId,
      ok: false,
      code,
      ...(line === undefined ? {} : { line }),
    };
  }
}

/**
 * Wire a transport to exactly one job. A second message is ignored outright —
 * this process parses one file and then has nothing left to offer.
 */
export function serveImportWorker(
  transport: WorkerTransport,
  env: NodeJS.ProcessEnv = process.env,
): void {
  let handled = false;
  transport.onMessage((message) => {
    if (handled) return;
    handled = true;
    void (async () => {
      let request: ImportWorkerRequest | null = null;
      try {
        request = parseWorkerRequest(message);
      } catch (error) {
        const jobId =
          typeof (message as { jobId?: unknown })?.jobId === "string" &&
          (message as { jobId: string }).jobId.length <= 64
            ? (message as { jobId: string }).jobId
            : "";
        transport.send({
          v: IMPORT_WORKER_PROTOCOL_VERSION,
          jobId,
          ok: false,
          code: failureCode(error).code,
        });
        return;
      }
      transport.send(await runImportJob(request, env));
    })();
  });
}

// Started as a child (utility process or fork): serve. Imported by a test:
// nothing happens until it asks.
const transport = detectTransport();
if (transport) serveImportWorker(transport);
