/**
 * The MCP catalogue contract (Phase 9, `docs/plans/phase9.md` §Catalogue).
 *
 * What a backend can honestly say about the MCP servers *its own runtime* has,
 * and nothing else. Three properties decide every type in this file:
 *
 *  - **Metadata only.** Server labels, a connection state and tool *names*. No
 *    schemas, descriptions, URLs, commands, environment values, headers,
 *    backend session identifiers, or raw backend error text. A catalogue is
 *    something the user reads; none of that belongs in it, and several parts of
 *    it are secrets.
 *  - **Absence is a state, not an empty list.** "This backend has no catalogue
 *    surface", "the harness has not started", "the query failed" and "this
 *    server is connected and genuinely has no tools" are four different
 *    answers, and a UI that renders them the same way is lying about one of
 *    them. Hence a discriminated union rather than an array plus a flag.
 *  - **Bounded.** Server and tool counts and name lengths are clamped here, at
 *    the boundary, because the names come from whatever MCP server the user
 *    configured — including a hostile one.
 *
 * These types are engine-local on purpose. Nothing here crosses IPC as-is; the
 * desktop maps it to whatever the renderer contract turns out to be, and this
 * file has no dependency on that decision.
 */

/**
 * A server's connection state, normalised across three backends.
 *
 * `notStarted` and `unknown` are deliberately separate: Codex reports a
 * `runtimeStatus` of `null` when the configuration changed under it, which is
 * not the same claim as "this server has not been started".
 */
export type CatalogueServerState =
  | "connected"
  | "failed"
  | "needsAuth"
  | "pending"
  | "disabled"
  | "notStarted"
  | "cancelled"
  | "unknown";

export interface CatalogueServer {
  /**
   * The server's own name, byte-identical to what the backend reported — this
   * is the identity a later lookup matches on, so it is never rewritten. A name
   * that cannot be used as-is (too long, or carrying control or bidi
   * characters) is omitted entirely and disclosed through `truncated`.
   */
  name: string;
  state: CatalogueServerState;
  /** Tool names only. Sorted for a stable render; duplicates collapsed. */
  tools: string[];
  /** A tool list, or a name, that did not fit the bounds in this file. */
  truncated: boolean;
}

/**
 * The answer to one catalogue query.
 *
 * `error` carries no message on purpose. A backend's failure text can name a
 * command line, a URL with a token in it, or a file path; the desktop turns
 * this into one actionable state, and the detail stays in the engine's log.
 */
export type ToolCatalogue =
  | { kind: "ok"; servers: CatalogueServer[]; truncated: boolean }
  /** This backend exposes no catalogue surface at all. */
  | { kind: "unsupported" }
  /** No live runtime, and the caller did not ask to start one. */
  | { kind: "notStarted" }
  /** The query failed. Generic by design — see above. */
  | { kind: "error" }
  /** The caller's signal aborted, or the query outran its deadline. */
  | { kind: "cancelled" }
  /**
   * The runtime this answer came from is no longer the runtime the harness has
   * — a restart, a dispose, a new backend session mid-flight. The result is
   * discarded rather than shown as current.
   */
  | { kind: "stale" };

export interface CatalogueOptions {
  /** Cancels the query; the answer becomes `cancelled`. */
  signal?: AbortSignal | undefined;
  /** Hard deadline for the whole query. */
  timeoutMs?: number | undefined;
  /**
   * Whether an explicit refresh may start the backend runtime.
   *
   * `false` (the default) answers `notStarted` rather than launching a child
   * process to populate a list nobody asked to populate. The desktop passes
   * `true` only for a user-initiated refresh.
   */
  initialize?: boolean | undefined;
}

/** Servers kept in the answer before the rest are dropped and `truncated` is set. */
export const MAX_SERVERS = 100;
/** Tools kept per server before the rest are dropped. */
export const MAX_TOOLS_PER_SERVER = 250;
/**
 * Entries *looked at* per list, which is a different bound from the two above.
 *
 * [review] The accept-caps alone were not a bound at all: the loop stopped when
 * it had gathered enough *unique, valid* names, so a server offering five
 * million duplicate — or five million malformed — names was walked end to end
 * to produce one row. A hostile or merely broken server must cost a fixed
 * amount of work, so the scan itself is capped and the overflow is disclosed.
 */
