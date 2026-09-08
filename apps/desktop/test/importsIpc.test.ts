import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportedTranscript } from "@capygen/engine";
import { createImportsHandlers, type ImportHandlers } from "../src/ipc/imports.js";
import { createIpcContext } from "../src/ipc/handlers.js";
import { ImportStagingService } from "../src/imports/staging.js";
import { makeHarness, type Harness } from "./workspaceHarness.js";

function snapshot(hash = "a".repeat(64)): ImportedTranscript {
  return {
    backend: "codex",
    format: "codex-rollout/rust-v0.153.4",
    nativeId: "00000000-0000-4000-8000-000000000001",
    title: "Imported example",
    sourcePath: "C:\\selected\\rollout.jsonl",
    sourceBytes: 42,
    sourceSha256: hash,
    cwd: "C:\\historical",
    startedAt: null,
    endedAt: null,
    entries: [
      {
        index: 0,
        at: null,
        label: "user",
        truncated: false,
        kind: "message",
        speaker: "user",
        text: "historical request",
      },
      {
        index: 1,
        at: null,
        label: "assistant",
        truncated: false,
        kind: "message",
        speaker: "assistant",
        text: "historical answer",
      },
    ],
    counts: {
      records: 2,
      entries: 2,
      messages: 2,
      thinking: 0,
      activities: 0,
      notices: 0,
      droppedConfiguration: 0,
      unknownRecords: 0,
      echoedEvents: 0,
      truncatedTexts: 0,
      normalizedBytes: 600,
    },
    unknownTypes: [],
    warnings: [],
    complete: true,
  };
}

