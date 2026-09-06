/**
 * **Block parity** (PLAN.md Phase 3, SPEC R6): for each backend, a recorded
 * `EngineEvent` stream is run through the *real* session runner and real IPC
 * handlers against a real temp database, and the persisted rows must cover
 * every block kind that backend is on the hook for.
 *
 * The expectation is not written here. It comes from
 * `BACKEND_BLOCK_PARITY` in `@capygen/shared`, which lists, per backend, the
 * applicable kinds and — for the rest — the reason that backend can never
 * produce them. So adding a kind to `BLOCK_KINDS` fails this suite until the
 * table has an answer for all three backends, and a harness that quietly stops
 * emitting a kind fails it too.
 *
 * The renderer half of the same contract is
 * `apps/renderer/src/components/blocks/blockParity.test.tsx`.
 *
 * What is faked and what is not:
 *   - **not faked**: the runner, `persist.ts`, the handlers, SQLite, the zod
 *     re-parse on every row, `maybeOpenWidget`'s detect→open→upsert path, and
 *     the permission/question/elicitation round-trip through `ipc.handlers`;
 *   - **faked**: the backend itself. A harness's own event stream is proved
 *     against its backend elsewhere (`packages/engine/test/codexHarness.test.ts`
 *     replays recorded app-server frames; `api.test.ts` a mocked provider), and
 *     replaying those here would test the harnesses twice and the runner once.
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
  PermissionAnswer,
} from "@capygen/engine";
import {
  BACKEND_BLOCK_PARITY,
  BLOCK_KINDS,
  missingBlockParityKinds,
  parseInvokeArgs,
  parseInvokeResult,
  type Backend,
  type Block,
  type BlockKind,
  type EventChannel,
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

// ---------------------------------------------------------------------------
// the fake backend
// ---------------------------------------------------------------------------

class ScriptedHarness implements Harness {
  events = new AsyncQueue<EngineEvent>();
  answered: { requestId: string; value: unknown }[] = [];

  constructor(readonly backend: Backend) {}

  async start(_session: HarnessSession, _agent: HarnessAgent): Promise<void> {}

  send(): AsyncIterable<EngineEvent> {
    this.events = new AsyncQueue<EngineEvent>();
    return this.events;
  }

  async interrupt(): Promise<boolean> {
    this.events.push({ type: "turn", status: "interrupted" });
    this.events.close();
    return true;
  }

  listCommands(): SlashCommand[] {
    return [];
  }

  capabilities(): HarnessCapabilities {
    return {
      streamingDeltas: true,
      permissions: true,
      questions: true,
      subagents: this.backend === "claude",
      resume: true,
      interrupt: true,
      slashCommands: this.backend !== "api",
    };
  }

  answerPermission(requestId: string, answer: PermissionAnswer): boolean {
    this.answered.push({ requestId, value: answer });
    return true;
  }

  answerQuestion(requestId: string, answers: Record<string, string>): boolean {
    this.answered.push({ requestId, value: answers });
    return true;
  }

  answerElicitation(requestId: string, answers: Record<string, unknown> | null): boolean {
    this.answered.push({ requestId, value: answers });
    return true;
  }

  backendSessionId(): string | null {
    return null;
  }

  async dispose(): Promise<void> {
    this.events.push({ type: "turn", status: "interrupted" });
    this.events.close();
  }
}

/**
 * The stream one turn of each backend produces, kind by kind. Every entry is
 * shaped like the real harness's own output — Claude's `Bash`/`Read`, Codex's
 * `shell`/`apply_patch`, the API loop's own tool names — because the point is
 * that the *runner* stores and the *renderer* draws whatever any of them emits,
 * not that they emit the same thing.
 *
 * `widget` is deliberately absent from the Claude and API streams: neither
 * harness emits one. Their widget arrives from `SessionRunner.maybeOpenWidget`,
 * which asks the widget host about a finished `mcp__…` tool call — the path the
 * `widgets` dependency below exercises for real.
 */
