/**
 * The one **live, read-only** check that the shapes `ClaudeConfigStore` parses
 * are the shapes the real `claude` CLI prints (SPEC R29, PLAN A9).
 *
 * Skipped unless `CAPYGEN_LIVE_CONFIG=1`, and deliberately so:
 * `docs/RUN.md` promises that `corepack pnpm test` touches no network and no
 * real profile, and `claude mcp list` health-checks the user's servers — which
 * for a claude.ai connector means an HTTPS round trip. Run it on purpose:
 *
 *     CAPYGEN_LIVE_CONFIG=1 corepack pnpm exec vitest run --project engine configLive
 *
 * Read-only means read-only: this file runs `--version`, `plugin list --json`,
 * `plugin marketplace list --json` and `mcp list`, and nothing else. No `add`,
 * no `remove`, no `install`. The write paths are proved against temp homes in
 * `configStores.test.ts`, and the `CLAUDE_CONFIG_DIR` isolation those rely on
 * was itself proved live before this file existed (see that file's header).
 */
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeConfigStore, parseMcpListOutput } from "../src/config/index.js";

function claudeAvailable(): boolean {
  try {
    execFileSync("claude", ["--version"], { windowsHide: true, timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const live = process.env.CAPYGEN_LIVE_CONFIG === "1" && claudeAvailable();

describe.skipIf(!live)("live Claude CLI (read-only)", () => {
  const home = os.homedir();
  const store = new ClaudeConfigStore({
    configDir: process.env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"),
    home,
    env: process.env,
  });

  it("parses `claude plugin list --json` into PluginEntry-shaped rows", async () => {
    const rows = await store.livePlugins();
    expect(Array.isArray(rows)).toBe(true);
    for (const row of rows) {
      expect(row.id).toMatch(/^[^@]+@[^@]+$/);
      expect(typeof row.enabled).toBe("boolean");
    }
    // The same ids must be readable from the file the store normally uses, or
    // the settings page and the CLI would disagree about what is installed.
    const fromFiles = new Set(store.read().plugins.map((plugin) => plugin.name));
    for (const row of rows) expect(fromFiles.has(row.id)).toBe(true);
  }, 60_000);

  it("parses `claude plugin marketplace list --json`", async () => {
    const rows = await store.marketplaces();
    for (const row of rows) expect(row.name.length).toBeGreaterThan(0);
  }, 60_000);

  it("parses `claude mcp list`'s text into names and statuses", async () => {
    const rows = await store.liveMcpStatus();
    for (const row of rows) {
      expect(row.name.length).toBeGreaterThan(0);
      expect(["connected", "failed", "needs-auth", "unknown"]).toContain(row.status);
    }
    // The parser must not have swallowed the header line.
    expect(rows.some((row) => row.name.includes("Checking"))).toBe(false);
  }, 120_000);

  it("reads the machine's own settings chain without throwing", () => {
    const snapshot = store.read();
    expect(Array.isArray(snapshot.skills)).toBe(true);
    expect(Array.isArray(snapshot.tools)).toBe(true);
    // Whatever is in the real files, every row is well-formed.
    for (const skill of snapshot.skills) expect(skill.path.endsWith("SKILL.md")).toBe(true);
    for (const policy of snapshot.tools) {
      expect(["allow", "deny", "ask"]).toContain(policy.decision);
    }
  });
});

describe("the `claude mcp list` parser is exercised offline too", () => {
  it("ignores the health-check banner", () => {
    expect(parseMcpListOutput("Checking MCP server health…\n")).toEqual([]);
  });
});