describe("transcript import IPC service", () => {
  let h: Harness;
  let staging: ImportStagingService;
  let handlers: ImportHandlers;
  let owner: number;
  let alive: boolean;
  let selected: string | null;
  let parsed: ImportedTranscript;
  let pickFile: ReturnType<typeof vi.fn<(ownerId: number) => Promise<string | null>>>;
  let validateAgent: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    h = makeHarness({ prefix: "capygen-import-ipc-" });
    owner = 7;
    alive = true;
    selected = "C:\\native-picker\\selected.jsonl";
    parsed = snapshot();
    pickFile = vi.fn(async () => selected);
    validateAgent = vi.fn((agent) => ({ ...agent, model: `${agent.model}-resolved` }));
    staging = new ImportStagingService({
      directory: path.join(h.dir, "staging"),
      parse: async (sourcePath) => ({ ...parsed, sourcePath }),
      projectExists: (projectId) => h.store.projects.get(projectId) !== null,
      log: h.log,
      newHandle: () => "a".repeat(32),
    });
    await staging.initialize();
    handlers = createImportsHandlers({
      store: h.store,
      staging,
      ownerId: () => owner,
      isOwnerAlive: () => alive,
      pickFile,
      broadcast: h.broadcast,
      validateAgent,
    });
  });

  afterEach(async () => {
    await staging.dispose();
    h.close();
  });

  it("validates project and window authority around the native picker before staging", async () => {
    await expect(handlers["imports.pick"]({ projectId: "project_missing" })).rejects.toThrow(
      /unknown project/,
    );
    expect(pickFile).not.toHaveBeenCalled();

    pickFile.mockImplementationOnce(async () => {
      alive = false;
      return selected;
    });
    await expect(handlers["imports.pick"]({ projectId: h.projectId })).rejects.toThrow(
      /window.*closed/i,
    );
    expect(staging.outstanding()).toBe(0);
  });

  it("previews duplicate and changed snapshots, consumes handles once, and enforces ownership", async () => {
    const existing = h.store.imports.commit({ projectId: h.projectId, snapshot: snapshot() });
    const preview = await handlers["imports.pick"]({ projectId: h.projectId });
    expect(preview).toMatchObject({
      sourcePath: selected,
      destinationProjectId: h.projectId,
      existingSessionId: existing.session.id,
    });

    owner = 8;
    await expect(handlers["imports.commit"]({ handle: preview!.handle })).rejects.toThrow(
      /no longer available/i,
    );
    owner = 7;
    expect(await handlers["imports.commit"]({ handle: preview!.handle })).toEqual({
      session: existing.session,
      duplicate: true,
    });
    await expect(handlers["imports.commit"]({ handle: preview!.handle })).rejects.toThrow(
      /no longer available/i,
    );

    parsed = snapshot("b".repeat(64));
    const changed = await handlers["imports.pick"]({ projectId: h.projectId });
    expect(changed).toMatchObject({ changedSnapshot: true });
    expect(changed).not.toHaveProperty("existingSessionId");
    expect(await handlers["imports.cancel"]({ handle: changed!.handle })).toEqual({ ok: true });
    expect(staging.size()).toBe(0);
  });

  it("creates an inert fresh continuation with the exact previewed reference and no dispatch", async () => {
    const source = h.store.imports.commit({ projectId: h.projectId, snapshot: snapshot() }).session;
    const reference = await handlers["imports.reference"]({ sessionId: source.id });
    const result = await handlers["imports.continue"]({
      sessionId: source.id,
      projectId: h.projectId,
      agent: { name: "capy", backend: "codex", model: "gpt-5", role: "lead", config: null },
    });

    expect(validateAgent).toHaveBeenCalledOnce();
    expect(result.session).toMatchObject({
      origin: "live",
      continuationSourceSessionId: source.id,
      leadAgentId: result.agents[0]!.id,
    });
    expect(result.agents[0]).toMatchObject({ backend: "codex", model: "gpt-5-resolved" });
    const turns = h.store.turns.list(result.session.id);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ role: "system", status: "done", agentId: null });
    expect(turns[0]!.speakerLabel).toBe("capygen:imported-reference");
    const blocks = h.store.blocks.listByTurn(turns[0]!.id);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "text", text: reference.text });
    expect(Buffer.byteLength(reference.text, "utf8")).toBeLessThanOrEqual(6_000);
    expect(h.store.turns.hasStreaming(result.session.id)).toBe(false);
    expect(h.eventsOn("session.updated").at(-1)).toEqual(result.session);
    expect(h.eventsOn("agents.updated").at(-1)).toEqual({
      sessionId: result.session.id,
      agents: result.agents,
    });
  });

  it("wires continuation through the central IPC map with model materialization and credential refusal", async () => {
    h.store.globalSettings.patch({ backends: { api: { provider: "openai" } } });
    const context = createIpcContext({
      store: h.store,
      broadcast: h.broadcast,
      log: h.log,
      pickDirectory: async () => null,
      appInfo: () => ({
        name: "capygen",
        version: "0.1.0",
        electron: "44",
        chrome: "1",
        node: "24",
        platform: "win32",
        userDataDir: h.dir,
        logFile: path.join(h.dir, "capygen.log"),
        dbFile: h.store.db.file,
      }),
      integrations: { home: h.dir, env: {} },
      imports: {
        staging,
        ownerId: () => owner,
        isOwnerAlive: () => true,
        pickFile,
      },
    });
    try {
      const source = h.store.imports.commit({ projectId: h.projectId, snapshot: snapshot() }).session;
      const dispatch = vi.spyOn(context.engine, "dispatch");
      expect(() => context.handlers["chat.send"]({ sessionId: source.id, text: "Do not execute", agentId: null, attachments: [] })).toThrow(/read-only/);
      expect(dispatch).not.toHaveBeenCalled();
      const continued = await context.handlers["imports.continue"]({
        sessionId: source.id,
        projectId: h.projectId,
        agent: { name: "api", backend: "api", model: "gpt-5.2", role: "lead", config: null },
      });
      expect(continued.agents[0]).toMatchObject({
        backend: "api",
        model: "gpt-5.2",
        config: { api: { provider: "openai" } },
      });

      const before = h.store.sessions.list({ includeArchived: true }).length;
      expect(() =>
        context.handlers["imports.continue"]({
          sessionId: source.id,
          projectId: h.projectId,
          agent: {
            name: "unsafe",
            backend: "api",
            model: "gpt-5.2",
            role: "lead",
            config: {
              api: {
                provider: "openai",
                mcpServers: { private: { url: "https://example.test", headers: { Authorization: "secret" } } },
              },
            },
          },
        }),
      ).toThrow(/MCP credentials.*Settings/i);
      expect(h.store.sessions.list({ includeArchived: true })).toHaveLength(before);
    } finally {
      await context.dispose();
    }
  });
});
