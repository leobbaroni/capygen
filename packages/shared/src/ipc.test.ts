import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import {
  AgentConfigSchema,
  AgentDescribeSchema,
  AgentDraftSchema,
  AgentPatchSchema,
  AgentSchema,
  assertNoInlineAgentMcpCredentials,
  redactInlineAgentMcpCredentials,
  BLOCK_KINDS,
  BlockSchema,
  DEFAULT_SESSION_SETTINGS,
  DEFAULT_SETTINGS,
  DEFAULT_GLOBAL_SETTINGS,
  DevServerDraftSchema,
  DevServerRunSchema,
  DevServerSchema,
  EVENT_CHANNEL_NAMES,
  FileEntrySchema,
  GitDiffSchema,
  GitStatusSchema,
  GlobalSettingsSchema,
  HarnessInfoSchema,
  INVOKE_CHANNEL_NAMES,
  IpcContractError,
  McpServerEntrySchema,
  PANE_KINDS,
  PluginEntrySchema,
  PrereqStepSchema,
  SessionSchema,
  SessionSettingsSchema,
  SettingsSchema,
  SkillEntrySchema,
  TaskPatchSchema,
  TaskSchema,
  TerminalInfoSchema,
  ToolPolicyEntrySchema,
  WorkspaceLayoutSchema,
  defineIpc,
  deriveMentionName,
  isInvokeChannel,
  mergeGlobalSettingsPatch,
  newId,
  resetGlobalSettingsSection,
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
      "automations.list", "automations.create", "automations.update", "automations.delete",
      "automations.runNow", "automations.cancelRun", "automations.listRuns",
      "inbox.list", "inbox.markRead", "inbox.markAllRead", "usage.report",
      "projects.pick",
      "projects.list",
      "worktrees.list",
      "worktrees.create",
      "worktrees.register",
      "worktrees.remove",
      "imports.pick",
      "imports.cancel",
      "imports.commit",
      "imports.get",
      "imports.entries",
      "imports.reference",
      "imports.continue",
      "sharing.export.preview",
      "sharing.export.entries",
      "sharing.export.comments",
      "sharing.export.save",
      "sharing.export.cancel",
      "sharing.import.pick",
      "sharing.import.entries",
      "sharing.import.comments",
      "sharing.import.cancel",
      "sharing.import.commit",
      "sharing.entries",
      "sharing.get",
      "sharing.reference",
      "sharing.continue",
      "sharing.notes.list",
      "sharing.notes.create",
      "sharing.notes.update",
      "sharing.notes.remove",
      "sharing.comments",
      "approve.pending",
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
      "agents.catalogue",
      "agents.runtime",
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
      "settings.getAll",
      "settings.patch",
      "settings.reset",
      "app.version",
      "integrations.list",
      "integrations.mcp.add",
      "integrations.mcp.update",
      "integrations.mcp.remove",
      "integrations.mcp.test",
      "integrations.plugin.install",
      "integrations.plugin.uninstall",
      "integrations.plugin.setEnabled",
      "integrations.plugin.marketplaces",
      "integrations.skill.setEnabled",
      "integrations.skill.create",
      "integrations.skill.open",
      "integrations.tools.setPolicy",
      "integrations.tools.removePolicy",
      "integrations.refresh",
      "prereqs.status",
      "prereqs.run",
      "diagnostics.get",
      "diagnostics.copy",
      "layout.get",
      "layout.set",
      "fs.list",
      "fs.read",
      "fs.write",
      "fs.search",
      "fs.watch",
      "fs.unwatch",
      "git.status",
      "git.diff",
      "git.commit",
      "terminal.create",
      "terminal.write",
      "terminal.resize",
      "terminal.kill",
      "terminal.list",
      "servers.detect",
      "servers.list",
      "servers.start",
      "servers.stop",
      "servers.logs",
      "servers.saveCustom",
      "servers.remove",
      "tasks.create",
      "tasks.list",
      "tasks.update",
      "browser.attach",
      "browser.detach",
      "browser.navigate",
      "browser.setBounds",
      "browser.devtools",
      "policy.members.list",
      "policy.members.create",
      "policy.members.update",
      "policy.members.remove",
      "policy.session.subject.get",
      "policy.session.subject.assign",
      "policy.rules.list",
      "policy.rules.create",
      "policy.rules.update",
      "policy.rules.remove",
      "policy.rules.preview",
      "policy.grants.list",
      "policy.grants.revoke",
      "policy.audit.list",
      "policy.boundaries.availability",
      "customMode.generate", "customMode.cancel", "customMode.capabilities", "customMode.apply",
      "dictation.availability", "dictation.recognize", "dictation.cancel", "terminal.attach",
      "extensions.theme", "extensions.list", "extensions.pick", "extensions.register",
      "extensions.unregister", "extensions.refresh", "extensions.open", "extensions.bounds", "extensions.close",
    ]);
    expect(EVENT_CHANNEL_NAMES).toEqual([
      "extensions.changed", "extensions.navigate",
      "policy.changed",
      "automations.changed", "automationRun.changed", "inbox.changed",
      "chat.block",
      "chat.turnStatus",
      "session.updated",
      "agents.updated",
      "agent.runtime",
      "chat.chainStopped",
      "permission.request",
      "question.request",
      "elicitation.request",
      "app.status",
      "fs.changed",
      "terminal.data",
      "terminal.exit",
      "servers.status",
      "servers.log",
      "tasks.updated",
      "browser.state",
      "settings.changed",
      "integrations.changed",
      "prereqs.changed",
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

  it("refuses inline agent MCP credentials and redacts unsupported legacy values", () => {
    const config = AgentConfigSchema.parse({
      api: { mcpServers: { demo: { command: "node", env: { TOKEN: "secret" } } } },
    });
    expect(() => assertNoInlineAgentMcpCredentials(config)).toThrow(/Settings > MCP servers/);
    const publicConfig = redactInlineAgentMcpCredentials(config);
    expect(JSON.stringify(publicConfig)).not.toContain("secret");
    expect(publicConfig).toMatchObject({
      api: { mcpServers: { demo: { command: "node", envKeys: ["TOKEN"] } } },
    });
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

describe("Phase 5: workspace panes, dev servers, tasks (contracts)", () => {
  it("lists the eight pane kinds SPEC R16 names", () => {
    expect(PANE_KINDS).toEqual([
      "files",
      "editor",
      "diff",
      "browser",
      "terminal",
      "agents",
      "tasks",
      "servers",
    ]);
  });

  it("round-trips a saved workspace layout", () => {
    const layout = WorkspaceLayoutSchema.parse({
      projectId: newId("project"),
      layoutJson: { grid: { root: {} } },
      updatedAt: 1,
    });
    expect(layout.layoutJson).toEqual({ grid: { root: {} } });
  });

  it("defaults a dev server's args to an empty array and accepts a custom draft", () => {
    const server = DevServerSchema.parse({
      id: newId("devServer"),
      projectId: newId("project"),
      name: "web",
      source: "package.json",
      command: "npm",
      cwd: "C:\\proj",
      createdAt: 1,
      updatedAt: 1,
    });
    expect(server.args).toEqual([]);

    const draft = DevServerDraftSchema.parse({ name: "web", command: "npm run dev", cwd: "C:\\proj" });
    expect(draft.source).toBe("custom");
  });

  it("mints a dev server run without a pid/url until one is known", () => {
    const run = DevServerRunSchema.parse({ serverId: newId("devServer"), status: "starting" });
    expect(run.pid).toBeUndefined();
    expect(run.url).toBeUndefined();
  });

  it("defaults a task's status/source/order and lets tasks.update patch only the editable fields", () => {
    const task = TaskSchema.parse({
      id: newId("task"),
      title: "Fix the flaky test",
      createdAt: 1,
      updatedAt: 1,
    });
    expect(task).toMatchObject({
      sessionId: null,
      agentId: null,
      status: "pending",
      source: "manual",
      order: 0,
    });

    const patch = TaskPatchSchema.parse({ status: "in_progress" });
    expect(patch).toEqual({ status: "in_progress" });
    // Identity fields are not part of the patch shape at all.
    expect("source" in TaskPatchSchema.shape).toBe(false);
    expect("sessionId" in TaskPatchSchema.shape).toBe(false);
  });

  it("validates a live terminal info shape (never persisted — see TerminalInfoSchema's doc comment)", () => {
    const info = TerminalInfoSchema.parse({
      id: newId("terminal"),
      projectId: newId("project"),
      title: "PowerShell",
      cwd: "C:\\proj",
      shell: "pwsh.exe",
      cols: 80,
      rows: 24,
    });
    expect(info.sessionId).toBeNull();
  });

  it("round-trips a file entry, a git status (and its non-repo null), and a diff", () => {
    expect(FileEntrySchema.parse({ path: "src/a.ts", name: "a.ts", kind: "file" }).kind).toBe("file");
    expect(GitStatusSchema.nullable().parse(null)).toBeNull();
    const status = GitStatusSchema.parse({
      branch: "main",
      ahead: 1,
      behind: 0,
      entries: [{ path: "a.ts", status: "M" }],
    });
    expect(status.entries).toHaveLength(1);
    const diff = GitDiffSchema.parse({ path: "a.ts", unified: "@@ -1 +1 @@" });
    expect(diff.binary).toBeUndefined();
  });
});

describe("Phase 6: settings hub, integrations, prerequisites (contracts)", () => {
  it("fills the sectioned defaults for an empty GlobalSettings row", () => {
    expect(GlobalSettingsSchema.parse({})).toEqual(DEFAULT_GLOBAL_SETTINGS);
    expect(DEFAULT_GLOBAL_SETTINGS.general).toEqual({
      defaultBackend: "claude",
      defaultModel: "claude-opus-4-5",
      submitWithCtrlEnter: false,
      alwaysSteer: false,
      autoTitleSessions: true,
    });
    expect(DEFAULT_GLOBAL_SETTINGS.efficiency).toEqual({
      compactionThresholdPct: 70,
      toolOutputCapKb: 64,
      lazyMcpSchemas: true,
    });
    expect(DEFAULT_GLOBAL_SETTINGS.telemetry).toBe(false);
    // The layering's middle rung: every per-backend default starts unset,
    // not defaulted to some concrete permissionMode/approvalPolicy/provider.
    expect(DEFAULT_GLOBAL_SETTINGS.backends).toEqual({ claude: {}, codex: {}, api: {} });
  });

  it("mergeGlobalSettingsPatch merges one section without clobbering its siblings or other sections (the jitless-defaults bug this shape avoids)", () => {
    const first = mergeGlobalSettingsPatch(DEFAULT_GLOBAL_SETTINGS, {
      general: { defaultModel: "claude-sonnet-4-5" },
    });
    expect(first.general).toEqual({
      ...DEFAULT_GLOBAL_SETTINGS.general,
      defaultModel: "claude-sonnet-4-5",
    });
    // A second, unrelated patch must not reset the first patch's field.
    const second = mergeGlobalSettingsPatch(first, { appearance: { theme: "dark" } });
    expect(second.general.defaultModel).toBe("claude-sonnet-4-5");
    expect(second.appearance).toEqual({ ...DEFAULT_GLOBAL_SETTINGS.appearance, theme: "dark" });
  });

  it("mergeGlobalSettingsPatch merges nested backend defaults per-backend", () => {
    const withClaude = mergeGlobalSettingsPatch(DEFAULT_GLOBAL_SETTINGS, {
      backends: { claude: { permissionMode: "plan" } },
    });
    const withCodexToo = mergeGlobalSettingsPatch(withClaude, {
      backends: { codex: { approvalPolicy: "untrusted" } },
    });
    expect(withCodexToo.backends).toEqual({
      claude: { permissionMode: "plan" },
      codex: { approvalPolicy: "untrusted" },
      api: {},
    });
  });

  it("mergeGlobalSettingsPatch replaces shortcuts.overrides wholesale, not key-by-key", () => {
    const withA = mergeGlobalSettingsPatch(DEFAULT_GLOBAL_SETTINGS, {
      shortcuts: { overrides: { "chat.send": "Ctrl+Enter" } },
    });
    const withB = mergeGlobalSettingsPatch(withA, {
      shortcuts: { overrides: { "chat.clear": "Ctrl+K" } },
    });
    // "chat.send" is gone: a patch that names shortcuts always submits the
    // whole table (GlobalShortcutsPatchSchema's doc comment).
    expect(withB.shortcuts.overrides).toEqual({ "chat.clear": "Ctrl+K" });
  });

  it("resetGlobalSettingsSection resets only the named section, and 'all' resets everything", () => {
    const edited = mergeGlobalSettingsPatch(DEFAULT_GLOBAL_SETTINGS, {
      general: { defaultModel: "claude-sonnet-4-5" },
      appearance: { theme: "dark" },
    });
    const generalReset = resetGlobalSettingsSection(edited, "general");
    expect(generalReset.general).toEqual(DEFAULT_GLOBAL_SETTINGS.general);
    expect(generalReset.appearance.theme).toBe("dark"); // untouched

    expect(resetGlobalSettingsSection(edited, "all")).toEqual(DEFAULT_GLOBAL_SETTINGS);
  });

  it("round-trips an MCP server entry and rejects one with no id-worthy identity fields", () => {
    const entry = McpServerEntrySchema.parse({
      backend: "claude",
      name: "higgsfield",
      transport: "stdio",
      command: "npx",
      args: ["-y", "higgsfield-mcp"],
      scope: "project",
      source: "C:\\proj\\.mcp.json",
    });
    expect(entry.enabled).toBe(true); // default
    expect(entry.status).toBeUndefined();

    expect(() =>
      McpServerEntrySchema.parse({ backend: "claude", transport: "stdio", scope: "user", source: "live" }),
    ).toThrow(); // missing name
  });

  it("round-trips a plugin entry, a skill entry and a tool policy entry", () => {
    const plugin = PluginEntrySchema.parse({
      backend: "claude",
      name: "cockpit",
      source: "C:\\Users\\x\\.claude\\plugins\\installed_plugins.json",
    });
    expect(plugin).toMatchObject({ enabled: true, installed: true, commands: [], skills: [] });

    const skill = SkillEntrySchema.parse({
      backend: "claude",
      name: "graphify",
      scope: "user",
      path: "C:\\Users\\x\\.claude\\skills\\graphify\\SKILL.md",
    });
    expect(skill.enabled).toBe(true);

    const policy = ToolPolicyEntrySchema.parse({
      backend: "codex",
      pattern: "Bash(rm *)",
      decision: "deny",
      scope: "global",
    });
    expect(policy.decision).toBe("deny");
  });

  it("round-trips a prereq step, including a blockedBy chain", () => {
    const step = PrereqStepSchema.parse({
      id: "codex-cli",
      title: "Install Codex CLI",
      detected: false,
      command: "npm install -g @openai/codex",
      kind: "cli",
      blockedBy: ["node"],
    });
    expect(step.description).toBe(""); // defaulted
    expect(step.blockedBy).toEqual(["node"]);
  });

  it("sends only the given section for settings.patch, not the other sections (the same jitless-default fix as settings.set)", async () => {
    const invoke = vi.fn(async () => DEFAULT_GLOBAL_SETTINGS);
    const ipc = defineIpc(fakeTransport({ invoke }));

    await ipc.invoke("settings.patch", { patch: { general: { defaultModel: "claude-sonnet-4-5" } } });

    expect(invoke).toHaveBeenCalledWith("settings.patch", {
      patch: { general: { defaultModel: "claude-sonnet-4-5" } },
    });
  });

  it("integrations.list answers one backend's whole snapshot, lastSync null until synced", async () => {
    const invoke = vi.fn(async () => ({
      mcpServers: [],
      plugins: [],
      skills: [],
      tools: [],
      lastSync: null,
    }));
    const ipc = defineIpc(fakeTransport({ invoke }));

    const result = await ipc.invoke("integrations.list", { backend: "codex" });
    expect(result.lastSync).toBeNull();
    expect(invoke).toHaveBeenCalledWith("integrations.list", { backend: "codex" });
  });
});
