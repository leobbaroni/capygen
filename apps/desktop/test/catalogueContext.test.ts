import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openStore, type CapygenStore } from "@capygen/db";
import { createIpcContext, type IpcContext } from "../src/ipc/handlers.js";
import { createStubEngine } from "../src/engine/stub.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));
let dir: string | undefined;
let store: CapygenStore | undefined;
let contexts: IpcContext[] = [];

function baseDeps() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-catalogue-context-"));
  const claudeHome = path.join(dir, "claude");
  const codexHome = path.join(dir, "codex");
  fs.mkdirSync(claudeHome, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  store = openStore(path.join(dir, "capygen.db"), { migrationsDir: MIGRATIONS_DIR });
  return {
    store,
    broadcast: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    makeEngine: createStubEngine,
    integrations: { env: { CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome }, home: dir },
    pickDirectory: async () => null,
    appInfo: () => ({ name: "capygen", version: "test", electron: "", chrome: "", node: "", platform: "win32", userDataDir: dir!, logFile: "", dbFile: store!.db.file }),
  };
}

afterEach(async () => {
  const activeContexts = contexts.splice(0);
  try {
    for (const context of activeContexts) await context.dispose();
  } finally {
    try {
      store?.close();
    } finally {
      try {
        if (dir) fs.rmSync(dir, { recursive: true, force: true });
      } finally {
        dir = undefined;
        store = undefined;
      }
    }
  }
});

describe("catalogue context ownership", () => {
  it("resolves the lead, preserves explicit initialization, and refuses another session's agent", async () => {
    const deps = baseDeps();
    const project = store!.projects.upsertByPath({ path: path.join(dir!, "project"), name: "Project" });
    const create = () => store!.sessions.create({ projectId: project.id, mode: "solo",
      agents: [{ name: "Lead", backend: "codex", model: "gpt-5.6-luna", role: "lead", config: null }] });
    const first = create();
    const other = create();
    const catalogue = vi.fn(async () => ({ kind: "notStarted" as const }));
    const context = createIpcContext({ ...deps, makeEngine: (engineDeps) => ({
      ...createStubEngine(engineDeps), catalogueAgent: catalogue,
    }) });
    contexts.push(context);
    await expect(context.handlers["agents.catalogue"]({ sessionId: first.session.id,
      agentId: null, initialize: false })).resolves.toEqual({ kind: "notStarted" });
    expect(catalogue).toHaveBeenCalledWith(first.session.id, first.agents[0]!.id, false);
    await context.handlers["agents.catalogue"]({ sessionId: first.session.id,
      agentId: first.agents[0]!.id, initialize: true });
    expect(catalogue).toHaveBeenLastCalledWith(first.session.id, first.agents[0]!.id, true);
    await expect(context.handlers["agents.catalogue"]({ sessionId: first.session.id,
      agentId: other.agents[0]!.id, initialize: true })).rejects.toThrow("No matching agent");
    expect(catalogue).toHaveBeenCalledTimes(2);
    store!.db.run("UPDATE sessions SET origin = 'import', artifact_kind = 'shared-bundle' WHERE id = ?", first.session.id);
    await expect(context.handlers["agents.catalogue"]({ sessionId: first.session.id,
      agentId: null, initialize: true })).rejects.toThrow("No runnable session");
    expect(catalogue).toHaveBeenCalledTimes(2);
  });
});
