/**
 * A JSON-RPC client for `codex app-server` over newline-delimited JSON.
 *
 * The framing is the one the Phase 1 spike proved on the wire
 * (`docs/spikes/codex-shapes.md` §2, `packages/engine/scripts/spike-codex.ts`):
 *
 *   - one JSON object per line, both directions, **without** a `"jsonrpc"`
 *     member — the schema bundle has no such property and the server answers
 *     plain `{id, method, params}` frames;
 *   - `{id, method, params}` from the client is a request, `{method, params}` a
 *     notification, `{id, result}` / `{id, error}` an answer;
 *   - the **server** also sends requests (approvals, user input, elicitation,
 *     `currentTime/read`) which the client must answer with `{id, result}` or
 *     `{id, error}`. Server ids live in their own space and start at 0, so
 *     client and server ids overlap — they are told apart by direction, never
 *     by value.
 *
 * The process is behind a `CodexTransport` seam so the harness tests can replay
 * recorded frames without spawning anything (`test/fakeAppServer.ts`); the
 * default transport spawns the bundled binary with `windowsHide` and the
 * cleaned env from `../env.ts` (SPEC §Edge Cases: Windows, non-ASCII paths).
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { cleanEnv, type EnvRecord } from "../env.js";
import { resolveCodexBinary, type CodexBinary, type ResolveCodexBinaryOptions } from "./binary.js";
import {
  CODEX_METHODS,
  type CodexClientInfo,
  type CodexInitializeResponse,
  type CodexRequestId,
  type CodexRpcFrame,
} from "./protocol.js";

export interface CodexClientLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

const NO_LOG: CodexClientLogger = { info: () => {}, warn: () => {}, error: () => {} };

export interface CodexExitInfo {
  code: number | null;
  signal: NodeJS.Signals | string | null;
}

/** What a transport reports back to the client. */
export interface CodexTransportHandlers {
  onLine: (line: string) => void;
  onStderr: (line: string) => void;
  onExit: (info: CodexExitInfo) => void;
}

/** One live `codex app-server` (or a test double standing in for one). */
export interface CodexTransport {
  write: (line: string) => void;
  close: () => Promise<void>;
}

export type CodexTransportFactory = (handlers: CodexTransportHandlers) => CodexTransport;

/** Server → client request handler. Return the result, or throw to send an error. */
export type CodexServerRequestHandler = (
  method: string,
  params: unknown,
) => Promise<unknown> | unknown;

export type CodexNotificationHandler = (method: string, params: unknown) => void;

