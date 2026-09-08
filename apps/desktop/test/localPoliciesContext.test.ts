import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openStore, type CapygenStore } from "@capygen/db";
import type { PolicyBoundaryAvailability } from "@capygen/shared";
import { LocalPolicyService } from "../src/policies/index.js";
import { createIpcContext, type IpcContext } from "../src/ipc/handlers.js";
import { createStubEngine } from "../src/engine/stub.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));
let dir: string | undefined;
let store: CapygenStore | undefined;
let contexts: IpcContext[] = [];

function baseDeps() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-policy-context-"));
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

describe("local policy context wiring", () => {
  it("refuses a policy call when the dependency is absent", async () => {
    const context = createIpcContext(baseDeps());
    contexts.push(context);
    await expect(Promise.resolve().then(() => context.handlers["policy.members.list"]({}))).rejects.toThrow("unavailable");
  });

  it("routes central policy channels to the supplied real service", async () => {
    const deps = baseDeps();
    const project = store!.projects.upsertByPath({ path: path.join(dir!, "project"), name: "Project" });
    const session = store!.sessions.create({ projectId: project.id, mode: "solo", agents: [] }).session;
    const availability: PolicyBoundaryAvailability[] = [{ boundary: "api-tool", available: true, reason: null }];
    const service = new LocalPolicyService({
      store: store!,
      resolveContext: () => null,
      ask: async () => ({ kind: "deny" }),
      interruptAndDeny: () => {},
      isQuiescent: () => true,
    });
    const context = createIpcContext({
      ...deps,
      localPolicies: {
        service,
        catalogue: {
          sessionExists: (id) => id === session.id,
          projectExists: (id) => id === project.id,
          isReadOnlyArtifact: () => false,
          boundaryAvailability: () => ({ backend: "api", boundaries: availability }),
        },
      },
    });
    contexts.push(context);
    const listed = await context.handlers["policy.members.list"]({});
    expect(listed.members.length).toBeGreaterThan(0);
    const created = await context.handlers["policy.members.create"]({ label: "Reviewer", role: "editor" });
    expect(created.member.label).toBe("Reviewer");
  });
});
