/**
 * The MCP catalogue across all three backends (Phase 9).
 *
 * Everything here is metadata-only and model-free: the assertions that matter
 * most are the negative ones — no prompt is ever enqueued, no second server
 * process is spawned, and nothing but names and states leaves the harness.
 */
import { describe, expect, it, vi } from "vitest";
import { ApiHarness } from "../src/api/ApiHarness.js";
import { ClaudeHarness } from "../src/claude/ClaudeHarness.js";
import { CodexHarness } from "../src/codex/CodexHarness.js";
import { McpClientPool } from "../src/mcp/client/McpClientPool.js";
import {
  CatalogueRunner,
  MAX_CATALOGUE_BYTES,
  MAX_NAME_CHARS,
  MAX_SCANNED_SERVERS,
  MAX_SCANNED_TOOLS_PER_SERVER,
  MAX_SERVERS,
  MAX_TOOLS_PER_SERVER,
  boundCatalogue,
} from "../src/catalogue/types.js";
import type { HarnessAgent, HarnessSession } from "../src/harness.js";
import { createFakeAppServer, settle } from "./codexFakeAppServer.js";
import { AsyncQueue } from "../src/asyncQueue.js";
import type { McpSdk } from "../src/mcp/client/sdk.js";
import type { ClaudeQuery, ClaudeQueryFn, SDKUserMessage } from "../src/claude/sdk.js";

/**
 * A `query()` double with just enough of the control surface for a catalogue:
 * it never yields a message, so no turn can complete, and it records anything
 * pushed into the streaming input so a test can prove no prompt was sent.
 */
function catalogueQuery(control: {
  mcpServerStatus?: () => Promise<unknown[]>;
  onInput?: (message: SDKUserMessage) => void;
  onQuery?: () => void;
}): ClaudeQueryFn {
  return ({ prompt }) => {
    control.onQuery?.();
    const out = new AsyncQueue<never>();
    void (async () => {
      if (typeof prompt === "string") return;
      for await (const message of prompt) control.onInput?.(message);
    })();
    const generator = (async function* () {
      yield* out;
    })();
    return Object.assign(generator, {
      interrupt: async (): Promise<undefined> => {
        out.close();
        return undefined;
      },
      ...(control.mcpServerStatus ? { mcpServerStatus: control.mcpServerStatus } : {}),
    }) as unknown as ClaudeQuery;
  };
}

const SESSION: HarnessSession = { sessionId: "ses_cat", projectPath: "C:\\capygen" };

