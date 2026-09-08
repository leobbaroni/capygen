/**
 * A `codex app-server` double that speaks the real wire format.
 *
 * It stands in for the child process only — the framing, the id spaces, the
 * request/response pairing and the server→client request path are the
 * production ones in `CodexAppServerClient`, so a test that passes here has
 * exercised the same parser the app runs.
 *
 * Two things it deliberately does *not* do:
 *
 *  - it does not replay a recorded session end to end. The harness issues calls
 *    the Phase 1 spike never made (`skills/list` after `thread/start`), so a
 *    strictly sequential replay would desynchronise on the first one. Instead
 *    requests are answered **by method** and the recorded *notification* frames
 *    (`test/fixtures/codex-frames.json`, lifted verbatim from
 *    `docs/spikes/codex.raw.json`) are pushed by the test at the point the real
 *    server pushed them;
 *  - it does not invent protocol. Anything not in the recording is built from
 *    the generated bindings in `docs/spikes/codex-app-server-schema/v0.153.4-ts`
 *    and the test that uses it says so.
 */
import type {
  CodexTransport,
  CodexTransportFactory,
  CodexTransportHandlers,
} from "../src/codex/CodexAppServerClient.js";

export interface FakeFrame {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Returned by a handler that wants to answer *later*: nothing is written now,
 * and the test delivers the reply itself with `emit({id, result})`. Lets a test
 * hold a request open — the window between `turn/start` being sent and its
 * response arriving, for instance.
 */
export const DEFER: unique symbol = Symbol("capygen.fakeAppServer.defer");

/** Answers one client request. Return the `result`, or throw for an error. */
export type FakeHandler = (params: unknown) => unknown;

export interface FakeAppServerOptions {
  /** Per-method answers. Anything unhandled is answered `{}`. */
  handlers?: Record<string, FakeHandler>;
}

export interface FakeAppServer {
  /** Hand this to `CodexHarness({ transport })`. */
  readonly transport: CodexTransportFactory;
  /** Every frame the client wrote, parsed, in order. */
  readonly sent: FakeFrame[];
  /** True once the client closed the transport. */
  readonly closed: boolean;
  /** Register (or replace) a request handler after construction. */
  on(method: string, handler: FakeHandler): void;
  /** Push a raw server→client frame. */
  emit(frame: FakeFrame): void;
  /** Push a notification. */
  notify(method: string, params?: unknown): void;
  /** Push several recorded frames in order (notifications only). */
  replay(frames: FakeFrame[]): void;
  /** Send a server→client **request**; resolves with the client's answer. */
  ask(method: string, params: unknown): Promise<unknown>;
  /** Resolves with the first client request for `method` (past or future). */
  waitForRequest(method: string): Promise<FakeFrame>;
  /** Kill the child. */
  exit(info?: { code: number | null; signal: string | null }): void;
}

export function createFakeAppServer(options: FakeAppServerOptions = {}): FakeAppServer {
  const handlers = new Map<string, FakeHandler>(Object.entries(options.handlers ?? {}));
  const sent: FakeFrame[] = [];
  const waiters: { method: string; resolve: (frame: FakeFrame) => void }[] = [];
  /** Server request ids live in their own space and start at 0 (spike §2). */
  let nextServerId = 0;
  const awaiting = new Map<
    string | number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();

  let handles: CodexTransportHandlers | null = null;
  let closed = false;

  function deliver(frame: FakeFrame): void {
    if (closed || !handles) return;
    handles.onLine(JSON.stringify(frame));
  }

  function onClientFrame(frame: FakeFrame): void {
    sent.push(frame);

    // An answer to one of our server→client requests.
    if (frame.method === undefined && frame.id !== undefined) {
      const pending = awaiting.get(frame.id);
      if (!pending) return;
      awaiting.delete(frame.id);
      if (frame.error) pending.reject(new Error(frame.error.message));
      else pending.resolve(frame.result);
      return;
    }
    if (frame.method === undefined) return;

    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i];
      if (waiter && waiter.method === frame.method) {
        waiters.splice(i, 1);
        waiter.resolve(frame);
      }
    }
    if (frame.id === undefined) return; // a client notification: nothing to answer

    const handler = handlers.get(frame.method);
    // Answer on a later tick, the way a real process does: a handler that
    // resolved synchronously would let the harness see its own reply before it
    // finished awaiting the send.
    queueMicrotask(() => {
      if (!handler) {
        deliver({ id: frame.id, result: {} });
        return;
      }
      try {
        const answer = handler(frame.params);
        if (answer === DEFER) return;
        deliver({ id: frame.id, result: answer ?? {} });
      } catch (err) {
        deliver({
          id: frame.id,
          error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
        });
      }
    });
  }

  const transport: CodexTransportFactory = (h): CodexTransport => {
    handles = h;
    return {
      write: (line: string) => {
        for (const part of line.split("\n")) {
          if (part.trim().length === 0) continue;
          onClientFrame(JSON.parse(part) as FakeFrame);
        }
      },
      close: async () => {
        closed = true;
      },
    };
  };

  return {
    transport,
    sent,
    get closed() {
      return closed;
    },
    on(method, handler) {
      handlers.set(method, handler);
    },
    emit: deliver,
    notify(method, params) {
      deliver(params === undefined ? { method } : { method, params });
    },
    replay(frames) {
      for (const frame of frames) deliver(frame);
    },
    ask(method, params) {
      const id = nextServerId++;
      return new Promise<unknown>((resolve, reject) => {
        awaiting.set(id, { resolve, reject });
        deliver({ id, method, params });
      });
    },
    waitForRequest(method) {
      const already = sent.find((f) => f.method === method);
      if (already) return Promise.resolve(already);
      return new Promise<FakeFrame>((resolve) => waiters.push({ method, resolve }));
    },
    exit(info = { code: 1, signal: null }) {
      closed = true;
      handles?.onExit({ code: info.code, signal: info.signal });
    },
  };
}

/** Drains the microtask queue (and one macrotask) so pushed frames settle. */
export async function settle(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setTimeout(r, 0));
}
