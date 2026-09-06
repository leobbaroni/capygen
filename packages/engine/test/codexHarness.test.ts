/**
 * The Codex harness against a fake `codex app-server`.
 *
 * Where a case is driven by **recorded** frames the fixture says so: the text
 * turn and the command-approval round trip replay
 * `test/fixtures/codex-frames.json`, which is the Phase 1 spike's
 * `docs/spikes/codex.raw.json` filtered to the server→client frames of the
 * `appserver-c` (text) and `appserver-d1` (approval) sessions, verbatim.
 *
 * The file-change, MCP-tool-call and usage cases have **no** recording — the
 * spike never triggered a patch, an MCP tool or an unredacted token count — so
 * their frames are built here from the generated bindings in
 * `docs/spikes/codex-app-server-schema/v0.153.4-ts` (`FileChangePatchUpdatedNotification`,
 * `ThreadItem`'s `mcpToolCall` variant, `ThreadTokenUsage`). That is a shape
 * claim, not an observation, and is called out in each test's name.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  CODEX_BUILTIN_COMMANDS,
  CodexHarness,
  commandDecision,
  countDiff,
  readCodexConfig,
} from "../src/codex/CodexHarness.js";
import { readCodexUsage, estimateCodexCost } from "../src/codex/pricing.js";
import { resolveBundledCodex, resolveCodexBinary } from "../src/codex/binary.js";
import type {
  EngineEvent,
  HarnessAgent,
  HarnessSession,
  PermissionAnswer,
} from "../src/harness.js";
import { createFakeAppServer, settle, type FakeFrame } from "./codexFakeAppServer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const RECORDED = JSON.parse(
  readFileSync(path.join(here, "fixtures", "codex-frames.json"), "utf8"),
) as { source: string; textTurn: FakeFrame[]; approvalTurn: FakeFrame[] };

/** The recorded response to request `id` in one of the recorded sessions. */
function recordedResult(frames: FakeFrame[], id: number): unknown {
  const frame = frames.find((f) => f.id === id && f.method === undefined);
  if (!frame) throw new Error(`no recorded response #${id}`);
  return frame.result;
}

/** The recorded notification frames, in order, optionally up to a method. */
function notifications(frames: FakeFrame[], stopBefore?: string): FakeFrame[] {
  const out: FakeFrame[] = [];
  for (const frame of frames) {
    if (frame.method === undefined) continue; // a response, replayed by method
    if (stopBefore && frame.method === stopBefore) break;
    if (frame.id !== undefined) continue; // a server request, sent with `ask`
    out.push(frame);
  }
  return out;
}

const TEXT_THREAD = recordedResult(RECORDED.textTurn, 2) as { thread: { id: string } };
const TEXT_TURN = recordedResult(RECORDED.textTurn, 3) as { turn: { id: string } };
const APPROVAL_THREAD = recordedResult(RECORDED.approvalTurn, 2) as { thread: { id: string } };
const APPROVAL_TURN = recordedResult(RECORDED.approvalTurn, 3) as { turn: { id: string } };

const SESSION: HarnessSession = {
  sessionId: "ses_1",
  projectPath: "C:\\Users\\TugaPlayz\\Desktop\\GITHUB\\capygen",
};
const AGENT: HarnessAgent = {
  agentId: "agt_1",
  name: "codex",
  backend: "codex",
  model: "gpt-5.5",
};

function drain(events: AsyncIterable<EngineEvent>): {
  events: EngineEvent[];
  done: Promise<void>;
} {
  const seen: EngineEvent[] = [];
  const done = (async () => {
    for await (const event of events) seen.push(event);
  })();
  return { events: seen, done };
}

function blocks(
  events: EngineEvent[],
  kind: string,
): { key: string; patch: Record<string, unknown> }[] {
  return events
    .filter((e): e is Extract<EngineEvent, { type: "block" }> => e.type === "block")
    .filter((e) => e.patch.kind === kind)
    .map((e) => ({ key: e.key, patch: e.patch as unknown as Record<string, unknown> }));
}

/** The last patch emitted for a block key — blocks are upserted, not appended. */
function latest(events: EngineEvent[], kind: string): Record<string, unknown> | undefined {
  const all = blocks(events, kind);
  return all.at(-1)?.patch;
}

interface Rig {
  server: ReturnType<typeof createFakeAppServer>;
  harness: CodexHarness;
}