function agent(overrides: Partial<HarnessAgent> = {}): HarnessAgent {
  return {
    agentId: "agent_cat",
    name: "cat",
    backend: "claude",
    model: "claude-opus-4-5",
    resumeSessionId: null,
    config: null,
    ...overrides,
  } as HarnessAgent;
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

describe("Claude catalogue", () => {
  function rig(status: unknown[]) {
    const pushed: unknown[] = [];
    const harness = new ClaudeHarness({
      query: catalogueQuery({
        onInput: (message) => pushed.push(message),
        mcpServerStatus: async () => status,
      }),
    });
    return { harness, pushed };
  }

  it("answers notStarted rather than launching a backend to fill a list", async () => {
    const { harness, pushed } = rig([]);
    await harness.start(SESSION, agent());
    expect(await harness.catalogue!()).toEqual({ kind: "notStarted" });
    expect(pushed).toEqual([]);
    await harness.dispose();
  });

  it("initializes on an explicit refresh and sends no prompt", async () => {
    const { harness, pushed } = rig([
      {
        name: "files",
        status: "connected",
        tools: [{ name: "read", description: "leaks nothing" }, { name: "write" }],
      },
      { name: "broken", status: "failed", error: "spawn C:/secret/token.exe ENOENT" },
      { name: "off", status: "disabled" },
      { name: "auth", status: "needs-auth" },
      { name: "empty", status: "connected", tools: [] },
    ]);
    await harness.start(SESSION, agent());
    const result = await harness.catalogue!({ initialize: true });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.servers).toEqual([
      { name: "files", state: "connected", tools: ["read", "write"], truncated: false },
      { name: "broken", state: "failed", tools: [], truncated: false },
      { name: "off", state: "disabled", tools: [], truncated: false },
      { name: "auth", state: "needsAuth", tools: [], truncated: false },
      { name: "empty", state: "connected", tools: [], truncated: false },
    ]);
    // Metadata only: no description, and no raw backend error text anywhere.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("leaks nothing");
    expect(serialized).not.toContain("ENOENT");
    expect(serialized).not.toContain("secret");
    // And no model input was ever enqueued.
    expect(pushed).toEqual([]);
    await harness.dispose();
  });

  it("joins simultaneous refreshes into one query and one initialization", async () => {
    let calls = 0;
    let queries = 0;
    const harness = new ClaudeHarness({
      query: catalogueQuery({
        onQuery: () => (queries += 1),
        mcpServerStatus: async () => {
          calls += 1;
          await new Promise((r) => setTimeout(r, 20));
          return [{ name: "one", status: "connected", tools: [] }];
        },
      }),
    });
    await harness.start(SESSION, agent());
    const [a, b, c] = await Promise.all([
      harness.catalogue!({ initialize: true }),
      harness.catalogue!({ initialize: true }),
      harness.catalogue!({ initialize: true }),
    ]);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(calls).toBe(1);
    // The concurrency guard also covers `ensureQuery`: three racing callers
    // must not each build a streaming session.
    expect(queries).toBe(1);
    await harness.dispose();
  });

  it("reports a generic error, never the backend's own words", async () => {
    const harness = new ClaudeHarness({
      query: catalogueQuery({
        mcpServerStatus: async () => {
          throw new Error("connect ECONNREFUSED https://user:pw@host/mcp");
        },
      }),
    });
    await harness.start(SESSION, agent());
    const result = await harness.catalogue!({ initialize: true });
    expect(result).toEqual({ kind: "error" });
    await harness.dispose();
  });

  it("cancels on the caller's signal", async () => {
    const abort = new AbortController();
    const harness = new ClaudeHarness({
      query: catalogueQuery({
        mcpServerStatus: () => new Promise(() => {}),
      }),
    });
    await harness.start(SESSION, agent());
    const pending = harness.catalogue!({ initialize: true, signal: abort.signal });
    await settle();
    abort.abort();
    expect(await pending).toEqual({ kind: "cancelled" });
    await harness.dispose();
  });

  it("discards a result whose runtime was disposed mid-flight", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = new ClaudeHarness({
      query: catalogueQuery({
        mcpServerStatus: async () => {
          await gate;
          return [{ name: "one", status: "connected", tools: [] }];
        },
      }),
    });
    await harness.start(SESSION, agent());
    const pending = harness.catalogue!({ initialize: true });
    await settle();
    await harness.dispose();
    release!();
    expect(await pending).toEqual({ kind: "stale" });
  });

  it("bounds hostile metadata", async () => {
    const harness = new ClaudeHarness({
      query: catalogueQuery({
        mcpServerStatus: async () => [
          {
            // An unusable *server* name: omitted rather than rewritten, because
            // a clamped name is a different identity that can collide.
            name: `evil\u0000\u001b[31m${"N".repeat(MAX_NAME_CHARS * 4)}`,
            status: "connected",
            tools: [{ name: "hidden" }],
          },
          {
            name: "legible",
            status: "connected",
            tools: Array.from({ length: MAX_TOOLS_PER_SERVER + 40 }, (_, i) => ({
              name: `tool_${i}`,
            })),
          },
          ...Array.from({ length: MAX_SERVERS + 10 }, (_, i) => ({
            name: `s${i}`,
            status: "connected" as const,
            tools: [],
          })),
        ],
      }),
    });
    await harness.start(SESSION, agent());
    const result = await harness.catalogue!({ initialize: true });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.servers.length).toBeLessThanOrEqual(MAX_SERVERS);
    expect(result.truncated).toBe(true);
    // The hostile row is gone, not renamed into something that could shadow a
    // real server, and its tools left with it.
    expect(result.servers.some((s) => s.name.includes("\u0000"))).toBe(false);
    expect(result.servers.some((s) => s.name.startsWith("evil"))).toBe(false);
    expect(JSON.stringify(result)).not.toContain("hidden");
    const legible = result.servers.find((s) => s.name === "legible")!;
    expect(legible.tools.length).toBeLessThanOrEqual(MAX_TOOLS_PER_SERVER);
    expect(legible.truncated).toBe(true);
    await harness.dispose();
  });
});

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