export const MAX_SCANNED_SERVERS = 500;
export const MAX_SCANNED_TOOLS_PER_SERVER = 1_000;
/**
 * Longest name kept. A name is an **identity**, so an overlong one is dropped
 * rather than shortened: two names sharing a 512-character prefix would clamp
 * to the same string and become indistinguishable.
 */
export const MAX_NAME_CHARS = 512;
/**
 * Ceiling on the whole answer's serialised size.
 *
 * Every per-item bound can be satisfied while the total is still tens of
 * megabytes (100 servers x 250 tools x 512 chars), and this DTO is destined for
 * a renderer.
 */
export const MAX_CATALOGUE_BYTES = 256 * 1024;
/** Default deadline for one caller waiting on a catalogue query. */
export const DEFAULT_CATALOGUE_TIMEOUT_MS = 15_000;
/** Default ceiling on the shared operation itself, whatever its callers do. */
export const DEFAULT_CATALOGUE_OPERATION_TIMEOUT_MS = 30_000;

/**
 * Characters that may not appear in a name capygen will show or match on.
 *
 * C0/C1 controls and DEL corrupt a log line and a terminal; the bidi and
 * isolate formatters (U+061C, U+200E/F, U+202A-E, U+2066-9) reorder rendered
 * text, so a name can display as something other than what it matches. Neither
 * belongs in an identity, and neither is repairable by editing the string —
 * that would mint a new identity — so a name containing one is omitted.
 */
const FORBIDDEN_IN_NAME =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

/**
 * The exact name, or `null` when it cannot be used.
 *
 * Never rewrites: the caller discloses the omission through `truncated`, and
 * what survives is byte-identical to what the backend reported, because a
 * later lookup matches on it. Whitespace is deliberately *not* trimmed.
 */
export function acceptName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length === 0 || raw.length > MAX_NAME_CHARS) return null;
  if (FORBIDDEN_IN_NAME.test(raw)) return null;
  return raw;
}

/** One server's raw metadata, before bounds are applied. */
export interface RawCatalogueServer {
  name: unknown;
  state: CatalogueServerState;
  toolNames: readonly unknown[];
  /** Set when this server's own tool list was already incomplete at the source. */
  truncated?: boolean;
}

/**
 * The bytes a string actually occupies once it is serialised, quotes included.
 *
 * [review] Not `Buffer.byteLength(name)`. `"` and `\` are both legal in an MCP
 * tool name and both become two bytes under `JSON.stringify`, so a budget kept
 * in raw UTF-8 bytes under-counts an adversarial name by a factor of two and
 * the aggregate ceiling stops being a guarantee. Non-ASCII needs no correction
 * — `JSON.stringify` leaves it literal — which is why measuring the *encoded*
 * form rather than applying a fudge factor is the only accounting that holds.
 */
function jsonBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), "utf8");
}

/** Every state, so the fixed overhead is reserved against the longest one. */
const ALL_STATES: readonly CatalogueServerState[] = [
  "connected",
  "failed",
  "needsAuth",
  "pending",
  "disabled",
  "notStarted",
  "cancelled",
  "unknown",
];

const LONGEST_STATE = ALL_STATES.reduce((a, b) => (b.length > a.length ? b : a));

/** `{"kind":"ok","servers":[],"truncated":false}` — the envelope, exactly. */
const ENVELOPE_BYTES = Buffer.byteLength(
  JSON.stringify({ kind: "ok", servers: [], truncated: false }),
  "utf8",
);

/**
 * One server row's punctuation, keys, state and flag — everything but its own
 * name and its tools. The empty name contributes two quote bytes which
 * `jsonBytes(name)` supplies again, so they are subtracted; the trailing `+ 1`
 * reserves the comma joining this row to the previous one (charged for the
 * first row too, which only ever over-reserves).
 */
const SERVER_OVERHEAD_BYTES =
  Buffer.byteLength(
    JSON.stringify({ name: "", state: LONGEST_STATE, tools: [], truncated: false }),
    "utf8",
  ) -
  2 +
  1;