function rig(
  thread: unknown,
  turn: unknown,
  extra: Record<string, (params: unknown) => unknown> = {},
  agent: Partial<HarnessAgent> = {},
): Rig {
  const server = createFakeAppServer({
    handlers: {
      initialize: () => ({ codexHome: "C:\\Users\\x\\.codex", platformFamily: "windows" }),
      "thread/start": () => thread,
      "thread/resume": () => thread,
      "turn/start": () => turn,
      "skills/list": () => ({ data: [] }),
      ...extra,
    },
  });
  const harness = new CodexHarness({
    transport: server.transport,
    requestTimeoutMs: 2_000,
    // A test never waits out the real 5 s grace: `interrupt()` arms this and
    // then only Codex's own `turn/completed` cancels it.
    interruptGraceMs: 10,
  });
  void harness.start(SESSION, { ...AGENT, ...agent });
  return { server, harness };
}

describe("CodexHarness — a text turn (recorded frames)", () => {
  it("replays the spike's pong turn into text blocks and a done turn", async () => {
    const { server, harness } = rig(TEXT_THREAD, TEXT_TURN);
    const turn = drain(harness.send({ turnId: "trn_1", text: "Reply with exactly the word pong." }));

    const started = await server.waitForRequest("turn/start");
    expect(started.params).toMatchObject({
      threadId: TEXT_THREAD.thread.id,
      input: [{ type: "text", text: "Reply with exactly the word pong.", text_elements: [] }],
    });

    server.replay(notifications(RECORDED.textTurn));
    await turn.done;

    // The user's own message item is dropped: capygen already has that row.
    expect(blocks(turn.events, "text").map((b) => b.patch.text)).toContain("pong");
    expect(turn.events.at(-1)).toEqual({ type: "turn", status: "done" });
    expect(harness.backendSessionId()).toBe(TEXT_THREAD.thread.id);

    const session = turn.events.find((e) => e.type === "session");
    expect(session).toMatchObject({
      backendSessionId: TEXT_THREAD.thread.id,
      model: "gpt-5.5",
    });
    await harness.dispose();
  });

  // From the live run: gpt-5.5 opened a `reasoning` item whose summary never
  // arrived, and the harness raised a `thinking` block with `text: ""`.
  it("raises no block for an item that is still empty", async () => {
    const { server, harness } = rig(TEXT_THREAD, TEXT_TURN);
    const turn = drain(harness.send({ turnId: "trn_1", text: "hi" }));
    await server.waitForRequest("turn/start");
    const envelope = { threadId: TEXT_THREAD.thread.id, turnId: TEXT_TURN.turn.id };
    server.notify("item/started", {
      item: { type: "reasoning", id: "rs_1", summary: [], content: [] },
      ...envelope,
    });
    server.notify("item/started", {
      item: { type: "agentMessage", id: "msg_1", text: "", phase: "final_answer" },
      ...envelope,
    });
    await settle();
    expect(blocks(turn.events, "thinking")).toHaveLength(0);
    expect(blocks(turn.events, "text")).toHaveLength(0);

    server.notify("item/reasoning/summaryTextDelta", {
      ...envelope,
      itemId: "rs_1",
      delta: "weighing it up",
    });
    await settle();
    expect(latest(turn.events, "thinking")).toEqual({
      kind: "thinking",
      text: "weighing it up",
    });
    await harness.interrupt();
    await turn.done;
    await harness.dispose();
  });

  it("passes cwd, approvalsReviewer:user and the config's policy/sandbox to thread/start", async () => {
    const { server, harness } = rig(TEXT_THREAD, TEXT_TURN, {}, {
      config: { codex: { approvalPolicy: "untrusted", sandbox: "read-only", model: "gpt-6-astra" } },
    });
    const turn = drain(harness.send({ turnId: "trn_1", text: "hi" }));
    const start = await server.waitForRequest("thread/start");
    expect(start.params).toEqual({
      cwd: SESSION.projectPath,
      approvalPolicy: "untrusted",
      sandbox: "read-only",
      approvalsReviewer: "user",
      model: "gpt-6-astra",
    });
    await harness.interrupt();
    await turn.done;
    await harness.dispose();
  });

  it("defaults to on-request + workspace-write when the agent has no codex config", async () => {
    const { server, harness } = rig(TEXT_THREAD, TEXT_TURN);
    const turn = drain(harness.send({ turnId: "trn_1", text: "hi" }));
    const start = await server.waitForRequest("thread/start");
    expect(start.params).toMatchObject({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      model: "gpt-5.5",
    });
    await harness.interrupt();
    await turn.done;
    await harness.dispose();
  });
});

