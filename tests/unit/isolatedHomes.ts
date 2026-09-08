/** Native unit fixtures must never discover the developer's backend configuration. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-unit-homes-"));
const previous = new Map<string, string | undefined>();
const homes: Record<string, string> = {
  HOME: root, USERPROFILE: root,
  APPDATA: path.join(root, "roaming"), LOCALAPPDATA: path.join(root, "local"),
  CLAUDE_CONFIG_DIR: path.join(root, "claude"), CODEX_HOME: path.join(root, "codex"),
  CAPYGEN_CLAUDE_CONFIG_DIR: path.join(root, "claude"), CAPYGEN_CODEX_HOME: path.join(root, "codex"),
};
for (const [key, value] of Object.entries(homes)) {
  previous.set(key, process.env[key]);
  fs.mkdirSync(value, { recursive: true });
  process.env[key] = value;
}
for (const key of Object.keys(process.env)) {
  if (["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "OPENROUTER_API_KEY"].includes(key.toUpperCase())) {
    previous.set(key, process.env[key]); delete process.env[key];
  }
}
afterAll(() => {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
