import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { launchEnv, PERSONAL_KEY_ENV } from "./e2e/testPolicy.js";
import { cleanEnv } from "../packages/engine/src/env.js";

test("packaged Windows runtime: bridge, updates, speech, bundled CLI, PTY and assets", async () => {
  test.skip(process.platform !== "win32", "Requires the Windows packaged executable");
  const repo = path.resolve(__dirname, "..");
  const executablePath = path.join(repo, "release/artifacts/win-unpacked/capygen.exe");
  expect(fs.existsSync(executablePath)).toBe(true);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-packaged-smoke-"));
  const userDataDir = path.join(root, "profile");
  const projectDir = path.join(root, "project");
  const homes = { claudeHome: path.join(root, "claude"), codexHome: path.join(root, "codex"), dedicated: false, cleanup() {} };
  for (const dir of [userDataDir, projectDir, homes.claudeHome, homes.codexHome]) fs.mkdirSync(dir);
  const env = launchEnv({ userDataDir, projectDir, homes, engine: "stub" });
  const excluded = new Set([...PERSONAL_KEY_ENV, "GH_TOKEN", "GITHUB_TOKEN", "PORTABLE_EXECUTABLE_FILE", "ELECTRON_RUN_AS_NODE"].map((key) => key.toLowerCase()));
  for (const key of Object.keys(env)) if (excluded.has(key.toLowerCase())) delete env[key];
  // CLI and shell defaults also resolve beneath this run's owned home.
  env.HOME = root; env.USERPROFILE = root;
  const isolatedEnv = cleanEnv(env) as Record<string, string>;
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ executablePath, args: [`--user-data-dir=${userDataDir}`], cwd: projectDir, env: isolatedEnv });
    const page = await app.firstWindow();
    await expect(page.getByTestId("landing-heading")).toHaveText("What should we build?");
    const packaged = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, root: app.getAppPath(), profile: app.getPath("userData") }));
    expect(packaged.packaged).toBe(true);
    expect(path.resolve(packaged.profile)).toBe(path.resolve(userDataDir));
    const invoke = <T>(channel: string, payload = {}) => page.evaluate(async ({ channel, payload }) => {
      const bridge = (window as any).capygen;
      if (!bridge) throw new Error("Packaged preload bridge missing");
      return bridge.invoke(channel, payload);
    }, { channel, payload }) as Promise<T>;
    const status = await invoke<{ phase: string; hasCredential: boolean; message: string }>("updates.status");
    expect(status.hasCredential).toBe(false);
    expect(status.phase).not.toBe("unavailable");
    expect(status.message).not.toMatch(/unpackaged|unavailable in this host/i);
    const speech = await invoke<{ available: boolean; languages: string[] }>("dictation.availability");
    expect(speech.available).toBe(true);
    expect(speech.languages.length).toBeGreaterThan(0);
    for (const relative of ["desktop/dist/speech/capygen-speech.exe", "desktop/dist/assets/extensions/sample/capygen-extension.json", "desktop/dist/assets/extensions/sample/index.html", "desktop/dist/assets/extensions/sample/sample.js", "desktop/dist/assets/extensions/sample/sample.css"]) {
      expect(fs.existsSync(path.join(packaged.root, relative)), relative).toBe(true);
    }
    const versions: Record<string, string> = {};
    for (const [backend, relative] of Object.entries({
      claude: "node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe",
      codex: "node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
    })) {
      const cli = path.join(packaged.root, relative);
      expect(fs.existsSync(cli), `${backend} physical executable`).toBe(true);
      versions[backend] = await app.evaluate(async (_electron, { cli, env, cwd }) => {
        const { execFile } = process.getBuiltinModule("node:child_process") as typeof import("node:child_process");
        return new Promise<string>((resolve, reject) => execFile(cli, ["--version"], { env, cwd, windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024 }, (error, stdout) => error ? reject(new Error("Bundled CLI version probe failed")) : resolve(stdout.trim())));
      }, { cli, env: isolatedEnv, cwd: projectDir });
    }
    expect(versions.claude).toMatch(/^\d+\.\d+\.\d+.*Claude Code/);
    expect(versions.codex).toMatch(/^codex-cli \d+\.\d+\.\d+/);
    const projects = await invoke<{ id: string }[]>("projects.list");
    expect(projects).toHaveLength(1);
    await page.evaluate(() => {
      (window as any).__packagedTerminalOutput = "";
      (window as any).capygen.subscribe("terminal.data", (event: { data: string }) => { (window as any).__packagedTerminalOutput += event.data; });
    });
    const terminal = await invoke<{ id: string }>("terminal.create", { projectId: projects[0]!.id, cols: 80, rows: 24 });
    try {
      // The command input never contains the contiguous expected output.
      await invoke("terminal.write", { id: terminal.id, data: "Write-Output ('capygen-packaged-' + (6 * 7))\r" });
      await expect.poll(() => page.evaluate(() => (window as any).__packagedTerminalOutput)).toContain("capygen-packaged-42");
    } finally { await invoke("terminal.kill", { id: terminal.id }); }
    expect(await invoke("terminal.list", { projectId: projects[0]!.id })).toEqual([]);
    await page.evaluate(() => { (window as any).__packagedTerminalOutput = ""; });
    const attached = await invoke<{ id: string }>("terminal.attach", { projectId: projects[0]!.id, backend: "codex", cols: 100, rows: 30 });
    let attachmentOutput = "";
    try {
      await expect.poll(async () => {
        attachmentOutput = await page.evaluate(() => (window as any).__packagedTerminalOutput);
        return attachmentOutput;
      }).toMatch(/Welcome to Codex|Sign in with ChatGPT|Sign in to Codex|OpenAI Codex|trust this (?:directory|folder)/i);
      expect(attachmentOutput).not.toMatch(/not recognized|cannot find|MODULE_NOT_FOUND/i);
      expect(await invoke<{ id: string }[]>("terminal.list", { projectId: projects[0]!.id })).toEqual(expect.arrayContaining([expect.objectContaining({ id: attached.id })]));
    } finally { await invoke("terminal.kill", { id: attached.id }); }
    expect(await invoke("terminal.list", { projectId: projects[0]!.id })).toEqual([]);
    await test.info().attach("runtime-proof", { body: JSON.stringify({ packaged: packaged.packaged, updater: status.phase, speechLanguages: speech.languages, bundledVersions: versions, terminalEcho: true, rawCodexStartup: true, assets: true }), contentType: "application/json" });
  } finally {
    await app?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