describe("Codex catalogue", () => {
  const THREAD = { thread: { id: "thread_cat" } };

  function rig(handler: (params: unknown) => unknown) {
    let threadStarts = 0;
    const server = createFakeAppServer({
      handlers: {
        initialize: () => ({}),
        "thread/start": () => {
          threadStarts += 1;
          return THREAD;
        },
        "skills/list": () => ({ data: [] }),
        "mcpServerStatus/list": handler,
      },
    });
    const harness = new CodexHarness({ transport: server.transport });
    return { server, harness, threadStarts: () => threadStarts };
  }

  it("answers notStarted without spawning an app-server", async () => {
    const { harness, server, threadStarts } = rig(() => ({ data: [] }));
    await harness.start(SESSION, agent({ backend: "codex", model: "gpt-5.6-luna" }));
    expect(await harness.catalogue!()).toEqual({ kind: "notStarted" });
    expect(server.sent).toHaveLength(0);
    expect(threadStarts()).toBe(0);
    await harness.dispose();
  });

  it("uses the existing thread and spawns no duplicate server", async () => {
    const seen: unknown[] = [];
    const { harness, server, threadStarts } = rig((params) => {
      seen.push(params);
      return {
        data: [
          {
            name: "docs",
            runtimeStatus: "connected",
            tools: { search: { name: "search", description: "d", inputSchema: {} } },
          },
          { name: "later", runtimeStatus: "notStarted", tools: {} },
          { name: "moved", runtimeStatus: null, tools: {} },
        ],
        nextCursor: null,
      };
    });
    await harness.start(SESSION, agent({ backend: "codex", model: "gpt-5.6-luna" }));
    const result = await harness.catalogue!({ initialize: true });
    expect(result).toEqual({
      kind: "ok",
      truncated: false,
      servers: [
        { name: "docs", state: "connected", tools: ["search"], truncated: false },
        { name: "later", state: "notStarted", tools: [], truncated: false },
        { name: "moved", state: "unknown", tools: [], truncated: false },
      ],
    });
    // The catalogue rides the thread the harness already has.
    expect(threadStarts()).toBe(1);
    expect((seen[0] as { threadId?: string }).threadId).toBe("thread_cat");
    // No turn was ever started.
    expect(server.sent.some((frame) => frame.method === "turn/start")).toBe(false);
    await harness.dispose();
  });

  it("marks a paginated listing as truncated rather than paging forever", async () => {
    const { harness } = rig(() => ({
      data: [{ name: "docs", runtimeStatus: "connected", tools: {} }],
      nextCursor: "more",
    }));
    await harness.start(SESSION, agent({ backend: "codex", model: "gpt-5.6-luna" }));
    const result = await harness.catalogue!({ initialize: true });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.truncated).toBe(true);
    await harness.dispose();
  });

  it("joins concurrent refreshes into one request", async () => {
    let calls = 0;
    const { harness } = rig(() => {
      calls += 1;
      return { data: [{ name: "docs", runtimeStatus: "connected", tools: {} }] };
    });
    await harness.start(SESSION, agent({ backend: "codex", model: "gpt-5.6-luna" }));
    const [a, b] = await Promise.all([
      harness.catalogue!({ initialize: true }),
      harness.catalogue!({ initialize: true }),
    ]);
    expect(a).toEqual(b);
    expect(calls).toBe(1);
    await harness.dispose();
  });

  it("returns a generic error when the app-server refuses", async () => {
    const { harness } = rig(() => {
      throw new Error("codex is not signed in as user@example.com");
    });
    await harness.start(SESSION, agent({ backend: "codex", model: "gpt-5.6-luna" }));
    expect(await harness.catalogue!({ initialize: true })).toEqual({ kind: "error" });
    await harness.dispose();
  });
});

// ---------------------------------------------------------------------------
// api
// ---------------------------------------------------------------------------