/**
 * Apply every bound in one place, so three backends cannot disagree about them.
 *
 * Four separate limits, because they fail in different ways: how much is
 * *scanned* (a hostile list), how much is *kept* (a large honest list), how
 * long one name may be (an identity), and how large the answer may get in
 * total (a renderer's budget). Anything dropped by any of them sets
 * `truncated`, so an incomplete answer is never presented as a complete one.
 */
export function boundCatalogue(
  raw: readonly RawCatalogueServer[],
  /** The source said there were more *servers* than it returned. */
  moreServers = false,
): ToolCatalogue {
  const servers: CatalogueServer[] = [];
  const scanLimit = Math.min(raw.length, MAX_SCANNED_SERVERS);
  let truncated = moreServers || raw.length > scanLimit;
  // Reserved up front, so the ceiling covers the whole serialised answer and
  // not merely the strings inside it.
  let budget = MAX_CATALOGUE_BYTES - ENVELOPE_BYTES;

  for (let index = 0; index < scanLimit; index += 1) {
    if (servers.length >= MAX_SERVERS) {
      truncated = true;
      break;
    }
    const entry = raw[index];
    if (!entry) {
      truncated = true;
      continue;
    }
    const name = acceptName(entry.name);
    if (name === null) {
      // Omitted, not renamed. A server we cannot name is one the user cannot
      // act on, and a clamped name could shadow a legitimate one.
      truncated = true;
      continue;
    }
    const cost = jsonBytes(name) + SERVER_OVERHEAD_BYTES;
    if (cost > budget) {
      truncated = true;
      break;
    }
    budget -= cost;

    let serverTruncated = entry.truncated === true;
    const names = new Set<string>();
    const toolNames = entry.toolNames ?? [];
    const toolScanLimit = Math.min(toolNames.length, MAX_SCANNED_TOOLS_PER_SERVER);
    if (toolNames.length > toolScanLimit) serverTruncated = true;
    for (let cursor = 0; cursor < toolScanLimit; cursor += 1) {
      if (names.size >= MAX_TOOLS_PER_SERVER) {
        serverTruncated = true;
        break;
      }
      const tool = acceptName(toolNames[cursor]);
      if (tool === null) {
        serverTruncated = true;
        continue;
      }
      if (names.has(tool)) continue;
      // The name as it will be serialised, plus the comma that will separate it
      // from the previous tool.
      const toolCost = jsonBytes(tool) + 1;
      if (toolCost > budget) {
        serverTruncated = true;
        truncated = true;
        break;
      }
      budget -= toolCost;
      names.add(tool);
    }
    servers.push({
      name,
      state: entry.state,
      tools: [...names].sort(),
      truncated: serverTruncated,
    });
    truncated ||= serverTruncated;
  }
  return { kind: "ok", servers, truncated };
}

// ---------------------------------------------------------------------------
// The shared runner
// ---------------------------------------------------------------------------

/**
 * Why a catalogue came back as `error` or `cancelled`, in a fixed vocabulary.
 *
 * [review] Deliberately *not* the backend's own exception. A failed MCP launch
 * quotes the command line it tried, an HTTP server quotes the URL it dialled,
 * and either can carry a token or a path into a log file that outlives the
 * session. The contract already forbids raw failures crossing to the renderer;
 * a logger is not an exemption from it.
 */
export type CatalogueFailureCode = "initialize_failed" | "fetch_failed" | "operation_timeout";

/**
 * Everything three harnesses would otherwise each get subtly wrong: joining
 * concurrent refreshes, honouring a signal and a deadline, bounding the shared
 * work itself, and discarding a result whose runtime is no longer the one that
 * produced it.
 *
 * `lifecycle()` returns an opaque token identifying the current backend
 * runtime — a query object, a thread id, a pool. It is read around both the
 * initialization and the query, and a change means `stale`: the answer
 * describes a session the harness no longer has, and showing it as current
 * would be a lie that survives until the next refresh.
 */
