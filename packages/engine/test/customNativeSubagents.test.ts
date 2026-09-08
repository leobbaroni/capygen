import { describe, expect, it, vi } from "vitest";
import { ClaudeHarness } from "../src/claude/ClaudeHarness.js";
import { CodexHarness } from "../src/codex/CodexHarness.js";
import type { LocalAuthorizationRequest } from "../src/policy/types.js";
import { makeFakeSdk } from "./fakeSdk.js";
import { createFakeAppServer } from "./codexFakeAppServer.js";

const session = { sessionId: "ses_custom", projectPath: "C:\\custom-fixture" };

describe("Custom Mode native spawn suppression", () => {
  it("denies both Claude aliases before fail-open routing or an allow, leaving delegate_task usable", async () => {
    const fake = makeFakeSdk();
    const routeSubagent = vi.fn(() => { throw new Error("legacy fail-open"); });
    const authorizeLocal = vi.fn(async (request: LocalAuthorizationRequest) => ({
      allowed: true, approvedInput: request.input,
    }));
    const harness = new ClaudeHarness({
      query: fake.query, disableNativeSubagents: true, routeSubagent,
      authorizeLocal,
    });
    await harness.start(session, {
      agentId: "agt_custom", name: "lead", backend: "claude", model: "claude-sonnet-5",
    });
    const done = (async () => {
      for await (const event of harness.send({ turnId: "trn_custom", text: "delegate" })) void event;
    })();
    try {
      await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
      const hook = fake.options().hooks?.PreToolUse?.[0]?.hooks[0];
      expect(hook).toBeDefined();
      for (const tool_name of ["Agent", "Task"]) {
        const result = await hook!({
          hook_event_name: "PreToolUse", tool_name, tool_input: { prompt: "do work" },
        } as never, tool_name, { signal: new AbortController().signal });
        expect(result).toMatchObject({ hookSpecificOutput: {
          permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("delegate_task"),
        } });
      }
      expect(routeSubagent).not.toHaveBeenCalled();
      expect(authorizeLocal).not.toHaveBeenCalled();
      const delegated = await hook!({
        hook_event_name: "PreToolUse", tool_name: "mcp__capygen__delegate_task", tool_input: {},
      } as never, "delegated", { signal: new AbortController().signal });
      expect(delegated).toEqual({});
      expect(authorizeLocal).toHaveBeenCalledOnce();
    } finally {
      await harness.interrupt();
      fake.end();
      await done;
      await harness.dispose();
    }
  });

  // Wire contract only: a fake server cannot prove removal of native tools.
  it.each([false, true])("passes both Codex feature disables with MCP config (resume=%s)", async (resume) => {
    const server = createFakeAppServer({ handlers: {
      initialize: () => ({ codexHome: "C:\\fixture-home" }),
      "thread/start": () => ({ thread: { id: "thread_custom" } }),
      "thread/resume": () => ({ thread: { id: "thread_custom" } }),
      "turn/start": () => ({ turn: { id: "turn_custom" } }),
      "skills/list": () => ({ data: [] }),
    } });
    const harness = new CodexHarness({
      transport: server.transport, disableNativeSubagents: true, interruptGraceMs: 1,
      resolvedMcpServers: () => ({ docs: { enabled: false } }),
    });
    await harness.start(session, {
      agentId: "agt_custom", name: "lead", backend: "codex", model: "gpt-6-astra",
      ...(resume ? { resumeSessionId: "thread_custom" } : {}),
    });
    const done = (async () => {
      for await (const event of harness.send({ turnId: "trn_custom", text: "hello" })) void event;
    })();
    try {
      const frame = await server.waitForRequest(resume ? "thread/resume" : "thread/start");
      expect(frame.params).toMatchObject({ config: {
        mcp_servers: { docs: { enabled: false } },
        features: { multi_agent: false, multi_agent_v2: false },
      } });
      await server.waitForRequest("turn/start");
    } finally {
      await harness.interrupt();
      await done;
      await harness.dispose();
    }
  });
});
