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
