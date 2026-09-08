/** Interactive microphone acceptance in a disposable, model-free Electron profile. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";
import { cleanEnv } from "../packages/engine/src/env.js";
import { whisperInstalled } from "../apps/desktop/src/workspace/WhisperDictation.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = process.argv[2];
if (!runtime || !path.isAbsolute(runtime) || !whisperInstalled(runtime)) throw new Error("Pass the approved isolated Whisper runtime directory.");
const root = fs.mkdtempSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "Temp", "capygen-speech-test-"));
const profile = path.join(root, "profile");
const project = path.join(root, "project");
const home = path.join(root, "home");
const claude = path.join(root, "claude"); const codex = path.join(root, "codex");
for (const directory of [profile, project, home, claude, codex, path.join(home, "AppData", "Roaming"), path.join(home, "AppData", "Local")]) fs.mkdirSync(directory, { recursive: true });
const speechLink = path.join(profile, "speech");
fs.symlinkSync(fs.realpathSync(runtime), speechLink, "junction");
const env = cleanEnv(process.env);
for (const key of Object.keys(env)) {
  if (/^(ANTHROPIC_|OPENAI_|OPENROUTER_|CLAUDE_CODE_OAUTH_TOKEN|CAPYGEN_TEST_|CAPYGEN_DEV_URL$|ELECTRON_RUN_AS_NODE$|HOME$|USERPROFILE$|APPDATA$|LOCALAPPDATA$)/i.test(key)) delete env[key];
}
Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"),
  CAPYGEN_USER_DATA_DIR: profile, CAPYGEN_PROJECT_DIR: project, CAPYGEN_CLAUDE_CONFIG_DIR: claude, CAPYGEN_CODEX_HOME: codex,
  CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex, CAPYGEN_ENGINE: "stub", ELECTRON_ENABLE_LOGGING: "0" });
let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
try {
  app = await electron.launch({ args: [path.join(repo, "apps", "desktop"), `--user-data-dir=${profile}`], cwd: project, env });
  const page = await app.firstWindow();
  await page.getByTestId("landing-composer-input").waitFor();
  await page.waitForFunction(() => {
    const mic = document.querySelector<HTMLButtonElement>('[data-testid="landing-composer-mic"]');
    return mic && !mic.disabled && mic.title.includes("automatically");
  });
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window?.setTitle("capygen — microphone acceptance test"); window?.show(); window?.focus(); });
  await page.screenshot({ path: path.join(repo, "e2e-out", "speech-test-ready.png") });
  console.log(JSON.stringify({ ready: true, microphoneOpened: false, modelCallsEnabled: false, pid: app.process().pid }));
  await new Promise<void>(resolve => app!.once("close", resolve));
} finally {
  await app?.close().catch(() => {});
  // Unlink the junction itself first, preserving the separately approved runtime.
  if (fs.existsSync(speechLink)) fs.unlinkSync(speechLink);
  const tempParent = path.join(process.env.SystemRoot ?? "C:\\Windows", "Temp");
  if (path.dirname(root).toLowerCase() !== tempParent.toLowerCase() || !path.basename(root).startsWith("capygen-speech-test-")) throw new Error("Refusing unexpected cleanup path");
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
