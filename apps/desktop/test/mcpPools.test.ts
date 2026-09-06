/**
 * The shared MCP pool registry (SPEC R26).
 *
 * The finding it exists for: an `api`-backend session with a widget-capable
 * MCP server built two independent `McpClientPool`s from the same
 * `loadMcpServers()` answer — one inside `ApiHarness.ensurePool()`, one inside
 * the widget host's `defaultAccess()` — so every stdio server was spawned twice
 * and its schema fetched twice, per session.
 */
import { describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "@capygen/engine";
import { createMcpPoolRegistry, serverListKey } from "../src/ipc/mcpPools.js";

const LOG = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const ALPHA: McpServerConfig = {
  name: "alpha",
  transport: "stdio",
  command: "a",
  args: ["--x"],
  source: "project-mcp-json",
};
const BETA: McpServerConfig = { name: "beta", transport: "stdio", command: "b", source: "agent" };

/** An http server reached with a credential — the R-B scenario. */
const REMOTE: McpServerConfig = {
  name: "remote",
  transport: "http",
  url: "https://example.invalid/mcp",
  headers: { Authorization: "Bearer token-one", "X-Trace": "t1" },
  source: "claude-settings",
};
/** The same URL, a different account's credential. */
const REMOTE_OTHER_CREDENTIAL: McpServerConfig = {
  ...REMOTE,
  headers: { Authorization: "Bearer token-two", "X-Trace": "t1" },
};
/** A stdio server whose workspace/account comes from its environment. */
const SCOPED: McpServerConfig = {
  name: "scoped",
  transport: "stdio",
  command: "s",
  env: { WORKSPACE: "alpha", TOKEN: "secret-alpha" },
  source: "agent",
};
const SCOPED_OTHER_ENV: McpServerConfig = {
  ...SCOPED,
  env: { WORKSPACE: "beta", TOKEN: "secret-beta" },
};

describe("serverListKey", () => {
  it("is order-independent and reflects how a server is reached", () => {
    expect(serverListKey([ALPHA, BETA])).toBe(serverListKey([BETA, ALPHA]));
    expect(serverListKey([ALPHA])).not.toBe(serverListKey([BETA]));
    expect(serverListKey([ALPHA])).not.toBe(
      serverListKey([{ ...ALPHA, args: ["--y"] }]),
    );
    // The source file an entry came from is not part of its identity — the
    // same server registered in two places is still one process.
    expect(serverListKey([ALPHA])).toBe(serverListKey([{ ...ALPHA, source: "agent" }]));
  });
});

/**
 * [7-P2] Connection identity (review finding R-B).
 *
 * `McpClientPool.open()` builds the transport from `env` (stdio) and `headers`
 * (http) as well as command/args/cwd/url. A key that omitted the first two let
 * two sessions using the same URL with *different* credentials — or the same
 * command with a different workspace environment — share one transport, so the
 * second lease ran under the first one's account.
 */
describe("serverListKey — every effective transport option is part of identity", () => {
  it("isolates http servers that differ only by credential header", () => {
    expect(serverListKey([REMOTE])).not.toBe(serverListKey([REMOTE_OTHER_CREDENTIAL]));
  });

  it("isolates stdio servers that differ only by environment", () => {
    expect(serverListKey([SCOPED])).not.toBe(serverListKey([SCOPED_OTHER_ENV]));
  });

  it("isolates a server that adds a header or env var the other does not have", () => {
    expect(serverListKey([REMOTE])).not.toBe(
      serverListKey([{ ...REMOTE, headers: { Authorization: "Bearer token-one" } }]),
    );
    expect(serverListKey([SCOPED])).not.toBe(
      serverListKey([{ ...SCOPED, env: { WORKSPACE: "alpha" } }]),
    );
  });

  it("shares when equivalent maps differ only by insertion order", () => {
    expect(
      serverListKey([
        { ...REMOTE, headers: { "X-Trace": "t1", Authorization: "Bearer token-one" } },
      ]),
    ).toBe(serverListKey([REMOTE]));
    expect(
      serverListKey([{ ...SCOPED, env: { TOKEN: "secret-alpha", WORKSPACE: "alpha" } }]),
    ).toBe(serverListKey([SCOPED]));
  });

  it("treats an empty map, an empty args list and disabled:false as absent", () => {
    expect(serverListKey([{ ...BETA, env: {}, headers: {}, args: [], disabled: false }])).toBe(
      serverListKey([BETA]),
    );
  });

  it("matches header names case-insensitively, the way fetch does", () => {
    expect(
      serverListKey([
        { ...REMOTE, headers: { authorization: "Bearer token-one", "x-trace": "t1" } },
      ]),
    ).toBe(serverListKey([REMOTE]));
  });

  it("keeps two header names that normalise to one apart by their combined order", () => {
    // `new Headers()` combines duplicates in insertion order: {X:"a", x:"b"}
    // sends "a, b" and {x:"b", X:"a"} sends "b, a". Different requests, so
    // sorting the tie on the value (which made them equal) was wrong.
    expect(serverListKey([{ ...REMOTE, headers: { X: "a", x: "b" } }])).not.toBe(
      serverListKey([{ ...REMOTE, headers: { x: "b", X: "a" } }]),
    );
    // Distinct names are still order-independent.
    expect(serverListKey([{ ...REMOTE, headers: { A: "1", B: "2" } }])).toBe(
      serverListKey([{ ...REMOTE, headers: { B: "2", A: "1" } }]),
    );
  });

  it("keeps environment variable names case-sensitive rather than risk under-isolation", () => {
    expect(serverListKey([{ ...SCOPED, env: { workspace: "alpha", TOKEN: "secret-alpha" } }]))
      .not.toBe(serverListKey([SCOPED]));
  });

  it("cannot be confused by a value that contains the encoder's own separators", () => {
    expect(serverListKey([{ ...ALPHA, args: ["ab", "c"] }])).not.toBe(
      serverListKey([{ ...ALPHA, args: ["a", "bc"] }]),
    );
    expect(serverListKey([{ ...SCOPED, env: { "A=B": "c" } }])).not.toBe(
      serverListKey([{ ...SCOPED, env: { A: "B=c" } }]),
    );
  });

  it("is an opaque digest that never carries a credential in clear text", () => {
    const key = serverListKey([REMOTE, SCOPED]);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    for (const secret of ["Bearer token-one", "token-one", "secret-alpha", "example.invalid"]) {
      expect(key).not.toContain(secret);
    }
  });
});

describe("createMcpPoolRegistry", () => {
  it("hands the same pool to two holders of one server list", async () => {
    const registry = createMcpPoolRegistry({ log: LOG });
    const agent = registry.acquire([ALPHA]);
    const widgetHost = registry.acquire([ALPHA]);
    expect(widgetHost.pool).toBe(agent.pool);
    expect(registry.size()).toBe(1);
    await registry.closeAll();
  });

  it("keeps different server lists apart", async () => {
    const registry = createMcpPoolRegistry({ log: LOG });
    expect(registry.acquire([ALPHA]).pool).not.toBe(registry.acquire([BETA]).pool);
    expect(registry.size()).toBe(2);
    await registry.closeAll();
  });

  it("closes the pool only when the last holder lets go", async () => {
    const registry = createMcpPoolRegistry({ log: LOG });
    const agent = registry.acquire([ALPHA]);
    const widgetHost = registry.acquire([ALPHA]);
    const closed: string[] = [];
    agent.pool.close = async () => void closed.push("closed");

    // The agent's session ends while a widget is still on screen.
    await agent.release();
    expect(closed).toEqual([]);
    expect(registry.size()).toBe(1);

    await widgetHost.release();
    expect(closed).toEqual(["closed"]);
    expect(registry.size()).toBe(0);
  });

  it("[7-P2] gives two credentials for one url their own pool, and reuses one for equal maps", async () => {
    const registry = createMcpPoolRegistry({ log: LOG });
    const first = registry.acquire([REMOTE]);
    const second = registry.acquire([REMOTE_OTHER_CREDENTIAL]);
    expect(second.pool).not.toBe(first.pool);
    expect(registry.size()).toBe(2);

    const reordered = registry.acquire([
      { ...REMOTE, headers: { "X-Trace": "t1", Authorization: "Bearer token-one" } },
    ]);
    expect(reordered.pool).toBe(first.pool);
    expect(registry.size()).toBe(2);
    await registry.closeAll();
  });

  it("[7-P2] leases expose only the pool and its release, never the key", async () => {
    const registry = createMcpPoolRegistry({ log: LOG });
    const lease = registry.acquire([REMOTE]);
    expect(Object.keys(lease).sort()).toEqual(["pool", "release"]);
    await registry.closeAll();
  });

  it("[7-P2] never writes a credential, an env value or the key into the log", async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const registry = createMcpPoolRegistry({ log });
    const lease = registry.acquire([REMOTE, SCOPED]);
    await lease.release();
    const written = [...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls]
      .flat()
      .map((entry) => String(entry))
      .join(" ");
    for (const secret of [
      "Bearer token-one",
      "token-one",
      "secret-alpha",
      "example.invalid",
      serverListKey([REMOTE, SCOPED]),
    ]) {
      expect(written).not.toContain(secret);
    }
  });

  it("[7-P2] captures one base environment at construction, not once per pool", async () => {
    // `serverListKey` deliberately omits the base environment; that is only
    // sound if every pool in one registry was built from the same one.
    const NAME = "CAPYGEN_TEST_POOL_BASE_ENV";
    const original = process.env[NAME];
    try {
      process.env[NAME] = "at-construction";
      const registry = createMcpPoolRegistry({ log: LOG });
      process.env[NAME] = "changed-after-construction";
      const first = registry.acquire([ALPHA]);
      const second = registry.acquire([BETA]);
      const envOf = (lease: { pool: unknown }): Record<string, string | undefined> =>
        (lease.pool as { deps: { env?: Record<string, string | undefined> } }).deps.env ?? {};
      expect(envOf(first)[NAME]).toBe("at-construction");
      expect(envOf(second)[NAME]).toBe("at-construction");
      await registry.closeAll();
    } finally {
      if (original === undefined) delete process.env[NAME];
      else process.env[NAME] = original;
    }
    expect(process.env[NAME]).toBe(original);
  });

  it("ignores a double release rather than closing a pool someone else took", async () => {
    const registry = createMcpPoolRegistry({ log: LOG });
    const first = registry.acquire([ALPHA]);
    await first.release();
    const second = registry.acquire([ALPHA]);
    await first.release();
    expect(registry.size()).toBe(1);
    await second.release();
    expect(registry.size()).toBe(0);
  });
});
