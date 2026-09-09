import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { launchEnv, PERSONAL_KEY_ENV, E2E_CLAUDE_MODEL } from "./testPolicy.js";
import { nativeClaudePath } from "./nativeClaude.js";

const repoRoot = path.resolve(__dirname, "..", "..");
const invoke = <T>(page: Page, channel: string, payload: unknown): Promise<T> => page.evaluate(async ({ channel, payload }) =>
  (window as unknown as { capygen: { invoke(channel: string, payload: unknown): Promise<T> } }).capygen.invoke(channel, payload), { channel, payload });

test("custom draft generation, reviewed Apply and restart preserve the working transcript", async () => {
  if (!process.env.SystemRoot) throw new Error("Custom native fixture requires SystemRoot for isolation outside the user profile.");
  const root = fs.mkdtempSync(path.join(process.env.SystemRoot, "Temp", "capygen-custom-native-"));
  const userDataDir = path.join(root, "profile");
  const projectDir = path.join(root, "project");
  fs.mkdirSync(projectDir);
  const homes = { claudeHome: path.join(root, "claude"), codexHome: path.join(root, "codex"), dedicated: false, cleanup() {} };
  fs.mkdirSync(homes.claudeHome); fs.mkdirSync(homes.codexHome);
  const target = { backend: "claude", model: E2E_CLAUDE_MODEL, effort: "low" };
  const crew = { version: 1, title: "Reviewed fixture crew", description: "Native offline fixture",
    roster: [{ id: "lead", label: "Lead", role: "lead", target, instructions: "Lead this fixture" },
      { id: "worker", label: "Worker", role: "worker", target, instructions: "Handle delegated tasks" }],
    routing: [], defaultWorker: "worker", debate: { enabled: false, triggers: [], participants: [] } };
  const calls: Array<{ authoring: boolean; model: string; tools: number; effort: unknown; leaksHistory: boolean; titleCall: boolean; personalConfig: boolean }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      if (request.url === "/api/hello") { response.writeHead(200, { "Content-Type": "application/json" }).end("{}"); return; }
      if (!request.url?.startsWith("/v1/messages")) { response.writeHead(404).end(); return; }
      const parsed = JSON.parse(body);
      const authoring = JSON.stringify(parsed.system).includes("Return only JSON matching this schema");
      calls.push({ authoring, model: parsed.model, tools: parsed.tools?.length ?? 0,
        effort: parsed.output_config?.effort, titleCall: (parsed.messages?.length === 1 && parsed.messages[0]?.role === "user" && parsed.messages[0]?.content?.some((part: { type?: string; text?: string }) => part.type === "text" && /^<session>\n[\s\S]*\n<\/session>\n\nWrite the title in the predominant language of the session/.test(part.text ?? ""))) === true, personalConfig: (/\.claude[\\/]+CLAUDE\.md/i).test(JSON.stringify(parsed.messages)), leaksHistory: authoring && JSON.stringify(parsed).includes("Earlier private fixture conversation") });
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
    // The SDK can chat without a global CLI, but the catalogue probes PATH.
    // Supply the same real pinned CLI and exclude developer-installed backends.
    for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
    env.PATH = [path.dirname(nativeClaudePath(repoRoot)), path.dirname(process.execPath),
      path.join(process.env.SystemRoot!, "System32"), process.env.SystemRoot!].join(path.delimiter);
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


    // Starting in Custom must apply the reviewed crew before the first dispatch.
    await page.getByTestId("new-session").click();
    await expect(page.getByTestId("landing-heading")).toBeVisible();
    const sessionsBeforeLanding = await invoke<Array<{ id: string }>>(page, "sessions.list", {});
    await page.getByTestId("landing-mode-picker-custom").click();
    const landingEditor = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Custom mode", exact: true }) });
    await expect(landingEditor).toBeVisible();
    await landingEditor.getByRole("button", { name: "JSON", exact: true }).click();
    const landingCrew = { ...crew, title: "Custom from first message" };
    await landingEditor.getByLabel("Crew JSON").fill(JSON.stringify(landingCrew));
    await expect(landingEditor.getByRole("button", { name: "Review changes", exact: true }), await landingEditor.innerText()).toBeEnabled();
    await landingEditor.getByRole("button", { name: "Review changes", exact: true }).click();
    await landingEditor.getByRole("button", { name: "Apply crew", exact: true }).click();
    await expect(landingEditor).toHaveCount(0);
    await expect(page.getByTestId("landing-heading")).toBeVisible();
    const sessionsAfterLanding = await invoke<Array<{ id: string }>>(page, "sessions.list", {});
    const newSessions = sessionsAfterLanding.filter(session => !sessionsBeforeLanding.some(old => old.id === session.id));
    expect(newSessions).toHaveLength(1);
    const landingSessionId = newSessions[0]!.id;
    const beforeDispatch = await invoke<any>(page, "sessions.get", { sessionId: landingSessionId });
    const registeredProjects = await invoke<Array<{ id: string; path: string }>>(page, "projects.list", {});
    const selectedPath = registeredProjects.find(project => project.id === beforeDispatch.session.projectId)?.path;
    expect(selectedPath).toBeDefined();
    expect(fs.realpathSync.native(selectedPath!).toLowerCase()).toBe(fs.realpathSync.native(projectDir).toLowerCase());
    expect(beforeDispatch.session.mode).toBe("custom");
    expect(beforeDispatch.session.settings.crew).toEqual(landingCrew);
    expect(beforeDispatch.turns).toHaveLength(0);
    expect(beforeDispatch.agents).toHaveLength(1); // Worker policy does not create a top-level agent.
    expect(beforeDispatch.agents[0]).toMatchObject({ role: "lead", backend: "claude", model: E2E_CLAUDE_MODEL, config: { claude: { effort: "low" } } });
    expect(calls).toHaveLength(beforeCalls); // Opening/reviewing/applying makes no model call.

    const firstPrompt = "First message with the reviewed landing crew";
    await page.getByTestId("landing-composer-input").fill(firstPrompt);
    await page.getByTestId("landing-composer-input").press("Enter");
    await expect(page.getByTestId("chat-page")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/c/${landingSessionId}$`));
    await expect(page.getByTestId("transcript")).toContainText("Earlier private fixture conversation");
    const afterDispatch = await invoke<any>(page, "sessions.get", { sessionId: landingSessionId });
    expect(afterDispatch.session.mode).toBe("custom");
    expect(afterDispatch.session.settings.crew.title).toBe(landingCrew.title);
    expect(afterDispatch.blocks.some((block: { text?: string }) => block.text === firstPrompt)).toBe(true);
    expect(afterDispatch.turns.some((turn: { agentId?: string }) => turn.agentId === beforeDispatch.agents[0].id)).toBe(true);
    const newCalls = calls.slice(beforeCalls);
    const taskCalls = newCalls.filter(call => !call.titleCall);
    expect(taskCalls).toHaveLength(1);
    expect(taskCalls[0]).toMatchObject({ authoring: false, model: E2E_CLAUDE_MODEL, effort: "low", personalConfig: false });
    expect(newCalls.filter(call => call.titleCall).length).toBeLessThanOrEqual(1);
    expect(calls.every(call => !call.personalConfig)).toBe(true);
    expect(calls.filter(call => call.authoring)).toHaveLength(1);
  } catch (error) {
    const window = app?.windows()[0];
    if (window) await window.screenshot({ path: path.join(repoRoot, "e2e-out", "ux-repair-custom-failure.png") }).catch(() => {});
    throw error;
  } finally {
    await app?.close().catch(() => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