function parityStream(backend: Backend): EngineEvent[] {
  // One MCP tool call, named the way every backend names one (`mcp__<server>__
  // <tool>` — the convention `maybeOpenWidget` keys on).
  const mcpTool = { name: "mcp__capyfixture__show_card", server: "capyfixture" };

  const events: EngineEvent[] = [
    { type: "block", key: "msg:1", patch: { kind: "text", text: "Working on it." } },
    {
      type: "block",
      key: "think:1",
      patch: { kind: "thinking", text: "The file is small; read it whole." },
    },
    {
      type: "block",
      key: "tool:1",
      patch: {
        kind: "tool_call",
        name: backend === "codex" ? "shell" : "Bash",
        family: "bash",
        input: { command: "echo capy" },
        output: "capy\n",
        status: "success",
        toolUseId: "call_bash",
      },
    },
    {
      type: "block",
      key: "tool:2",
      patch: {
        kind: "tool_call",
        name: backend === "codex" ? "apply_patch" : "Edit",
        family: "edit",
        input: { path: "notes.md" },
        status: "success",
        toolUseId: "call_edit",
      },
    },
    {
      type: "block",
      key: "diff:1",
      patch: {
        kind: "diff",
        path: "notes.md",
        patch: "--- a/notes.md\n+++ b/notes.md\n@@\n-old\n+new\n",
        additions: 1,
        deletions: 1,
      },
    },
    {
      type: "block",
      key: "tool:mcp",
      patch: {
        kind: "tool_call",
        name: mcpTool.name,
        family: "mcp",
        serverName: mcpTool.server,
        input: { title: "Hello" },
        output: { content: [{ type: "text", text: "shown" }] },
        status: "success",
        toolUseId: "call_mcp",
      },
    },
    {
      type: "block",
      key: "permission:1",
      patch: {
        kind: "permission",
        request: {
          requestId: "req_perm",
          toolName: backend === "codex" ? "shell" : "Bash",
          input: { command: "rm -rf build" },
          suggestions: [],
        },
        decision: null,
        title: "Run a shell command",
      },
    },
    { type: "permission", requestId: "req_perm", key: "permission:1", request: {
      requestId: "req_perm",
      toolName: backend === "codex" ? "shell" : "Bash",
      input: { command: "rm -rf build" },
      suggestions: [],
    } },
    {
      type: "block",
      key: "question:1",
      patch: {
        kind: "question",
        requestId: "req_q",
        questions: [
          {
            question: "Which one?",
            header: "Pick",
            multiSelect: false,
            options: [{ label: "A" }, { label: "B" }],
          },
        ],
        answers: null,
        allowOther: true,
      },
    },
    {
      type: "question",
      requestId: "req_q",
      key: "question:1",
      questions: [
        {
          question: "Which one?",
          header: "Pick",
          multiSelect: false,
          options: [{ label: "A" }, { label: "B" }],
        },
      ],
    },
    { type: "block", key: "error:1", patch: { kind: "error", message: "the tool refused" } },
    {
      type: "block",
      key: "usage:1",
      patch: {
        kind: "usage",
        model: "m",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 2,
          cacheCreationTokens: 0,
          costUsd: 0.001,
        },
      },
    },
    {
      type: "usage",
      backend,
      model: "m",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 2,
        cacheCreationTokens: 0,
        costUsd: 0.001,
      },
      byModel: {},
    },
  ];

  if (BACKEND_BLOCK_PARITY[backend].applicable.includes("subagent")) {
    events.push({
      type: "block",
      key: "task:1",
      patch: {
        kind: "subagent",
        agentId: null,
        name: "explorer",
        backend,
        model: "m",
        description: "read the tree",
        status: "done",
      },
    });
  }

  if (BACKEND_BLOCK_PARITY[backend].applicable.includes("elicitation")) {
    events.push(
      {
        type: "block",
        key: "elicit:1",
        patch: {
          kind: "elicitation",
          requestId: "req_elicit",
          title: "capyfixture",
          description: "Which workspace?",
          schema: { type: "object", properties: { workspace: { type: "string" } } },
          answers: null,
          status: "pending",
        },
      },
      {
        type: "elicitation",
        requestId: "req_elicit",
        key: "elicit:1",
        title: "capyfixture",
        description: "Which workspace?",
        schema: { type: "object", properties: { workspace: { type: "string" } } },
      },
    );
  }

  // Codex reads the widget's `ui://` URI straight off the app-server item, so
  // its harness emits the block itself; Claude and the API loop get theirs
  // from the widget host, driven by the `mcp__…` tool_call above.
  if (backend === "codex") {
    events.push({
      type: "block",
      key: "widget:1",
      patch: {
        kind: "widget",
        toolCallId: "call_mcp",
        serverName: "capyfixture",
        toolName: "show_card",
        resourceUri: "ui://capyfixture/card.html",
        html: "<p>hi</p>",
        htmlStatus: "ready",
        toolInput: { title: "Hello" },
        toolResult: { content: [{ type: "text", text: "shown" }] },
        meta: null,
      },
    });
  }

  return events;
}

