/**
 * The Claude, Codex and API config stores (SPEC R19-R21, R28-R30).
 *
 * **Every test here runs against a temp home.** The machine's real `~/.claude`
 * and `~/.codex` are the user's; nothing in this file reads or writes them, and
 * the two homes are passed explicitly rather than being picked up from the
 * environment, so a stray `CLAUDE_CONFIG_DIR` in the shell cannot make a test
 * touch the wrong directory either.
 *
 * The Claude CLI is a **shim**: `fakeCli` records every argv it is handed and
 * applies the same file effect the real CLI does (verified live on 2026-09-06
 * against `claude mcp add -s user|project|local` under an isolated
 * `CLAUDE_CONFIG_DIR` — `.claude.json` → `mcpServers`, `<project>/.mcp.json`,
 * and `.claude.json` → `projects[<forward-slashed cwd>].mcpServers`
 * respectively). The live half of that proof is `configLive.test.ts`, which
 * runs the real `claude` read-only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  API_MCP_SETTINGS_KEY,
  ApiConfigStore,
  CODEX_DISABLED_SKILL_FILE,
  ClaudeConfigStore,
  CodexConfigStore,
  claudeProjectKey,
  claudeWatchTargets,
  codexWatchTargets,
  parseMcpListOutput,
  resolveBackendHomes,
  changedKinds,
  type CliResult,
  type CliRunner,
} from "../src/config/index.js";

const temps: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `capygen-${prefix}-`));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function write(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, "utf8");
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

/**
 * A `claude` stand-in: records argv, and reproduces the file effect of the two
 * commands the store depends on for `.claude.json`.
 */
