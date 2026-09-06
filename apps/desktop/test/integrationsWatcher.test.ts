/**
 * The watcher, for real (SPEC R29: "changes … outside the app … reflected").
 *
 * `integrations.test.ts` drives the coordinator through a *fake* watcher, which
 * proves the plumbing but not the thing that actually breaks: whether chokidar,
 * on Windows, fires for the files capygen points it at. So this file runs the
 * real one — a real `~/.codex/config.toml` under a temp `CODEX_HOME`, edited
 * with `fs.writeFileSync`, and an assertion that the event arrives.
 *
 * It is slower than the rest of the suite (chokidar's `awaitWriteFinish` alone
 * is 250 ms) and it is the only test here that sleeps, which is why it is one
 * file with two cases rather than a rule applied everywhere.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexConfigStore, codexWatchTargets } from "@capygen/engine";
import { IntegrationsService } from "../src/integrations/IntegrationsService.js";
import { SyncCoordinator } from "../src/integrations/SyncCoordinator.js";
import { makeHarness, waitFor, type Harness } from "./workspaceHarness.js";

let h: Harness;
let codexHome: string;
let sync: SyncCoordinator | null;

beforeEach(() => {
  h = makeHarness({ prefix: "capygen-watch-" });
  codexHome = path.join(h.dir, "codex");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "config.toml"), '# start\nmodel = "gpt-6"\n', "utf8");
  sync = null;
});

afterEach(async () => {
  await sync?.dispose();
  h.close();
});

function start(): SyncCoordinator {
  const store = new CodexConfigStore({ configDir: codexHome });
  const empty = {
    read: () => ({ mcpServers: [], plugins: [], skills: [], tools: [], marketplaces: [] }),
    watchTargets: (): string[] => [],
    toolPolicyScopes: [],
  };
  const coordinator = new SyncCoordinator({
    store: h.store,
    broadcast: h.broadcast,
    log: h.log,
    ttlMs: 0,
    debounceMs: 50,
    sources: {
      claude: empty,
      api: empty,
      codex: {
        read: () => store.read(),
        watchTargets: () => codexWatchTargets(store.paths),
        toolPolicyScopes: [],
      },
    },
  });
  sync = coordinator;
  return coordinator;
}

describe("chokidar on the real config paths", () => {
  it("notices a config.toml written by something that is not capygen", async () => {
    const coordinator = start();
    // Prime the cache so the first diff has something to compare against.
    expect(coordinator.snapshot("codex").mcpServers).toEqual([]);
    await coordinator.start();

    const configToml = path.join(codexHome, "config.toml");
    const outside = '# start\nmodel = "gpt-6"\n\n[mcp_servers.outside]\ncommand = "node"\n';
    fs.writeFileSync(configToml, outside, "utf8");

    // [C] Re-written on every poll, not once. Under the full suite (six vitest
    // projects, each with its own workers, on a machine that is also running a
    // build) chokidar's Windows backend has been observed to drop the single
    // edit outright — this file failed exactly that way in a loaded
    // `pnpm test` while passing three times in a row on its own. The subject
    // of the test is "an edit capygen did not make is noticed", and an edit
    // repeated until it is noticed still only passes if the watcher fires;
    // a broken watcher still times out. The content is byte-identical each
    // time, so `awaitWriteFinish` sees a normal settle, and the snapshot
    // assertion below is unchanged.
    const arrived = await waitFor(
      () => {
        if (h.eventsOn("integrations.changed").length > 0) return true;
        fs.writeFileSync(configToml, outside, "utf8");
        return false;
      },
      20_000,
      250,
    );
    expect(arrived).toBe(true);
    expect(h.eventsOn("integrations.changed")[0]).toEqual({
      backend: "codex",
      kinds: ["mcpServers"],
    });
    expect(coordinator.snapshot("codex").mcpServers.map((e) => e.name)).toEqual(["outside"]);
  }, 30_000);

  it("watches a skills directory that does not exist yet", async () => {
    // A fresh machine has no `~/.codex/skills`; chokidar must not throw, and
    // the coordinator must still be usable.
    const coordinator = start();
    await coordinator.start();
    expect(h.log.error).not.toHaveBeenCalled();
    expect(coordinator.snapshot("codex").skills).toEqual([]);
  }, 30_000);
});

/**
 * [review] `integrations.list` calls `retargetIfProjectMoved()` and then reads
 * `sync.snapshot()` synchronously. `retarget()` only clears the cache after it
 * has awaited every watcher's `close()`, and nothing awaits it — so with a
 * real TTL the first list after a project switch used to answer out of the
 * *previous* project's snapshot, project-scope MCP servers and skills
 * included. This runs with `ttlMs` well above the test's own duration, so a
 * regression cannot pass by the cache expiring on its own.
 */
describe("switching project invalidates the cache before the next list", () => {
  it("does not answer with the previous project's .mcp.json", async () => {
    const projectA = path.join(h.dir, "a");
    const projectB = path.join(h.dir, "b");
    fs.mkdirSync(projectA, { recursive: true });
    fs.mkdirSync(projectB, { recursive: true });
    fs.writeFileSync(
      path.join(projectA, ".mcp.json"),
      JSON.stringify({ mcpServers: { "only-in-a": { command: "node" } } }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(projectB, ".mcp.json"),
      JSON.stringify({ mcpServers: { "only-in-b": { command: "node" } } }),
      "utf8",
    );
    const a = h.store.projects.upsertByPath({ path: projectA });
    const b = h.store.projects.upsertByPath({ path: projectB });

    const claudeHome = path.join(h.dir, "claude");
    fs.mkdirSync(claudeHome, { recursive: true });
    const service = new IntegrationsService({
      store: h.store,
      broadcast: h.broadcast,
      log: h.log,
      env: { CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: path.join(h.dir, "codex") },
      home: h.dir,
      // Far longer than this test takes: the cache must be dropped by the
      // project switch itself, never by the TTL running out.
      ttlMs: 60_000,
      createWatcher: () => ({ on: () => undefined, close: () => undefined }),
    });
    try {
      await service.start();
      h.store.projects.touch(a.id);
      expect(service.list({ backend: "claude" }).mcpServers.map((e) => e.name)).toEqual([
        "only-in-a",
      ]);

      h.store.projects.touch(b.id);
      expect(service.list({ backend: "claude" }).mcpServers.map((e) => e.name)).toEqual([
        "only-in-b",
      ]);
    } finally {
      await service.dispose();
    }
  });
});