export interface CatalogueRunnerDeps {
  /**
   * Bring the backend runtime up if it is not already.
   *
   * Split from `fetch` because initialization is what *creates* the runtime:
   * the lifecycle token is compared across it rather than sampled once, so a
   * dispose or restart that lands mid-initialization is caught.
   */
  initialize?: (signal: AbortSignal) => Promise<void>;
  lifecycle: () => unknown;
  /** The actual backend query. Rejections become `error`, never a message. */
  fetch: (signal: AbortSignal) => Promise<
    | readonly RawCatalogueServer[]
    | { servers: readonly RawCatalogueServer[]; moreServers?: boolean }
  >;
  /** A fixed code — never an error object, a message or a stack. */
  onFailure?: (code: CatalogueFailureCode) => void;
  /**
   * Ceiling on the shared operation, independent of any caller's deadline.
   *
   * Past it the request is abandoned and `cancelled` is published — but it
   * keeps its claim on the runtime: later refreshes answer `cancelled` without
   * issuing anything until it finally settles or the runtime is replaced (see
   * `CatalogueRunner.abandoned`). Non-finite or non-positive values fall back
   * to `DEFAULT_CATALOGUE_OPERATION_TIMEOUT_MS`.
   */
  operationTimeoutMs?: number;
}

/**
 * One underlying backend request, and everything needed to decide whether it is
 * still worth waiting on.
 */
interface Operation {
  readonly controller: AbortController;
  /** The bounded view every caller awaits. */
  readonly promise: Promise<ToolCatalogue>;
  /** The runtime this request is bound to, sampled once initialization is done. */
  lifecycle: unknown;
  /** True once the *underlying* work settled, however late that was. */
  settled: boolean;
}