describe("CodexHarness — command approval (recorded frames)", () => {
  /** The recorded `item/commandExecution/requestApproval` params. */
  const approvalRequest = RECORDED.approvalTurn.find(
    (f) => f.method === "item/commandExecution/requestApproval",
  );

  it("round-trips accept: the card's allow becomes {decision:'accept'} on the wire", async () => {
    expect(approvalRequest).toBeDefined();
    const { server, harness } = rig(APPROVAL_THREAD, APPROVAL_TURN);
    const turn = drain(
      harness.send({ turnId: "trn_1", text: "Run the shell command `echo capy`." }),
    );
    await server.waitForRequest("turn/start");

    server.replay(notifications(RECORDED.approvalTurn, "item/commandExecution/requestApproval"));
    const answered = server.ask(
      "item/commandExecution/requestApproval",
      approvalRequest!.params,
    );

    await vi.waitFor(() => expect(turn.events.some((e) => e.type === "permission")).toBe(true));
    const permission = turn.events.find(
      (e): e is Extract<EngineEvent, { type: "permission" }> => e.type === "permission",
    )!;
    expect(permission.request.toolName).toBe("shell");
    expect(permission.request.input).toMatchObject({
      command: (approvalRequest!.params as { command: string }).command,
      cwd: SESSION.projectPath,
      kind: "command",
    });
    // The pending card is on screen before the answer.
    expect(latest(turn.events, "permission")).toMatchObject({ decision: null });

    expect(harness.answerPermission(permission.requestId, { behavior: "allow" })).toBe(true);
    expect(await answered).toEqual({ decision: "accept" });
    expect(latest(turn.events, "permission")).toMatchObject({
      decision: { behavior: "allow", scope: "once" },
    });

    // …and the rest of the recorded turn still lands.
    server.replay(
      RECORDED.approvalTurn.filter(
        (f) =>
          f.method !== undefined &&
          f.id === undefined &&
          !["thread/started", "turn/started", "thread/settings/updated"].includes(f.method),
      ),
    );
    await turn.done;

    const shell = blocks(turn.events, "tool_call").at(-1)!.patch;
    expect(shell).toMatchObject({ name: "shell", family: "bash", status: "success" });
    expect(String(shell.output)).toContain("capy");
    expect(blocks(turn.events, "text").map((b) => b.patch.text)).toContain(
      "Output:\n\n```text\ncapy\n```",
    );
    expect(turn.events.at(-1)).toEqual({ type: "turn", status: "done" });
    await harness.dispose();
  });

  it("maps deny to decline and allow-always to acceptForSession", async () => {
    // `scope` is not on `PermissionAnswer` — the desktop's three-way
    // `permission.answer` rides it along on the same object and `scopeOf`
    // reads it back, which is what turns "always" into `acceptForSession`
    // without widening the interface for every harness (see harness.ts).
    const cases: { answer: PermissionAnswer; decision: string }[] = [
      { answer: { behavior: "deny" }, decision: "decline" },
      {
        answer: { behavior: "allow", ...({ scope: "always" } as object) },
        decision: "acceptForSession",
      },
    ];
    for (const { answer, decision } of cases) {
      const { server, harness } = rig(APPROVAL_THREAD, APPROVAL_TURN);
      const turn = drain(harness.send({ turnId: "trn_1", text: "run it" }));
      await server.waitForRequest("turn/start");
      const answered = server.ask(
        "item/commandExecution/requestApproval",
        approvalRequest!.params,
      );
      await vi.waitFor(() => expect(turn.events.some((e) => e.type === "permission")).toBe(true));
      const permission = turn.events.find(
        (e): e is Extract<EngineEvent, { type: "permission" }> => e.type === "permission",
      )!;
      harness.answerPermission(permission.requestId, answer);
      expect(await answered).toEqual({ decision });
      await harness.interrupt();
      await turn.done;
      await harness.dispose();
    }
  });

  it("denies rather than guesses when no turn is open to ask in", async () => {
    const { server, harness } = rig(APPROVAL_THREAD, APPROVAL_TURN);
    const turn = drain(harness.send({ turnId: "trn_1", text: "hi" }));
    await server.waitForRequest("turn/start");
    await harness.interrupt();
    await turn.done;
    expect(
      await server.ask("item/commandExecution/requestApproval", approvalRequest!.params),
    ).toEqual({ decision: "decline" });
    await harness.dispose();
  });
});

