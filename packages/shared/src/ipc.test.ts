import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import {
  BLOCK_KINDS,
  BlockSchema,
  DEFAULT_SETTINGS,
  EVENT_CHANNEL_NAMES,
  INVOKE_CHANNEL_NAMES,
  IpcContractError,
  SettingsSchema,
  defineIpc,
  isInvokeChannel,
  newId,
  type IpcTransport,
} from "./index.js";

function fakeTransport(overrides: Partial<IpcTransport> = {}): IpcTransport {
  return {
    invoke: async () => ({}),
    subscribe: () => () => {},
    ...overrides,
  };
}

describe("IPC contract", () => {
  it("declares every channel the shell depends on", () => {
    expect(INVOKE_CHANNEL_NAMES).toEqual([
      "projects.pick",
      "projects.list",
      "sessions.create",
      "sessions.list",
      "sessions.get",
      "sessions.archive",
      "turns.list",
      "chat.send",
      "chat.interrupt",
      "chat.listCommands",
      "permission.answer",
      "question.answer",
      "settings.get",
      "settings.set",
      "app.version",
    ]);
    expect(EVENT_CHANNEL_NAMES).toEqual([
      "chat.block",
      "chat.turnStatus",
      "session.updated",
      "permission.request",
      "question.request",
      "app.status",
    ]);
  });

  it("rejects channels this build does not declare", () => {
    expect(isInvokeChannel("chat.send")).toBe(true);
    expect(isInvokeChannel("chat.exfiltrate")).toBe(false);
  });
});

describe("defineIpc", () => {
  it("applies schema defaults before the payload leaves the renderer", async () => {
    const invoke = vi.fn(async () => ({ userTurnId: "trn_a", agentTurnId: "trn_b" }));
    const ipc = defineIpc(fakeTransport({ invoke }));

    await ipc.invoke("chat.send", { sessionId: "ses_1", text: "hi" });

    expect(invoke).toHaveBeenCalledWith("chat.send", {
      sessionId: "ses_1",
      text: "hi",
      agentId: null,
    });
  });

  it("refuses to send a payload that violates the contract", async () => {
    const invoke = vi.fn();
    const ipc = defineIpc(fakeTransport({ invoke }));

    await expect(
      // @ts-expect-error deliberately wrong shape
      ipc.invoke("chat.send", { sessionId: "", text: 7 }),
    ).rejects.toBeInstanceOf(IpcContractError);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses a malformed response from main", async () => {
    const ipc = defineIpc(fakeTransport({ invoke: async () => ({ nope: true }) }));
    await expect(ipc.invoke("app.version", {})).rejects.toBeInstanceOf(IpcContractError);
  });

  it("validates event payloads and returns an unsubscribe", () => {
    let emit: ((p: unknown) => void) | null = null;
    const unsub = vi.fn();
    const ipc = defineIpc(
      fakeTransport({
        subscribe: (_c, listener) => {
          emit = listener;
          return unsub;
        },
      }),
    );

    const seen: unknown[] = [];
    const off = ipc.on("chat.turnStatus", (p) => seen.push(p));
    emit!({ sessionId: "ses_1", turnId: "trn_1", status: "streaming" });
    expect(seen).toEqual([
      { sessionId: "ses_1", turnId: "trn_1", status: "streaming" },
    ]);

    expect(() => emit!({ sessionId: "ses_1" })).toThrow(IpcContractError);
    off();
    expect(unsub).toHaveBeenCalled();
  });
});

describe("domain schemas", () => {
  it("round-trips every block kind through the discriminated union", () => {
    const base = {
      turnId: "trn_1",
      sessionId: "ses_1",
      index: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    const samples: Record<(typeof BLOCK_KINDS)[number], unknown> = {
      text: { ...base, id: newId("block"), kind: "text", text: "hello" },
      thinking: { ...base, id: newId("block"), kind: "thinking", text: "hmm" },
      tool_call: {
        ...base,
        id: newId("block"),
        kind: "tool_call",
        name: "Read",
        input: { file: "a.ts" },
        status: "running",
      },
      diff: { ...base, id: newId("block"), kind: "diff", path: "a.ts", patch: "@@" },
      permission: {
        ...base,
        id: newId("block"),
        kind: "permission",
        request: { requestId: "req_1", toolName: "Bash", input: { cmd: "ls" } },
      },
      question: {
        ...base,
        id: newId("block"),
        kind: "question",
        requestId: "req_2",
        questions: [{ question: "Which?", options: [{ label: "A" }] }],
      },
      subagent: { ...base, id: newId("block"), kind: "subagent", name: "reviewer" },
      error: { ...base, id: newId("block"), kind: "error", message: "boom" },
      usage: { ...base, id: newId("block"), kind: "usage", usage: {} },
    };

    for (const kind of BLOCK_KINDS) {
      const parsed = BlockSchema.parse(samples[kind]);
      expect(parsed.kind).toBe(kind);
    }
  });

  it("fills the shipping defaults for an empty settings row", () => {
    expect(SettingsSchema.parse({})).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.hopCap).toBe(3);
    expect(DEFAULT_SETTINGS.compactionThreshold).toBe(0.7);
  });

  it("keeps zod jitless, so a strict-CSP renderer can parse (no `new Function`)", () => {
    // Regression guard for "Code generation from strings disallowed for this
    // context": zod's JIT validators are blocked by the renderer's CSP.
    expect(z.config().jitless).toBe(true);
  });

  it("mints prefixed ids per entity kind", () => {
    expect(newId("session")).toMatch(/^ses_[0-9a-f]{32}$/);
    expect(newId("block")).toMatch(/^blk_[0-9a-f]{32}$/);
  });
});
