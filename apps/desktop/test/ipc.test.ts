/**
 * The IPC handlers against a real temp database — no Electron. This is where the
 * turn/block lifecycle is pinned: what `chat.send` writes, what it broadcasts,
 * and that a relaunch can rebuild the transcript from the rows alone.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openStore, type CapygenStore } from "@capygen/db";
import {
  parseInvokeArgs,
  parseInvokeResult,
  type EventChannel,
  type InvokeChannel,
} from "@capygen/shared";
import { createIpcContext, type IpcContext } from "../src/ipc/handlers.js";

const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../../packages/db/migrations", import.meta.url),
);

let dir: string;
let store: CapygenStore;
let ipc: IpcContext;
let events: { channel: EventChannel; payload: unknown }[];
let picked: string | null;

/** Call a handler the way main.ts does: parse in, parse out. */
async function call<C extends InvokeChannel>(channel: C, raw: unknown): Promise<unknown> {
  const args = parseInvokeArgs(channel, raw);
  const handler = ipc.handlers[channel] as (a: unknown) => unknown;
  return parseInvokeResult(channel, await handler(args));
}

function eventsOn(channel: EventChannel): unknown[] {
  return events.filter((e) => e.channel === channel).map((e) => e.payload);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-ipc-"));
  store = openStore(path.join(dir, "capygen.db"), { migrationsDir: MIGRATIONS_DIR });
  events = [];
  picked = path.join(dir, "project");
  ipc = createIpcContext({
    store,
    broadcast: (channel, payload) => events.push({ channel, payload }),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    pickDirectory: async () => picked,
    appInfo: () => ({
      name: "capygen",
      version: "0.1.0",
      electron: "44.2.0",
      chrome: "1",
      node: "24.20.0",
      platform: "win32",
      userDataDir: dir,
      logFile: path.join(dir, "logs", "capygen-desktop.log"),
      dbFile: store.db.file,
    }),
  });
});