describe("CodexHarness — file changes (shape from the 0.153.4 bindings, not recorded)", () => {
  const fileChangeItem = {
    type: "fileChange",
    id: "call_patch_1",
    status: "completed",
    changes: [
      {
        path: "C:\\project\\src\\a.ts",
        kind: { type: "update", move_path: null },
        diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@\n-const a = 1;\n+const a = 2;\n+const b = 3;\n",
      },
      {
        path: "C:\\project\\src\\b.ts",
        kind: { type: "add", move_path: null },
        diff: "--- /dev/null\n+++ b/src/b.ts\n@@\n+export const b = 1;\n",
      },
    ],
  };

  it("emits one tool_call (family edit) plus one diff block per change", async () => {
    const { server, harness } = rig(APPROVAL_THREAD, APPROVAL_TURN);
    const turn = drain(harness.send({ turnId: "trn_1", text: "patch it" }));
    await server.waitForRequest("turn/start");

    const threadId = APPROVAL_THREAD.thread.id;
    const turnId = APPROVAL_TURN.turn.id;
    server.notify("item/started", {
      item: { ...fileChangeItem, status: "inProgress", changes: [] },
      threadId,
      turnId,
    });
    server.notify("item/fileChange/patchUpdated", {
      threadId,
      turnId,
      itemId: fileChangeItem.id,
      changes: fileChangeItem.changes,
    });
    server.notify("item/completed", { item: fileChangeItem, threadId, turnId });
    await settle();

    const tool = latest(turn.events, "tool_call")!;
    expect(tool).toMatchObject({
      name: "apply_patch",
      family: "edit",
      status: "success",
      toolUseId: "call_patch_1",
    });
    const diffs = blocks(turn.events, "diff");
    expect(diffs.map((d) => d.key)).toEqual([
      "diff:call_patch_1:0",
      "diff:call_patch_1:1",
      "diff:call_patch_1:0",
      "diff:call_patch_1:1",
    ]);
    expect(diffs.at(-2)!.patch).toMatchObject({
      path: "C:\\project\\src\\a.ts",
      additions: 2,
      deletions: 1,
    });
    expect(diffs.at(-1)!.patch).toMatchObject({ path: "C:\\project\\src\\b.ts", additions: 1 });

    await harness.interrupt();
    await turn.done;
    await harness.dispose();
  });

  it("calls an all-add patch a write, and answers item/fileChange/requestApproval", async () => {
    const { server, harness } = rig(APPROVAL_THREAD, APPROVAL_TURN);
    const turn = drain(harness.send({ turnId: "trn_1", text: "write it" }));
    await server.waitForRequest("turn/start");
    const threadId = APPROVAL_THREAD.thread.id;
    const turnId = APPROVAL_TURN.turn.id;
    const addOnly = {
      ...fileChangeItem,
      status: "inProgress",
      changes: [fileChangeItem.changes[1]],
    };
    server.notify("item/started", { item: addOnly, threadId, turnId });
    await settle();
    expect(latest(turn.events, "tool_call")).toMatchObject({ family: "write", status: "running" });

    const answered = server.ask("item/fileChange/requestApproval", {
      threadId,
      turnId,
      itemId: fileChangeItem.id,
      reason: "writes outside the sandbox",
      grantRoot: "C:\\project",
    });
    await vi.waitFor(() => expect(turn.events.some((e) => e.type === "permission")).toBe(true));
    const permission = turn.events.find(
      (e): e is Extract<EngineEvent, { type: "permission" }> => e.type === "permission",
    )!;
    expect(permission.request).toMatchObject({
      toolName: "apply_patch",
      reason: "writes outside the sandbox",
    });
    expect(permission.request.input).toMatchObject({ grantRoot: "C:\\project" });
    harness.answerPermission(permission.requestId, { behavior: "allow" });
    expect(await answered).toEqual({ decision: "accept" });

    await harness.interrupt();
    await turn.done;
    await harness.dispose();
  });
});

