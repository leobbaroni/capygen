import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { openStore } from "@capygen/db";
import { createIpcContext } from "../src/ipc/handlers.js";

it("re-derives both settings aliases when the API provider changes before a catalogue refresh", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-api-default-"));
  const claudeHome = path.join(root, "claude");
  const codexHome = path.join(root, "codex");
  fs.mkdirSync(claudeHome);
  fs.mkdirSync(codexHome);
  const store = openStore(path.join(root, "test.db"), {
    migrationsDir: fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url)),
  });
  const ipc = createIpcContext({
    store, broadcast: () => {}, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    pickDirectory: async () => root,
    appInfo: () => ({ name: "capygen", version: "0", electron: "44", chrome: "1", node: "24",
      platform: "win32", userDataDir: root, dbFile: store.db.file, logFile: path.join(root, "test.log") }),
    env: {}, integrations: { home: root, env: { CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome } },
    catalogue: () => [{ backend: "api", label: "API", available: true,
      defaultModel: "claude-opus-4-5", providers: ["anthropic", "openai"],
      models: [{ id: "claude-opus-4-5", label: "Claude" }, { id: "gpt-5", label: "GPT" }] }],
  });
  try {
    await ipc.handlers["settings.patch"]({ patch: { general: { defaultBackend: "api" }, backends: { api: { provider: "anthropic" } } } });
    await ipc.handlers["settings.patch"]({ patch: { backends: { api: { provider: "openai" } } } });
    const all = await ipc.handlers["settings.getAll"]({});
    expect(all.general.defaultModel).toBe("gpt-5");
    expect(store.settings.all().defaultModel).toBe("gpt-5");
  } finally {
    await ipc.dispose();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
