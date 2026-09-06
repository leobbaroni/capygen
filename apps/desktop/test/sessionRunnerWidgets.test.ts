/**
 * Who resolves an MCP App widget, and what happens to the tool card when one
 * does (SPEC R31).
 *
 * Three behaviours are pinned here, all of them review findings:
 *
 *  1. a harness that emits its own `widget` block (Codex reads the `ui://`
 *     off `mcpToolCall.appContext`; the `api` loop off the tool's `_meta`) has
 *     its document fetched — `widgets.open()` used to be reachable only from
 *     `maybeOpenWidget`, whose trigger was a tool name starting with `mcp__`,
 *     which no Codex tool_call ever is, so those widgets span forever;
 *  2. the runner does **not** run a second, independent `detect()` against the
 *     same server for a call the harness already claimed;
 *  3. once the widget renders, the tool_call row is flagged `hasWidget` so the
 *     same payload is not shown twice.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openStore, type CapygenStore } from "@capygen/db";
import { AsyncQueue } from "@capygen/engine";
import type {
  EngineEvent,
  Harness,
  HarnessAgent,
  HarnessCapabilities,
  HarnessSession,
} from "@capygen/engine";
import {
  parseInvokeArgs,
  parseInvokeResult,
  type Block,
  type InvokeChannel,
  type SlashCommand,
} from "@capygen/shared";
import { createIpcContext, type IpcContext } from "../src/ipc/handlers.js";
import { createSessionRunner } from "../src/engine/SessionRunner.js";
import type { EngineDeps } from "../src/engine/types.js";
import type { WidgetHostHandlers } from "../src/ipc/widgets.js";

const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../../packages/db/migrations", import.meta.url),
);

/** A harness whose whole job is to emit the events the test scripts. */
class ScriptedHarness implements Harness {
  readonly backend = "codex" as const;
  events = new AsyncQueue<EngineEvent>();
  script: EngineEvent[] = [];

  async start(_s: HarnessSession, _a: HarnessAgent): Promise<void> {}
  send(): AsyncIterable<EngineEvent> {
    this.events = new AsyncQueue<EngineEvent>();
    for (const event of this.script) this.events.push(event);
    this.events.push({ type: "turn", status: "done" });
    this.events.close();
    return this.events;
  }
  async interrupt(): Promise<boolean> {
    return false;
  }
  listCommands(): SlashCommand[] {
    return [];
  }
  capabilities(): HarnessCapabilities {
    return {
      streamingDeltas: true,
      permissions: true,
      questions: true,
      subagents: false,
      resume: true,
      interrupt: true,
      slashCommands: true,
    };
  }
  answerPermission(): boolean {
    return false;
  }
  answerQuestion(): boolean {
    return false;
  }
  backendSessionId(): string | null {
    return null;
  }
  async dispose(): Promise<void> {}
}

interface HostCalls {
  detect: string[];
  open: string[];
}

function fakeWidgetHost(calls: HostCalls, htmlStatus: "ready" | "unavailable" = "ready"): WidgetHostHandlers {
  const partial = {
    detect: async (call: { toolName: string }) => {
      calls.detect.push(call.toolName);
      return call.toolName.startsWith("mcp__")
        ? { serverName: "capyfixture", toolName: "show_card", resourceUri: "ui://x/card.html" }
        : null;
    },
    open: async (input: { toolCallId: string; toolInput: unknown; resourceUri?: string }) => {
      calls.open.push(input.toolCallId);
      return {
        state: {},
        patch: {
          kind: "widget" as const,
          toolCallId: input.toolCallId,
          serverName: "capyfixture",
          toolName: "show_card",
          resourceUri: input.resourceUri ?? "ui://x/card.html",
          html: htmlStatus === "ready" ? "<p>hi</p>" : null,
          htmlStatus,
          toolInput: input.toolInput,
          toolResult: null,
          meta: null,
        },
      };
    },
  };
  return partial as unknown as WidgetHostHandlers;
}

let dir: string;
let store: CapygenStore;
let ipc: IpcContext;
let harness: ScriptedHarness;
let calls: HostCalls;

async function call<C extends InvokeChannel>(channel: C, raw: unknown): Promise<unknown> {
  const args = parseInvokeArgs(channel, raw);
  const handler = ipc.handlers[channel] as (a: unknown) => unknown;
  return parseInvokeResult(channel, await handler(args));
}

function open(host: WidgetHostHandlers): void {
  ipc = createIpcContext({
    store,
    broadcast: () => {},
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    widgets: host,
    makeEngine: (deps: EngineDeps) =>
      createSessionRunner({ ...deps, makeHarness: () => harness }),
    pickDirectory: async () => path.join(dir, "project"),
    appInfo: () => ({
      name: "capygen",
      version: "0.1.0",
      electron: "44.2.0",
      chrome: "1",
      node: "24.20.0",
      platform: "win32",
      userDataDir: dir,
      logFile: path.join(dir, "log"),
      dbFile: store.db.file,
    }),
  });
}