/**
 * A widget host that says yes to the one MCP tool in the stream. Only `detect`
 * and `open` are reachable from the runner; the rest of `WidgetHostHandlers` is
 * the renderer-facing surface and is covered by `test/widgets.test.ts`.
 */
function fakeWidgetHost(): WidgetHostHandlers {
  const partial = {
    detect: async (call: { toolName: string }) =>
      call.toolName === "mcp__capyfixture__show_card"
        ? { serverName: "capyfixture", toolName: "show_card", resourceUri: "ui://capyfixture/card.html" }
        : null,
    open: async (input: { toolCallId: string; toolInput: unknown }) => ({
      state: {},
      patch: {
        kind: "widget" as const,
        toolCallId: input.toolCallId,
        serverName: "capyfixture",
        toolName: "show_card",
        resourceUri: "ui://capyfixture/card.html",
        html: "<p>hi</p>",
        htmlStatus: "ready" as const,
        toolInput: input.toolInput,
        toolResult: null,
        meta: null,
      },
    }),
  };
  return partial as unknown as WidgetHostHandlers;
}

// ---------------------------------------------------------------------------
// rig
// ---------------------------------------------------------------------------

let dir: string;
let store: CapygenStore;
let ipc: IpcContext | null;
let harness: ScriptedHarness;
let events: { channel: EventChannel; payload: unknown }[];

async function call<C extends InvokeChannel>(channel: C, raw: unknown): Promise<unknown> {
  const args = parseInvokeArgs(channel, raw);
  if (!ipc) throw new Error("call() before open(): no IPC context in this test");
  const handler = ipc.handlers[channel] as (a: unknown) => unknown;
  return parseInvokeResult(channel, await handler(args));
}