/** Any deadline the caller supplies, made finite and positive. */
function normalizeDeadline(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

/** One in-flight catalogue, shared by every caller that asks while it runs. */
export class CatalogueRunner {
  private inFlight: Operation | null = null;
  /**
   * A request whose deadline expired while the backend was still working on it.
   *
   * [review] The previous version simply forgot it and let the next refresh
   * start another — so a wedged CLI control request produced a fresh one every
   * thirty seconds, none of which could be cancelled. Stacking abandoned SDK
   * requests is not recovery; it is a leak with a timer. Neither
   * `Query.mcpServerStatus()` nor an app-server round trip is genuinely
   * abortable, so the honest bound is **one** unresolved request per runtime:
   * later refreshes answer `cancelled` until either it finally settles or the
   * runtime itself is replaced, both of which are real recoveries.
   */
  private abandoned: Operation | null = null;

  constructor(private readonly deps: CatalogueRunnerDeps) {}

  run(options: CatalogueOptions = {}): Promise<ToolCatalogue> {
    // Before anything else, and before `initialize`: a refresh the caller has
    // already cancelled must not spawn a CLI child or open an app-server thread
    // on its way to answering "cancelled".
    if (options.signal?.aborted) return Promise.resolve({ kind: "cancelled" });
    // Joined, not queued: a second refresh while one is running wants the same
    // answer, not a second SDK query or a second app-server round trip.
    if (this.inFlight) return this.race(this.inFlight.promise, options);
    if (this.blockedByAbandoned()) return Promise.resolve({ kind: "cancelled" });
    return this.race(this.begin().promise, options);
  }

  /**
   * Whether a previously abandoned request still owns the backend.
   *
   * It stops owning it when it settles (the backend answered at last, however
   * uselessly) or when the runtime it was bound to is gone — a disposed or
   * restarted harness cannot still be servicing it.
   */
  private blockedByAbandoned(): boolean {
    const stuck = this.abandoned;
    if (!stuck) return false;
    if (stuck.settled || this.deps.lifecycle() !== stuck.lifecycle) {
      this.abandoned = null;
      return false;
    }
    return true;
  }

  private begin(): Operation {
    const controller = new AbortController();
    const operation: Operation = {
      controller,
      lifecycle: this.deps.lifecycle(),
      settled: false,
      promise: undefined as unknown as Promise<ToolCatalogue>,
    };
    const raw = this.execute(controller.signal, (token) => {
      operation.lifecycle = token;
    });
    // Registered before the bounded view, and with both handlers, so an
    // abandoned rejection is never unhandled and the slot is always released.
    void raw.then(
      () => this.onSettled(operation),
      () => this.onSettled(operation),
    );
    (operation as { promise: Promise<ToolCatalogue> }).promise = this.bound(operation, raw);
    this.inFlight = operation;
    return operation;
  }

  private onSettled(operation: Operation): void {
    operation.settled = true;
    if (this.inFlight === operation) this.inFlight = null;
    if (this.abandoned === operation) this.abandoned = null;
  }

  /**
   * The caller-visible view of one operation, bounded by the operation's own
   * ceiling. On expiry the signal is aborted — advisory, since neither
   * backend's status call is truly cancellable — the request is moved to
   * `abandoned`, and `cancelled` is published. Whatever it eventually produces
   * is dropped: it can no longer resolve this promise and is never cached.
   */
  private bound(operation: Operation, raw: Promise<ToolCatalogue>): Promise<ToolCatalogue> {
    const ceiling = normalizeDeadline(
      this.deps.operationTimeoutMs,
      DEFAULT_CATALOGUE_OPERATION_TIMEOUT_MS,
    );
    return new Promise<ToolCatalogue>((resolve) => {
      let settled = false;
      const finish = (value: ToolCatalogue): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        operation.controller.abort();
        if (!operation.settled) {
          if (this.inFlight === operation) this.inFlight = null;
          this.abandoned = operation;
        }
        this.deps.onFailure?.("operation_timeout");
        finish({ kind: "cancelled" });
      }, ceiling);
      timer.unref?.();
      raw.then(finish, () => finish({ kind: "error" }));
    });
  }

  private async execute(
    signal: AbortSignal,
    onStarted: (lifecycle: unknown) => void,
  ): Promise<ToolCatalogue> {
    const before = this.deps.lifecycle();
    if (this.deps.initialize) {
      try {
        await this.deps.initialize(signal);
      } catch {
        // Silent when the operation was given up on: a failure line for work
        // nobody is waiting on is noise, and the code is already recorded.
        if (!signal.aborted) this.deps.onFailure?.("initialize_failed");
        return { kind: "error" };
      }
    }
    // [review] Checked after every await, before any further work: an
    // initialization that resolves past the deadline must not fall through and
    // issue the query anyway.
    if (signal.aborted) return { kind: "cancelled" };

    const started = this.deps.lifecycle();
    onStarted(started);
    // Nothing live once initialization returned: the runtime was disposed while
    // it was being built. Not an error — there is no session to describe.
    if (started === null || started === undefined) return { kind: "stale" };
    // A runtime that existed before and is a *different* one now was restarted
    // underneath this query.
    if (before !== null && before !== undefined && before !== started) return { kind: "stale" };

    let raw: readonly RawCatalogueServer[];
    let more = false;
    try {
      const fetched = await this.deps.fetch(signal);
      if (Array.isArray(fetched)) {
        raw = fetched;
      } else {
        const page = fetched as { servers: readonly RawCatalogueServer[]; moreServers?: boolean };
        raw = page.servers;
        more = page.moreServers === true;
      }
    } catch {
      if (!signal.aborted) this.deps.onFailure?.("fetch_failed");
      return { kind: "error" };
    }
    if (signal.aborted) return { kind: "cancelled" };
    if (this.deps.lifecycle() !== started) return { kind: "stale" };
    return boundCatalogue(raw, more);
  }

  /**
   * The caller's own deadline and signal, applied to a shared operation.
   *
   * Deliberately per-caller: one caller cancelling must not cancel the work a
   * second caller is still waiting on, so this races rather than aborting the
   * shared operation. The operation's own ceiling is what bounds that.
   */
  private race(work: Promise<ToolCatalogue>, options: CatalogueOptions): Promise<ToolCatalogue> {
    const { signal } = options;
    const deadline = normalizeDeadline(options.timeoutMs, DEFAULT_CATALOGUE_TIMEOUT_MS);
    return new Promise<ToolCatalogue>((resolve) => {
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const finish = (value: ToolCatalogue): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const onAbort = (): void => finish({ kind: "cancelled" });
      const timer = setTimeout(() => finish({ kind: "cancelled" }), deadline);
      timer.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
      work.then(finish, () => finish({ kind: "error" }));
    });
  }
}
