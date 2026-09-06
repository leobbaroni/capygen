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
      projectId: null,
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
 * [7-P0] The scope an `integrations.list` answers in is the `projectId` it was
 * given, resolved once, per request — not "whichever project was touched most
 * recently". This used to be a mutable service-wide active project re-pointed
 * on every list, so two windows on two projects raced: whichever one last
 * touched a session row decided which `.mcp.json` *both* of them saw.
 *
 * `ttlMs` here is far longer than the test, so a regression cannot pass by the
 * cache happening to expire: the two answers have to come from two separately
 * keyed snapshots.
 */
describe("two projects are two scopes, resolved per request", () => {
  it("answers each project from its own .mcp.json regardless of recency", async () => {
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
      ttlMs: 60_000,
      createWatcher: () => ({ on: () => undefined, close: () => undefined }),
    });
    try {
      await service.start();
      // B is the most recent project throughout: it must not affect any answer.
      h.store.projects.touch(b.id);

      expect(service.list({ backend: "claude", projectId: a.id }).mcpServers.map((e) => e.name)).toEqual([
        "only-in-a",
      ]);
      expect(service.list({ backend: "claude", projectId: b.id }).mcpServers.map((e) => e.name)).toEqual([
        "only-in-b",
      ]);
      // Back to A, within the (very long) TTL: still A's file, from A's own
      // cache entry rather than the one B just filled.
      expect(service.list({ backend: "claude", projectId: a.id }).mcpServers.map((e) => e.name)).toEqual([
        "only-in-a",
      ]);
      // And no project named means the global files only.
      expect(service.list({ backend: "claude" }).mcpServers).toEqual([]);
    } finally {
      await service.dispose();
    }
  });

  it("refuses an id that names no project", async () => {
    const service = new IntegrationsService({
      store: h.store,
      broadcast: h.broadcast,
      log: h.log,
      env: { CLAUDE_CONFIG_DIR: path.join(h.dir, "claude"), CODEX_HOME: codexHome },
      home: h.dir,
      createWatcher: () => ({ on: () => undefined, close: () => undefined }),
    });
    try {
      expect(() => service.list({ backend: "claude", projectId: "nope" })).toThrow(
        /unknown project/i,
      );
    } finally {
      await service.dispose();
    }
  });
});

/**
 * [7-P0] Watcher lifecycle. Two things must hold no matter how the awaits
 * interleave: one (backend, scope) pair opens **one** watcher however many
 * requests ask for it, and a watcher that was still starting when the service
 * was disposed is closed rather than left running — a live watcher outliving
 * the service resurrects refreshes and broadcasts after shutdown.
 */
describe("watchers start once and close on disposal", () => {
  function makeService(opened: { paths: string[]; closed: boolean }[]): IntegrationsService {
    return new IntegrationsService({
      store: h.store,
      broadcast: h.broadcast,
      log: h.log,
      env: { CLAUDE_CONFIG_DIR: path.join(h.dir, "claude"), CODEX_HOME: codexHome },
      home: h.dir,
      ttlMs: 0,
      debounceMs: 5,
      createWatcher: (paths) => {
        const record = { paths, closed: false };
        opened.push(record);
        return {
          on: () => undefined,
          close: () => {
            record.closed = true;
          },
        };
      },
    });
  }

  it("opens one watcher per (backend, project), not one per request", async () => {
    const projectDir = path.join(h.dir, "one");
    fs.mkdirSync(projectDir, { recursive: true });
    const project = h.store.projects.upsertByPath({ path: projectDir });
    const opened: { paths: string[]; closed: boolean }[] = [];
    const service = makeService(opened);
    try {
      await service.start();
      const afterStart = opened.length;
      for (let i = 0; i < 5; i += 1) service.list({ backend: "claude", projectId: project.id });
      await waitFor(() => opened.length > afterStart, 2_000, 10);
      // Exactly one more watcher than the global ones `start()` opened.
      expect(opened.length).toBe(afterStart + 1);
    } finally {
      await service.dispose();
    }
    expect(opened.every((w) => w.closed)).toBe(true);
  });

  it("closes a watcher that was still starting, and ignores its late events", async () => {
    const projectDir = path.join(h.dir, "two");
    fs.mkdirSync(projectDir, { recursive: true });
    const project = h.store.projects.upsertByPath({ path: projectDir });
    const opened: { paths: string[]; closed: boolean; fire: () => void }[] = [];
    const releases: (() => void)[] = [];
    const service = new IntegrationsService({
      store: h.store,
      broadcast: h.broadcast,
      log: h.log,
      env: { CLAUDE_CONFIG_DIR: path.join(h.dir, "claude"), CODEX_HOME: codexHome },
      home: h.dir,
      ttlMs: 0,
      debounceMs: 5,
      // Every watcher parks until the test releases it, so disposal happens
      // while they are all mid-start.
      createWatcher: async (paths) => {
        await new Promise<void>((resolve) => releases.push(resolve));
        const handlers: (() => void)[] = [];
        const record = {
          paths,
          closed: false,
          fire: () => handlers.forEach((fn) => fn()),
        };
        opened.push(record);
        return {
          on: (event: string, fn: (changed: string) => void) => {
            if (event !== "error") handlers.push(() => fn("changed"));
          },
          close: () => {
            record.closed = true;
          },
        };
      },
    });
    void service.start();
    service.list({ backend: "claude", projectId: project.id });
    expect(await waitFor(() => releases.length > 0, 2_000, 5)).toBe(true);

    const disposed = service.dispose();
    for (const resolve of releases) resolve();
    // A watcher released *after* dispose started still has to be closed.
    await waitFor(() => releases.length === opened.length, 2_000, 5);
    for (const resolve of releases) resolve();
    await disposed;

    expect(opened.length).toBeGreaterThan(0);
    expect(opened.every((w) => w.closed)).toBe(true);

    // And a late callback from one of them resurrects nothing.
    h.events.length = 0;
    for (const watcher of opened) watcher.fire();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(h.eventsOn("integrations.changed")).toEqual([]);
  });
});
