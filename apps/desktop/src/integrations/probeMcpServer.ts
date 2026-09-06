/**
 * `integrations.mcp.test` — connect to one MCP server and list its tools.
 *
 * Built on the **shared** pool registry (`ipc/mcpPools.ts`, SPEC R26) rather
 * than a fresh client, for the reason that registry exists at all: a stdio
 * server is a child process, and a Test button that spawned its own copy while
 * the same server was already running for a session would be two children for
 * one row. The pool is acquired, asked, and released — reference counting keeps
 * it alive only while somebody wants it.
 *
 * The single-server list is deliberate: the pool this returns knows about *one*
 * server, so `listTools` cannot accidentally connect to the other five while
 * the user is testing one.
 */
import type { McpServerConfig } from "@capygen/engine";
import type { McpServerEntry } from "@capygen/shared";
import type { McpPoolRegistry } from "../ipc/mcpPools.js";

/** How long a test connection may take before it is reported as failed. */
export const MCP_TEST_TIMEOUT_MS = 20_000;

export function createMcpPoolProbe(
  pools: McpPoolRegistry,
): (entry: McpServerEntry, projectPath: string | null) => Promise<string[]> {
  return async (entry, projectPath) => {
    if (entry.transport === "claudeai-proxy") {
      // A claude.ai cloud connector is reached through the CLI's own account
      // session, which capygen has no client for; the caller falls back to
      // `claude mcp list` for those.
      throw new Error("a claude.ai connector can only be tested through the Claude CLI");
    }
    const config: McpServerConfig = {
      name: entry.name,
      transport: entry.transport,
      ...(entry.command ? { command: entry.command } : {}),
      ...(entry.args ? { args: entry.args } : {}),
      ...(entry.env ? { env: entry.env } : {}),
      ...(entry.url ? { url: entry.url } : {}),
      ...(projectPath ? { cwd: projectPath } : {}),
      source: "agent",
    };
    const lease = pools.acquire([config]);
    try {
      const tools = await withTimeout(
        lease.pool.listTools(entry.name),
        MCP_TEST_TIMEOUT_MS,
        entry.name,
      );
      return tools.map((tool) => tool.name);
    } finally {
      await lease.release();
    }
  };
}

function withTimeout<T>(work: Promise<T>, ms: number, name: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${name} did not answer within ${ms} ms`)),
      ms,
    );
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
