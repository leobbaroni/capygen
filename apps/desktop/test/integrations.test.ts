/**
 * The config-sync engine end to end (SPEC R20, R28-R30), driven through the
 * real IPC handlers with args and results parsed by the shared contract.
 *
 * **Every test runs on a temp home**: `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are
 * set to directories under the harness's temp dir, and the `claude` CLI is a
 * shim that records argv. Nothing here reads or writes the machine's real
 * `~/.claude`, `~/.codex` or `%APPDATA%\capygen`.
 *
 * The claims under test are the ones SPEC R29 actually makes:
 *  1. an edit made **outside** the app reaches the UI (watcher → refresh →
 *     `integrations.changed`, and only for the kinds that moved);
 *  2. an edit made **inside** the app lands in the backend's own file and is
 *     read back from it, not from a cache;
 *  3. the cache is a projection, so a row the files stop mentioning disappears.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseInvokeArgs,
  parseInvokeResult,
  type InvokeChannel,
  type McpServerEntry,
  type PluginEntry,
  type SkillEntry,
  type ToolPolicyEntry,
} from "@capygen/shared";
import type { CliResult, CliRunner } from "@capygen/engine";
import { createIpcContext, type IpcContext } from "../src/ipc/handlers.js";
import { INTEGRATIONS_CHANNELS } from "../src/ipc/integrations.js";
import type { WatcherLike } from "../src/integrations/SyncCoordinator.js";
import { createStubEngine } from "../src/engine/stub.js";
import { makeHarness, waitFor, type Harness } from "./workspaceHarness.js";

let h: Harness;
let ipc: IpcContext;
let claudeHome: string;
let codexHome: string;
let cliCalls: string[][];
/** Every path `integrations.skill.open` actually handed to the shell. */
let opened: string[];
/** Every plugin confirm the R27 gate asked for, and the answer it was given. */
let confirms: { detail: string }[];
let confirmAnswer: boolean;
/** Fired by the fake watcher to simulate an outside edit. */
let fireWatch: ((backend: string) => void) | null;

function write(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, "utf8");
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

/** A `claude` stand-in for the two commands that own `.claude.json`. */
function makeRunner(): CliRunner {
  return async (command, args, options): Promise<CliResult> => {
    cliCalls.push([command, ...args]);
    const home = options.overrides?.CLAUDE_CONFIG_DIR ?? claudeHome;
    const globalConfig = path.join(home, ".claude.json");
    const config = fs.existsSync(globalConfig) ? readJson(globalConfig) : {};
    if (args[0] === "mcp" && args[1] === "add") {
      const dashes = args.indexOf("--");
      const name = (dashes >= 0 ? args[dashes - 1] : args[args.length - 2]) as string;
      const servers = (config.mcpServers as Record<string, unknown>) ?? {};
      servers[name] =
        dashes >= 0
          ? { type: "stdio", command: args[dashes + 1], args: args.slice(dashes + 2) }
          : { type: args[args.indexOf("--transport") + 1], url: args[args.length - 1] };
      config.mcpServers = servers;
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
      return {
        code: 0,
        stdout: "Checking MCP server health…\n\nfrom-cli: node x.js - ✔ Connected\n",
        stderr: "",
      };
    }
    if (args[0] === "plugin" && args[1] === "marketplace") {
      return { code: 0, stdout: JSON.stringify([{ name: "cockpit", repo: "a/b" }]), stderr: "" };
    }
    if (args[0] === "plugin" && (args[1] === "enable" || args[1] === "disable")) {
      const settings = path.join(home, "settings.json");
      const current = fs.existsSync(settings) ? readJson(settings) : {};
      const enabled = (current.enabledPlugins as Record<string, unknown>) ?? {};
      enabled[args[2] as string] = args[1] === "enable";
      current.enabledPlugins = enabled;
      write(settings, JSON.stringify(current, null, 2));
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "plugin" && args[1] === "install") {
      const file = path.join(home, "plugins", "installed_plugins.json");
      const current = fs.existsSync(file) ? readJson(file) : { version: 2, plugins: {} };
      (current.plugins as Record<string, unknown>)[args[2] as string] = [{ scope: "user" }];
      write(file, JSON.stringify(current, null, 2));
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "plugin" && args[1] === "uninstall") {
      const file = path.join(home, "plugins", "installed_plugins.json");
      const current = fs.existsSync(file) ? readJson(file) : { version: 2, plugins: {} };
      delete (current.plugins as Record<string, unknown>)[args[2] as string];
      write(file, JSON.stringify(current, null, 2));
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `fake claude: unhandled ${args.join(" ")}` };
  };
}

