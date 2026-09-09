/** Opt-in real private-feed check from an existing older packaged executable.
 * The GitHub CLI credential stays in test/main memory and isolated safeStorage;
 * it never enters the renderer, an environment variable, a log, or the report. */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";
import { cleanEnv } from "../packages/engine/src/env.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executablePath = process.argv[2];
const targetVersion = process.argv[3];
if (!process.argv.includes("--live") || !executablePath || !path.isAbsolute(executablePath) || !fs.existsSync(executablePath) || !targetVersion || !/^\d+\.\d+\.\d+$/.test(targetVersion)) {
  throw new Error("Pass an existing absolute older packaged executable, target version, and --live.");
}
const parent = path.join(process.env.SystemRoot ?? "C:\\Windows", "Temp");
const root = fs.mkdtempSync(path.join(parent, "capygen-private-update-"));
const profile = path.join(root, "profile"), project = path.join(root, "project"), home = path.join(root, "home");
const claude = path.join(root, "claude"), codex = path.join(root, "codex");
const roaming = path.join(home, "AppData", "Roaming"), local = path.join(home, "AppData", "Local");
for (const directory of [profile, project, claude, codex, roaming, local]) fs.mkdirSync(directory, { recursive: true });
const env = cleanEnv(process.env);
for (const key of Object.keys(env)) if (/^(ANTHROPIC_|OPENAI_|OPENROUTER_|CLAUDE_CODE_|CAPYGEN_|GH_TOKEN$|GITHUB_TOKEN$|PORTABLE_EXECUTABLE_FILE$|ELECTRON_RUN_AS_NODE$|HOME$|USERPROFILE$|APPDATA$|LOCALAPPDATA$)/i.test(key)) delete env[key];
Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: roaming, LOCALAPPDATA: local, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex,
  CAPYGEN_USER_DATA_DIR: profile, CAPYGEN_PROJECT_DIR: project, CAPYGEN_CLAUDE_CONFIG_DIR: claude, CAPYGEN_CODEX_HOME: codex, CAPYGEN_ENGINE: "stub" });
let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
let token = "";
let stage = "authentication";
try {
  // Standard gh authentication for this repository; never print stdout/stderr.
  token = execFileSync("gh", ["auth", "token", "--hostname", "github.com"], { env: cleanEnv(process.env), windowsHide: true, encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  if (!token || token.length > 4096) throw new Error("GitHub authentication unavailable");
  stage = "launch older app";
  const launchEnv = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  app = await electron.launch({ executablePath, args: [`--user-data-dir=${profile}`], cwd: project, env: launchEnv });
  await (await app.firstWindow()).getByTestId("landing-heading").waitFor();
  stage = "check private feed";
  const proof = await app.evaluate(async ({ app, ipcMain, BrowserWindow }, input) => {
    if (!app.isPackaged || app.getVersion() === input.targetVersion) throw new Error("An actual older packaged app is required");
    // Test-only access to the registered production handlers in Electron main.
    // This avoids putting a credential in renderer JS while exercising the old
    // binary's real schema validation, safeStorage, UpdateService and driver.
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, payload: unknown) => Promise<any>> })._invokeHandlers;
    const window = BrowserWindow.getAllWindows()[0]!;
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
    const setCredential = handlers?.get("updates.setCredential");
    const check = handlers?.get("updates.check");
    const deleteCredential = handlers?.get("updates.deleteCredential");
    if (!setCredential || !check || !deleteCredential) throw new Error("Packaged updater handler unavailable");
    try {
      await setCredential(event, { value: input.token });
      const status = await check(event, {});
      return { currentVersion: app.getVersion(), targetVersion: status.version, phase: status.phase,
        passed: status.phase === "available" && status.version === input.targetVersion,
        packaged: app.isPackaged, privateFeed: true, installInvoked: false };
    } finally { await deleteCredential(event, {}); }
  }, { token, targetVersion });
  token = "";
  fs.writeFileSync(path.join(repo, "e2e-out", "private-update-proof.json"), JSON.stringify(proof, null, 2) + "\n");
  console.log(JSON.stringify(proof));
  if (!proof.passed) process.exitCode = 1;
} catch {
  console.error(`Private update verification failed during ${stage}; no credential or native diagnostic is printed.`);
  process.exitCode = 1;
} finally {
  token = "";
  await app?.close().catch(() => {});
  if (path.dirname(root).toLowerCase() !== parent.toLowerCase() || !path.basename(root).startsWith("capygen-private-update-")) throw new Error("Unexpected test cleanup path");
  await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