function fakeCli(): { run: CliRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: CliRunner = async (command, args, options): Promise<CliResult> => {
    calls.push([command, ...args]);
    const home = options.overrides?.CLAUDE_CONFIG_DIR;
    const globalConfig = home ? path.join(home, ".claude.json") : null;
    const readGlobal = (): Record<string, unknown> =>
      globalConfig && fs.existsSync(globalConfig) ? readJson(globalConfig) : {};
    const writeGlobal = (value: Record<string, unknown>): void => {
      if (globalConfig) write(globalConfig, JSON.stringify(value, null, 2));
    };

    if (args[0] === "mcp" && args[1] === "add") {
      const scope = args[args.indexOf("-s") + 1] as string;
      const transportAt = args.indexOf("--transport");
      const transport = transportAt >= 0 ? (args[transportAt + 1] as string) : "stdio";
      const env: Record<string, string> = {};
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] !== "-e") continue;
        const [key, ...rest] = (args[i + 1] as string).split("=");
        env[key as string] = rest.join("=");
      }
      const dashes = args.indexOf("--");
      const name = (dashes >= 0 ? args[dashes - 1] : args[args.length - 2]) as string;
      const entry: Record<string, unknown> =
        transport === "stdio"
          ? {
              type: "stdio",
              command: args[dashes + 1],
              args: args.slice(dashes + 2),
              env,
            }
          : { type: transport, url: args[args.length - 1] };
      const config = readGlobal();
      if (scope === "user") {
        const servers = (config.mcpServers as Record<string, unknown>) ?? {};
        servers[name] = entry;
        config.mcpServers = servers;
      } else {
        const projects = (config.projects as Record<string, unknown>) ?? {};
        const key = claudeProjectKey(options.cwd ?? "");
        const node = (projects[key] as Record<string, unknown>) ?? {};
        const servers = (node.mcpServers as Record<string, unknown>) ?? {};
        servers[name] = entry;
        node.mcpServers = servers;
        projects[key] = node;
        config.projects = projects;
      }
      writeGlobal(config);
      return { code: 0, stdout: `Added ${name}`, stderr: "" };
    }

    if (args[0] === "mcp" && args[1] === "remove") {
      const name = args[2] as string;
      const scope = args[args.indexOf("-s") + 1] as string;
      const config = readGlobal();
      if (scope === "user") {
        const servers = (config.mcpServers as Record<string, unknown>) ?? {};
        delete servers[name];
        config.mcpServers = servers;
      } else {
        const projects = (config.projects as Record<string, unknown>) ?? {};
        const node = (projects[claudeProjectKey(options.cwd ?? "")] as Record<string, unknown>) ?? {};
        const servers = (node.mcpServers as Record<string, unknown>) ?? {};
        delete servers[name];
        node.mcpServers = servers;
      }
      writeGlobal(config);
      return { code: 0, stdout: `Removed ${name}`, stderr: "" };
    }

    if (args[0] === "plugin" && args[1] === "list") {
      return {
        code: 0,
        stdout: JSON.stringify([{ id: "cockpit@cockpit", version: "3.0.0", enabled: true }]),
        stderr: "",
      };
    }
    if (args[0] === "plugin" && args[1] === "marketplace") {
      return {
        code: 0,
        stdout: JSON.stringify([
          { name: "cockpit", source: "github", repo: "leobbaroni/cockpit" },
        ]),
        stderr: "",
      };
    }
    if (args[0] === "plugin" && (args[1] === "enable" || args[1] === "disable")) {
      const settings = home ? path.join(home, "settings.json") : null;
      if (settings) {
        const current = fs.existsSync(settings) ? readJson(settings) : {};
        const enabled = (current.enabledPlugins as Record<string, unknown>) ?? {};
        enabled[args[2] as string] = args[1] === "enable";
        current.enabledPlugins = enabled;
        write(settings, JSON.stringify(current, null, 2));
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

// ---------------------------------------------------------------------------
// homes
// ---------------------------------------------------------------------------

describe("backend homes", () => {
  it("honours CLAUDE_CONFIG_DIR and CODEX_HOME, and defaults to the home dir", () => {
    expect(resolveBackendHomes({}, "C:/home")).toEqual({
      claude: path.join("C:/home", ".claude"),
      codex: path.join("C:/home", ".codex"),
      home: "C:/home",
    });
    const isolated = resolveBackendHomes(
      { CLAUDE_CONFIG_DIR: "C:/tmp/c", CODEX_HOME: "C:/tmp/x" },
      "C:/home",
    );
    expect(isolated.claude).toBe("C:/tmp/c");
    expect(isolated.codex).toBe("C:/tmp/x");
  });

  it("moves .claude.json inside CLAUDE_CONFIG_DIR when it is set", () => {
    // Verified live: `CLAUDE_CONFIG_DIR=<tmp> claude mcp add -s user …` wrote
    // <tmp>/.claude.json and left ~/.claude.json alone.
    const isolated = new ClaudeConfigStore({
      configDir: "C:/tmp/c",
      home: "C:/home",
      env: { CLAUDE_CONFIG_DIR: "C:/tmp/c" },
    });
    expect(isolated.paths.globalConfig).toBe(path.join("C:/tmp/c", ".claude.json"));
    const normal = new ClaudeConfigStore({ configDir: "C:/home/.claude", home: "C:/home", env: {} });
    expect(normal.paths.globalConfig).toBe(path.join("C:/home", ".claude.json"));
  });
});

// ---------------------------------------------------------------------------
// Claude — read / attribution
// ---------------------------------------------------------------------------

describe("ClaudeConfigStore — read", () => {
  function seed(): { store: ClaudeConfigStore; home: string; project: string } {
    const home = tempDir("claude-home");
    const project = tempDir("claude-proj");

    write(
      path.join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: { "user-server": { type: "stdio", command: "node", args: ["u.js"] } },
        projects: {
          [claudeProjectKey(project)]: {
            mcpServers: { "local-server": { type: "http", url: "https://local.example/mcp" } },
            enabledMcpjsonServers: ["proj-server"],
          },
        },
      }),
    );
    write(
      path.join(home, "settings.json"),
      JSON.stringify({
        permissions: { allow: ["Bash(npm run *)"], deny: ["Bash(rm *)"] },
        skillOverrides: { retired: "off" },
        enabledPlugins: { "cockpit@cockpit": true, "old@cockpit": false },
      }),
    );
    write(
      path.join(home, "settings.local.json"),
      JSON.stringify({ permissions: { ask: ["WebFetch(domain:example.com)"] } }),
    );
    write(
      path.join(project, ".mcp.json"),
      JSON.stringify({ mcpServers: { "proj-server": { command: "node", args: ["p.js"] } } }),
    );
    write(
      path.join(home, "skills", "capy", "SKILL.md"),
      "---\nname: capy\ndescription: A user skill.\n---\n# capy\n",
    );
    write(path.join(home, "skills", "retired", "SKILL.md"), "---\nname: retired\n---\n");
    write(
      path.join(project, ".claude", "skills", "repo-thing", "SKILL.md"),
      "---\nname: repo-thing\ndescription: Project scope.\n---\n",
    );
    write(
      path.join(home, "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "cockpit@cockpit": [
            { scope: "user", installPath: path.join(home, "cache", "cockpit"), version: "3.0.0" },
          ],
          "old@cockpit": [{ scope: "user", installPath: path.join(home, "cache", "old") }],
        },
      }),
    );
    write(
      path.join(home, "plugins", "known_marketplaces.json"),
      JSON.stringify({ cockpit: { source: { source: "github", repo: "leobbaroni/cockpit" } } }),
    );
    write(
      path.join(home, "cache", "cockpit", "skills", "pilot", "SKILL.md"),
      "---\nname: pilot\ndescription: From a plugin.\n---\n",
    );
    write(
      path.join(home, "cache", "cockpit", ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: "cockpit",
        mcpServers: { "plugin-server": { command: "node", args: ["pl.js"] } },
      }),
    );

    const store = new ClaudeConfigStore({
      configDir: home,
      home,
      env: { CLAUDE_CONFIG_DIR: home },
      projectPath: project,
    });
    return { store, home, project };
  }

  it("merges the four MCP scopes and says which file each came from", () => {
    const { store, home, project } = seed();
    const { mcpServers } = store.read();
    const byName = new Map(mcpServers.map((entry) => [entry.name, entry]));

    expect(byName.get("user-server")).toMatchObject({
      scope: "user",
      transport: "stdio",
      command: "node",
      args: ["u.js"],
      source: path.join(home, ".claude.json"),
      enabled: true,
    });
    expect(byName.get("local-server")).toMatchObject({
      scope: "local",
      transport: "http",
      url: "https://local.example/mcp",
      source: path.join(home, ".claude.json"),
    });
    expect(byName.get("proj-server")).toMatchObject({
      scope: "project",
      transport: "stdio",
      source: path.join(project, ".mcp.json"),
      // approved via `enabledMcpjsonServers` in the project's `.claude.json` node
      enabled: true,
    });
    expect(byName.get("plugin-server")).toMatchObject({
      scope: "plugin",
      source: "plugin:cockpit@cockpit",
    });
  });

  it("reports an unapproved .mcp.json server as not enabled", () => {
    const home = tempDir("claude-home");
    const project = tempDir("claude-proj");
    write(
      path.join(project, ".mcp.json"),
      JSON.stringify({ mcpServers: { pending: { command: "node" } } }),
    );
    const store = new ClaudeConfigStore({
      configDir: home,
      home,
      env: { CLAUDE_CONFIG_DIR: home },
      projectPath: project,
    });
    expect(store.read().mcpServers[0]).toMatchObject({ name: "pending", enabled: false });
  });

  it("reads skills from all three scopes and honours skillOverrides", () => {
    const { store } = seed();
    const skills = store.read().skills;
    const byName = new Map(skills.map((entry) => [entry.name, entry]));
    expect(byName.get("capy")).toMatchObject({
      scope: "user",
      enabled: true,
      description: "A user skill.",
    });
    expect(byName.get("retired")).toMatchObject({ scope: "user", enabled: false });
    expect(byName.get("repo-thing")).toMatchObject({ scope: "project", enabled: true });
    expect(byName.get("pilot")).toMatchObject({ scope: "plugin", pluginName: "cockpit@cockpit" });
  });

  it("reads plugins with their enabled flag from the settings chain", () => {
    const { store } = seed();
    const plugins = store.read().plugins;
    expect(plugins.map((p) => [p.name, p.enabled])).toEqual([
      ["cockpit@cockpit", true],
      ["old@cockpit", false],
    ]);
    expect(plugins[0]?.skills).toEqual(["pilot"]);
    expect(plugins[0]?.version).toBe("3.0.0");
  });

  it("reads tool policies from every settings file, tagged by scope", () => {
    const { store } = seed();
    const tools = store.read().tools;
    expect(tools).toContainEqual({
      backend: "claude",
      pattern: "Bash(npm run *)",
      decision: "allow",
      scope: "global",
    });
    expect(tools).toContainEqual({
      backend: "claude",
      pattern: "Bash(rm *)",
      decision: "deny",
      scope: "global",
    });
    expect(tools).toContainEqual({
      backend: "claude",
      pattern: "WebFetch(domain:example.com)",
      decision: "ask",
      scope: "global",
    });
  });

  it("survives a settings file somebody is mid-edit", () => {
    const home = tempDir("claude-home");
    write(path.join(home, "settings.json"), "{ not json");
    const warnings: string[] = [];
    const store = new ClaudeConfigStore({
      configDir: home,
      home,
      env: { CLAUDE_CONFIG_DIR: home },
      log: { info: () => {}, warn: (m) => warnings.push(m) },
    });
    expect(store.read().tools).toEqual([]);
    expect(warnings.join(" ")).toContain("not valid JSON");
  });
});