describe("CodexHarness — MCP tool calls (shape from the bindings, not recorded)", () => {
  it("keeps _meta and raises a widget block for a ui:// app result", async () => {
    const { server, harness } = rig(TEXT_THREAD, TEXT_TURN);
    const turn = drain(harness.send({ turnId: "trn_1", text: "use the app" }));
    await server.waitForRequest("turn/start");

    const item = {
      type: "mcpToolCall",
      id: "call_mcp_1",
      server: "higgsfield",
      tool: "animate",
      status: "completed",
      arguments: { prompt: "a capybara" },
      appContext: {
        connectorId: "higgsfield",
        resourceUri: "ui://higgsfield/animate.html",
        appName: "Higgsfield",
        actionName: "Animate",
      },
      result: {
        content: [{ type: "text", text: "queued" }],
        structuredContent: { jobId: "job_1" },
        _meta: { "openai/widget": { csp: "default-src 'none'" } },
      },
      error: null,
    };
    server.notify("item/completed", {
      item,
      threadId: TEXT_THREAD.thread.id,
      turnId: TEXT_TURN.turn.id,
    });
    await settle();

    expect(latest(turn.events, "tool_call")).toMatchObject({
      name: "animate",
      family: "mcp",
      serverName: "higgsfield",
      status: "success",
      toolUseId: "call_mcp_1",
    });
    expect(latest(turn.events, "widget")).toEqual({
      kind: "widget",
      toolCallId: "call_mcp_1",
      serverName: "higgsfield",
      toolName: "animate",
      resourceUri: "ui://higgsfield/animate.html",
      html: null,
      htmlStatus: "pending",
      toolInput: { prompt: "a capybara" },
      toolResult: {
        content: [{ type: "text", text: "queued" }],
        structuredContent: { jobId: "job_1" },
      },
      meta: { "openai/widget": { csp: "default-src 'none'" } },
    });

    await harness.interrupt();
    await turn.done;
    await harness.dispose();
  });

  it("raises no widget for an ordinary MCP result and marks an errored call error", async () => {
    const { server, harness } = rig(TEXT_THREAD, TEXT_TURN);
    const turn = drain(harness.send({ turnId: "trn_1", text: "use the tool" }));
    await server.waitForRequest("turn/start");
    server.notify("item/completed", {
      item: {
        type: "mcpToolCall",
        id: "call_mcp_2",
        server: "files",
        tool: "read",
        status: "failed",
        arguments: {},
        appContext: null,
        result: null,
        error: { message: "server refused" },
      },
      threadId: TEXT_THREAD.thread.id,
      turnId: TEXT_TURN.turn.id,
    });
    await settle();
    expect(blocks(turn.events, "widget")).toHaveLength(0);
    expect(latest(turn.events, "tool_call")).toMatchObject({
      family: "mcp",
      status: "error",
      output: { error: "server refused" },
    });
    await harness.interrupt();
    await turn.done;
    await harness.dispose();
  });
});

describe("CodexHarness — interrupt", () => {
  it("sends turn/interrupt for the live turn and settles interrupted", async () => {
    const { server, harness } = rig(TEXT_THREAD, TEXT_TURN);
    const turn = drain(harness.send({ turnId: "trn_1", text: "long job" }));
    await server.waitForRequest("turn/start");
    await settle();

    expect(await harness.interrupt()).toBe(true);
    const sent = await server.waitForRequest("turn/interrupt");
    expect(sent.params).toEqual({
      threadId: TEXT_THREAD.thread.id,
      turnId: TEXT_TURN.turn.id,
    });

    // Codex answers with its own turn/completed; the harness must not
    // double-settle when it does.
    server.notify("turn/completed", {
      threadId: TEXT_THREAD.thread.id,
      turn: { id: TEXT_TURN.turn.id, items: [], status: "interrupted", error: null },
    });
    await turn.done;
    expect(turn.events.at(-1)).toEqual({ type: "turn", status: "interrupted" });
    expect(await harness.interrupt()).toBe(false);
    await harness.dispose();
  });

  it("ends the turn on its own when Codex never answers the interrupt", async () => {
    const server = createFakeAppServer({
      handlers: {
        initialize: () => ({}),
        "thread/start": () => TEXT_THREAD,
        "turn/start": () => TEXT_TURN,
        "skills/list": () => ({ data: [] }),
      },
    });
    const harness = new CodexHarness({ transport: server.transport, interruptGraceMs: 5 });
    await harness.start(SESSION, AGENT);
    const turn = drain(harness.send({ turnId: "trn_1", text: "long job" }));
    await server.waitForRequest("turn/start");
    await harness.interrupt();
    await turn.done;
    expect(turn.events.at(-1)).toEqual({ type: "turn", status: "interrupted" });
    await harness.dispose();
  });
});