async function runTurn(): Promise<Block[]> {
  const project = (await call("projects.pick", {})) as { id: string };
  const created = (await call("sessions.create", {
    projectId: project.id,
    agents: [{ name: "codex", backend: "codex", model: "gpt-5.5", role: "lead" }],
  })) as { session: { id: string } };
  const sessionId = created.session.id;
  await call("chat.send", { sessionId, text: "go" });
  // Resolution is fire-and-forget by design (a turn never waits on an MCP
  // server), so wait for the widget row to reach a settled status.
  await vi.waitFor(() =>
    expect(
      store.blocks
        .listBySession(sessionId)
        .some((b) => b.kind === "widget" && b.htmlStatus !== "pending"),
    ).toBe(true),
  );
  return store.blocks.listBySession(sessionId);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-widgets-"));
  store = openStore(path.join(dir, "capygen.db"), { migrationsDir: MIGRATIONS_DIR });
  harness = new ScriptedHarness();
  calls = { detect: [], open: [] };
});

afterEach(async () => {
  await ipc.dispose();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Codex names a tool_call after the raw tool, never `mcp__server__tool`. */
const CODEX_TOOL_CALL: EngineEvent = {
  type: "block",
  key: "tool:call_1",
  patch: {
    kind: "tool_call",
    name: "show_card",
    family: "mcp",
    serverName: "capyfixture",
    input: { title: "Hello" },
    output: { content: [{ type: "text", text: "shown" }] },
    status: "success",
    toolUseId: "call_1",
  },
};

const CODEX_WIDGET: EngineEvent = {
  type: "block",
  key: "widget:call_1",
  patch: {
    kind: "widget",
    toolCallId: "call_1",
    serverName: "capyfixture",
    toolName: "show_card",
    resourceUri: "ui://capyfixture/card.html",
    html: null,
    htmlStatus: "pending",
    toolInput: { title: "Hello" },
    toolResult: null,
    meta: null,
  },
};

describe("a widget the harness announced itself", () => {
  it("fetches its document instead of leaving the card pending forever", async () => {
    harness.script = [CODEX_TOOL_CALL, CODEX_WIDGET];
    open(fakeWidgetHost(calls));
    const blocks = await runTurn();

    const widget = blocks.find((b) => b.kind === "widget");
    expect(widget).toMatchObject({ htmlStatus: "ready", html: "<p>hi</p>" });
    // Resolved through the URI the harness already stated, not a re-detection.
    expect(calls.open).toEqual(["call_1"]);
    expect(widget).toMatchObject({ resourceUri: "ui://capyfixture/card.html" });
  });

  it("never runs a second detection for a call the harness already claimed", async () => {
    harness.script = [
      {
        ...CODEX_TOOL_CALL,
        patch: { ...CODEX_TOOL_CALL.patch, name: "mcp__capyfixture__show_card" },
      } as EngineEvent,
      CODEX_WIDGET,
    ];
    open(fakeWidgetHost(calls));
    const blocks = await runTurn();

    // One widget row, one open, and — whatever `detect` did — the harness's
    // own pending row was never abandoned.
    expect(blocks.filter((b) => b.kind === "widget")).toHaveLength(1);
    expect(calls.open).toEqual(["call_1"]);
    expect(blocks.find((b) => b.kind === "widget")).toMatchObject({ htmlStatus: "ready" });
  });

  it("hides the tool card once the widget renders, and keeps it when it cannot", async () => {
    harness.script = [CODEX_TOOL_CALL, CODEX_WIDGET];
    open(fakeWidgetHost(calls));
    let blocks = await runTurn();
    await vi.waitFor(() =>
      expect(store.blocks.get(blocks.find((b) => b.kind === "tool_call")!.id)).toMatchObject({
        hasWidget: true,
      }),
    );

    // A widget that could not be read leaves the tool card standing (R31's
    // own fallback), so the result is never invisible.
    await ipc.dispose();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-widgets-"));
    store = openStore(path.join(dir, "capygen.db"), { migrationsDir: MIGRATIONS_DIR });
    harness = new ScriptedHarness();
    harness.script = [CODEX_TOOL_CALL, CODEX_WIDGET];
    calls = { detect: [], open: [] };
    open(fakeWidgetHost(calls, "unavailable"));
    blocks = await runTurn();
    expect(blocks.find((b) => b.kind === "tool_call")).not.toMatchObject({ hasWidget: true });
  });
});

describe("a widget only the host knows about (Claude: no tool _meta on the wire)", () => {
  it("still detects and opens one for an mcp__ tool call", async () => {
    harness.script = [
      {
        type: "block",
        key: "tool:call_2",
        patch: {
          kind: "tool_call",
          name: "mcp__capyfixture__show_card",
          family: "mcp",
          input: { title: "Hello" },
          output: { content: [] },
          status: "success",
          toolUseId: "call_2",
        },
      },
    ];
    open(fakeWidgetHost(calls));
    const blocks = await runTurn();
    expect(calls.detect).toEqual(["mcp__capyfixture__show_card"]);
    expect(blocks.find((b) => b.kind === "widget")).toMatchObject({ htmlStatus: "ready" });
  });
});
