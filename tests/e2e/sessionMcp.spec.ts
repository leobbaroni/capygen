import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { launchEnv, E2E_CLAUDE_MODEL, E2E_CODEX_MODEL } from "./testPolicy.js";

const repoRoot = path.resolve(__dirname, "..", "..");
async function invoke<T>(page: Page, channel: string, payload: unknown): Promise<T> {
  return page.evaluate(async ({ channel, payload }) => (window as unknown as {
    capygen: { invoke(channel: string, payload: unknown): Promise<unknown> };
  }).capygen.invoke(channel, payload), { channel, payload }) as Promise<T>;
}

for (const backend of ["claude", "codex"] as const) {
test(`${backend} session MCP editor discovers tools in the slash menu without a model turn`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capygen session-mcp-"));
  const homes = { claudeHome: path.join(root, "claude"), codexHome: path.join(root, "codex") };
  for (const dir of Object.values(homes)) fs.mkdirSync(dir);
  const projectDir = path.join(root, "project café");
  fs.mkdirSync(projectDir);
  const starts = path.join(root, "server-starts.txt");
  const fixture = path.join(root, "fixture.cjs");
  const events = path.join(root, "server-events.txt");
  fs.writeFileSync(fixture, `
const fs = require('node:fs');
const readline = require('node:readline');
const record = (event) => fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify({event,pid:process.pid,ppid:process.ppid})+'\\n');
record('start');
process.on('exit', () => record('exit'));
process.stdin.on('end', () => record('stdin-end'));
fs.appendFileSync(${JSON.stringify(starts)}, 'start\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize' || request.method === 'tools/list') record(request.method);
  if (request.id === undefined) return;
  let result;
  if (request.method === 'initialize') result = {protocolVersion:request.params.protocolVersion, capabilities:{tools:{}}, serverInfo:{name:'owned-fixture',version:'1'}};
  else if (request.method === 'tools/list') result = {tools:[{name:'fixture_echo',description:'Owned fixture',inputSchema:{type:'object',properties:{}}}]};
  else if (request.method === 'tools/call') result = {content:[{type:'text',text:'fixture'}]};
  else result = {};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
});
`, "utf8");
  // An inherited server is the positive control for disabling: omission alone
  // must not silently reload it from backend files after a session override.
  const inherited = { owned_fixture: { command: process.execPath, args: [fixture] } };
  if (backend === "claude") {
    fs.writeFileSync(path.join(projectDir, ".mcp.json"), JSON.stringify({ mcpServers: inherited }));
  } else {
    fs.writeFileSync(path.join(homes.codexHome, "config.toml"),
      `[mcp_servers.owned_fixture]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(fixture)}]\n`);
  }
  const requestPaths: string[] = [];
  const provider = createServer((request, response) => {
    requestPaths.push((request.url ?? "").split("?")[0]!);
    response.writeHead(500).end("No model request belongs to catalogue discovery");
  });
  let app: ElectronApplication | undefined;
  try {
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("No fixture port");
    const userDataDir = path.join(root, "profile");
    const env = launchEnv({ userDataDir, projectDir, homes });
    // No inherited credentials, proxies, cloud selectors or authenticated test
    // identity. Retain only process-start requirements and this fixture's homes.
    const allowed = new Set([
      "systemroot", "systemdrive", "windir", "comspec", "path", "pathext",
      "number_of_processors", "processor_architecture", "os",
      "capygen_user_data_dir", "capygen_project_dir", "capygen_claude_config_dir",
      "capygen_codex_home", "claude_config_dir", "codex_home", "electron_enable_logging",
    ]);
    for (const key of Object.keys(env)) if (!allowed.has(key.toLowerCase())) delete env[key];
    for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "XDG_CONFIG_HOME"]) {
      const dir = path.join(root, key.toLowerCase());
      fs.mkdirSync(dir, { recursive: true });
      env[key] = dir;
    }
    env.ANTHROPIC_API_KEY = "dummy-session-mcp-fixture";
    env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${address.port}`;
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    app = await electron.launch({ args: [path.join(repoRoot, "apps", "desktop"), `--user-data-dir=${userDataDir}`], cwd: repoRoot, env });
    const page = await app.firstWindow();
    const projects = await invoke<Array<{ id: string }>>(page, "projects.list", {});
    const created = await invoke<{ session: { id: string }; agents: Array<{ id: string; config: unknown }> }>(page, "sessions.create", {
      projectId: projects[0]!.id, mode: "solo", title: "MCP catalogue fixture",
      agents: [{ name: "Fixture", backend, model: backend === "claude" ? E2E_CLAUDE_MODEL : E2E_CODEX_MODEL, role: "lead",
        config: { [backend]: backend === "claude" ? { effort: "low", strictMcpConfig: false } : { reasoningEffort: "low" } } }],
    });
    await page.evaluate((id) => { window.location.hash = `/c/${id}`; }, created.session.id);
    await page.getByTestId("session-settings-button").click();
    await expect(page.getByTestId("session-mcp-panel")).toBeVisible();
    await page.getByTestId("session-mcp-name").fill("owned_fixture");
    await page.getByTestId("session-mcp-command").fill(`"${process.execPath}" "${fixture}"`);
    await page.getByTestId("session-mcp-add").click();
    await expect(page.getByTestId("session-mcp-item-owned_fixture")).toBeVisible();
    const saved = await invoke<Array<{ id: string; config: unknown }>>(page, "agents.list", { sessionId: created.session.id });
    expect(saved.find((agent) => agent.id === created.agents[0]!.id)?.config).toMatchObject({ [backend]: {
      ...(backend === "claude" ? { effort: "low" } : { reasoningEffort: "low" }), mcpServers: { owned_fixture: { command: process.execPath, args: [fixture] } },
    } });
    const args = { sessionId: created.session.id, agentId: created.agents[0]!.id };
    expect(await invoke(page, "agents.catalogue", args)).toMatchObject({ kind: "notStarted" });
    expect(fs.existsSync(starts)).toBe(false);
    await Promise.all([
      invoke(page, "agents.catalogue", { ...args, initialize: true }),
      invoke(page, "agents.catalogue", { ...args, initialize: true }),
    ]);
    await expect.poll(async () => JSON.stringify(await invoke(page, "agents.catalogue", { ...args, initialize: true })),
      { timeout: 20_000 }).toContain('fixture_echo');
    const fixturePids = (): number[] => [...new Set(fs.readFileSync(events, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as { event: string; pid: number })
      .filter((event) => event.event === "start").map((event) => event.pid))];
    const aliveFixturePids = (): number[] => fixturePids().filter((pid) => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    });
    // Claude reuses its single process. The pinned Codex status API starts a
    // transient discovery probe even with plain config.toml (native control
    // reproduced separately). It must leave exactly the same persistent
    // session process after each query, never accumulating discovery children.
    if (backend === "claude") {
      expect(fs.readFileSync(starts, "utf8").trim().split("\n")).toHaveLength(1);
    }
    await expect.poll(() => aliveFixturePids().length).toBe(1);
    const persistent = aliveFixturePids();
    await page.getByTestId("session-mcp-refresh").click();
    await expect(page.getByTestId("session-mcp-state-owned_fixture")).toContainText("Connected");
    await expect(page.getByTestId("session-mcp-refresh")).toBeEnabled();
    await expect.poll(aliveFixturePids).toEqual(persistent);
    await page.getByTestId("session-settings-close").click();
    const composer = page.getByTestId("chat-composer-input");
    await composer.fill("/");
    const tool = page.getByTestId("slash-menu-mcp-tool").filter({ hasText: "fixture_echo" });
    await expect(tool).toBeVisible();
    await expect(tool).toHaveAttribute("aria-disabled", "true");
    // A physical click on an informational disabled row must not submit it.
    const bounds = await tool.boundingBox();
    if (!bounds) throw new Error("No MCP tool row bounds");
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await expect(composer).toHaveValue("/");
    const session = await invoke<{ turns: unknown[] }>(page, "sessions.get", { sessionId: created.session.id });
    expect(session.turns).toEqual([]);
    // The pinned CLI probes /api/hello on startup. Any other provider
    // endpoint is unexpected here; in particular, no messages/model call.
    expect(requestPaths.filter((endpoint) => endpoint !== "/api/hello")).toEqual([]);
    await composer.fill("");
    await page.getByTestId("session-settings-button").click();
    const startCount = fixturePids().length;
    await page.getByTestId("session-mcp-toggle-owned_fixture").click();
    await expect(page.getByTestId("session-mcp-toggle-owned_fixture")).toHaveText("Enable");
    await expect.poll(() => aliveFixturePids().length).toBe(0);
    await page.getByTestId("session-mcp-refresh").click();
    await expect(page.getByTestId("session-mcp-refresh")).toBeEnabled();
    await expect.poll(async () => {
      const value = await invoke<{ kind: string; servers?: Array<{ name: string; state: string; tools: string[] }> }>(
        page, "agents.catalogue", args);
      return value.kind === "ok" && (value.servers ?? []).every((server) =>
        server.name !== "owned_fixture" || (server.state === "disabled" && server.tools.length === 0));
    }).toBe(true);
    expect(fixturePids()).toHaveLength(startCount);
    expect(aliveFixturePids()).toEqual([]);
    await app.close();
    app = undefined;
    await expect.poll(aliveFixturePids).toEqual([]);

  } finally {
    try { await app?.close(); }
    finally {
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

}
