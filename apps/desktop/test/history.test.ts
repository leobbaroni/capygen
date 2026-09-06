/**
 * The `api` backend's memory (SPEC R9, R15).
 *
 * Claude and Codex are resumed by a backend session id. An `api` agent has
 * none — capygen *is* its loop — so the stored transcript is the whole of what
 * it remembers across a restart, and `loadApiHistory` is the only thing that
 * turns rows back into a conversation. The rules pinned here are the ones a
 * provider rejects the request over, not stylistic ones.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type CapygenStore } from "@capygen/db";
import type { HarnessAgent, HarnessSession } from "@capygen/engine";
import { newId, type Block } from "@capygen/shared";
import { loadApiHistory } from "../src/engine/history.js";

const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../../packages/db/migrations", import.meta.url),
);

let dir: string;
let store: CapygenStore;
let sessionId: string;
let agentId: string;
let otherAgentId: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-history-"));
  store = openStore(path.join(dir, "capygen.db"), { migrationsDir: MIGRATIONS_DIR });
  const project = store.projects.upsertByPath({ path: path.join(dir, "project") });
  const created = store.sessions.create({
    projectId: project.id,
    mode: "solo",
    agents: [
      { name: "capy", backend: "api", model: "claude-sonnet-4-5", role: "lead", config: null },
      { name: "codey", backend: "codex", model: "gpt-5.5", role: "member", config: null },
    ],
  });
  sessionId = created.session.id;
  agentId = created.session.leadAgentId!;
  otherAgentId = created.agents.find((a) => a.id !== agentId)!.id;
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function turn(role: "user" | "agent", status: "done" | "streaming", forAgent?: string): string {
  return store.turns.create({
    sessionId,
    role,
    status,
    ...(forAgent ? { agentId: forAgent } : {}),
  }).id;
}

function put(turnId: string, patch: Partial<Block> & { kind: Block["kind"] }): void {
  store.blocks.upsert({
    id: newId("block"),
    turnId,
    sessionId,
    index: store.blocks.nextIndex(turnId),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...patch,
  } as Block);
}

function load(): ReturnType<typeof loadApiHistory> {
  const session: HarnessSession = { sessionId, projectPath: dir };
  const agent: HarnessAgent = {
    agentId,
    name: "capy",
    backend: "api",
    model: "claude-sonnet-4-5",
  };
  return loadApiHistory(store, session, agent);
}

describe("loadApiHistory", () => {
  it("replays user text and this agent's own reply, in order", () => {
    const u = turn("user", "done");
    put(u, { kind: "text", text: "hello" });
    const a = turn("agent", "done", agentId);
    put(a, { kind: "text", text: "hi back" });

    expect(load()).toEqual([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi back" }] },
    ]);
  });

  it("pairs every tool_use with a tool_result, inventing one when the turn was cut short", () => {
    const u = turn("user", "done");
    put(u, { kind: "text", text: "read it" });
    const a = turn("agent", "done", agentId);
    put(a, {
      kind: "tool_call",
      name: "read_file",
      input: { path: "a.md" },
      output: "contents",
      status: "success",
      toolUseId: "call_1",
    });
    put(a, {
      kind: "tool_call",
      name: "bash",
      input: { command: "sleep 1" },
      status: "running",
      toolUseId: "call_2",
    });

    const [, assistant, results] = load();
    expect(assistant!.content.map((c) => c.type)).toEqual(["tool_use", "tool_use"]);
    // Both providers reject a tool_use with no matching result, so the
    // unfinished call gets an explicit marker rather than being dropped.
    expect(results!.role).toBe("user");
    expect(results!.content).toEqual([
      { type: "tool_result", toolUseId: "call_1", content: "contents" },
      {
        type: "tool_result",
        toolUseId: "call_2",
        content: "[no result: the turn ended before this tool finished]",
      },
    ]);
  });

  it("replays a denied tool call as its denial, not as an unfinished one", () => {
    const u = turn("user", "done");
    put(u, { kind: "text", text: "delete it" });
    const a = turn("agent", "done", agentId);
    put(a, {
      kind: "tool_call",
      name: "bash",
      input: { command: "rm -rf ." },
      output: "The user denied this tool call.",
      status: "denied",
      toolUseId: "call_d",
    });

    const [, , results] = load();
    // "the turn ended before this tool finished" reads to the model as an
    // interruption — a plausible reason to retry the exact command the user
    // just refused. The denial has to survive the replay.
    expect(results!.content).toEqual([
      {
        type: "tool_result",
        toolUseId: "call_d",
        content: "The user denied this tool call.",
        isError: true,
      },
    ]);
  });

  it("replays another agent's reply as attributed user text, never as its own", () => {
    const a = turn("agent", "done", otherAgentId);
    put(a, { kind: "text", text: "I looked at it" });

    expect(load()).toEqual([
      { role: "user", content: [{ type: "text", text: "[codey]: I looked at it" }] },
    ]);
  });

  it("drops unsigned thinking and keeps signed thinking", () => {
    const a = turn("agent", "done", agentId);
    put(a, { kind: "thinking", text: "unsigned" });
    put(a, { kind: "thinking", text: "signed", signature: "sig" });

    // Anthropic rejects a replayed `thinking` block with no signature.
    expect(load()[0]!.content).toEqual([
      { type: "thinking", thinking: "signed", signature: "sig" },
    ]);
  });

  it("skips the turn that is still streaming — its prompt is handed to send()", () => {
    const u = turn("user", "done");
    put(u, { kind: "text", text: "one" });
    const live = turn("agent", "streaming", agentId);
    put(live, { kind: "text", text: "half a reply" });

    expect(load()).toEqual([{ role: "user", content: [{ type: "text", text: "one" }] }]);
  });

  it("leaves capygen's own cards out of the conversation", () => {
    const a = turn("agent", "done", agentId);
    put(a, { kind: "text", text: "done" });
    put(a, {
      kind: "usage",
      model: "m",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
      },
    });
    put(a, { kind: "error", message: "something" });

    expect(load()[0]!.content).toEqual([{ type: "text", text: "done" }]);
  });

  it("truncates a huge tool result rather than replaying megabytes", () => {
    const a = turn("agent", "done", agentId);
    put(a, {
      kind: "tool_call",
      name: "bash",
      input: {},
      output: "x".repeat(20_000),
      status: "success",
      toolUseId: "call_big",
    });

    const result = load()[1]!.content[0] as { content: string };
    expect(result.content.length).toBeLessThan(9_000);
    expect(result.content).toContain("truncated by capygen");
  });
});
