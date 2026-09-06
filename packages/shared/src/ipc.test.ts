import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import {
  AgentConfigSchema,
  AgentDescribeSchema,
  AgentDraftSchema,
  AgentPatchSchema,
  AgentSchema,
  BLOCK_KINDS,
  BlockSchema,
  DEFAULT_SESSION_SETTINGS,
  DEFAULT_SETTINGS,
  EVENT_CHANNEL_NAMES,
  HarnessInfoSchema,
  INVOKE_CHANNEL_NAMES,
  IpcContractError,
  SessionSchema,
  SessionSettingsSchema,
  SettingsSchema,
  defineIpc,
  deriveMentionName,
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
      "sessions.setMode",
      "sessions.updateSettings",
      "agents.list",
      "agents.add",
      "agents.update",
      "agents.remove",
      "agents.setLead",
      "agents.describe",
      "turns.list",
      "blocks.getOutput",
      "turns.usage",
      "chat.send",
      "chat.interrupt",
      "chat.listCommands",
      "chat.continue",
      "permission.answer",
      "question.answer",
      "elicitation.answer",
      "harness.list",
      "secrets.set",
      "secrets.has",
      "secrets.delete",
      "mcp.readResource",
      "widget.callTool",
      "widget.event",
      "settings.get",
      "settings.set",
      "app.version",
    ]);
    expect(EVENT_CHANNEL_NAMES).toEqual([
      "chat.block",
      "chat.turnStatus",
      "session.updated",
      "agents.updated",
      "chat.chainStopped",
      "permission.request",
      "question.request",
      "elicitation.request",
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

  it("sends permission.answer's three-way decision, not the old binary behavior", async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const ipc = defineIpc(fakeTransport({ invoke }));

    await ipc.invoke("permission.answer", { requestId: "req_1", decision: "allow_always" });

    expect(invoke).toHaveBeenCalledWith("permission.answer", {
      requestId: "req_1",
      decision: "allow_always",
      scope: "once",
    });
  });

  it("sends only the fields settings.set was given, not every shipping default (bug fix)", async () => {
    // Regression for a real bug: `settings.set` used to validate its input
    // against `SettingsSchema.partial()`. Under this codebase's mandatory
    // `z.config({jitless:true})` (zodRuntime.ts), wrapping a `.default(...)`
    // field in `.optional()` does not suppress the default for an omitted
    // key, so a caller sending only `{theme:"dark"}` actually had all nine
    // settings fields sent to main — and `SettingsRepo.patch`'s
    // `{...this.all(), ...patch}` then reset every other setting (hopCap,
    // defaultModel, ...) back to its shipping default on every edit.
    const invoke = vi.fn(async (_c, payload) => ({ ...DEFAULT_SETTINGS, ...(payload as object) }));
    const ipc = defineIpc(fakeTransport({ invoke }));

    await ipc.invoke("settings.set", { theme: "dark" });

    expect(invoke).toHaveBeenCalledWith("settings.set", { theme: "dark" });
  });

  it("never round-trips a secret value back through secrets.has", async () => {
    const invoke = vi.fn(async () => ({ has: true }));
    const ipc = defineIpc(fakeTransport({ invoke }));

    const result = await ipc.invoke("secrets.has", { provider: "anthropic" });

    // `source` says stored/environment/none; the *value* never comes back.
    expect(result).toEqual({ has: true, source: "none" });
    expect(invoke).toHaveBeenCalledWith("secrets.has", { provider: "anthropic" });
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
      widget: {
        ...base,
        id: newId("block"),
        kind: "widget",
        toolCallId: "toolu_1",
        serverName: "higgsfield",
        toolName: "animate",
        resourceUri: "ui://higgsfield/animate",
        htmlStatus: "pending",
        toolInput: { prompt: "a capybara" },
      },
      elicitation: {
        ...base,
        id: newId("block"),
        kind: "elicitation",
        requestId: "req_3",
        schema: { type: "object", properties: { name: { type: "string" } } },
      },
    };

    for (const kind of BLOCK_KINDS) {
      const parsed = BlockSchema.parse(samples[kind]);
      expect(parsed.kind).toBe(kind);
    }
  });

  it("rejects a widget block whose resourceUri is not a ui:// URI (R31)", () => {
    const base = {
      id: newId("block"),
      turnId: "trn_1",
      sessionId: "ses_1",
      index: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    expect(() =>
      BlockSchema.parse({
        ...base,
        kind: "widget",
        toolCallId: "toolu_1",
        serverName: "higgsfield",
        toolName: "animate",
        resourceUri: "https://not-a-ui-resource",
        htmlStatus: "pending",
        toolInput: {},
      }),
    ).toThrow();
  });

  it("widens a permission decision to allow_always without dropping the rest (R28/R32)", () => {
    const decided = BlockSchema.parse({
      id: newId("block"),
      turnId: "trn_1",
      sessionId: "ses_1",
      index: 0,
      createdAt: 1,
      updatedAt: 1,
      kind: "permission",
      request: { requestId: "req_1", toolName: "Bash", input: { cmd: "ls" } },
      decision: { behavior: "allow_always", scope: "always", decidedAt: 2 },
      title: "Run a shell command",
      suggestions: [{ tool: "Bash" }],
    });
    expect(decided.kind === "permission" && decided.decision?.behavior).toBe("allow_always");
    expect(decided.kind === "permission" && decided.title).toBe("Run a shell command");
  });

  it("validates a per-backend agent config and keeps unknown claude/codex fields (Phase 3)", () => {
    const config = AgentConfigSchema.parse({
      claude: { model: "claude-opus-4-5", permissionMode: "plan", futureField: true },
      codex: { approvalPolicy: "on-request", sandbox: "workspace-write" },
      api: { provider: "openrouter", model: "z-ai/glm" },
    });
    expect(config.claude).toMatchObject({ permissionMode: "plan", futureField: true });
    expect(config.codex).toMatchObject({ approvalPolicy: "on-request" });
    expect(config.api).toMatchObject({ provider: "openrouter", model: "z-ai/glm" });

    expect(() => AgentConfigSchema.parse({ api: { provider: "bogus", model: "x" } })).toThrow();
  });

  it("validates a harness listing", () => {
    const list = HarnessInfoSchema.parse({
      backend: "codex",
      label: "Codex",
      available: false,
      reason: "codex.exe not found",
      models: [{ id: "gpt-5-codex", label: "GPT-5 Codex" }],
      defaultModel: "gpt-5-codex",
    });
    expect(list.available).toBe(false);
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

describe("Phase 4: session modes, agents, dispatcher, routing", () => {
  it("defaults an agent's role to member and requires a mentionName", () => {
    const agent = AgentSchema.parse({
      id: newId("agent"),
      sessionId: newId("session"),
      name: "capy",
      displayName: "Capy",
      mentionName: "capy",
      backend: "claude",
      model: "claude-opus-4-5",
      createdAt: 1,
    });
    expect(agent.role).toBe("member");
    expect(agent.order).toBe(0);

    expect(() =>
      AgentSchema.parse({
        id: newId("agent"),
        sessionId: newId("session"),
        name: "capy",
        displayName: "Capy",
        mentionName: "Capy With Spaces",
        backend: "claude",
        model: "claude-opus-4-5",
        createdAt: 1,
      }),
    ).toThrow();
  });

  it("lets a draft omit displayName/mentionName (SessionsRepo fills them in)", () => {
    const draft = AgentDraftSchema.parse({ name: "codey", backend: "codex", model: "gpt-5.5" });
    expect(draft.role).toBe("member");
    expect(draft.displayName).toBeUndefined();
    expect(draft.mentionName).toBeUndefined();
  });

  it("derives a lowercase, no-space mention name, falling back when nothing survives", () => {
    expect(deriveMentionName("Claude Lead")).toBe("claude-lead");
    expect(deriveMentionName("codey_2")).toBe("codey_2".replace(/_/g, "-"));
    expect(deriveMentionName("🦫🦫")).toBe("agent");
  });

  it("lets an agent patch include role (the single-lead invariant is a repo-level rule, not a schema one)", () => {
    // AgentPatchSchema accepts `role: "lead"`; SessionsRepo.updateAgent is what
    // refuses it (packages/db/test/store.test.ts), because only `setLead`
    // demotes the previous holder in the same write.
    expect(AgentPatchSchema.parse({ role: "lead" })).toEqual({ role: "lead" });
  });

  it("fills session settings defaults (hopCap 3, parallelAgents false)", () => {
    expect(SessionSettingsSchema.parse({})).toEqual(DEFAULT_SESSION_SETTINGS);
    expect(DEFAULT_SESSION_SETTINGS.hopCap).toBe(3);
    expect(DEFAULT_SESSION_SETTINGS.parallelAgents).toBe(false);

    const session = SessionSchema.parse({
      id: newId("session"),
      projectId: newId("project"),
      mode: "round-table",
      leadAgentId: null,
      title: "",
      status: "idle",
      createdAt: 1,
      updatedAt: 1,
      archived: false,
    });
    expect(session.settings).toEqual(DEFAULT_SESSION_SETTINGS);
  });

  it("accepts a session-wide sub-agent routing override under settings.routing", () => {
    const settings = SessionSettingsSchema.parse({
      routing: { subagents: { backend: "codex", model: "gpt-5.5" } },
    });
    expect(settings.routing?.subagents).toEqual({ backend: "codex", model: "gpt-5.5" });
  });

  it("sends only the given field for sessions.updateSettings too (same jitless-default fix)", async () => {
    const invoke = vi.fn(async () => SessionSchema.parse({
      id: newId("session"),
      projectId: newId("project"),
      mode: "round-table",
      leadAgentId: null,
      title: "",
      status: "idle",
      createdAt: 1,
      updatedAt: 1,
      archived: false,
    }));
    const ipc = defineIpc(fakeTransport({ invoke }));

    await ipc.invoke("sessions.updateSettings", {
      sessionId: "ses_1",
      patch: { hopCap: 5 },
    });

    expect(invoke).toHaveBeenCalledWith("sessions.updateSettings", {
      sessionId: "ses_1",
      patch: { hopCap: 5 },
    });
  });

  it("round-trips an agents.describe payload with its own compact usage shape", () => {
    const info = AgentDescribeSchema.parse({
      description: "Reviews code",
      capabilities: ["permissions", "questions"],
      tools: ["Bash", "Read"],
      model: "claude-opus-4-5",
      backend: "claude",
      usage: { input: 100, output: 20, cached: 900, costUsd: 0.01 },
      others: [{ agentId: newId("agent"), mentionName: "codex", backend: "codex", model: "gpt-5.5" }],
    });
    expect(info.usage.cached).toBe(900);
    expect(info.others).toHaveLength(1);
  });
});
