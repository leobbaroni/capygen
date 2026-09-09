import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { _electron as electron, chromium, expect, test, type Page } from "@playwright/test";
import { launchEnv, PERSONAL_KEY_ENV } from "./e2e/testPolicy.js";

// Installation and uninstallation belong to the hosted-only PowerShell wrapper.
// This test can also rehearse the runtime checks against a disposable package copy.
test("installed runtime: launch, terminal, native browser, tray and SQLite restart", async () => {
  const executablePath = process.env.CAPYGEN_INSTALLED_EXE ?? "";
  const root = process.env.CAPYGEN_INSTALLED_TEST_ROOT ?? "";
  expect(process.platform).toBe("win32");
  expect(path.isAbsolute(executablePath) && fs.existsSync(executablePath)).toBe(true);
  expect(path.isAbsolute(root)).toBe(true);
  expect(executablePath).toMatch(/ /);
  expect(executablePath).toMatch(/[^\x00-\x7f]/);
  const profile = path.join(root, "profile"), project = path.join(root, "project");
  const homes = { claudeHome: path.join(root, "claude"), codexHome: path.join(root, "codex") };
  fs.mkdirSync(root, { recursive: true });
  for (const directory of [profile, project, homes.claudeHome, homes.codexHome]) fs.mkdirSync(directory);
  for (const directory of [project, homes.claudeHome, homes.codexHome]) {
    fs.writeFileSync(path.join(directory, "fixture-preserved.txt"), "Owned uninstall-preservation fixture.\n");
  }
  const env = launchEnv({ userDataDir: profile, projectDir: project, homes, engine: "stub" });
  const excluded = new Set([...PERSONAL_KEY_ENV, "GH_TOKEN", "GITHUB_TOKEN", "PORTABLE_EXECUTABLE_FILE", "ELECTRON_RUN_AS_NODE"].map((key) => key.toLowerCase()));
  for (const key of Object.keys(env)) if (excluded.has(key.toLowerCase())) delete env[key];
  const home = path.join(root, "home");
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData/Roaming"), LOCALAPPDATA: path.join(home, "AppData/Local") });
  fs.mkdirSync(env.APPDATA!, { recursive: true }); fs.mkdirSync(env.LOCALAPPDATA!, { recursive: true });
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end("<!doctype html><title>Installed capygen fixture</title><h1>Native browser works</h1>");
  });
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  let page: Page;
  const invoke = <T>(channel: string, payload: unknown = {}) => page.evaluate(async ({ channel, payload }) => {
    return (window as any).capygen.invoke(channel, payload);
  }, { channel, payload }) as Promise<T>;
  const out = path.resolve(__dirname, "../e2e-out");
  fs.mkdirSync(out, { recursive: true });
  try {
    // Launch the executable directly: ElectronApplication.launch also connects
    // a main-process debugger, whose setup time is not application startup.
    const speedProfile = path.join(root, "speed-profile");
    const speedEnv = { ...env, CAPYGEN_USER_DATA_DIR: speedProfile };
    const started = Date.now();
    const child = spawn(executablePath, ["--remote-debugging-port=0", `--user-data-dir=${speedProfile}`], { cwd: project, env: speedEnv, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
    let launchMs = 0;
    try {
      const endpoint = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Installed launch did not expose its browser")), 15_000);
        let stderr = "";
        child.once("error", () => { clearTimeout(timeout); reject(new Error("Installed process failed to start")); });
        child.stderr!.on("data", (chunk: Buffer) => {
          stderr = (stderr + chunk.toString()).slice(-8192);
          const match = stderr.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/);
          if (match) { clearTimeout(timeout); resolve(match[1]!); }
        });
      });
      browser = await chromium.connectOverCDP(endpoint);
      await expect.poll(() => browser!.contexts().flatMap((context) => context.pages()).length).toBeGreaterThan(0);
      const landing = browser.contexts().flatMap((context) => context.pages())[0]!;
      await expect(landing.getByTestId("landing-heading")).toHaveText("What should we build?");
      await expect(landing.getByTestId("landing-composer-input")).toBeFocused();
      launchMs = Date.now() - started;
      expect(launchMs, "G1: direct packaged launch to focused composer").toBeLessThanOrEqual(3000);
      await landing.evaluate(() => (window as any).capygen.invoke("settings.set", { closeToTray: false }));
      await landing.close();
      await expect.poll(() => child.exitCode).toBe(0);
    } finally {
      await browser?.close().catch(() => {});
      if (child.exitCode === null) child.kill();
    }
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    app = await electron.launch({ executablePath, args: [`--user-data-dir=${profile}`], cwd: project, env });
    page = await app.firstWindow();
    await expect(page.getByTestId("landing-heading")).toHaveText("What should we build?");
    await expect(page.getByTestId("landing-composer-input")).toBeFocused();
    const identity = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, exe: app.getPath("exe"), profile: app.getPath("userData"), version: app.getVersion(), claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME }));
    expect(identity).toMatchObject({ packaged: true, profile, claude: homes.claudeHome, codex: homes.codexHome });
    expect(path.resolve(identity.exe).toLowerCase()).toBe(path.resolve(executablePath).toLowerCase());
    const [selected] = await invoke<{ id: string }[]>("projects.list");
    expect(selected).toBeTruthy();
    const created = await invoke<{ session: { id: string } }>("sessions.create", { projectId: selected!.id, title: "Installed SQLite preservation", mode: "solo", agents: [] });
    await page.evaluate(() => {
      (window as any).__installedTerminalOutput = "";
      (window as any).capygen.subscribe("terminal.data", (event: { data: string }) => { (window as any).__installedTerminalOutput += event.data; });
    });
    const terminal = await invoke<{ id: string }>("terminal.create", { projectId: selected!.id, cols: 80, rows: 24 });
    try {
      await invoke("terminal.write", { id: terminal.id, data: "Write-Output ('installed-terminal-' + (6 * 7))\r" });
      await expect.poll(() => page.evaluate(() => (window as any).__installedTerminalOutput)).toContain("installed-terminal-42");
    } finally { await invoke("terminal.kill", { id: terminal.id }); }
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    await invoke("browser.attach", { viewId: "installed-fixture", bounds: { x: 20, y: 120, width: 480, height: 240 }, url });
    try {
      await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.map((view) => {
        const contents = (view as Electron.WebContentsView).webContents;
        return { title: contents.getTitle(), url: contents.getURL(), bounds: view.getBounds() };
      }))).toContainEqual({ title: "Installed capygen fixture", url, bounds: { x: 20, y: 120, width: 480, height: 240 } });
      const png = await app.evaluate(async ({ BrowserWindow }) => {
        const view = BrowserWindow.getAllWindows()[0]!.contentView.children[0] as Electron.WebContentsView;
        return (await view.webContents.capturePage()).toPNG().toString("base64");
      });
      fs.writeFileSync(path.join(out, "installed-browser.png"), Buffer.from(png, "base64"));
    } finally { await invoke("browser.detach", { viewId: "installed-fixture" }); }
    await invoke("settings.set", { closeToTray: true });
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.close(); });
    await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((win) => win.isVisible()))).toEqual([false]);
    // A real second process exercises the installed app's single-instance reveal.
    await new Promise<void>((resolve, reject) => execFile(executablePath, [`--user-data-dir=${profile}`], { cwd: project, env, windowsHide: true, timeout: 15_000 }, (error) => error ? reject(new Error("Second installed launch failed")) : resolve()));
    await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((win) => win.isVisible()))).toEqual([true]);
    await app.close(); app = undefined;
    expect(fs.existsSync(path.join(profile, "capygen.db"))).toBe(true);
    app = await electron.launch({ executablePath, args: [`--user-data-dir=${profile}`], cwd: project, env });
    page = await app.firstWindow();
    await expect(page.getByTestId("landing-heading")).toBeVisible();
    expect(await invoke<{ id: string; title: string }[]>("sessions.list")).toContainEqual(expect.objectContaining({ id: created.session.id, title: "Installed SQLite preservation" }));
    fs.writeFileSync(path.join(out, "installed-runtime-proof.json"), JSON.stringify({ version: identity.version, launchMs, focused: true, packaged: true, pathSpacesAndUnicode: true, terminal: true, nativeBrowser: true, closeToTray: true, secondInstanceReveal: true, sqliteRestart: true, isolatedHomes: true }, null, 2) + "\n");
  } finally {
    await app?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // The wrapper checks these exact owned files after uninstall, then cleans up.
  }
});