export interface CodexAppServerClientOptions extends ResolveCodexBinaryOptions {
  /** Injected in tests; the default spawns the resolved binary. */
  transport?: CodexTransportFactory;
  /** Base environment; `cleanEnv` is applied on top. Defaults to `process.env`. */
  spawnEnv?: EnvRecord;
  log?: CodexClientLogger;
  /** Default per-request deadline. */
  requestTimeoutMs?: number;
  clientInfo?: CodexClientInfo;
  /**
   * `InitializeCapabilities` for the handshake. Defaults to the app's own
   * `{experimentalApi: true, requestAttestation: false}`; a probe overrides it
   * to find out which fields the binary gates behind `experimentalApi`.
   */
  capabilities?: { experimentalApi: boolean; requestAttestation: boolean };
  /** Called when the child exits, whether or not capygen asked it to. */
  onExit?: (info: CodexExitInfo) => void;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
/** How many stderr lines are kept, so a crash can be reported with its cause. */
const STDERR_RING = 40;

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Spawn `codex app-server` on stdio. Exported so the desktop app can build one
 * with its own logger, and so the resolution result is inspectable in a log.
 */
export function createStdioTransport(options: {
  binary: CodexBinary;
  env?: EnvRecord;
  log?: CodexClientLogger;
}): CodexTransportFactory {
  const log = options.log ?? NO_LOG;
  return (handlers) => {
    const env = cleanEnv(options.env);
    if (options.binary.pathDirs.length > 0) {
      const key = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
      env[key] = [...options.binary.pathDirs, env[key] ?? ""].join(path.delimiter);
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(options.binary.exe, ["app-server"], {
        env: env as NodeJS.ProcessEnv,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      // A spawn that throws synchronously (ENOENT on some shells) must look the
      // same to the client as one that fails asynchronously.
      queueMicrotask(() => {
        handlers.onStderr(err instanceof Error ? err.message : String(err));
        handlers.onExit({ code: null, signal: null });
      });
      return { write: () => {}, close: async () => {} };
    }
    child.once("error", (err) => {
      handlers.onStderr(`spawn ${options.binary.exe}: ${err.message}`);
      handlers.onExit({ code: null, signal: null });
    });
    child.once("exit", (code, signal) => handlers.onExit({ code, signal }));
    readline
      .createInterface({ input: child.stdout, crlfDelay: Infinity })
      .on("line", (line) => handlers.onLine(line));
    readline
      .createInterface({ input: child.stderr, crlfDelay: Infinity })
      .on("line", (line) => handlers.onStderr(line));

    return {
      write: (line) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.stdin.write(line);
      },
      close: async () => {
        try {
          child.stdin.end();
        } catch {
          /* already gone */
        }
        // Closing stdin is the polite ask; the kill is the guarantee that a
        // backend which ignores it cannot hang the app's shutdown.
        await new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve();
          const timer = setTimeout(() => {
            try {
              child.kill();
            } catch {
              /* ignore */
            }
            resolve();
          }, 1_500);
          timer.unref?.();
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
        log.info("[codex] app-server closed");
      },
    };
  };
}

export class CodexAppServerClient {
  private readonly options: CodexAppServerClientOptions;
  private readonly log: CodexClientLogger;
  private readonly pending = new Map<CodexRequestId, Pending>();
  private readonly notificationHandlers = new Set<CodexNotificationHandler>();
  private readonly stderr: string[] = [];

  private transport: CodexTransport | null = null;
  private nextId = 1;
  private started: Promise<CodexInitializeResponse> | null = null;
  private exited: CodexExitInfo | null = null;
  private closing = false;

  /** Replaced by the harness; the default refuses everything it is asked. */
  serverRequestHandler: CodexServerRequestHandler = (method) => {
    throw new Error(`capygen does not handle the server request ${method}`);
  };

  readonly binary: CodexBinary;

  constructor(options: CodexAppServerClientOptions = {}) {
    this.options = options;
    this.log = options.log ?? NO_LOG;
    this.binary = resolveCodexBinary(options);
  }

  get running(): boolean {
    return this.transport !== null && this.exited === null;
  }

  /** The tail of the child's stderr, for error messages that name a cause. */
  recentStderr(): string {
    return this.stderr.join("\n");
  }

  /** Spawn + `initialize` + the `initialized` notification. Idempotent. */
  start(): Promise<CodexInitializeResponse> {
    this.started ??= this.doStart().catch((err: unknown) => {
      this.started = null;
      throw err;
    });
    return this.started;
  }

  private async doStart(): Promise<CodexInitializeResponse> {
    const factory =
      this.options.transport ??
      createStdioTransport({
        binary: this.binary,
        env: this.options.spawnEnv,
        log: this.log,
      });
    this.exited = null;
    this.transport = factory({
      onLine: (line) => this.onLine(line),
      onStderr: (line) => this.onStderr(line),
      onExit: (info) => this.onExit(info),
    });
    this.log.info(
      `[codex] app-server ${this.binary.exe} (${this.binary.source})`,
    );
    const clientInfo = this.options.clientInfo ?? {
      name: "capygen",
      title: "capygen",
      version: "0.1.0",
    };
    const result = (await this.request(CODEX_METHODS.initialize, {
      clientInfo,
      capabilities: this.options.capabilities ?? {
        experimentalApi: true,
        requestAttestation: false,
      },
    })) as CodexInitializeResponse;
    this.notify(CODEX_METHODS.initialized);
    return result;
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (!this.transport || this.exited) {
      return Promise.reject(new Error(this.exitError(method)));
    }
    const id = this.nextId++;
    const limit = timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex ${method} timed out after ${limit} ms`));
      }, limit);
      timer.unref?.();
      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.send(params === undefined ? { id, method } : { id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.transport || this.exited) return;
    this.send(params === undefined ? { method } : { method, params });
  }

  onNotification(handler: CodexNotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const transport = this.transport;
    this.transport = null;
    this.started = null;
    this.failPending("the codex app-server was closed");
    await transport?.close();
    this.closing = false;
  }

  // -------------------------------------------------------------------------
  // wire
  // -------------------------------------------------------------------------

  private send(frame: CodexRpcFrame): void {
    this.transport?.write(`${JSON.stringify(frame)}\n`);
  }

  private onLine(line: string): void {
    if (line.trim().length === 0) return;
    let frame: CodexRpcFrame;
    try {
      frame = JSON.parse(line) as CodexRpcFrame;
    } catch {
      // The server logs on stderr, so a non-JSON stdout line is a protocol
      // surprise worth recording but never worth crashing a turn over.
      this.log.warn(`[codex] non-JSON line on stdout: ${line.slice(0, 200)}`);
      return;
    }
    if (frame.method !== undefined && frame.id !== undefined) {
      this.handleServerRequest(frame.id, frame.method, frame.params);
      return;
    }
    if (frame.method !== undefined) {
      for (const handler of [...this.notificationHandlers]) {
        try {
          handler(frame.method, frame.params);
        } catch (err) {
          this.log.error(`[codex] notification handler failed for ${frame.method}`, err);
        }
      }
      return;
    }
    if (frame.id === undefined) return;
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.error) {
      const detail = frame.error.data === undefined ? "" : ` ${JSON.stringify(frame.error.data)}`;
      pending.reject(
        new Error(
          `codex ${pending.method} failed: ${frame.error.code} ${frame.error.message}${detail}`,
        ),
      );
      return;
    }
    pending.resolve(frame.result);
  }

  private handleServerRequest(id: CodexRequestId, method: string, params: unknown): void {
    void Promise.resolve()
      .then(() => this.serverRequestHandler(method, params))
      .then(
        (result) => this.send({ id, result: result ?? {} }),
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          this.log.warn(`[codex] server request ${method} refused: ${message}`);
          // -32601 "method not found" is what the spike used for an unhandled
          // server request and what Codex tolerates: it falls back to its own
          // default handling rather than failing the turn.
          this.send({ id, error: { code: -32601, message } });
        },
      );
  }

  private onStderr(line: string): void {
    this.stderr.push(line);
    if (this.stderr.length > STDERR_RING) this.stderr.shift();
    this.log.warn(`[codex:stderr] ${line}`);
  }

  private onExit(info: CodexExitInfo): void {
    if (this.exited) return;
    this.exited = info;
    this.transport = null;
    this.started = null;
    this.failPending(this.exitError("request"));
    this.options.onExit?.(info);
  }

  private exitError(method: string): string {
    const how = this.exited
      ? `exited with code ${this.exited.code ?? "null"}${
          this.exited.signal ? ` (${String(this.exited.signal)})` : ""
        }`
      : "is not running";
    const tail = this.stderr.slice(-5).join("\n");
    return `codex app-server ${how}; ${method} cannot be sent${tail ? `\n${tail}` : ""}`;
  }

  private failPending(message: string): void {
    for (const [id, pending] of [...this.pending]) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new Error(`${pending.method}: ${message}`));
    }
  }
}