afterEach(() => {
  ipc.dispose();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function newSession(): Promise<{ sessionId: string }> {
  const project = (await call("projects.pick", {})) as { id: string };
  const created = (await call("sessions.create", { projectId: project.id })) as {
    session: { id: string };
  };
  return { sessionId: created.session.id };
}

describe("projects", () => {
  it("returns null when the picker is cancelled and stores nothing", async () => {
    picked = null;
    expect(await call("projects.pick", {})).toBeNull();
    expect(await call("projects.list", {})).toEqual([]);
  });

  it("registers the picked directory once", async () => {
    const first = (await call("projects.pick", {})) as { id: string; name: string };
    const second = (await call("projects.pick", {})) as { id: string };
    expect(second.id).toBe(first.id);
    expect(first.name).toBe("project");
    expect(await call("projects.list", {})).toHaveLength(1);
  });
});

describe("sessions", () => {
  it("creates a default lead agent from settings when none is supplied", async () => {
    const project = (await call("projects.pick", {})) as { id: string };
    const created = (await call("sessions.create", { projectId: project.id })) as {
      session: { id: string; mode: string; leadAgentId: string };
      agents: { id: string; backend: string; model: string }[];
    };
    expect(created.session.mode).toBe("solo");
    expect(created.agents).toHaveLength(1);
    expect(created.agents[0]!.backend).toBe("claude");
    expect(created.agents[0]!.model).toBe("claude-opus-4-5");
    expect(created.session.leadAgentId).toBe(created.agents[0]!.id);
    expect(eventsOn("session.updated")).toHaveLength(1);
  });

  it("refuses a session for a project that does not exist", async () => {
    await expect(call("sessions.create", { projectId: "prj_nope" })).rejects.toThrow(
      /unknown project/,
    );
  });

  it("archives and hides from the default list", async () => {
    const { sessionId } = await newSession();
    await call("sessions.archive", { sessionId, archived: true });
    expect(await call("sessions.list", {})).toHaveLength(0);
    expect(await call("sessions.list", { includeArchived: true })).toHaveLength(1);
  });
});

describe("chat.send (the Phase 2 echo path)", () => {
  it("stores the user turn, opens the agent turn, then echoes", async () => {
    const { sessionId } = await newSession();
    const sent = (await call("chat.send", { sessionId, text: "hello" })) as {
      userTurnId: string;
      agentTurnId: string;
    };

    // Immediately: the user block is stored and the agent turn is streaming.
    const early = eventsOn("chat.turnStatus") as { turnId: string; status: string }[];
    expect(early).toEqual([
      { sessionId, turnId: sent.userTurnId, status: "done" },
      { sessionId, turnId: sent.agentTurnId, status: "streaming" },
    ]);
    expect(store.sessions.get(sessionId)?.status).toBe("running");

    await vi.waitFor(() => {
      expect(store.turns.get(sent.agentTurnId)?.status).toBe("done");
    });

    const blocks = eventsOn("chat.block") as { kind: string; text?: string }[];
    expect(blocks.map((b) => b.text)).toEqual(["hello", "echo: hello"]);
    expect(store.sessions.get(sessionId)?.status).toBe("idle");
    expect(
      (eventsOn("chat.turnStatus") as { status: string }[]).at(-1)?.status,
    ).toBe("done");
  });

  it("links the agent turn to the user turn and bumps the hop index", async () => {
    const { sessionId } = await newSession();
    const sent = (await call("chat.send", { sessionId, text: "hi" })) as {
      userTurnId: string;
      agentTurnId: string;
    };
    const agentTurn = store.turns.get(sent.agentTurnId)!;
    expect(agentTurn.parentTurnId).toBe(sent.userTurnId);
    expect(agentTurn.hopIndex).toBe(1);
    expect(agentTurn.agentId).toBe(store.sessions.get(sessionId)!.leadAgentId);
  });

  it("rebuilds the whole transcript from the database (R15)", async () => {
    const { sessionId } = await newSession();
    await call("chat.send", { sessionId, text: "hello" });
    await vi.waitFor(() => {
      expect(eventsOn("chat.block")).toHaveLength(2);
    });

    const loaded = (await call("sessions.get", { sessionId })) as {
      turns: { role: string }[];
      blocks: { kind: string; text?: string }[];
      agents: unknown[];
    };
    expect(loaded.turns.map((t) => t.role)).toEqual(["user", "agent"]);
    expect(loaded.blocks.map((b) => b.text)).toEqual(["hello", "echo: hello"]);
    expect(loaded.agents).toHaveLength(1);

    const listed = (await call("turns.list", { sessionId })) as { blocks: unknown[] };
    expect(listed.blocks).toHaveLength(2);
  });

  it("interrupt stops the pending reply and marks the turn interrupted", async () => {
    const { sessionId } = await newSession();
    const sent = (await call("chat.send", { sessionId, text: "slow" })) as {
      agentTurnId: string;
    };
    expect(await call("chat.interrupt", { sessionId })).toEqual({ ok: true });
    expect(store.turns.get(sent.agentTurnId)?.status).toBe("interrupted");
    expect(store.sessions.get(sessionId)?.status).toBe("idle");

    await new Promise((r) => setTimeout(r, 400));
    const texts = (eventsOn("chat.block") as { text?: string }[]).map((b) => b.text);
    expect(texts).toEqual(["slow"]);

    expect(await call("chat.interrupt", { sessionId })).toEqual({ ok: false });
  });

  it("rejects a send to an unknown session", async () => {
    await expect(call("chat.send", { sessionId: "ses_nope", text: "x" })).rejects.toThrow(
      /unknown session/,
    );
  });
});

describe("permission and question answers", () => {
  it("records a permission decision on the block and re-broadcasts it", async () => {
    const { sessionId } = await newSession();
    const turn = store.turns.create({ sessionId, role: "agent" });
    const ts = Date.now();
    const block = store.blocks.upsert({
      id: "blk_perm",
      turnId: turn.id,
      sessionId,
      kind: "permission",
      index: 0,
      request: { requestId: "req_9", toolName: "Bash", input: { command: "rm -rf" }, suggestions: [] },
      decision: null,
      createdAt: ts,
      updatedAt: ts,
    });
    expect(block.kind).toBe("permission");

    expect(await call("permission.answer", { requestId: "req_9", behavior: "deny" })).toEqual({
      ok: true,
    });
    const saved = store.blocks.get("blk_perm");
    expect(saved?.kind === "permission" && saved.decision?.behavior).toBe("deny");
    expect(saved?.kind === "permission" && saved.decision?.scope).toBe("once");

    expect(await call("permission.answer", { requestId: "nope", behavior: "allow" })).toEqual({
      ok: false,
    });
  });

  it("records AskUserQuestion answers keyed by question text", async () => {
    const { sessionId } = await newSession();
    const turn = store.turns.create({ sessionId, role: "agent" });
    const ts = Date.now();
    store.blocks.upsert({
      id: "blk_q",
      turnId: turn.id,
      sessionId,
      kind: "question",
      index: 0,
      requestId: "req_q",
      questions: [
        { question: "Which backend?", multiSelect: false, options: [{ label: "Claude" }] },
      ],
      answers: null,
      createdAt: ts,
      updatedAt: ts,
    });

    await call("question.answer", {
      requestId: "req_q",
      answers: { "Which backend?": "Claude" },
    });
    const saved = store.blocks.get("blk_q");
    expect(saved?.kind === "question" && saved.answers).toEqual({
      "Which backend?": "Claude",
    });
  });
});

describe("settings, commands, version", () => {
  it("returns the defaults, patches, and persists", async () => {
    expect(await call("settings.get", {})).toMatchObject({ theme: "system", hopCap: 3 });
    expect(await call("settings.set", { theme: "dark" })).toMatchObject({ theme: "dark" });
    expect(await call("settings.get", {})).toMatchObject({ theme: "dark", hopCap: 3 });
  });

  it("lists the built-in slash commands (R14 baseline)", async () => {
    const commands = (await call("chat.listCommands", {})) as {
      name: string;
      source: string;
    }[];
    expect(commands.map((c) => c.name)).toContain("/compact");
    expect(commands.map((c) => c.name)).toContain("/cost");
    expect(commands.every((c) => c.source === "builtin")).toBe(true);
  });

  it("reports the runtime the shell is on", async () => {
    expect(await call("app.version", {})).toMatchObject({
      name: "capygen",
      platform: "win32",
    });
  });
});