describe("CodexHarness — resume", () => {
  it("resumes the stored thread id instead of starting a new one", async () => {
    const { server, harness } = rig(TEXT_THREAD, TEXT_TURN, {}, {
      resumeSessionId: TEXT_THREAD.thread.id,
    });
    const turn = drain(harness.send({ turnId: "trn_2", text: "again" }));
    const resumed = await server.waitForRequest("thread/resume");
    expect(resumed.params).toMatchObject({
      threadId: TEXT_THREAD.thread.id,
      cwd: SESSION.projectPath,
      approvalsReviewer: "user",
      // The deprecationNotice the spike recorded on a full-history resume asks
      // for this (`docs/spikes/codex.raw.json`, appserver-c-resume).
      excludeTurns: true,
    });
    expect(server.sent.some((f) => f.method === "thread/start")).toBe(false);
    await harness.interrupt();
    await turn.done;
    await harness.dispose();
  });

  it("falls back to a fresh thread, with an error block, when resume is refused", async () => {
    const server = createFakeAppServer({
      handlers: {
        initialize: () => ({}),
        "thread/resume": () => {
          throw new Error("thread not found");
        },
        "thread/start": () => TEXT_THREAD,
        "turn/start": () => TEXT_TURN,
        "skills/list": () => ({ data: [] }),
      },
    });
    const harness = new CodexHarness({ transport: server.transport, interruptGraceMs: 10 });
    await harness.start(SESSION, { ...AGENT, resumeSessionId: "ses_gone" });
    const turn = drain(harness.send({ turnId: "trn_1", text: "again" }));
    await server.waitForRequest("thread/start");
    await settle();
    expect(latest(turn.events, "error")).toMatchObject({
      message: "Could not resume the previous Codex thread; started a new one.",
    });
    expect(harness.backendSessionId()).toBe(TEXT_THREAD.thread.id);
    await harness.interrupt();
    await turn.done;
    await harness.dispose();
  });
});

describe("CodexHarness — usage, errors and slash commands", () => {
  it("bills the turn from tokenUsage.last, never .total (numbers synthetic — the recording redacts them)", async () => {
    const { server, harness } = rig(TEXT_THREAD, TEXT_TURN);
    const turn = drain(harness.send({ turnId: "trn_1", text: "hi" }));
    await server.waitForRequest("turn/start");
    server.notify("thread/tokenUsage/updated", {
      threadId: TEXT_THREAD.thread.id,
      turnId: TEXT_TURN.turn.id,
      tokenUsage: {
        total: { totalTokens: 90_000, inputTokens: 80_000, cachedInputTokens: 40_000, outputTokens: 10_000 },
        last: {
          totalTokens: 12_000,
          inputTokens: 10_000,
          cachedInputTokens: 4_000,
          cacheWriteInputTokens: 500,
          outputTokens: 2_000,
          reasoningOutputTokens: 1_000,
        },
        modelContextWindow: 258_400,
      },
    });
    server.notify("turn/completed", {
      threadId: TEXT_THREAD.thread.id,
      turn: { id: TEXT_TURN.turn.id, items: [], status: "completed", error: null },
    });
    await turn.done;

    const usage = turn.events.find(
      (e): e is Extract<EngineEvent, { type: "usage" }> => e.type === "usage",
    )!;
    expect(usage.backend).toBe("codex");
    expect(usage.model).toBe("gpt-5.5");
    // 10_000 input of which 4_000 cached → 6_000 fresh.
    expect(usage.usage).toMatchObject({
      inputTokens: 6_000,
      cacheReadTokens: 4_000,
      cacheCreationTokens: 500,
      outputTokens: 2_000,
    });
    expect(usage.usage.costUsd).toBeGreaterThan(0);
    expect(usage.byModel).toEqual({ "gpt-5.5": usage.usage });
    await harness.dispose();
  });

  it("turns an unauthorized turn failure into the sign-in message", async () => {
    const { server, harness } = rig(TEXT_THREAD, TEXT_TURN);
    const turn = drain(harness.send({ turnId: "trn_1", text: "hi" }));
    await server.waitForRequest("turn/start");
    server.notify("turn/completed", {
      threadId: TEXT_THREAD.thread.id,
      turn: {
        id: TEXT_TURN.turn.id,
        items: [],
        status: "failed",
        error: { message: "401 unauthorized", codexErrorInfo: "unauthorized" },
      },
    });
    await turn.done;
    expect(latest(turn.events, "error")).toEqual({
      kind: "error",
      message: "Codex is not signed in. Run `codex login` in a terminal, then retry.",
    });
    expect(turn.events.at(-1)).toMatchObject({ type: "turn", status: "error" });
    await harness.dispose();
  });

  it("ends the turn with the backend's stderr when the app-server dies mid-turn", async () => {
    const { server, harness } = rig(TEXT_THREAD, TEXT_TURN);
    const turn = drain(harness.send({ turnId: "trn_1", text: "hi" }));
    await server.waitForRequest("turn/start");
    server.exit({ code: 101, signal: null });
    await turn.done;
    expect(latest(turn.events, "error")!.message).toContain("codex app-server exited (code 101)");
    expect(turn.events.at(-1)).toMatchObject({ type: "turn", status: "error" });
    await harness.dispose();
  });

  it("runs /status locally and /compact through thread/compact/start", async () => {
    const { server, harness } = rig(TEXT_THREAD, TEXT_TURN);
    const first = drain(harness.send({ turnId: "trn_1", text: "/status" }));
    await first.done;
    const status = String(latest(first.events, "text")!.text);
    expect(status).toContain(TEXT_THREAD.thread.id);
    // `never` because the recorded `thread/start` answer says so: the response
    // wins over the requested policy, which is what the card must show.
    expect(status).toContain("approval never   sandbox workspace-write");
    expect(server.sent.some((f) => f.method === "turn/start")).toBe(false);

    const second = drain(harness.send({ turnId: "trn_2", text: "/compact" }));
    const compact = await server.waitForRequest("thread/compact/start");
    expect(compact.params).toEqual({ threadId: TEXT_THREAD.thread.id });
    server.notify("turn/completed", {
      threadId: TEXT_THREAD.thread.id,
      turn: { id: TEXT_TURN.turn.id, items: [], status: "completed", error: null },
    });
    await second.done;
    expect(second.events.at(-1)).toEqual({ type: "turn", status: "done" });
    await harness.dispose();
  });

  it("offers the built-ins plus the backend's skills, and sends a skill as a skill input", async () => {
    const { server, harness } = rig(TEXT_THREAD, TEXT_TURN, {
      "skills/list": () => ({
        data: [
          {
            cwd: SESSION.projectPath,
            skills: [
              { name: "graphify", shortDescription: "graph a repo", path: "C:\\skills\\graphify" },
              { name: "off", description: "disabled", path: "C:\\skills\\off", enabled: false },
            ],
          },
        ],
      }),
    });
    const turn = drain(harness.send({ turnId: "trn_1", text: "/graphify this repo" }));
    const started = await server.waitForRequest("turn/start");
    expect(started.params).toMatchObject({
      input: [
        { type: "skill", name: "graphify", path: "C:\\skills\\graphify" },
        { type: "text", text: "this repo", text_elements: [] },
      ],
    });
    expect(harness.listCommands().map((c) => c.name)).toEqual([
      ...CODEX_BUILTIN_COMMANDS.map((c) => c.name),
      "/graphify",
    ]);
    await harness.interrupt();
    await turn.done;
    await harness.dispose();
  });

  it("refuses to start a second turn while one is running", async () => {
    const { server, harness } = rig(TEXT_THREAD, TEXT_TURN);
    const first = drain(harness.send({ turnId: "trn_1", text: "hi" }));
    await server.waitForRequest("turn/start");
    const second = drain(harness.send({ turnId: "trn_2", text: "again" }));
    await second.done;
    expect(second.events).toEqual([
      { type: "turn", status: "error", error: "this agent is already running a turn" },
    ]);
    await harness.interrupt();
    await first.done;
    await harness.dispose();
  });
});