describe("api catalogue", () => {
  function poolFor(tools: Record<string, string[]>, failures: string[] = []) {
    const calls = { connects: 0 };
    const servers = [
      ...Object.keys(tools).map((name) => ({
        name,
        transport: "stdio" as const,
        command: name,
        source: "agent" as const,
      })),
      ...failures.map((name) => ({
        name,
        transport: "stdio" as const,
        command: name,
        source: "agent" as const,
      })),
      {
        name: "off",
        transport: "stdio" as const,
        command: "off",
        source: "agent" as const,
        disabled: true,
      },
    ];
    class FakeClient {
      private label = "";
      async connect(transport: { label: string }): Promise<void> {
        this.label = transport.label;
        calls.connects += 1;
        if (failures.includes(this.label)) throw new Error(`spawn ${this.label} ENOENT`);
      }
      async listTools(): Promise<unknown> {
        return {
          tools: (tools[this.label] ?? []).map((name) => ({
            name,
            description: "never surfaced",
            inputSchema: { type: "object", properties: {} },
          })),
        };
      }
      async close(): Promise<void> {}
    }
    const sdk: McpSdk = {
      Client: FakeClient as unknown as McpSdk["Client"],
      StdioClientTransport: function (params: { command: string }) {
        return { label: params.command, close: async () => {} };
      } as unknown as McpSdk["StdioClientTransport"],
      StreamableHTTPClientTransport: function (url: URL) {
        return { label: url.toString(), close: async () => {} };
      } as unknown as McpSdk["StreamableHTTPClientTransport"],
    };
    const pool = new McpClientPool({
      servers,
      sdk,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    return { pool, connects: () => calls.connects };
  }

  it("reuses the reference-counted pool and its tool cache", async () => {
    const { pool, connects } = poolFor({ alpha: ["one", "two"] }, ["beta"]);
    let released = 0;
    const harness = new ApiHarness({
      keys: { getKey: async () => "k" },
      mcpServers: pool.list(),
      acquirePool: () => ({
        pool,
        release: () => {
          released += 1;
        },
      }),
      loadHistory: async () => [],
      createProvider: async () =>
        ({ provider: "anthropic", baseUrl: "", stream: () => new AsyncQueue() }) as never,
    });
    await harness.start(SESSION, agent({ backend: "api", model: "gpt-5" }));
    const first = await harness.catalogue!({ initialize: true });
    const second = await harness.catalogue!({ initialize: true });
    expect(first).toEqual(second);
    expect(first.kind).toBe("ok");
    if (first.kind !== "ok") return;
    expect(first.servers).toEqual([
      { name: "alpha", state: "connected", tools: ["one", "two"], truncated: false },
      { name: "beta", state: "failed", tools: [], truncated: false },
      { name: "off", state: "disabled", tools: [], truncated: false },
    ]);
    expect(JSON.stringify(first)).not.toContain("never surfaced");
    expect(JSON.stringify(first)).not.toContain("ENOENT");
    // The successful server's tools came from the pool's cache the second time;
    // only the failed one was retried, which is what lets a user fix a broken
    // server and see it recover on the next refresh.
    expect(connects()).toBe(3);
    await harness.dispose();
    expect(released).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// isolation
// ---------------------------------------------------------------------------

describe("two agents keep separate catalogues", () => {
  it("does not let one harness's servers appear in another's", async () => {
    const first = new ClaudeHarness({
      query: catalogueQuery({ mcpServerStatus: async () => [{ name: "alpha", status: "connected", tools: [{ name: "a" }] }] }),
    });
    const second = new ClaudeHarness({
      query: catalogueQuery({ mcpServerStatus: async () => [{ name: "beta", status: "connected", tools: [{ name: "b" }] }] }),
    });
    await first.start(SESSION, agent({ agentId: "one" }));
    await second.start(SESSION, agent({ agentId: "two" }));
    const [a, b] = await Promise.all([
      first.catalogue!({ initialize: true }),
      second.catalogue!({ initialize: true }),
    ]);
    expect(a.kind === "ok" ? a.servers.map((entry) => entry.name) : null).toEqual(["alpha"]);
    expect(b.kind === "ok" ? b.servers.map((entry) => entry.name) : null).toEqual(["beta"]);
    await first.dispose();
    await second.dispose();
  });
});

// ---------------------------------------------------------------------------
// Corrective wave (docs/plans/phase9-resume-review.md §MCP catalogue)
// ---------------------------------------------------------------------------

/** Counts every indexed read, so a test can prove a scan was bounded. */
function countingList(value: unknown, length: number): {
  list: readonly unknown[];
  reads: () => number;
} {
  let reads = 0;
  // A holey array, so five million entries cost nothing to create: only the
  // reads the code under test actually performs are materialised.
  const backing = new Array<unknown>(length);
  const proxy = new Proxy(backing, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) {
        reads += 1;
        return value;
      }
      return Reflect.get(target, key, receiver);
    },
  });
  return { list: proxy as readonly unknown[], reads: () => reads };
}

describe("CatalogueRunner refuses work it was told not to start", () => {
  it("never initializes a backend for an already-cancelled refresh", async () => {
    const initialize = vi.fn(async () => {});
    const fetch = vi.fn(async () => []);
    const runner = new CatalogueRunner({ initialize, lifecycle: () => "live", fetch });
    const abort = new AbortController();
    abort.abort();
    expect(await runner.run({ signal: abort.signal, initialize: true })).toEqual({
      kind: "cancelled",
    });
    // The whole point: a cancelled refresh must not spawn a CLI child or open
    // an app-server thread on its way to answering "cancelled".
    expect(initialize).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("CatalogueRunner bounds the shared operation, not just each caller", () => {
  it("does not leave callers waiting on a fetch that ignores its abort", async () => {
    let attempt = 0;
    const runner = new CatalogueRunner({
      lifecycle: () => "live",
      operationTimeoutMs: 40,
      fetch: () => {
        attempt += 1;
        return new Promise<never>(() => {});
      },
    });
    expect(await runner.run({ timeoutMs: 20 })).toEqual({ kind: "cancelled" });
    // Before the fix `inFlight` still held the hung promise, so every later
    // refresh joined a query that could never answer — the caller waited out
    // its own deadline every time instead of being told at once.
    await new Promise((r) => setTimeout(r, 60));
    expect(await runner.run({ timeoutMs: 500 })).toEqual({ kind: "cancelled" });
    // …and answering promptly must not mean issuing a second uncancellable
    // request against the same wedged runtime.
    expect(attempt).toBe(1);
  });

  it("recovers after an initialization that ignores its abort, once it settles", async () => {
    let attempt = 0;
    let release: (() => void) | undefined;
    const runner = new CatalogueRunner({
      lifecycle: () => "live",
      operationTimeoutMs: 40,
      initialize: () => {
        attempt += 1;
        if (attempt === 1) {
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return Promise.resolve();
      },
      fetch: async () => [{ name: "later", state: "connected" as const, toolNames: [] }],
    });
    expect(await runner.run({ initialize: true, timeoutMs: 500 })).toEqual({ kind: "cancelled" });
    // Still wedged: no second initialization is started behind the first.
    expect(await runner.run({ initialize: true, timeoutMs: 500 })).toEqual({ kind: "cancelled" });
    expect(attempt).toBe(1);

    release?.();
    await new Promise((r) => setTimeout(r, 20));
    const recovered = await runner.run({ initialize: true, timeoutMs: 500 });
    expect(recovered.kind).toBe("ok");
    expect(attempt).toBe(2);
  });

  it("suppresses a late result from an abandoned operation", async () => {
    let release: ((value: never[]) => void) | undefined;
    let attempt = 0;
    const runner = new CatalogueRunner({
      lifecycle: () => "live",
      operationTimeoutMs: 30,
      fetch: async () => {
        attempt += 1;
        if (attempt === 1) {
          return new Promise<never[]>((resolve) => {
            release = resolve;
          });
        }
        return [{ name: "fresh", state: "connected" as const, toolNames: [] }] as never[];
      },
    });
    expect(await runner.run({ timeoutMs: 500 })).toEqual({ kind: "cancelled" });
    // The abandoned operation finishes long after it was given up on, which is
    // also what frees the slot for the next refresh.
    release?.([{ name: "ghost", state: "connected", toolNames: [] }] as never[]);
    await new Promise((r) => setTimeout(r, 20));
    const next = await runner.run({ timeoutMs: 500 });
    expect(next.kind).toBe("ok");
    if (next.kind !== "ok") return;
    // Never the ghost: a result nobody is waiting for is discarded, not cached.
    expect(next.servers.map((s) => s.name)).toEqual(["fresh"]);
  });

  it("still joins ordinary concurrent refreshes into one fetch", async () => {
    const fetch = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return [{ name: "one", state: "connected" as const, toolNames: [] }];
    });
    const runner = new CatalogueRunner({ lifecycle: () => "live", fetch });
    const [a, b, c] = await Promise.all([runner.run(), runner.run(), runner.run()]);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports stale when the runtime is disposed during initialization", async () => {
    let live: string | null = null;
    const runner = new CatalogueRunner({
      lifecycle: () => live,
      initialize: async () => {
        live = "started";
        // A dispose lands while initialization is still in flight.
        live = null;
      },
      fetch: async () => [{ name: "never", state: "connected" as const, toolNames: [] }],
    });
    expect(await runner.run({ initialize: true })).toEqual({ kind: "stale" });
  });

  it("reports stale when the runtime is restarted during initialization", async () => {
    let live = "first";
    const runner = new CatalogueRunner({
      lifecycle: () => live,
      initialize: async () => {
        live = "second";
      },
      fetch: async () => [{ name: "never", state: "connected" as const, toolNames: [] }],
    });
    expect(await runner.run({ initialize: true })).toEqual({ kind: "stale" });
  });
});

describe("CatalogueRunner never hands a raw backend failure to a logger", () => {
  it("reports a generic code, not the error", async () => {
    const seen: unknown[] = [];
    const secret = "https://user:s3cr3t-token@mcp.internal/sse";
    const runner = new CatalogueRunner({
      lifecycle: () => "live",
      fetch: async () => {
        throw new Error(`connect ECONNREFUSED ${secret} --api-key=abcd1234`);
      },
      onFailure: (code) => seen.push(code),
    });
    expect(await runner.run()).toEqual({ kind: "error" });
    expect(seen).toEqual(["fetch_failed"]);
    const serialized = JSON.stringify(seen);
    expect(serialized).not.toContain("s3cr3t");
    expect(serialized).not.toContain("abcd1234");
    expect(serialized).not.toContain("mcp.internal");
    // A raw Error must not be reachable at all — not as an object, not nested.
    expect(seen.every((entry) => typeof entry === "string")).toBe(true);
  });

  it("separates an initialization failure from a query failure", async () => {
    const seen: string[] = [];
    const runner = new CatalogueRunner({
      lifecycle: () => "live",
      initialize: async () => {
        throw new Error("spawn C:/Users/someone/.claude/creds.json ENOENT");
      },
      fetch: async () => [],
      onFailure: (code) => seen.push(code),
    });
    expect(await runner.run({ initialize: true })).toEqual({ kind: "error" });
    expect(seen).toEqual(["initialize_failed"]);
  });
});

describe("boundCatalogue bounds what it scans, and preserves identity", () => {
  it("stops scanning a flood of duplicate names instead of walking all of them", () => {
    const { list, reads } = countingList("same", 5_000_000);
    const result = boundCatalogue([
      { name: "flood", state: "connected", toolNames: list },
    ]);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    // Before the fix the loop broke on *unique* names, so five million
    // duplicates were all visited to accept one.
    expect(reads()).toBeLessThanOrEqual(MAX_SCANNED_TOOLS_PER_SERVER + 1);
    expect(result.servers[0]!.tools).toEqual(["same"]);
    expect(result.servers[0]!.truncated).toBe(true);
  });

  it("stops scanning a flood of invalid names", () => {
    const { list, reads } = countingList({ not: "a string" }, 5_000_000);
    const result = boundCatalogue([{ name: "flood", state: "connected", toolNames: list }]);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(reads()).toBeLessThanOrEqual(MAX_SCANNED_TOOLS_PER_SERVER + 1);
    expect(result.servers[0]!.tools).toEqual([]);
    expect(result.servers[0]!.truncated).toBe(true);
  });

  it("bounds the number of servers it scans", () => {
    const { list, reads } = countingList(
      { name: "s", state: "connected", toolNames: [] },
      5_000_000,
    );
    const result = boundCatalogue(list as never);
    expect(result.kind).toBe("ok");
    expect(reads()).toBeLessThanOrEqual(MAX_SCANNED_SERVERS + 1);
  });

  it("omits an unusable name rather than rewriting it into a collision", () => {
    const long = "a".repeat(MAX_NAME_CHARS + 1);
    const alsoLong = `${"a".repeat(MAX_NAME_CHARS)}DIFFERENT`;
    const result = boundCatalogue([
      {
        name: "server",
        state: "connected",
        toolNames: [
          "keep_me",
          long,
          alsoLong,
          "tab\there",
          "nul\u0000here",
          "esc\u001bhere",
          "bidi\u202ehere",
          "isolate\u2066here",
          "  spaced  ",
        ],
      },
    ]);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    const server = result.servers[0]!;
    // Two overlong names that share a 512-character prefix would have been
    // rewritten into the *same* identity by a clamp. Both are omitted.
    expect(server.tools).toEqual(["  spaced  ", "keep_me"]);
    expect(server.truncated).toBe(true);
    // Exact bytes for what survives: a name is an identity, and trimming or
    // normalising one breaks the lookup it exists for.
    expect(server.tools).toContain("  spaced  ");
  });

  it("omits a server whose own name is unusable, and discloses it", () => {
    const result = boundCatalogue([
      { name: "fine", state: "connected", toolNames: ["a"] },
      { name: `bad\u0000name`, state: "connected", toolNames: ["b"] },
      { name: "x".repeat(MAX_NAME_CHARS + 1), state: "connected", toolNames: ["c"] },
    ]);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.servers.map((s) => s.name)).toEqual(["fine"]);
    expect(result.truncated).toBe(true);
  });

  it("bounds the aggregate size of names that double when serialised", () => {
    // Every one of these characters is legal in a name and costs *two* bytes
    // once JSON-escaped, so a budget kept in raw UTF-8 bytes is off by 2x.
    const evil = (seed: string) => `${seed}${'"'.repeat(200)}${"\\".repeat(200)}`;
    const servers = Array.from({ length: MAX_SERVERS }, (_, s) => ({
      name: evil(`server_${s}_`),
      state: "notStarted" as const,
      toolNames: Array.from({ length: MAX_TOOLS_PER_SERVER }, (_, t) => evil(`tool_${t}_`)),
    }));
    const result = boundCatalogue(servers);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    // The guarantee is about the bytes that actually cross the boundary.
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(
      MAX_CATALOGUE_BYTES,
    );
    expect(result.truncated).toBe(true);
    // Whatever survived is still byte-identical: the budget clips the list, it
    // never edits a name to make one fit.
    for (const server of result.servers) {
      expect(server.name).toContain('"');
      expect(server.name).toContain("\\");
    }
  });

  it("bounds the aggregate size of the answer", () => {
    const name = "n".repeat(400);
    const servers = Array.from({ length: MAX_SERVERS }, (_, s) => ({
      name: `server_${s}_${name}`,
      state: "connected" as const,
      toolNames: Array.from({ length: MAX_TOOLS_PER_SERVER }, (_, t) => `tool_${t}_${name}`),
    }));
    const result = boundCatalogue(servers);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    // Every individual bound is satisfied above and the total is still tens of
    // megabytes without an aggregate one.
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(
      MAX_CATALOGUE_BYTES,
    );
    expect(result.truncated).toBe(true);
  });
});

describe("adapters cap before they allocate", () => {
  it("Claude does not map a hostile server's whole tool array", async () => {
    const { list, reads } = countingList({ name: "dup" }, 2_000_000);
    const harness = new ClaudeHarness({
      query: catalogueQuery({
        mcpServerStatus: async () => [{ name: "flood", status: "connected", tools: list }],
      }),
    });
    await harness.start(SESSION, agent());
    const result = await harness.catalogue!({ initialize: true });
    expect(result.kind).toBe("ok");
    expect(reads()).toBeLessThanOrEqual(MAX_SCANNED_TOOLS_PER_SERVER + 1);
    await harness.dispose();
  });

  it("Claude does not map a hostile server list", async () => {
    const { list, reads } = countingList({ name: "s", status: "connected", tools: [] }, 2_000_000);
    const harness = new ClaudeHarness({
      query: catalogueQuery({ mcpServerStatus: async () => list as unknown[] }),
    });
    await harness.start(SESSION, agent());
    await harness.catalogue!({ initialize: true });
    expect(reads()).toBeLessThanOrEqual(MAX_SCANNED_SERVERS + 1);
    await harness.dispose();
  });
});

// ---------------------------------------------------------------------------
// Adapter lifecycle (Astra review round 2)
// ---------------------------------------------------------------------------

describe("ClaudeHarness never resurrects a disposed backend", () => {
  /** A `loadQuery` that resolves only when the test says so. */
  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it("does not create a query when dispose lands while loadQuery is pending", async () => {
    const gate = deferred<ClaudeQueryFn>();
    let created = 0;
    const harness = new ClaudeHarness({
      loadQuery: () => gate.promise,
    });
    await harness.start(SESSION, agent());
    const pending = harness.catalogue!({ initialize: true, timeoutMs: 500 });
    await settle();
    // The SDK module finishes loading only after the harness is gone.
    await harness.dispose();
    gate.resolve(
      catalogueQuery({
        onQuery: () => (created += 1),
        mcpServerStatus: async () => [{ name: "ghost", status: "connected", tools: [] }],
      }),
    );
    const result = await pending;
    // A late `queryFn(...)` here spawns a CLI child for a harness the app has
    // already released — nothing would ever dispose it.
    expect(created).toBe(0);
    expect(result.kind).not.toBe("ok");
    expect(harness.backendSessionId()).toBeNull();
  });

  it("does not create a query when dispose lands while mcpServers is pending", async () => {
    const gate = deferred<Record<string, unknown> | null>();
    let created = 0;
    const harness = new ClaudeHarness({
      query: catalogueQuery({
        onQuery: () => (created += 1),
        mcpServerStatus: async () => [{ name: "ghost", status: "connected", tools: [] }],
      }),
      mcpServers: () => gate.promise,
    });
    await harness.start(SESSION, agent());
    const pending = harness.catalogue!({ initialize: true, timeoutMs: 500 });
    await settle();
    await harness.dispose();
    gate.resolve(null);
    const result = await pending;
    expect(created).toBe(0);
    expect(result.kind).not.toBe("ok");
  });

  it("still lets a turn and a catalogue share one initialization", async () => {
    const gate = deferred<ClaudeQueryFn>();
    let created = 0;
    const harness = new ClaudeHarness({ loadQuery: () => gate.promise });
    await harness.start(SESSION, agent());
    const catalogue = harness.catalogue!({ initialize: true, timeoutMs: 2_000 });
    const events: unknown[] = [];
    const turn = (async () => {
      for await (const event of harness.send({ turnId: "t1", text: "hi" })) events.push(event);
    })();
    await settle();
    gate.resolve(
      catalogueQuery({
        onQuery: () => (created += 1),
        mcpServerStatus: async () => [{ name: "files", status: "connected", tools: [] }],
      }),
    );
    const result = await catalogue;
    expect(result.kind).toBe("ok");
    // One streaming session for both callers — the concurrency guard survives.
    expect(created).toBe(1);
    await harness.dispose();
    await turn;
  });
});

describe("CatalogueRunner bounds the underlying request, not just the wait", () => {
  it("does not call fetch when the operation was aborted during initialization", async () => {
    const fetch = vi.fn(async () => []);
    const failures: string[] = [];
    const runner = new CatalogueRunner({
      lifecycle: () => "live",
      operationTimeoutMs: 30,
      // Resolves *after* the operation deadline: the abort must stop the
      // sequence here rather than falling through into the query.
      initialize: () => new Promise<void>((resolve) => setTimeout(resolve, 80)),
      fetch,
      onFailure: (code) => failures.push(code),
    });
    expect(await runner.run({ initialize: true, timeoutMs: 500 })).toEqual({ kind: "cancelled" });
    // Give the abandoned initialization every chance to fall through.
    await new Promise((r) => setTimeout(r, 120));
    expect(fetch).not.toHaveBeenCalled();
    // And no failure line for work nobody is waiting on.
    expect(failures).toEqual(["operation_timeout"]);
  });

  it("keeps at most one unresolved underlying request across repeated timeouts", async () => {
    let started = 0;
    const runner = new CatalogueRunner({
      lifecycle: () => "live",
      operationTimeoutMs: 25,
      fetch: () => {
        started += 1;
        return new Promise<never>(() => {});
      },
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await runner.run({ timeoutMs: 500 })).kind).toBe("cancelled");
      await new Promise((r) => setTimeout(r, 10));
    }
    // Stacking one abandoned SDK request per refresh is not recovery; the CLI
    // would accumulate five live control requests nobody can cancel.
    expect(started).toBe(1);
  });

  it("recovers once the abandoned request finally settles", async () => {
    let started = 0;
    let release: ((value: never[]) => void) | undefined;
    const runner = new CatalogueRunner({
      lifecycle: () => "live",
      operationTimeoutMs: 25,
      fetch: () => {
        started += 1;
        if (started === 1) {
          return new Promise<never[]>((resolve) => {
            release = resolve;
          });
        }
        return Promise.resolve([
          { name: "fresh", state: "connected" as const, toolNames: [] },
        ] as never[]);
      },
    });
    expect((await runner.run({ timeoutMs: 500 })).kind).toBe("cancelled");
    expect((await runner.run({ timeoutMs: 500 })).kind).toBe("cancelled");
    expect(started).toBe(1);

    // The wedged request finally answers; its result is still discarded, but
    // the slot is now genuinely free.
    release?.([{ name: "ghost", state: "connected", toolNames: [] }] as never[]);
    await new Promise((r) => setTimeout(r, 20));
    const recovered = await runner.run({ timeoutMs: 500 });
    expect(recovered.kind).toBe("ok");
    if (recovered.kind !== "ok") return;
    expect(recovered.servers.map((s) => s.name)).toEqual(["fresh"]);
    expect(started).toBe(2);
  });

  it("recovers immediately when the runtime itself is reset", async () => {
    let started = 0;
    let live = "first";
    const runner = new CatalogueRunner({
      lifecycle: () => live,
      operationTimeoutMs: 25,
      fetch: () => {
        started += 1;
        if (started === 1) return new Promise<never>(() => {});
        return Promise.resolve([
          { name: "after_restart", state: "connected" as const, toolNames: [] },
        ] as never[]);
      },
    });
    expect((await runner.run({ timeoutMs: 500 })).kind).toBe("cancelled");
    expect((await runner.run({ timeoutMs: 500 })).kind).toBe("cancelled");
    expect(started).toBe(1);
    // A genuine reset — the harness restarted, so the wedged request belongs to
    // a runtime that no longer exists and cannot be waited on any longer.
    live = "second";
    const recovered = await runner.run({ timeoutMs: 500 });
    expect(recovered.kind).toBe("ok");
    expect(started).toBe(2);
  });

  it("treats a non-finite or non-positive deadline as the default", async () => {
    const runner = new CatalogueRunner({
      lifecycle: () => "live",
      fetch: async () => {
        // A real backend answers on a later macrotask, which is exactly when an
        // unnormalised `setTimeout(fn, NaN)` has already fired.
        await new Promise((r) => setTimeout(r, 5));
        return [{ name: "one", state: "connected" as const, toolNames: [] }];
      },
    });
    for (const timeoutMs of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
      // `setTimeout(fn, NaN)` fires on the next tick, so an unnormalised NaN
      // deadline cancelled every refresh instantly.
      expect((await runner.run({ timeoutMs })).kind).toBe("ok");
    }
  });
});
