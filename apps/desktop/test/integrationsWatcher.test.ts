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

    fs.writeFileSync(
      path.join(codexHome, "config.toml"),
      '# start\nmodel = "gpt-6"\n\n[mcp_servers.outside]\ncommand = "node"\n',
      "utf8",
    );

    const arrived = await waitFor(
      () => h.eventsOn("integrations.changed").length > 0,
      20_000,
      50,
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