async function open(backend: Backend): Promise<void> {
  await ipc?.dispose();
  harness = new ScriptedHarness(backend);
  ipc = createIpcContext({
    store,
    broadcast: (channel, payload) => events.push({ channel, payload }),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    widgets: fakeWidgetHost(),
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

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-parity-"));
  store = openStore(path.join(dir, "capygen.db"), { migrationsDir: MIGRATIONS_DIR });
  events = [];
  ipc = null;
});

afterEach(async () => {
  await ipc?.dispose();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

interface ParityTurn {
  turnId: string;
  rows: Block[];
  /** Close the stream. Until it is called the cards are still answerable —
   *  the runner drops a request the moment its turn ends, exactly as a real
   *  stale card would be dropped. */
  finish(): Promise<void>;
}

async function runParityTurn(backend: Backend): Promise<ParityTurn> {
  await open(backend);
  const project = (await call("projects.pick", {})) as { id: string };
  const created = (await call("sessions.create", {
    projectId: project.id,
    agents: [{ name: backend, backend, model: "m", role: "lead", config: null }],
  })) as { session: { id: string } };
  const sessionId = created.session.id;
  const sent = (await call("chat.send", { sessionId, text: "go" })) as { agentTurnId: string };

  for (const event of parityStream(backend)) harness.events.push(event);

  const expected = BACKEND_BLOCK_PARITY[backend].applicable.length;
  await vi.waitFor(() =>
    expect(store.blocks.listByTurn(sent.agentTurnId).length).toBeGreaterThanOrEqual(expected),
  );
  return {
    turnId: sent.agentTurnId,
    rows: store.blocks.listByTurn(sent.agentTurnId),
    async finish() {
      harness.events.push({ type: "turn", status: "done" });
      harness.events.close();
      await vi.waitFor(() =>
        expect(store.turns.get(sent.agentTurnId)?.status).toBe("done"),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// the parity contract itself
// ---------------------------------------------------------------------------

describe("the parity table covers every block kind", () => {
  for (const backend of ["claude", "codex", "api"] as const) {
    it(`${backend}: no kind is left unexplained`, () => {
      // A kind that is neither claimed nor excused is the failure this whole
      // suite exists to catch — an omission nobody noticed.
      expect(missingBlockParityKinds(backend)).toEqual([]);
      for (const [kind, reason] of Object.entries(BACKEND_BLOCK_PARITY[backend].inapplicable)) {
        expect(BLOCK_KINDS).toContain(kind as BlockKind);
        expect(reason.length).toBeGreaterThan(20);
      }
    });
  }
});

describe("block parity — persisted rows", () => {
  for (const backend of ["claude", "codex", "api"] as const) {
    it(`${backend}: one turn produces every applicable block kind`, async () => {
      const turn = await runParityTurn(backend);
      await turn.finish();
      const rows = store.blocks.listByTurn(turn.turnId);
      const kinds = new Set(rows.map((b) => b.kind));
      const expected = BACKEND_BLOCK_PARITY[backend].applicable;

      const missing = expected.filter((kind) => !kinds.has(kind));
      expect(missing, `${backend} produced no ${missing.join(", ")} block`).toEqual([]);

      // …and nothing it is documented as unable to produce.
      const forbidden = Object.keys(BACKEND_BLOCK_PARITY[backend].inapplicable) as BlockKind[];
      expect(forbidden.filter((kind) => kinds.has(kind))).toEqual([]);

      // Rows survive the zod re-parse `blocks.upsert` does, and keep their
      // stream order — a transcript is an ordered thing, not a bag.
      expect(rows.map((b) => b.index)).toEqual(rows.map((_, i) => i));
    });
  }
});

describe("block parity — interaction cards reach the backend", () => {
  for (const backend of ["claude", "codex", "api"] as const) {
    it(`${backend}: permission, question${
      BACKEND_BLOCK_PARITY[backend].applicable.includes("elicitation") ? " and elicitation" : ""
    } answers route to the harness that asked`, async () => {
      const { rows, finish } = await runParityTurn(backend);

      expect(await call("permission.answer", { requestId: "req_perm", decision: "allow_always" }))
        .toEqual({ ok: true });
      expect(
        await call("question.answer", {
          requestId: "req_q",
          answers: { "Which one?": "A" },
        }),
      ).toEqual({ ok: true });

      const decided = rows
        .map((b) => store.blocks.get(b.id))
        .find((b) => b?.kind === "permission");
      expect(decided).toMatchObject({
        decision: { behavior: "allow_always", scope: "always" },
      });
      // The harness only ever hears "allow" — "always" is capygen's own record.
      expect(harness.answered[0]).toMatchObject({
        requestId: "req_perm",
        value: { behavior: "allow" },
      });

      if (BACKEND_BLOCK_PARITY[backend].applicable.includes("elicitation")) {
        const card = rows.find((b) => b.kind === "elicitation")!;
        expect(
          await call("elicitation.answer", {
            sessionId: card.sessionId,
            turnId: card.turnId,
            blockId: card.id,
            answers: { workspace: "capygen" },
          }),
        ).toEqual({ ok: true });
        expect(store.blocks.get(card.id)).toMatchObject({
          status: "accepted",
          answers: { workspace: "capygen" },
        });
        expect(harness.answered.at(-1)).toMatchObject({
          requestId: "req_elicit",
          value: { workspace: "capygen" },
        });
      }

      // Once the turn is over the same click reaches nobody, and says so
      // rather than marking the card answered.
      await finish();
      expect(await call("permission.answer", { requestId: "req_perm", decision: "deny" })).toEqual({
        ok: false,
      });
    });
  }
});

describe("block parity — usage accounting", () => {
  it("records one usage_events row per turn, tagged with the backend", async () => {
    for (const backend of ["claude", "codex", "api"] as const) {
      const { turnId, finish } = await runParityTurn(backend);
      await finish();
      const recorded = store.usage
        .listBySession(store.turns.get(turnId)!.sessionId)
        .filter((u) => u.turnId === turnId);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({ backend, model: "m", inputTokens: 10 });
    }
  });
});