async function call<C extends InvokeChannel>(channel: C, raw: unknown): Promise<unknown> {
  const args = parseInvokeArgs(channel, raw);
  const handler = ipc.handlers[channel] as (a: unknown) => unknown;
  return parseInvokeResult(channel, await handler(args));
}

beforeEach(async () => {
  h = makeHarness({ prefix: "capygen-integ-" });
  claudeHome = path.join(h.dir, "claude");
  codexHome = path.join(h.dir, "codex");
  cliCalls = [];
  opened = [];
  confirms = [];
  confirmAnswer = true;
  const listeners: Record<string, (() => void)[]> = {};
  fireWatch = (backend) => {
    for (const fn of listeners[backend] ?? []) fn();
  };

  // One fake watcher per backend, told apart by the paths it is handed.
  let watcherIndex = 0;
  const createWatcher = (paths: string[]): WatcherLike => {
    const backend = paths.some((p) => p.includes("codex")) ? "codex" : "claude";
    watcherIndex += 1;
    return {
      on: (event: string, fn: (changed: string) => void) => {
        if (event === "error") return;
        (listeners[backend] ??= []).push(() => fn("changed"));
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
      confirmInstall: async (options) => {
        confirms.push({ detail: options.detail });
        return confirmAnswer;
      },
      // No TTL: every call in these tests should see the file as it is now.
      ttlMs: 0,
      debounceMs: 5,
    },
  });
  await ipc.integrations.start();
  expect(watcherIndex).toBeGreaterThan(0);
});

afterEach(async () => {
  fireWatch = null;
  await ipc.dispose();
  h.close();
});

// ---------------------------------------------------------------------------

describe("contract coverage", () => {
  it("every integrations channel in the contract is answered for real", () => {
    for (const channel of INTEGRATIONS_CHANNELS) {
      expect(typeof ipc.handlers[channel]).toBe("function");
    }
    expect(INTEGRATIONS_CHANNELS).toHaveLength(15);
  });
});

describe("integrations.list", () => {
  it("merges every Claude scope with its source, and stamps lastSync", async () => {
    write(
      path.join(claudeHome, ".claude.json"),
      JSON.stringify({ mcpServers: { "user-one": { type: "stdio", command: "node" } } }),
    );
    write(
      path.join(h.root, ".mcp.json"),
      JSON.stringify({ mcpServers: { "proj-one": { command: "node" } } }),
    );
    write(
      path.join(claudeHome, "skills", "capy", "SKILL.md"),
      "---\nname: capy\ndescription: d\n---\n",
    );
    write(
      path.join(claudeHome, "settings.json"),
      JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }),
    );

    const result = (await call("integrations.list", { backend: "claude" })) as {
      mcpServers: McpServerEntry[];
      skills: SkillEntry[];
      tools: ToolPolicyEntry[];
      lastSync: number | null;
    };
    // Scope order, not alphabetical: user → local → project → plugin, which is
    // the precedence a person reasons about when two files name one server.
    expect(result.mcpServers.map((e) => [e.name, e.scope])).toEqual([
      ["user-one", "user"],
      ["proj-one", "project"],
    ]);
    expect(result.mcpServers[0]?.source).toBe(path.join(claudeHome, ".claude.json"));
    expect(result.skills.map((s) => s.name)).toEqual(["capy"]);
    expect(result.tools).toContainEqual({
      backend: "claude",
      pattern: "Bash(ls)",
      decision: "allow",
      scope: "global",
    });
    expect(typeof result.lastSync).toBe("number");
  });

  it("shows the api backend its own servers plus what it inherits", async () => {
    write(
      path.join(claudeHome, ".claude.json"),
      JSON.stringify({ mcpServers: { "from-claude": { type: "stdio", command: "node" } } }),
    );
    write(path.join(codexHome, "config.toml"), '[mcp_servers.from-codex]\ncommand = "x"\n');
    await call("integrations.mcp.add", {
      backend: "api",
      scope: "user",
      entry: { name: "mine", transport: "http", url: "https://x/mcp", source: "capygen" },
    });
    const result = (await call("integrations.list", { backend: "api" })) as {
      mcpServers: McpServerEntry[];
    };
    expect(result.mcpServers.map((e) => e.name)).toEqual(["mine", "from-claude", "from-codex"]);
    expect(result.mcpServers[1]?.source).toContain("inherited from claude");
  });

  it("caches within the TTL and re-reads after it", async () => {
    const service = ipc.integrations;
    // A store with a real TTL, so "cached" is observable.
    const first = service.sync.snapshot("codex");
    write(path.join(codexHome, "config.toml"), '[mcp_servers.late]\ncommand = "x"\n');
    // ttlMs is 0 in this suite, so the very next read must see the new file.
    const second = service.sync.snapshot("codex");
    expect(first.mcpServers).toEqual([]);
    expect(second.mcpServers.map((e) => e.name)).toEqual(["late"]);
  });
});

