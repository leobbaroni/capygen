/**
 * Phase 7-P0: every integrations operation carries an **explicit** project id.
 *
 * The contract these cases hold the code to (`docs/plans/phase7-project-scope.md`):
 *
 *  - `projectId` omitted means **global only**, never "the most recently
 *    touched project". Two windows on two projects must not read each other's
 *    `.mcp.json`/`.claude/skills` because one of them wrote a session row last.
 *  - An **unknown** id fails before any read, write, probe or shell open.
 *  - A project/local mutation needs an explicit valid id — there is no implicit
 *    target.
 *  - Request scope is **immutable across awaits**: an operation that awaits a
 *    slow CLI finishes against the project it started on, even though another
 *    project became the most recent one in the meantime.
 *  - Snapshots and watcher refreshes are keyed by scope, and the SQLite cache
 *    stays a projection of the **global** files: a project read must not
 *    overwrite the global rows.
 *
 * Every case runs on temp `CLAUDE_CONFIG_DIR`/`CODEX_HOME` homes and temp
 * project directories; nothing here touches the machine's real config.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseInvokeArgs,
  parseInvokeResult,
  type InvokeChannel,
  type McpServerEntry,
  type SkillEntry,
} from "@capygen/shared";
import type { CliResult, CliRunner } from "@capygen/engine";
import { createIpcContext, type IpcContext } from "../src/ipc/handlers.js";
import { IntegrationsService } from "../src/integrations/IntegrationsService.js";
import type { WatcherLike } from "../src/integrations/SyncCoordinator.js";
import { createStubEngine } from "../src/engine/stub.js";
import { makeHarness, waitFor, type Harness } from "./workspaceHarness.js";

let h: Harness;
let ipc: IpcContext;
let claudeHome: string;
let codexHome: string;
let projectA: string;
let projectB: string;
let idA: string;
let idB: string;
/** Resolves the next `claude` CLI call when a test wants to interleave. */
let gate: (() => void) | null;
/** Every path handed to the shell by `integrations.skill.open`. */
let opened: string[];
/** Fire the fake watcher for the paths matching this predicate. */
let fireWatch: ((match: (paths: string[]) => boolean) => void) | null;

/**
 * Watchers opened by a service built with `makeService` — the cases that need a
 * real TTL, a controllable watcher event or a bounded watcher pool build their
 * own service rather than using the shared IPC context (whose `ttlMs` is 0, so
 * nothing there can ever be observed to be stale).
 */
interface LocalWatcher {
  paths: string[];
  closed: boolean;
  fire: () => void;
}
let localWatchers: LocalWatcher[];
let watcherAttempts: number;
let watcherFails: boolean;
let clock: number;

function write(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, "utf8");
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

function mcpJson(root: string): Record<string, unknown> {
  const file = path.join(root, ".mcp.json");
  return fs.existsSync(file) ? readJson(file) : {};
}

function names(entries: McpServerEntry[]): string[] {
  return entries.map((entry) => entry.name);
}