// ---------------------------------------------------------------------------
// Claude — writes
// ---------------------------------------------------------------------------

describe("ClaudeConfigStore — writes", () => {
  function fresh(): {
    store: ClaudeConfigStore;
    home: string;
    project: string;
    calls: string[][];
  } {
    const home = tempDir("claude-home");
    const project = tempDir("claude-proj");
    const cli = fakeCli();
    const store = new ClaudeConfigStore({
      configDir: home,
      home,
      env: { CLAUDE_CONFIG_DIR: home },
      projectPath: project,
      run: cli.run,
      claudeBin: "claude",
    });
    return { store, home, project, calls: cli.calls };
  }

  it("adds a user-scope server through the CLI, with the isolated home", async () => {
    const { store, home, calls } = fresh();
    const entry = await store.addMcpServer("user", {
      name: "capy",
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      env: { TOKEN: "x" },
      source: "settings",
    });
    expect(entry).toMatchObject({ scope: "user", command: "node", args: ["server.js"] });
    expect(calls[0]).toEqual([
      "claude",
      "mcp",
      "add",
      "-s",
      "user",
      "-e",
      "TOKEN=x",
      "capy",
      "--",
      "node",
      "server.js",
    ]);
    // and the file the CLI owns really has it
    expect(readJson(path.join(home, ".claude.json")).mcpServers).toMatchObject({
      capy: { command: "node" },
    });
  });

  it("adds an http server with --transport, not `--`", async () => {
    const { store, calls } = fresh();
    await store.addMcpServer("user", {
      name: "remote",
      transport: "http",
      url: "https://example.com/mcp",
      source: "settings",
    });
    expect(calls[0]).toEqual([
      "claude",
      "mcp",
      "add",
      "-s",
      "user",
      "--transport",
      "http",
      "remote",
      "https://example.com/mcp",
    ]);
  });

  it("edits .mcp.json directly for project scope and keeps its other keys", async () => {
    const { store, project } = fresh();
    write(
      path.join(project, ".mcp.json"),
      JSON.stringify({ $schema: "https://example/schema.json", mcpServers: { keep: { command: "k" } } }),
    );
    await store.addMcpServer("project", {
      name: "added",
      transport: "stdio",
      command: "node",
      source: ".mcp.json",
    });
    const file = readJson(path.join(project, ".mcp.json"));
    expect(file.$schema).toBe("https://example/schema.json");
    expect(Object.keys(file.mcpServers as Record<string, unknown>).sort()).toEqual([
      "added",
      "keep",
    ]);
  });

  it("renames a server without leaving the old one behind", async () => {
    const { store, project } = fresh();
    write(
      path.join(project, ".mcp.json"),
      JSON.stringify({
        mcpServers: { before: { command: "node", args: ["a.js"] } },
      }),
    );
    write(
      path.join(project, ".claude", "settings.json"),
      JSON.stringify({ enableAllProjectMcpServers: true }),
    );
    const updated = await store.updateMcpServer("project", "before", { name: "after" });
    expect(updated.name).toBe("after");
    const servers = readJson(path.join(project, ".mcp.json")).mcpServers as Record<string, unknown>;
    expect(Object.keys(servers)).toEqual(["after"]);
    expect((servers.after as Record<string, unknown>).args).toEqual(["a.js"]);
  });

  it("refuses to edit a plugin's own MCP server", async () => {
    const { store } = fresh();
    await expect(
      store.addMcpServer("plugin", { name: "x", transport: "stdio", command: "n", source: "s" }),
    ).rejects.toThrow(/belong to the plugin/);
  });

  it("round-trips a tool policy and leaves the rest of settings.json alone", () => {
    const { store, home } = fresh();
    write(
      path.join(home, "settings.json"),
      JSON.stringify({
        model: "sonnet",
        hooks: { Stop: [{ hooks: [{ type: "command", command: "beep" }] }] },
        permissions: { defaultMode: "auto", allow: ["Bash(ls)"] },
      }),
    );
    const entry = store.setToolPolicy("global", "Bash(npm test)", "allow");
    expect(entry).toEqual({
      backend: "claude",
      pattern: "Bash(npm test)",
      decision: "allow",
      scope: "global",
    });
    const file = readJson(path.join(home, "settings.json"));
    expect(file.model).toBe("sonnet");
    expect(file.hooks).toBeTruthy();
    const permissions = file.permissions as Record<string, unknown>;
    expect(permissions.defaultMode).toBe("auto");
    expect(permissions.allow).toEqual(["Bash(ls)", "Bash(npm test)"]);
  });

  it("moves a pattern between buckets rather than duplicating it", () => {
    const { store, home } = fresh();
    store.setToolPolicy("global", "Bash(rm -rf *)", "ask");
    store.setToolPolicy("global", "Bash(rm -rf *)", "deny");
    const permissions = readJson(path.join(home, "settings.json")).permissions as Record<
      string,
      unknown
    >;
    expect(permissions.ask).toBeUndefined();
    expect(permissions.deny).toEqual(["Bash(rm -rf *)"]);
    expect(store.removeToolPolicy("global", "Bash(rm -rf *)")).toEqual({ ok: true });
    expect(store.read().tools).toEqual([]);
  });

  it("refuses a session-scope policy with the reason", () => {
    const { store } = fresh();
    expect(() => store.setToolPolicy("session", "Bash(x)", "allow")).toThrow(/Phase 9/);
  });

  it("disables a skill through skillOverrides and re-enables by deleting the key", () => {
    const { store, home } = fresh();
    write(
      path.join(home, "skills", "capy", "SKILL.md"),
      "---\nname: capy\ndescription: d\n---\n",
    );
    write(path.join(home, "settings.json"), JSON.stringify({ model: "sonnet" }));

    expect(store.setSkillEnabled("capy", false).enabled).toBe(false);
    let file = readJson(path.join(home, "settings.json"));
    expect(file.skillOverrides).toEqual({ capy: "off" });
    expect(file.model).toBe("sonnet");

    expect(store.setSkillEnabled("capy", true).enabled).toBe(true);
    file = readJson(path.join(home, "settings.json"));
    // Absent = on (the SDK's own schema), so the key is deleted, not set "on".
    expect(file.skillOverrides).toBeUndefined();
    // No file was moved: the skill is exactly where its author put it.
    expect(fs.existsSync(path.join(home, "skills", "capy", "SKILL.md"))).toBe(true);
  });

  it("creates a skill and reads it back", () => {
    const { store, home } = fresh();
    const created = store.createSkill("user", "brand-new", "---\nname: brand-new\n---\nBody\n");
    expect(created).toMatchObject({ name: "brand-new", scope: "user", enabled: true });
    expect(fs.readFileSync(path.join(home, "skills", "brand-new", "SKILL.md"), "utf8")).toContain(
      "Body",
    );
    expect(() => store.createSkill("user", "brand-new", "x")).toThrow(/already exists/);
    expect(() => store.createSkill("plugin", "x", "y")).toThrow(/belong to the plugin/);
  });

  // [review] `FileIo.write` mkdir -p's the parent, and the IPC schema for
  // `integrations.skill.create` only asks for a non-empty string, so a name
  // carrying separators used to write markdown anywhere the process could.
  it("refuses a skill name that would escape the skills directory", () => {
    const { store, home } = fresh();
    const outside = path.join(path.dirname(home), "escaped");
    for (const name of [
      String.raw`..\..\escaped`,
      "../../escaped",
      "..",
      "sub/dir",
      String.raw`C:\Windows\Temp\evil`,
      "   ",
    ]) {
      expect(() => store.createSkill("user", name, "x")).toThrow(
        /not a usable name|cannot be used as a name|would write outside/,
      );
    }
    expect(fs.existsSync(outside)).toBe(false);
    expect(fs.existsSync(path.join(outside, "SKILL.md"))).toBe(false);
  });

  // [review] `mcpAddArgs` puts the name before `--`, so a leading dash is read
  // by the CLI's own option parser rather than as the server name.
  it("refuses an MCP server or plugin name that the CLI would read as a flag", async () => {
    const { store, calls } = fresh();
    await expect(
      store.addMcpServer("user", {
        name: "--transport",
        transport: "stdio",
        command: "node",
        source: "s",
      }),
    ).rejects.toThrow(/cannot start with "-"/);
    await expect(store.removeMcpServer("user", "-s")).rejects.toThrow(/cannot start with "-"/);
    await expect(store.installPlugin("mkt", "--yes")).rejects.toThrow(/cannot start with "-"/);
    await expect(store.uninstallPlugin("-x")).rejects.toThrow(/cannot start with "-"/);
    await expect(store.setPluginEnabled("-x", true)).rejects.toThrow(/cannot start with "-"/);
    // Nothing reached the CLI at all.
    expect(calls).toEqual([]);
  });

  it("drives plugin enable/disable through the CLI", async () => {
    const { store, home, calls } = fresh();
    write(
      path.join(home, "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "cockpit@cockpit": [{ scope: "user" }] } }),
    );
    const disabled = await store.setPluginEnabled("cockpit@cockpit", false);
    expect(disabled.enabled).toBe(false);
    expect(calls.at(-1)).toEqual(["claude", "plugin", "disable", "cockpit@cockpit"]);
  });

  it("passes --yes to plugin install (the CLI refuses without a TTY otherwise)", async () => {
    const { store, home, calls } = fresh();
    write(
      path.join(home, "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "thing@mkt": [{ scope: "user" }] } }),
    );
    await store.installPlugin("mkt", "thing");
    expect(calls.at(-1)).toEqual(["claude", "plugin", "install", "thing@mkt", "--yes"]);
  });

  it("falls back to the cached marketplaces file when the CLI fails", async () => {
    const home = tempDir("claude-home");
    write(
      path.join(home, "plugins", "known_marketplaces.json"),
      JSON.stringify({ cached: { source: { source: "github", repo: "a/b" } } }),
    );
    const store = new ClaudeConfigStore({
      configDir: home,
      home,
      env: { CLAUDE_CONFIG_DIR: home },
      run: async () => ({ code: 1, stdout: "", stderr: "not found" }),
    });
    expect(await store.marketplaces()).toEqual([
      { name: "cached", url: "a/b", source: path.join(home, "plugins", "known_marketplaces.json") },
    ]);
  });

  it("reports the CLI's own message when a write fails", async () => {
    const home = tempDir("claude-home");
    const store = new ClaudeConfigStore({
      configDir: home,
      home,
      env: { CLAUDE_CONFIG_DIR: home },
      run: async () => ({ code: 2, stdout: "", stderr: "boom: no such marketplace" }),
    });
    await expect(store.installPlugin("mkt", "nope")).rejects.toThrow(/boom: no such marketplace/);
  });
});

describe("`claude mcp list` output", () => {
  it("parses names with spaces, urls, and each status", () => {
    // Verbatim shape from this machine on 2026-09-06.
    const rows = parseMcpListOutput(
      [
        "Checking MCP server health…",
        "",
        "claude.ai Higgsfield: https://mcp.higgsfield.ai/mcp - ✔ Connected",
        "claude.ai Microsoft 365: https://microsoft365.mcp.claude.com/mcp - ! Needs authentication",
        "probe-server: node probe.js - ✘ Failed to connect — -32000: Connection closed",
        "proj-server: https://example.com/mcp (HTTP) - ⏸ Pending approval (run `claude` to approve)",
      ].join("\n"),
    );
    expect(rows).toEqual([
      {
        name: "claude.ai Higgsfield",
        target: "https://mcp.higgsfield.ai/mcp",
        status: "connected",
      },
      {
        name: "claude.ai Microsoft 365",
        target: "https://microsoft365.mcp.claude.com/mcp",
        status: "needs-auth",
      },
      { name: "probe-server", target: "node probe.js", status: "failed" },
      {
        name: "proj-server",
        target: "https://example.com/mcp (HTTP)",
        // "Pending approval" is honestly unknown, never guessed as connected.
        status: "unknown",
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

const CODEX_FIXTURE = `# do not lose me
model = "gpt-6-astra"
model_reasoning_effort = "medium"

[projects.'c:\\users\\x']
trust_level = "trusted"

[mcp_servers.comfy-mcp]
command = "comfy-mcp"

[mcp_servers.node_repl]
command = 'C:\\bin\\node_repl.exe'
args = []

[mcp_servers.node_repl.env]
CODEX_HOME = 'C:\\Users\\x\\.codex'

[plugins."cockpit@cockpit"]
enabled = true

[marketplaces.cockpit]
source_type = "git"
source = "https://github.com/leobbaroni/cockpit.git"
`;

describe("CodexConfigStore", () => {
  function fresh(): { store: CodexConfigStore; home: string; project: string } {
    const home = tempDir("codex-home");
    const project = tempDir("codex-proj");
    write(path.join(home, "config.toml"), CODEX_FIXTURE);
    const store = new CodexConfigStore({ configDir: home, projectPath: project });
    return { store, home, project };
  }

  it("reads servers, plugins, marketplaces and defaults out of config.toml", () => {
    const { store, home } = fresh();
    const snapshot = store.read();
    expect(snapshot.mcpServers.map((s) => s.name)).toEqual(["comfy-mcp", "node_repl"]);
    expect(snapshot.mcpServers[1]).toMatchObject({
      scope: "user",
      transport: "stdio",
      command: "C:\\bin\\node_repl.exe",
      env: { CODEX_HOME: "C:\\Users\\x\\.codex" },
      source: path.join(home, "config.toml"),
    });
    expect(snapshot.plugins[0]).toMatchObject({
      name: "cockpit@cockpit",
      marketplace: "cockpit",
      enabled: true,
      installed: false,
    });
    expect(snapshot.marketplaces).toEqual([
      {
        name: "cockpit",
        url: "https://github.com/leobbaroni/cockpit.git",
        source: path.join(home, "config.toml"),
      },
    ]);
    expect(store.defaults()).toEqual({ model: "gpt-6-astra", reasoningEffort: "medium" });
    // Codex has no per-tool permission list — see the store's header.
    expect(snapshot.tools).toEqual([]);
  });

  it("adds a server and leaves every comment, quote and unknown key intact", () => {
    const { store, home } = fresh();
    const added = store.addMcpServer("user", {
      name: "capy",
      transport: "stdio",
      command: "node",
      args: ["s.js"],
      env: { A: "b" },
      source: "config.toml",
    });
    expect(added).toMatchObject({ name: "capy", command: "node", env: { A: "b" } });
    const text = fs.readFileSync(path.join(home, "config.toml"), "utf8");
    expect(text).toContain("# do not lose me");
    expect(text).toContain("[projects.'c:\\users\\x']");
    expect(text).toContain("CODEX_HOME = 'C:\\Users\\x\\.codex'");
    expect(text).toContain('[plugins."cockpit@cockpit"]');
    expect(store.read().mcpServers.map((s) => s.name)).toEqual([
      "capy",
      "comfy-mcp",
      "node_repl",
    ]);
  });

  it("updates a server in place, dropping its stale child env table", () => {
    const { store, home } = fresh();
    store.updateMcpServer("user", "node_repl", { env: { ONLY: "one" } });
    const text = fs.readFileSync(path.join(home, "config.toml"), "utf8");
    expect(text).not.toContain("[mcp_servers.node_repl.env]");
    const entry = store.read().mcpServers.find((s) => s.name === "node_repl");
    expect(entry?.env).toEqual({ ONLY: "one" });
    expect(entry?.command).toBe("C:\\bin\\node_repl.exe");
    expect(text).toContain("[mcp_servers.comfy-mcp]");
  });

  it("removes a server and nothing else", () => {
    const { store, home } = fresh();
    expect(store.removeMcpServer("user", "comfy-mcp")).toEqual({ ok: true });
    const text = fs.readFileSync(path.join(home, "config.toml"), "utf8");
    expect(text).not.toContain("comfy-mcp");
    expect(store.read().mcpServers.map((s) => s.name)).toEqual(["node_repl"]);
    expect(text).toContain("# do not lose me");
    expect(text).toContain('[marketplaces.cockpit]');
  });

  it("toggles a plugin and sets the top-level defaults in place", () => {
    const { store, home } = fresh();
    expect(store.setPluginEnabled("cockpit@cockpit", false).enabled).toBe(false);
    expect(store.setPluginEnabled("brand@new", false).enabled).toBe(false);
    store.setDefaults({ model: "gpt-6", approvalPolicy: "on-request" });
    expect(store.defaults()).toEqual({
      model: "gpt-6",
      reasoningEffort: "medium",
      approvalPolicy: "on-request",
    });
    const text = fs.readFileSync(path.join(home, "config.toml"), "utf8");
    expect(text).toContain("# do not lose me");
    expect(text.indexOf("approval_policy")).toBeLessThan(text.indexOf("[projects."));
  });

  it("refuses a scope Codex does not have", () => {
    const { store } = fresh();
    expect(() =>
      store.addMcpServer("project", { name: "x", transport: "stdio", command: "n", source: "s" }),
    ).toThrow(/Codex keeps every MCP server/);
  });

  it("disables a skill by renaming its document, never deleting it", () => {
    const { store, home } = fresh();
    write(
      path.join(home, "skills", "capy", "SKILL.md"),
      "---\nname: capy\ndescription: d\n---\nBody\n",
    );
    expect(store.read().skills[0]).toMatchObject({ name: "capy", enabled: true });

    const disabled = store.setSkillEnabled("capy", false);
    expect(disabled.enabled).toBe(false);
    expect(fs.existsSync(path.join(home, "skills", "capy", "SKILL.md"))).toBe(false);
    const parked = path.join(home, "skills", "capy", CODEX_DISABLED_SKILL_FILE);
    expect(fs.readFileSync(parked, "utf8")).toContain("Body");
    // still listed, still readable, just off
    expect(store.read().skills[0]).toMatchObject({ name: "capy", enabled: false });

    expect(store.setSkillEnabled("capy", true).enabled).toBe(true);
    expect(fs.readFileSync(path.join(home, "skills", "capy", "SKILL.md"), "utf8")).toContain("Body");
  });

  it("creates a project skill under .codex/skills", () => {
    const { store, project } = fresh();
    const created = store.createSkill("project", "repo-skill", "---\nname: repo-skill\n---\n");
    expect(created.scope).toBe("project");
    expect(fs.existsSync(path.join(project, ".codex", "skills", "repo-skill", "SKILL.md"))).toBe(
      true,
    );
  });

  it("refuses a skill name that would escape the codex skills directory", () => {
    const { store, home } = fresh();
    expect(() => store.createSkill("user", String.raw`..\..\escaped`, "x")).toThrow(
      /cannot be used as a name/,
    );
    expect(fs.existsSync(path.join(path.dirname(home), "escaped"))).toBe(false);
  });

  it("reads an absent config.toml as an empty configuration", () => {
    const home = tempDir("codex-empty");
    const store = new CodexConfigStore({ configDir: home });
    expect(store.read().mcpServers).toEqual([]);
    // …and can still be written to
    store.addMcpServer("user", { name: "first", transport: "stdio", command: "n", source: "s" });
    expect(store.read().mcpServers.map((s) => s.name)).toEqual(["first"]);
  });
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

describe("ApiConfigStore", () => {
  function fresh(): { store: ApiConfigStore; table: Record<string, unknown> } {
    let table: Record<string, unknown> = {};
    const store = new ApiConfigStore({
      own: {
        read: () => JSON.parse(JSON.stringify(table)) as Record<string, unknown>,
        write: (value) => {
          table = value;
        },
      },
      inherited: () => [
        {
          backend: "claude",
          name: "from-claude",
          transport: "stdio",
          command: "node",
          scope: "user",
          source: "~/.claude.json",
          enabled: true,
        },
        {
          backend: "codex",
          name: "from-codex",
          transport: "stdio",
          command: "comfy-mcp",
          scope: "user",
          source: "~/.codex/config.toml",
          enabled: true,
        },
      ],
    });
    return { store, get table() { return table; } } as { store: ApiConfigStore; table: Record<string, unknown> };
  }

  it("lists its own servers plus the ones it inherits, read-only", () => {
    const { store } = fresh();
    store.addMcpServer("user", {
      name: "mine",
      transport: "http",
      url: "https://x/mcp",
      source: "capygen",
    });
    const entries = store.read().mcpServers;
    expect(entries.map((e) => [e.name, e.scope])).toEqual([
      ["mine", "user"],
      ["from-claude", "plugin"],
      ["from-codex", "plugin"],
    ]);
    expect(entries[0]?.source).toContain(API_MCP_SETTINGS_KEY);
    expect(entries[1]?.source).toContain("inherited from claude");
    expect(entries[1]).toMatchObject({ backend: "api", inherited: true });
  });

  it("refuses to write an inherited server", () => {
    const { store } = fresh();
    expect(() =>
      store.updateMcpServer("plugin", "from-claude", { enabled: false }),
    ).toThrow(/inherited by the api backend/);
  });

  it("round-trips add, update, rename and remove", () => {
    const { store } = fresh();
    store.addMcpServer("user", {
      name: "one",
      transport: "stdio",
      command: "node",
      args: ["a.js"],
      source: "capygen",
    });
    expect(() =>
      store.addMcpServer("user", { name: "one", transport: "stdio", command: "n", source: "s" }),
    ).toThrow(/already has an MCP server/);
    const renamed = store.updateMcpServer("user", "one", { name: "two", enabled: false });
    expect(renamed).toMatchObject({ name: "two", enabled: false, args: ["a.js"] });
    expect(store.read().mcpServers.filter((e) => !("inherited" in e)).map((e) => e.name)).toEqual([
      "two",
    ]);
    expect(store.removeMcpServer("user", "two")).toEqual({ ok: true });
    expect(store.removeMcpServer("user", "two")).toEqual({ ok: false });
  });

  it("lets an own server shadow an inherited one of the same name", () => {
    const { store } = fresh();
    store.addMcpServer("user", {
      name: "from-claude",
      transport: "stdio",
      command: "mine",
      source: "capygen",
    });
    const entries = store.read().mcpServers.filter((e) => e.name === "from-claude");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.command).toBe("mine");
  });
});

// ---------------------------------------------------------------------------
// watch targets + diffing
// ---------------------------------------------------------------------------

describe("watch targets and snapshot diffing", () => {
  it("names every file a Claude/Codex change could arrive in", () => {
    const store = new ClaudeConfigStore({
      configDir: "C:/h/.claude",
      home: "C:/h",
      env: {},
      projectPath: "C:/proj",
    });
    const targets = claudeWatchTargets(store.paths);
    expect(targets).toContain(path.join("C:/h/.claude", "settings.json"));
    expect(targets).toContain(path.join("C:/h", ".claude.json"));
    expect(targets).toContain(path.join("C:/h/.claude", "plugins", "installed_plugins.json"));
    expect(targets).toContain(path.join("C:/proj", ".mcp.json"));

    const codex = new CodexConfigStore({ configDir: "C:/h/.codex", projectPath: "C:/proj" });
    expect(codexWatchTargets(codex.paths)).toContain(path.join("C:/h/.codex", "config.toml"));
  });

  it("reports only the kinds that actually moved", () => {
    const before = {
      mcpServers: [],
      plugins: [],
      skills: [],
      tools: [],
      marketplaces: [],
    };
    expect(changedKinds(before, before)).toEqual([]);
    expect(
      changedKinds(before, {
        ...before,
        skills: [
          {
            backend: "claude" as const,
            name: "n",
            scope: "user" as const,
            path: "p",
            enabled: true,
          },
        ],
      }),
    ).toEqual(["skills"]);
  });
});
