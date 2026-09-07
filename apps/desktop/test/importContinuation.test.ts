import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openStore, type CapygenStore } from "@capygen/db";
import {
  buildImportReference,
  IMPORTED_REFERENCE_SPEAKER_LABEL,
  type HarnessAgent,
  type HarnessSession,
} from "@capygen/engine";
import { newId, type Backend, type TextBlock } from "@capygen/shared";
import { loadApiHistory } from "../src/engine/history.js";
import { createRoundTable } from "../src/engine/RoundTable.js";
import { createSessionRunner } from "../src/engine/SessionRunner.js";

const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../../packages/db/migrations", import.meta.url),
);

let dir: string;
let store: CapygenStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-import-continuation-"));
  store = openStore(path.join(dir, "capygen.db"), { migrationsDir: MIGRATIONS_DIR });
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function continuedSession(backend: Backend): { sessionId: string; agentId: string; reference: string } {
  const project = store.projects.upsertByPath({ path: path.join(dir, backend) });
  const created = store.sessions.create({
    projectId: project.id,
    mode: "solo",
    title: "Continuation",
    agents: [{ name: "capy", backend, model: "model", role: "lead", config: null }],
  });
  const entry = {
    kind: "message" as const,
    speaker: "assistant" as const,
    label: "assistant",
    text: "historical context ".repeat(240),
    index: 0,
    at: null,
    truncated: false,
  };
  const reference = buildImportReference([entry]).text;
  expect(reference.length).toBeGreaterThan(1_500);
  const turn = store.turns.create({
    sessionId: created.session.id,
    role: "system",
    status: "done",
    speakerLabel: IMPORTED_REFERENCE_SPEAKER_LABEL,
  });
  const ts = Date.now();
  store.blocks.upsert({
    id: newId("block"),
    turnId: turn.id,
    sessionId: created.session.id,
    kind: "text",
    index: 0,
    text: reference,
    createdAt: ts,
    updatedAt: ts,
  } satisfies TextBlock);
  return { sessionId: created.session.id, agentId: created.agents[0]!.id, reference };
}

describe("imported continuation delivery", () => {
  it("refuses sends to imported artifacts before creating any turn or block", () => {
    const project = store.projects.upsertByPath({ path: path.join(dir, "source") });
    const imported = store.imports.commit({
      projectId: project.id,
      snapshot: {
        backend: "codex",
        format: "codex-rollout/test",
        nativeId: "native-read-only",
        title: "Read-only source",
        sourcePath: path.join(dir, "source.jsonl"),
        sourceBytes: 1,
        sourceSha256: "a".repeat(64),
        cwd: dir,
        startedAt: null,
        endedAt: null,
        entries: [],
        counts: {
          records: 0,
          entries: 0,
          messages: 0,
          thinking: 0,
          activities: 0,
          notices: 0,
          droppedConfiguration: 0,
          unknownRecords: 0,
          echoedEvents: 0,
          truncatedTexts: 0,
          normalizedBytes: 0,
        },
        unknownTypes: [],
        warnings: [],
        complete: true,
      },
    }).session;
    const engine = createSessionRunner({
      store,
      broadcast: () => {},
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(() => engine.dispatch({ sessionId: imported.id, text: "mutate source" })).toThrow(
      /read-only/i,
    );
    const synthetic = store.turns.create({
      sessionId: imported.id,
      role: "agent",
      status: "streaming",
    });
    expect(() => engine.send({
      sessionId: imported.id,
      turnId: synthetic.id,
      text: "mutate source",
    })).toThrow(/read-only/i);
    expect(store.turns.list(imported.id)).toEqual([synthetic]);
    expect(store.blocks.listBySession(imported.id)).toEqual([]);
    expect(store.sessions.get(imported.id)?.status).toBe("idle");
    void engine.dispose();
  });

  it("replays the marker as exact user-priority API history before null-agent fallback", () => {
    const continued = continuedSession("api");
    const session: HarnessSession = { sessionId: continued.sessionId, projectPath: dir };
    const agent: HarnessAgent = {
      agentId: continued.agentId,
      name: "capy",
      backend: "api",
      model: "model",
    };

    expect(loadApiHistory(store, session, agent)).toEqual([
      { role: "user", content: [{ type: "text", text: continued.reference }] },
    ]);
  });

  it("delivers the exact bounded reference to a native backend once, outside the ordinary delta clamp", async () => {
    const continued = continuedSession("claude");
    const prompts: string[] = [];
    const table = createRoundTable({
      store,
      broadcast: () => {},
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      runTurn: async (args) => {
        prompts.push(args.text);
        store.turns.setStatus(args.turnId, "done");
        store.sessions.setStatus(args.sessionId, "idle");
        return { status: "done" };
      },
    });

    table.dispatch({ sessionId: continued.sessionId, text: "new task" });
    await table.settled();
    expect(prompts[0]).toBe(`${continued.reference}\n\nnew task`);

    table.dispatch({ sessionId: continued.sessionId, text: "follow up" });
    await table.settled();
    expect(prompts[1]).toBe("follow up");
  });

  it("does not duplicate the API reference in the round-table prompt that follows loaded history", async () => {
    const continued = continuedSession("api");
    const prompts: string[] = [];
    const table = createRoundTable({
      store,
      broadcast: () => {},
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      runTurn: async (args) => {
        prompts.push(args.text);
        return { status: "done" };
      },
    });
    table.dispatch({ sessionId: continued.sessionId, text: "new task" });
    await table.settled();
    expect(prompts).toEqual(["new task"]);
  });
});