/** A `claude` stand-in for the user-scope commands, optionally gated. */
function makeRunner(): CliRunner {
  return async (_command, args, options): Promise<CliResult> => {
    if (gate) {
      await new Promise<void>((resolve) => {
        gate = resolve;
      });
    }
    const home = options.overrides?.CLAUDE_CONFIG_DIR ?? claudeHome;
    const globalConfig = path.join(home, ".claude.json");
    const config = fs.existsSync(globalConfig) ? readJson(globalConfig) : {};
    if (args[0] === "mcp" && args[1] === "add") {
      const dashes = args.indexOf("--");
      const name = (dashes >= 0 ? args[dashes - 1] : args[args.length - 2]) as string;
      const entry = { type: "stdio", command: args[dashes + 1], args: args.slice(dashes + 2) };
      if (args[args.indexOf("-s") + 1] === "local") {
        // The CLI keys a `local` server by the **cwd** it was run in, which is
        // the whole point of the scope; recording it is what lets a test say
        // which project the parked request finished against.
        const key = String(options.cwd ?? "").replace(/\\/g, "/");
        const projects = (config.projects as Record<string, { mcpServers?: Record<string, unknown> }>) ?? {};
        projects[key] = { ...(projects[key] ?? {}), mcpServers: { ...(projects[key]?.mcpServers ?? {}), [name]: entry } };
        config.projects = projects;
      } else {
        config.mcpServers = { ...((config.mcpServers as Record<string, unknown>) ?? {}), [name]: entry };
      }
      write(globalConfig, JSON.stringify(config, null, 2));
      return { code: 0, stdout: "Added", stderr: "" };
    }
    if (args[0] === "mcp" && args[1] === "remove") {
      const servers = (config.mcpServers as Record<string, unknown>) ?? {};
      delete servers[args[2] as string];
      config.mcpServers = servers;
      write(globalConfig, JSON.stringify(config, null, 2));
      return { code: 0, stdout: "Removed", stderr: "" };
    }
    if (args[0] === "mcp" && args[1] === "list") {
      return { code: 0, stdout: "Checking MCP server health…\n\n", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `fake claude: unhandled ${args.join(" ")}` };
  };
}

function makeService(options: {
  ttlMs?: number;
  maxProjectWatchers?: number;
  watchRetryCooldownMs?: number;
} = {}): IntegrationsService {
  return new IntegrationsService({
    store: h.store,
    broadcast: h.broadcast,
    log: h.log,
    env: { CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome },
    home: h.dir,
    run: makeRunner(),
    debounceMs: 5,
    now: () => clock,
    ...options,
    createWatcher: (paths: string[]): WatcherLike => {
      watcherAttempts += 1;
      if (watcherFails) throw new Error("fake: this path cannot be watched");
      const handlers: (() => void)[] = [];
      const record: LocalWatcher = {
        paths,
        closed: false,
        fire: () => handlers.forEach((fn) => fn()),
      };
      localWatchers.push(record);
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
}

/** The watchers a service opened on paths under `root`. */
function watchersFor(root: string): LocalWatcher[] {
  return localWatchers.filter((w) => w.paths.some((p) => p.startsWith(root)));
}

/**
 * Fire every watcher on `root`, after letting the pending `watch()` settle:
 * `ensureWatched` is deliberately not awaited by `integrations.list`, so the
 * event handlers are attached a microtask after the factory ran.
 */
async function fireWatchersFor(root: string): Promise<void> {
  expect(await waitFor(() => watchersFor(root).length > 0, 2_000, 5)).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (const watcher of watchersFor(root)) watcher.fire();
}

async function call<C extends InvokeChannel>(channel: C, raw: unknown): Promise<unknown> {
  const args = parseInvokeArgs(channel, raw);
  const handler = ipc.handlers[channel] as (a: unknown) => unknown;
  return parseInvokeResult(channel, await handler(args));
}

/** `integrations.list` for one scope, typed down to what these cases read. */
async function list(
  backend: "claude" | "codex" | "api",
  projectId?: string,
): Promise<{ mcpServers: McpServerEntry[]; skills: SkillEntry[] }> {
  return (await call("integrations.list", {
    backend,
    ...(projectId === undefined ? {} : { projectId }),
  })) as { mcpServers: McpServerEntry[]; skills: SkillEntry[] };
}

beforeEach(async () => {
  h = makeHarness({ prefix: "capygen-scope-" });
  claudeHome = path.join(h.dir, "claude");
  codexHome = path.join(h.dir, "codex");
  fs.mkdirSync(claudeHome, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  gate = null;
  opened = [];
  localWatchers = [];
  watcherAttempts = 0;
  watcherFails = false;
  clock = 1_000_000;

  projectA = path.join(h.dir, "alpha");
  projectB = path.join(h.dir, "beta");
  fs.mkdirSync(projectA, { recursive: true });
  fs.mkdirSync(projectB, { recursive: true });

  // The same *name* in both projects, so a row from the wrong project cannot
  // be mistaken for the right one by name alone.
  write(
    path.join(projectA, ".mcp.json"),
    JSON.stringify({ mcpServers: { shared: { command: "node", args: ["a.js"] } } }),
  );
  write(
    path.join(projectB, ".mcp.json"),
    JSON.stringify({ mcpServers: { shared: { command: "node", args: ["b.js"] } } }),
  );
  write(
    path.join(projectA, ".claude", "skills", "shared-skill", "SKILL.md"),
    "---\nname: shared-skill\ndescription: from A\n---\n",
  );
  write(
    path.join(projectB, ".claude", "skills", "shared-skill", "SKILL.md"),
    "---\nname: shared-skill\ndescription: from B\n---\n",
  );

  idA = h.store.projects.upsertByPath({ path: projectA }).id;
  idB = h.store.projects.upsertByPath({ path: projectB }).id;
  // B is the most recently touched project for every case below: the old
  // behaviour resolved *every* request to this one.
  h.store.projects.touch(idA);
  h.store.projects.touch(idB);

  const watchers: { paths: string[]; fire: () => void }[] = [];
  fireWatch = (match) => {
    for (const watcher of watchers) if (match(watcher.paths)) watcher.fire();
  };
  const createWatcher = (paths: string[]): WatcherLike => {
    const handlers: (() => void)[] = [];
    watchers.push({ paths, fire: () => handlers.forEach((fn) => fn()) });
    return {
      on: (event: string, fn: (changed: string) => void) => {
        if (event !== "error") handlers.push(() => fn("changed"));
      },
      close: () => undefined,
    };
  };

  ipc = createIpcContext({
    store: h.store,
    broadcast: h.broadcast,
    log: h.log,
    makeEngine: createStubEngine,
    pickDirectory: async () => null,
    appInfo: () => ({
      name: "capygen",
      version: "0.1.0",
      electron: "44.2.0",
      chrome: "1",
      node: "24.20.0",
      platform: "win32",
      userDataDir: h.dir,
      logFile: path.join(h.dir, "logs", "capygen.log"),
      dbFile: h.store.db.file,
    }),
    integrations: {
      env: { CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome },
      home: h.dir,
      run: makeRunner(),
      createWatcher,
      openPath: (target) => {
        opened.push(target);
      },
      confirmInstall: async () => true,
      ttlMs: 0,
      debounceMs: 5,
    },
  });
  await ipc.integrations.start();
});

afterEach(async () => {
  fireWatch = null;
  gate = null;
  await ipc.dispose();
  h.close();
});

// ---------------------------------------------------------------------------

describe("explicit project scope on reads", () => {
  it("answers each project from its own files, and omission from the globals only", async () => {
    write(
      path.join(claudeHome, ".claude.json"),
      JSON.stringify({ mcpServers: { "global-one": { type: "stdio", command: "node" } } }),
    );

    const a = await list("claude", idA);
    const b = await list("claude", idB);
    const global = await list("claude");

    expect(a.mcpServers.find((e) => e.scope === "project")?.args).toEqual(["a.js"]);
    expect(b.mcpServers.find((e) => e.scope === "project")?.args).toEqual(["b.js"]);
    expect(a.skills.find((s) => s.scope === "project")?.description).toBe("from A");
    expect(b.skills.find((s) => s.scope === "project")?.description).toBe("from B");

    // Omitted id is global-only — B being the most recent project must not
    // leak `shared`/`shared-skill` into this answer.
    expect(names(global.mcpServers)).toEqual(["global-one"]);
    expect(global.skills).toEqual([]);

    // …and the globals are visible from both projects.
    expect(names(a.mcpServers)).toContain("global-one");
    expect(names(b.mcpServers)).toContain("global-one");
  });

  it("refuses an unknown project id before it reads anything", async () => {
    await expect(list("claude", "no-such-project")).rejects.toThrow(/unknown project/i);
  });
});

describe("explicit project scope on writes", () => {
  it("mutates the requested project while another one is the most recent", async () => {
    await call("integrations.mcp.add", {
      backend: "claude",
      scope: "project",
      projectId: idA,
      entry: { name: "only-in-a", transport: "stdio", command: "node", source: "capygen" },
    });

    expect(Object.keys(mcpJson(projectA).mcpServers as object)).toEqual(["shared", "only-in-a"]);
    expect(Object.keys(mcpJson(projectB).mcpServers as object)).toEqual(["shared"]);
  });

  it("refuses a project-scope write with no project id", async () => {
    await expect(
      call("integrations.mcp.add", {
        backend: "claude",
        scope: "project",
        entry: { name: "nowhere", transport: "stdio", command: "node", source: "capygen" },
      }),
    ).rejects.toThrow(/project/i);
    expect(Object.keys(mcpJson(projectB).mcpServers as object)).toEqual(["shared"]);
  });

  it("refuses an unknown project id before it writes anything", async () => {
    await expect(
      call("integrations.mcp.add", {
        backend: "claude",
        scope: "project",
        projectId: "no-such-project",
        entry: { name: "nowhere", transport: "stdio", command: "node", source: "capygen" },
      }),
    ).rejects.toThrow(/unknown project/i);
    expect(Object.keys(mcpJson(projectA).mcpServers as object)).toEqual(["shared"]);
    expect(Object.keys(mcpJson(projectB).mcpServers as object)).toEqual(["shared"]);
  });

  it("keeps a request's scope across an await while other scopes interleave", async () => {
    // A `local`-scope add reaches the CLI with the project as its cwd — the
    // one write that both awaits *and* has a project component. It is parked
    // mid-flight while a second window lists B and makes B the most recent.
    gate = () => undefined;
    const pending = call("integrations.mcp.add", {
      backend: "claude",
      scope: "local",
      projectId: idA,
      entry: { name: "gated", transport: "stdio", command: "node", source: "capygen" },
    });
    expect(await waitFor(() => typeof gate === "function", 2_000, 5)).toBe(true);

    const bWhilePending = await list("claude", idB);
    expect(bWhilePending.mcpServers.find((e) => e.scope === "project")?.args).toEqual(["b.js"]);
    h.store.projects.touch(idB);

    const release = gate as unknown as () => void;
    gate = null;
    release();
    await pending;

    // The parked request finished against **A**: the CLI ran with A as its
    // cwd, so the row landed under A's key and not under B's.
    const config = readJson(path.join(claudeHome, ".claude.json"));
    const projects = config.projects as Record<string, { mcpServers?: Record<string, unknown> }>;
    expect(Object.keys(projects[projectA.replace(/\\/g, "/")]?.mcpServers ?? {})).toEqual(["gated"]);
    expect(projects[projectB.replace(/\\/g, "/")]).toBeUndefined();

    // …and it re-read and broadcast for its own scope, not for whichever
    // project happened to be most recent when it woke up.
    const changed = h.eventsOn("integrations.changed") as { projectId: string | null }[];
    expect(changed.some((e) => e.projectId === idA)).toBe(true);
    expect(changed.some((e) => e.projectId === idB)).toBe(false);
  });

  /**
   * [review] The reach of a write is the resource's, not the request's. The
   * settings page sends this window's selected project on **every** call,
   * including a `user`-scope add, which lands in `~/.claude.json`. Keying the
   * invalidation off the request's `projectId` refreshed project A alone and
   * left B's warm snapshot, the global snapshot and the global SQLite
   * projection holding the pre-write content — while telling every window the
   * change belonged to A.
   */
  it("treats a user-scope write sent with a projectId as the global change it is", async () => {
    const service = makeService({ ttlMs: 60_000 });
    try {
      await service.start();
      // Warm every scope: with a TTL far longer than this test, nothing here
      // can be re-read by accident.
      expect(names(service.list({ backend: "claude" }).mcpServers)).toEqual([]);
      service.list({ backend: "claude", projectId: idA });
      expect(names(service.list({ backend: "claude", projectId: idB }).mcpServers)).toEqual([
        "shared",
      ]);
      h.events.length = 0;

      await service.mcpAdd({
        backend: "claude",
        scope: "user",
        projectId: idA,
        entry: { name: "added-globally", transport: "stdio", command: "node", source: "capygen" },
      });

      // Every scope sees it, including the project that was never named.
      expect(names(service.list({ backend: "claude" }).mcpServers)).toEqual(["added-globally"]);
      expect(names(service.list({ backend: "claude", projectId: idB }).mcpServers)).toContain(
        "added-globally",
      );
      expect(names(service.list({ backend: "claude", projectId: idA }).mcpServers)).toContain(
        "added-globally",
      );
      // The global SQLite projection was re-read, not left behind.
      expect(h.store.mcpServers.listByBackend("claude").map((e) => e.name)).toEqual([
        "added-globally",
      ]);
      // And the event says "global", so every window reloads.
      const changed = h.eventsOn("integrations.changed") as {
        backend: string;
        projectId: string | null;
      }[];
      expect(changed.length).toBeGreaterThan(0);
      expect(changed.every((e) => e.projectId === null)).toBe(true);
      // `api` inherits from Claude, so its listeners are told too.
      expect(changed.some((e) => e.backend === "api")).toBe(true);
    } finally {
      await service.dispose();
    }
  });

  it("refuses a project/session tool policy the schema cannot identify", async () => {
    // `policies` is keyed by (backend, scope, pattern) with no project or
    // session column, so these would be one global row wearing a scope label.
    for (const args of [
      { backend: "codex", scope: "project", pattern: "shell(ls)", decision: "deny", projectId: idA },
      { backend: "api", scope: "session", pattern: "read", decision: "ask" },
      { backend: "claude", scope: "session", pattern: "Bash(x)", decision: "ask" },
    ]) {
      await expect(call("integrations.tools.setPolicy", args)).rejects.toThrow(
        /no project or session identity/i,
      );
    }
    expect(h.store.toolPolicies.listByBackend("codex")).toEqual([]);
    expect(h.store.toolPolicies.listByBackend("api")).toEqual([]);
    expect(h.store.toolPolicies.listByBackend("claude")).toEqual([]);
  });
});

describe("caches and watchers are per scope", () => {
  it("a project read never overwrites the global cache rows", async () => {
    write(
      path.join(claudeHome, ".claude.json"),
      JSON.stringify({ mcpServers: { "global-one": { type: "stdio", command: "node" } } }),
    );
    await list("claude");
    const globalRows = h.store.mcpServers.listByBackend("claude").map((e) => e.name);

    await list("claude", idA);
    await list("claude", idB);

    expect(h.store.mcpServers.listByBackend("claude").map((e) => e.name)).toEqual(globalRows);
    expect(globalRows).toEqual(["global-one"]);
  });

  it("an outside edit in one project refreshes that project's scope only", async () => {
    await list("claude", idA);
    await list("claude", idB);
    h.events.length = 0;

    write(
      path.join(projectA, ".mcp.json"),
      JSON.stringify({ mcpServers: { shared: { command: "node", args: ["a.js"] }, late: { command: "node" } } }),
    );
    fireWatch?.((paths) => paths.some((p) => p.startsWith(projectA)));

    expect(await waitFor(() => h.eventsOn("integrations.changed").length > 0, 4_000, 10)).toBe(true);
    const events = h.eventsOn("integrations.changed") as {
      backend: string;
      kinds: string[];
      projectId: string | null;
    }[];
    expect(events.every((e) => e.projectId === idA)).toBe(true);
    expect(names((await list("claude", idA)).mcpServers)).toContain("late");
    expect(names((await list("claude", idB)).mcpServers)).not.toContain("late");
  });

  it("a global write invalidates the project snapshots too", async () => {
    await list("claude", idA);
    await call("integrations.mcp.add", {
      backend: "claude",
      scope: "user",
      entry: { name: "added-globally", transport: "stdio", command: "node", source: "capygen" },
    });
    expect(names((await list("claude", idA)).mcpServers)).toContain("added-globally");
    expect(names((await list("claude", idB)).mcpServers)).toContain("added-globally");
  });
});

describe("skill.open stays inside the requested scope", () => {
  it("refuses a skill file that only the other project lists", async () => {
    const bSkill = path.join(projectB, ".claude", "skills", "shared-skill", "SKILL.md");
    await expect(
      call("integrations.skill.open", { path: bSkill, projectId: idA }),
    ).rejects.toThrow(/skill files/i);
    expect(opened).toEqual([]);

    await call("integrations.skill.open", { path: bSkill, projectId: idB });
    expect(opened).toEqual([bSkill]);
  });
});

/**
 * [review] A global watcher event and the caches that layer on it.
 *
 * The watcher on `~/.claude.json` fires, the coordinator re-reads the **global**
 * scope and broadcasts. Every window then reloads — and a window on project A
 * asks for A's scope, whose snapshot was computed against the *previous* global
 * content and is still inside its TTL. Unless the global re-read drops the
 * project snapshots **before** it broadcasts, the reload the event asked for is
 * served the stale answer, which is exactly the state the event existed to end.
 */
describe("an outside global edit invalidates the project scopes first", () => {
  it("serves the new global row to a warm project scope on the very next list", async () => {
    const service = makeService({ ttlMs: 60_000 });
    try {
      await service.start();
      // Warm A and B. With a 60 s TTL neither can be re-read by expiry.
      expect(names(service.list({ backend: "claude", projectId: idA }).mcpServers)).toEqual([
        "shared",
      ]);
      expect(names(service.list({ backend: "claude", projectId: idB }).mcpServers)).toEqual([
        "shared",
      ]);
      service.list({ backend: "claude" });
      h.events.length = 0;

      // Something that is not capygen edits the global config…
      write(
        path.join(claudeHome, ".claude.json"),
        JSON.stringify({ mcpServers: { "outside-global": { type: "stdio", command: "node" } } }),
      );
      // …and the watcher on the global paths fires.
      await fireWatchersFor(claudeHome);

      expect(
        await waitFor(() => h.eventsOn("integrations.changed").length > 0, 4_000, 10),
      ).toBe(true);
      const changed = h.eventsOn("integrations.changed") as { projectId: string | null }[];
      expect(changed.every((e) => e.projectId === null)).toBe(true);

      // The reload the event asks for. Both project scopes must already have
      // been dropped, so these read the file rather than the warm snapshot.
      expect(names(service.list({ backend: "claude", projectId: idA }).mcpServers)).toContain(
        "outside-global",
      );
      expect(names(service.list({ backend: "claude", projectId: idB }).mcpServers)).toContain(
        "outside-global",
      );
    } finally {
      await service.dispose();
    }
  });
});

/**
 * [review] The `api` backend watches no files of its own — its list is its own
 * SQLite servers plus everything it inherits from Claude and Codex. A window
 * that only opens Settings ▸ MCP ▸ API for a project therefore established no
 * watcher on that project at all, and nothing ever invalidated the `api` view
 * when the inherited half changed.
 */
describe("api inherits, so it watches and refreshes with the other two", () => {
  it("establishes the Claude and Codex watchers for a project listed as api", async () => {
    const service = makeService({ ttlMs: 60_000 });
    try {
      await service.start();
      expect(watchersFor(projectA)).toHaveLength(0);
      service.list({ backend: "api", projectId: idA });
      expect(
        await waitFor(() => watchersFor(projectA).length > 0, 2_000, 5),
      ).toBe(true);
      // Claude's project paths (`.mcp.json`, `.claude/**`) and Codex's
      // (`.codex/skills`) — the two sources an `api` row can be inherited from.
      const paths = watchersFor(projectA).flatMap((w) => w.paths);
      expect(paths.some((p) => p.endsWith(".mcp.json"))).toBe(true);
      expect(paths.some((p) => p.includes(".codex"))).toBe(true);
    } finally {
      await service.dispose();
    }
  });

  it("invalidates and announces the api scope when its inherited half moves", async () => {
    const service = makeService({ ttlMs: 60_000 });
    try {
      await service.start();
      expect(names(service.list({ backend: "api", projectId: idA }).mcpServers)).toEqual([
        "shared",
      ]);
      h.events.length = 0;

      write(
        path.join(projectA, ".mcp.json"),
        JSON.stringify({
          mcpServers: { shared: { command: "node", args: ["a.js"] }, inherited: { command: "node" } },
        }),
      );
      await fireWatchersFor(projectA);

      expect(
        await waitFor(
          () =>
            (h.eventsOn("integrations.changed") as { backend: string }[]).some(
              (e) => e.backend === "api",
            ),
          4_000,
          10,
        ),
      ).toBe(true);
      const apiEvents = (h.eventsOn("integrations.changed") as {
        backend: string;
        projectId: string | null;
      }[]).filter((e) => e.backend === "api");
      expect(apiEvents.every((e) => e.projectId === idA)).toBe(true);
      expect(names(service.list({ backend: "api", projectId: idA }).mcpServers)).toContain(
        "inherited",
      );
    } finally {
      await service.dispose();
    }
  });
});

/**
 * [review] Project watchers used to accumulate for the life of the app: every
 * project a window ever looked at kept three chokidar instances and their OS
 * handles alive. And a path that could not be watched at all was retried by
 * every single `integrations.list`.
 */
describe("the project watcher pool is bounded", () => {
  it("evicts the least-recently-used project and closes its watchers", async () => {
    const roots: string[] = [];
    const ids: string[] = [];
    for (const name of ["p1", "p2", "p3"]) {
      const root = path.join(h.dir, name);
      fs.mkdirSync(root, { recursive: true });
      roots.push(root);
      ids.push(h.store.projects.upsertByPath({ path: root }).id);
    }
    const service = makeService({ ttlMs: 60_000, maxProjectWatchers: 2 });
    try {
      await service.start();
      for (const id of ids) {
        service.list({ backend: "claude", projectId: id });
        clock += 1_000;
      }
      expect(
        await waitFor(() => watchersFor(roots[2]!).length > 0, 2_000, 5),
      ).toBe(true);

      expect(service.sync.watchedProjectCount()).toBe(2);
      // p1 was the coldest, so it is the one that was released…
      expect(await waitFor(() => watchersFor(roots[0]!).every((w) => w.closed), 2_000, 5)).toBe(
        true,
      );
      expect(watchersFor(roots[0]!).length).toBeGreaterThan(0);
      // …and the two still in play are untouched.
      expect(watchersFor(roots[1]!).some((w) => w.closed)).toBe(false);
      expect(watchersFor(roots[2]!).some((w) => w.closed)).toBe(false);

      // An evicted project is still answerable — it just re-opens its watchers.
      expect(names(service.list({ backend: "claude", projectId: ids[0]! }).mcpServers)).toEqual([]);
    } finally {
      await service.dispose();
    }
  });

  it("backs off a watcher that cannot be created instead of retrying every list", async () => {
    watcherFails = true;
    const service = makeService({ ttlMs: 0, watchRetryCooldownMs: 30_000 });
    try {
      await service.start();
      const afterStart = watcherAttempts;
      for (let i = 0; i < 5; i += 1) service.list({ backend: "claude", projectId: idA });
      await waitFor(() => watcherAttempts > afterStart, 2_000, 5);
      expect(watcherAttempts).toBe(afterStart + 1);

      // Still inside the cooldown: no further attempt.
      clock += 10_000;
      service.list({ backend: "claude", projectId: idA });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(watcherAttempts).toBe(afterStart + 1);

      // Past it: one more try.
      clock += 30_000;
      service.list({ backend: "claude", projectId: idA });
      expect(await waitFor(() => watcherAttempts === afterStart + 2, 2_000, 5)).toBe(true);
    } finally {
      await service.dispose();
    }
  });
});