describe("CodexHarness — user input and elicitation server requests", () => {
  it("maps item/tool/requestUserInput onto a question card and answers by question id", async () => {
    const { server, harness } = rig(TEXT_THREAD, TEXT_TURN);
    const turn = drain(harness.send({ turnId: "trn_1", text: "ask me" }));
    await server.waitForRequest("turn/start");

    const answered = server.ask("item/tool/requestUserInput", {
      threadId: TEXT_THREAD.thread.id,
      turnId: TEXT_TURN.turn.id,
      itemId: "call_ask_1",
      isBlocking: true,
      questions: [
        {
          id: "q1",
          header: "Deploy target",
          question: "Where should this go?",
          isOther: true,
          options: [{ label: "staging" }, { label: "production", description: "the real one" }],
        },
      ],
    });

    await vi.waitFor(() => expect(turn.events.some((e) => e.type === "question")).toBe(true));
    const question = turn.events.find(
      (e): e is Extract<EngineEvent, { type: "question" }> => e.type === "question",
    )!;
    expect(question.questions[0]).toMatchObject({
      question: "Where should this go?",
      header: "Deploy target",
      multiSelect: false,
      options: [{ label: "staging" }, { label: "production", description: "the real one" }],
    });
    expect(latest(turn.events, "question")).toMatchObject({ allowOther: true, answers: null });

    harness.answerQuestion(question.requestId, { "Where should this go?": "staging" });
    expect(await answered).toEqual({ answers: { q1: { answers: ["staging"] } } });
    expect(latest(turn.events, "question")).toMatchObject({
      answers: { "Where should this go?": "staging" },
    });

    await harness.interrupt();
    await turn.done;
    await harness.dispose();
  });

  it("shows an MCP elicitation as a card and declines it (no answer channel yet)", async () => {
    const { server, harness } = rig(TEXT_THREAD, TEXT_TURN);
    const turn = drain(harness.send({ turnId: "trn_1", text: "elicit" }));
    await server.waitForRequest("turn/start");

    const answered = await server.ask("mcpServer/elicitation/request", {
      threadId: TEXT_THREAD.thread.id,
      turnId: TEXT_TURN.turn.id,
      serverName: "notion",
      mode: "form",
      message: "Which workspace?",
      requestedSchema: { type: "object", properties: { workspace: { type: "string" } } },
      elicitationId: "el_1",
    });
    expect(answered).toEqual({ action: "decline", content: null, _meta: null });

    const card = latest(turn.events, "elicitation")!;
    expect(card).toMatchObject({
      title: "notion",
      description: "Which workspace?",
      status: "declined",
      answers: null,
    });
    await harness.interrupt();
    await turn.done;
    await harness.dispose();
  });

  it("refuses an unhandled server request instead of guessing an answer", async () => {
    const { server, harness } = rig(TEXT_THREAD, TEXT_TURN);
    const turn = drain(harness.send({ turnId: "trn_1", text: "hi" }));
    await server.waitForRequest("turn/start");
    await expect(server.ask("attestation/generate", {})).rejects.toThrow(
      /does not handle attestation\/generate/,
    );
    // …but the clock request, which costs nothing to answer, is answered.
    const now = (await server.ask("currentTime/read", {})) as { currentTimeAt: number };
    expect(now.currentTimeAt).toBeGreaterThan(1_700_000_000);
    await harness.interrupt();
    await turn.done;
    await harness.dispose();
  });
});