describe("outside edits reach the app (R29, two-way)", () => {
  it("a watcher event refreshes and broadcasts only the kinds that moved", async () => {
    await call("integrations.list", { backend: "codex" });
    h.events.length = 0;

    write(path.join(codexHome, "config.toml"), '[mcp_servers.added-outside]\ncommand = "x"\n');
    fireWatch?.("codex");

    expect(
      await waitFor(() => h.eventsOn("integrations.changed").length > 0, 4_000, 10),
    ).toBe(true);
    const events = h.eventsOn("integrations.changed") as { backend: string; kinds: string[] }[];
    expect(events[0]).toEqual({ backend: "codex", kinds: ["mcpServers"] });

    // A second event with no change on disk must not re-broadcast.
    h.events.length = 0;
    fireWatch?.("codex");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(h.eventsOn("integrations.changed")).toEqual([]);
  });

  it("integrations.refresh re-reads on demand", async () => {
    await call("integrations.list", { backend: "claude" });
    write(
      path.join(claudeHome, ".claude.json"),
      JSON.stringify({ mcpServers: { later: { type: "stdio", command: "node" } } }),
    );
    h.events.length = 0;
    expect(await call("integrations.refresh", { backend: "claude" })).toEqual({ ok: true });
    const result = (await call("integrations.list", { backend: "claude" })) as {
      mcpServers: McpServerEntry[];
    };
    expect(result.mcpServers.map((e) => e.name)).toEqual(["later"]);
  });

  it("drops a cached row the files stop mentioning", async () => {
    write(path.join(codexHome, "config.toml"), '[mcp_servers.gone]\ncommand = "x"\n');
    await call("integrations.list", { backend: "codex" });
    expect(h.store.mcpServers.listByBackend("codex").map((e) => e.name)).toEqual(["gone"]);

    write(path.join(codexHome, "config.toml"), "");
    await call("integrations.refresh", { backend: "codex" });
    expect(h.store.mcpServers.listByBackend("codex")).toEqual([]);
  });
});

