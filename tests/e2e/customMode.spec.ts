import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { backendHomes, launchEnv, PERSONAL_KEY_ENV, E2E_CLAUDE_MODEL } from "./testPolicy.js";

const repoRoot = path.resolve(__dirname, "..", "..");
const invoke = <T>(page: Page, channel: string, payload: unknown): Promise<T> => page.evaluate(async ({ channel, payload }) =>
  (window as unknown as { capygen: { invoke(channel: string, payload: unknown): Promise<T> } }).capygen.invoke(channel, payload), { channel, payload });

test("custom draft generation, reviewed Apply and restart preserve the working transcript", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-custom-native-"));
  const userDataDir = path.join(root, "profile");
  const projectDir = path.join(root, "project");
  fs.mkdirSync(projectDir);
  const homes = backendHomes("custom-mode");
  const target = { backend: "claude", model: E2E_CLAUDE_MODEL, effort: "low" };
  const crew = { version: 1, title: "Reviewed fixture crew", description: "Native offline fixture",
    roster: [{ id: "lead", label: "Lead", role: "lead", target, instructions: "Lead this fixture" },
      { id: "worker", label: "Worker", role: "worker", target, instructions: "Handle delegated tasks" }],
    routing: [], defaultWorker: "worker", debate: { enabled: false, triggers: [], participants: [] } };
  const calls: Array<{ authoring: boolean; model: string; tools: number; effort: unknown; leaksHistory: boolean }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      if (request.url === "/api/hello") { response.writeHead(200, { "Content-Type": "application/json" }).end("{}"); return; }
      if (!request.url?.startsWith("/v1/messages")) { response.writeHead(404).end(); return; }
      const parsed = JSON.parse(body);
      const authoring = JSON.stringify(parsed.system).includes("Return only JSON matching this schema");
      calls.push({ authoring, model: parsed.model, tools: parsed.tools?.length ?? 0,
        effort: parsed.output_config?.effort, leaksHistory: authoring && JSON.stringify(parsed).includes("Earlier private fixture conversation") });
      const text = authoring ? JSON.stringify(crew) : "Earlier private fixture conversation";
      const events = [
        { type: "message_start", message: { id: `msg_${calls.length}`, type: "message", role: "assistant", model: E2E_CLAUDE_MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } },
        { type: "message_stop" },
      ];
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
    });
  });
  let app: ElectronApplication | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const env = launchEnv({ userDataDir, projectDir, homes });
    const keys = new Set(PERSONAL_KEY_ENV.map((key) => key.toLowerCase()));
    for (const key of Object.keys(env)) if (keys.has(key.toLowerCase())) delete env[key];
    const allowed = new Set(["systemroot", "systemdrive", "windir", "comspec", "path", "pathext", "number_of_processors", "processor_architecture", "os", "capygen_user_data_dir", "capygen_project_dir", "capygen_claude_config_dir", "capygen_codex_home", "claude_config_dir", "codex_home", "electron_enable_logging"]);
    for (const key of Object.keys(env)) if (!allowed.has(key.toLowerCase())) delete env[key];
    for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "XDG_CONFIG_HOME"]) {
      env[key] = path.join(root, key.toLowerCase());
      fs.mkdirSync(env[key]!, { recursive: true });
    }
    env.ANTHROPIC_API_KEY = "fixture-only-custom-mode";
    env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${address.port}`;
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    const launch = () => electron.launch({ args: [path.join(repoRoot, "apps", "desktop"), `--user-data-dir=${userDataDir}`], cwd: repoRoot, env });
    app = await launch();
    let page = await app.firstWindow();
    await invoke(page, "harness.list", {});
    const projects = await invoke<Array<{ id: string }>>(page, "projects.list", {});
    const created = await invoke<{ session: { id: string }; agents: Array<{ id: string }> }>(page, "sessions.create", {
      projectId: projects[0]!.id, mode: "solo", title: "Custom native proof",
      agents: [{ name: "Original", backend: "claude", model: E2E_CLAUDE_MODEL, role: "lead", config: { claude: { effort: "low" } } }],
    });
    const sessionId = created.session.id;
    await page.evaluate((id) => { location.hash = `/c/${id}`; }, sessionId);
    await invoke(page, "chat.send", { sessionId, text: "Earlier private fixture conversation" });
    await expect.poll(() => calls.length).toBeGreaterThan(0);
    await expect(page.getByTestId("chat-mode-picker-custom")).toBeEnabled();
    await page.getByTestId("chat-mode-picker-custom").click();
    await page.getByLabel("Describe your custom mode").fill("Create a lead and one worker for this offline fixture.");
    await page.getByLabel("Draft generator").selectOption(JSON.stringify(target));
    await page.getByRole("button", { name: "Generate draft", exact: true }).click();
    await expect(page.getByText("Draft returned for review.", { exact: false })).toBeVisible();
    const authoringCalls = calls.filter((call) => call.authoring);
    expect(authoringCalls).toHaveLength(1);
    expect(authoringCalls[0]).toMatchObject({ authoring: true, model: E2E_CLAUDE_MODEL, tools: 0, effort: "low", leaksHistory: false });
    await expect(page.getByLabel("Crew JSON")).toHaveValue(JSON.stringify(crew));
    await page.getByRole("button", { name: "Visual", exact: true }).click();
    await page.getByLabel("Crew title").fill("Applied fixture crew");
    await page.getByRole("button", { name: "Review changes", exact: true }).click();
    await page.getByRole("button", { name: "Apply crew", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const read = () => invoke<any>(page, "sessions.get", { sessionId });
    let saved = await read();
    expect(saved.session.mode).toBe("custom");
    expect(saved.session.settings.crew.title).toBe("Applied fixture crew");
    expect(saved.agents[0].id).not.toBe(created.agents[0]!.id);
    expect(saved.turns.some((turn: { agentId: string }) => turn.agentId === created.agents[0]!.id)).toBe(true);
    expect(saved.blocks.some((block: { text?: string }) => block.text === "Earlier private fixture conversation")).toBe(true);
    const beforeTurns = saved.turns.map((turn: { id: string }) => turn.id);
    const beforeCalls = calls.length;
    await app.close(); app = undefined;
    app = await launch(); page = await app.firstWindow();
    saved = await invoke<any>(page, "sessions.get", { sessionId });
    expect(saved.session.mode).toBe("custom");
    expect(saved.session.settings.crew.title).toBe("Applied fixture crew");
    expect(saved.turns.map((turn: { id: string }) => turn.id)).toEqual(beforeTurns);
    expect(calls).toHaveLength(beforeCalls);
  } finally {
    await app?.close().catch(() => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