describe("CodexHarness — pure helpers", () => {
  it("counts diff lines without the file headers", () => {
    expect(countDiff("--- a\n+++ b\n@@\n+one\n+two\n-three\n")).toEqual({
      additions: 2,
      deletions: 1,
    });
  });

  it("collapses a permission answer onto a Codex decision", () => {
    expect(commandDecision({ behavior: "allow" })).toBe("accept");
    expect(commandDecision({ behavior: "deny" })).toBe("decline");
    expect(
      commandDecision({ behavior: "allow", ...({ scope: "session" } as object) }),
    ).toBe("acceptForSession");
  });

  it("reads only the codex block of an agent config, ignoring junk", () => {
    expect(
      readCodexConfig({
        codex: { model: "gpt-6-astra", approvalPolicy: "nonsense", sandbox: "read-only" },
        claude: { model: "opus" },
      }),
    ).toEqual({ model: "gpt-6-astra", sandbox: "read-only" });
    expect(readCodexConfig(null)).toEqual({});
  });

  it("subtracts the cached share from input and never invents a price", () => {
    expect(
      readCodexUsage({ inputTokens: 100, cachedInputTokens: 140, outputTokens: 10 }),
    ).toMatchObject({ inputTokens: 0, cacheReadTokens: 140 });
    expect(
      estimateCodexCost("a-model-nobody-priced", {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
      }),
    ).toBe(0);
  });
});

describe("resolveCodexBinary", () => {
  const isWinX64 = process.platform === "win32" && process.arch === "x64";

  // The regression this guards: `createRequire(...).resolve("@openai/codex-sdk")`
  // throws `No "exports" main defined` (the package publishes only an `import`
  // condition), which made `resolveBundledCodex()` return null and the harness
  // silently spawn whatever `codex` the machine had installed — 0.139.0 here,
  // a different protocol version from the 0.153.4 COMPAT.md pins. Caught by the
  // first live run, not by any test.
  it.runIf(isWinX64)("finds the vendored 0.153.4 that ships with @openai/codex-sdk", () => {
    const bundled = resolveBundledCodex();
    expect(bundled).not.toBeNull();
    expect(bundled!.source).toBe("bundled");
    expect(bundled!.exe.replaceAll("\\", "/")).toContain(
      "@openai/codex/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
    );
    // `rg.exe` lives here; without it Codex's search tools are missing.
    expect(bundled!.pathDirs[0]?.replaceAll("\\", "/")).toContain(
      "x86_64-pc-windows-msvc/codex-path",
    );
    expect(resolveCodexBinary().exe).toBe(bundled!.exe);
  });

  it("lets an explicit path and CAPYGEN_CODEX_BIN win over discovery", () => {
    expect(resolveCodexBinary({ binaryPath: "C:\pinned\codex.exe" })).toEqual({
      exe: "C:\pinned\codex.exe",
      pathDirs: [],
      source: "option",
    });
    expect(resolveCodexBinary({ env: { CAPYGEN_CODEX_BIN: "/usr/bin/codex" } })).toEqual({
      exe: "/usr/bin/codex",
      pathDirs: [],
      source: "env",
    });
  });
});