describe("inside edits reach the backend's own files (R29, the other way)", () => {
  it("adds a Claude user-scope server through the CLI and reads it back", async () => {
    const entry = (await call("integrations.mcp.add", {
      backend: "claude",
      scope: "user",
      entry: { name: "capy", transport: "stdio", command: "node", args: ["s.js"], source: "x" },
    })) as McpServerEntry;
    expect(entry).toMatchObject({ backend: "claude", scope: "user", command: "node" });
    expect(cliCalls[0]?.slice(0, 5)).toEqual(["claude", "mcp", "add", "-s", "user"]);
    // …and the file the CLI owns really changed
    expect(readJson(path.join(claudeHome, ".claude.json")).mcpServers).toMatchObject({
      capy: { command: "node" },
    });
    // …and the change is broadcast so a second window updates
    const kinds = (h.eventsOn("integrations.changed") as { kinds: string[] }[]).flatMap(
      (e) => e.kinds,
    );
    expect(kinds).toContain("mcpServers");
  });

  it("writes a Codex server into config.toml without losing a comment", async () => {
    write(
      path.join(codexHome, "config.toml"),
      '# hand-written\nmodel = "gpt-6"\n\n[mcp_servers.keep]\ncommand = "keep"\n',
    );
    await call("integrations.mcp.add", {
      backend: "codex",
      scope: "user",
      entry: { name: "capy", transport: "stdio", command: "node", source: "x" },
    });
    const text = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
    expect(text).toContain("# hand-written");
    expect(text).toContain('model = "gpt-6"');
    expect(text).toContain("[mcp_servers.keep]");
    expect(text).toContain("[mcp_servers.capy]");
    // no CLI was spawned for Codex — it is a file edit
    expect(cliCalls.filter((c) => c[1] === "mcp")).toEqual([]);
  });

  it("removes a server and reports whether it is really gone", async () => {
    write(path.join(codexHome, "config.toml"), '[mcp_servers.bye]\ncommand = "x"\n');
    expect(
      await call("integrations.mcp.remove", { backend: "codex", scope: "user", name: "bye" }),
    ).toEqual({ ok: true });
    expect(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8")).not.toContain("bye");
  });

  it("writes a tool policy into Claude's own permissions arrays", async () => {
    write(path.join(claudeHome, "settings.json"), JSON.stringify({ model: "sonnet" }));
    const entry = (await call("integrations.tools.setPolicy", {
      backend: "claude",
      scope: "global",
      pattern: "Bash(npm test)",
      decision: "allow",
    })) as ToolPolicyEntry;
    expect(entry.decision).toBe("allow");
    const file = readJson(path.join(claudeHome, "settings.json"));
    expect(file.model).toBe("sonnet");
    expect((file.permissions as Record<string, unknown>).allow).toEqual(["Bash(npm test)"]);

    expect(
      await call("integrations.tools.removePolicy", {
        backend: "claude",
        scope: "global",
        pattern: "Bash(npm test)",
      }),
    ).toEqual({ ok: true });
  });

  it("keeps a codex tool policy in capygen's own table (Codex has no such file)", async () => {
    write(path.join(codexHome, "config.toml"), 'model = "gpt-6"\n');
    const entry = (await call("integrations.tools.setPolicy", {
      backend: "codex",
      scope: "global",
      pattern: "shell(rm *)",
      decision: "deny",
    })) as ToolPolicyEntry;
    expect(entry).toEqual({
      backend: "codex",
      scope: "global",
      pattern: "shell(rm *)",
      decision: "deny",
    });
    // config.toml is untouched — capygen does not invent a permissions section
    expect(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8")).toBe('model = "gpt-6"\n');
    // …and a re-sync does not prune it
    await call("integrations.refresh", { backend: "codex" });
    const listed = (await call("integrations.list", { backend: "codex" })) as {
      tools: ToolPolicyEntry[];
    };
    expect(listed.tools).toEqual([entry]);
  });

  it("disables a skill through skillOverrides and re-reads it", async () => {
    write(
      path.join(claudeHome, "skills", "capy", "SKILL.md"),
      "---\nname: capy\ndescription: d\n---\n",
    );
    const off = (await call("integrations.skill.setEnabled", {
      backend: "claude",
      name: "capy",
      enabled: false,
    })) as SkillEntry;
    expect(off.enabled).toBe(false);
    expect(readJson(path.join(claudeHome, "settings.json")).skillOverrides).toEqual({
      capy: "off",
    });
    // the file itself was never moved
    expect(fs.existsSync(path.join(claudeHome, "skills", "capy", "SKILL.md"))).toBe(true);
  });

  it("creates a skill and lists it", async () => {
    const created = (await call("integrations.skill.create", {
      backend: "codex",
      scope: "user",
      name: "brand-new",
      markdown: "---\nname: brand-new\ndescription: made here\n---\nBody\n",
    })) as SkillEntry;
    expect(created).toMatchObject({ backend: "codex", scope: "user", enabled: true });
    expect(fs.readFileSync(created.path, "utf8")).toContain("Body");
  });

  it("toggles a Claude plugin through the CLI and a Codex one in config.toml", async () => {
    write(
      path.join(claudeHome, "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "cockpit@cockpit": [{ scope: "user" }] } }),
    );
    const claudePlugin = (await call("integrations.plugin.setEnabled", {
      backend: "claude",
      name: "cockpit@cockpit",
      enabled: false,
    })) as PluginEntry;
    expect(claudePlugin.enabled).toBe(false);
    expect(cliCalls.at(-1)).toEqual(["claude", "plugin", "disable", "cockpit@cockpit"]);

    write(path.join(codexHome, "config.toml"), '[plugins."x@y"]\nenabled = true\n');
    const codexPlugin = (await call("integrations.plugin.setEnabled", {
      backend: "codex",
      name: "x@y",
      enabled: false,
    })) as PluginEntry;
    expect(codexPlugin.enabled).toBe(false);
    expect(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8")).toContain(
      "enabled = false",
    );
  });

  it("lists marketplaces from the CLI for claude and from config.toml for codex", async () => {
    expect(await call("integrations.plugin.marketplaces", { backend: "claude" })).toEqual([
      { name: "cockpit", url: "a/b", source: "claude plugin marketplace list" },
    ]);
    write(
      path.join(codexHome, "config.toml"),
      '[marketplaces.mine]\nsource_type = "git"\nsource = "https://example/x.git"\n',
    );
    expect(await call("integrations.plugin.marketplaces", { backend: "codex" })).toEqual([
      { name: "mine", url: "https://example/x.git", source: path.join(codexHome, "config.toml") },
    ]);
    expect(await call("integrations.plugin.marketplaces", { backend: "api" })).toEqual([]);
  });
});

describe("refusals carry the reason (SPEC §Edge Cases)", () => {
  it("refuses a plugin operation on a backend with no plugin host", async () => {
    await expect(
      call("integrations.plugin.install", { backend: "api", marketplace: "m", name: "n" }),
    ).rejects.toThrow(/no plugin host/);
  });

  it("refuses to edit a plugin-scope MCP server", async () => {
    await expect(
      call("integrations.mcp.remove", { backend: "claude", scope: "plugin", name: "x" }),
    ).rejects.toThrow(/belong to the plugin/);
  });

  it("refuses a session-scope Claude policy as a file write and keeps it in SQLite", async () => {
    const entry = (await call("integrations.tools.setPolicy", {
      backend: "claude",
      scope: "session",
      pattern: "Bash(x)",
      decision: "ask",
    })) as ToolPolicyEntry;
    expect(entry.scope).toBe("session");
    expect(fs.existsSync(path.join(claudeHome, "settings.json"))).toBe(false);
  });
});

describe("integrations.mcp.test", () => {
  it("uses capygen's own client when it can reach the server", async () => {
    write(path.join(codexHome, "config.toml"), '[mcp_servers.local]\ncommand = "node"\n');
    // A probe stands in for the shared MCP pool (`probeMcpServer.ts` wires the
    // real one in `main.ts`); this asserts the plumbing, not the SDK.
    const probed: string[] = [];
    const service = ipc.integrations;
    (service as unknown as { deps: { probeMcpServer?: unknown } }).deps.probeMcpServer = async (
      entry: McpServerEntry,
    ): Promise<string[]> => {
      probed.push(entry.name);
      return ["search", "fetch"];
    };
    expect(await call("integrations.mcp.test", { backend: "codex", name: "local" })).toEqual({
      ok: true,
      status: "connected",
      tools: ["search", "fetch"],
    });
    expect(probed).toEqual(["local"]);
  });

  it("says so, with the status, when there is nothing to reach", async () => {
    write(path.join(codexHome, "config.toml"), '[mcp_servers.local]\ncommand = "node"\n');
    const result = (await call("integrations.mcp.test", {
      backend: "codex",
      name: "local",
    })) as { ok: boolean; status: string; error?: string };
    expect(result).toEqual({
      ok: false,
      status: "unknown",
      error: "capygen has no way to reach this server from here",
    });
    expect(
      await call("integrations.mcp.test", { backend: "codex", name: "nope" }),
    ).toMatchObject({ ok: false, status: "unknown" });
  });

  it("falls back to `claude mcp list` for a Claude server", async () => {
    write(
      path.join(claudeHome, ".claude.json"),
      JSON.stringify({ mcpServers: { "from-cli": { type: "stdio", command: "node" } } }),
    );
    expect(await call("integrations.mcp.test", { backend: "claude", name: "from-cli" })).toEqual({
      ok: true,
      status: "connected",
    });
  });
});

// ---------------------------------------------------------------------------
// [review] Fixes from the Phase 6 review wave.
// ---------------------------------------------------------------------------

const SKILL_MD = ["---", "name: capy", "---", ""].join("\n");

describe("integrations.skill.open only opens skills capygen lists", () => {
  it("opens a real skill file", async () => {
    const file = path.join(claudeHome, "skills", "capy", "SKILL.md");
    write(file, SKILL_MD);
    await call("integrations.list", { backend: "claude" });
    expect(await call("integrations.skill.open", { path: file })).toEqual({ ok: true });
    expect(opened).toEqual([file]);
  });

  it("refuses any other path, so the channel cannot launch a program", async () => {
    write(path.join(claudeHome, "skills", "capy", "SKILL.md"), SKILL_MD);
    await call("integrations.list", { backend: "claude" });
    for (const target of [
      String.raw`C:\Windows\System32\cmd.exe`,
      path.join(claudeHome, "settings.json"),
      path.join(claudeHome, "skills", "capy", "evil.bat"),
    ]) {
      await expect(call("integrations.skill.open", { path: target })).rejects.toThrow(
        /not one of the skill files/,
      );
    }
    expect(opened).toEqual([]);
  });
});

describe("plugin install/uninstall is gated (SPEC R27)", () => {
  function installedPlugins(): Record<string, unknown> {
    const file = path.join(claudeHome, "plugins", "installed_plugins.json");
    return fs.existsSync(file)
      ? ((readJson(file).plugins as Record<string, unknown>) ?? {})
      : {};
  }

  it("shows the exact command and installs only after a Yes", async () => {
    await call("integrations.plugin.install", {
      backend: "claude",
      marketplace: "cockpit",
      name: "thing",
    });
    expect(confirms).toHaveLength(1);
    expect(confirms[0]?.detail).toContain("claude plugin install thing@cockpit --yes");
    expect(Object.keys(installedPlugins())).toEqual(["thing@cockpit"]);
  });

  it("runs nothing at all when the dialog is cancelled", async () => {
    confirmAnswer = false;
    await expect(
      call("integrations.plugin.install", {
        backend: "claude",
        marketplace: "cockpit",
        name: "thing",
      }),
    ).rejects.toThrow(/was not run — you cancelled/);
    expect(confirms).toHaveLength(1);
    expect(cliCalls.filter((c) => c[1] === "plugin")).toEqual([]);
    expect(installedPlugins()).toEqual({});
  });

  it("gates uninstall the same way", async () => {
    write(
      path.join(claudeHome, "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "cockpit@cockpit": [{ scope: "user" }] } }),
    );
    confirmAnswer = false;
    await expect(
      call("integrations.plugin.uninstall", { backend: "claude", name: "cockpit@cockpit" }),
    ).rejects.toThrow(/was not run/);
    expect(confirms[0]?.detail).toContain("claude plugin uninstall cockpit@cockpit");
    expect(Object.keys(installedPlugins())).toEqual(["cockpit@cockpit"]);

    confirmAnswer = true;
    expect(
      await call("integrations.plugin.uninstall", { backend: "claude", name: "cockpit@cockpit" }),
    ).toEqual({ ok: true });
    expect(installedPlugins()).toEqual({});
  });
});
