/**
 * `TasksService` — the Tasks pane's rows, derived from blocks an agent already
 * wrote (SPEC R16, P10). No model is ever asked for a plan, so none of this
 * costs a token (R26).
 *
 * The blocks here are recorded shapes, not invented ones: Claude's `TodoWrite`
 * input is `{todos:[{content, status, activeForm}]}`, and Codex's plan step is
 * `{step, status}` with `pending | inProgress | completed`
 * (`docs/spikes/codex-app-server-schema/v0.153.4-ts/v2/TurnPlanStep.ts`).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId, type Block, type Task } from "@capygen/shared";
import {
  TasksService,
  derivedTaskId,
  normaliseStatus,
  readPlan,
  readTodos,
  sourceForTool,
} from "../src/workspace/TasksService.js";
import { makeHarness, type Harness } from "./workspaceHarness.js";

let h: Harness;
let service: TasksService;
let sessionId: string;
let agentId: string;
let turnId: string;

function toolCall(name: string, input: unknown, turn = turnId): Block {
  const ts = Date.now();
  return {
    id: newId("block"),
    turnId: turn,
    sessionId,
    kind: "tool_call",
    index: 0,
    name,
    input,
    status: "success",
    createdAt: ts,
    updatedAt: ts,
  };
}

function titlesAndStatuses(): [string, string][] {
  return h.store.tasks.listBySession(sessionId).map((t) => [t.title, t.status]);
}

beforeEach(() => {
  h = makeHarness({ prefix: "capygen-tasks-" });
  service = new TasksService({ store: h.store, broadcast: h.broadcast, log: h.log });
  const created = h.store.sessions.create({
    projectId: h.projectId,
    mode: "solo",
    agents: [{ name: "capy", backend: "claude", model: "opus", role: "lead", config: null }],
  });
  sessionId = created.session.id;
  agentId = created.agents[0]!.id;
  turnId = h.store.turns.create({ sessionId, agentId, role: "agent", status: "streaming" }).id;
});

afterEach(() => h.close());

describe("TodoWrite", () => {
  it("becomes one ordered task per todo, attributed to the turn's agent", () => {
    service.observeBlock(
      toolCall("TodoWrite", {
        todos: [
          { content: "Read the spec", status: "completed", activeForm: "Reading the spec" },
          { content: "Write the service", status: "in_progress", activeForm: "Writing the service" },
          { content: "Run the tests", status: "pending", activeForm: "Running the tests" },
        ],
      }),
    );

    const tasks = h.store.tasks.listBySession(sessionId);
    expect(tasks.map((t) => [t.title, t.status, t.order])).toEqual([
      ["Read the spec", "completed", 0],
      // In progress shows the present-tense form Claude Code's own spinner uses.
      ["Writing the service", "in_progress", 1],
      ["Run the tests", "pending", 2],
    ]);
    expect(tasks.every((t) => t.source === "todo_write")).toBe(true);
    expect(tasks.every((t) => t.agentId === agentId)).toBe(true);
  });

  it("re-sending the list updates the same rows instead of duplicating them", () => {
    service.observeBlock(
      toolCall("TodoWrite", {
        todos: [
          { content: "One", status: "pending" },
          { content: "Two", status: "pending" },
        ],
      }),
    );
    const firstIds = h.store.tasks.listBySession(sessionId).map((t) => t.id);

    // A *different* block (a second tool call), the same plan moved on.
    service.observeBlock(
      toolCall("TodoWrite", {
        todos: [
          { content: "One", status: "completed" },
          { content: "Two", status: "in_progress" },
        ],
      }),
    );

    const tasks = h.store.tasks.listBySession(sessionId);
    expect(tasks.map((t) => t.id)).toEqual(firstIds);
    expect(tasks.map((t) => t.status)).toEqual(["completed", "in_progress"]);
  });

  it("a shortened plan deletes the rows it dropped", () => {
    service.observeBlock(
      toolCall("TodoWrite", {
        todos: [
          { content: "One", status: "pending" },
          { content: "Two", status: "pending" },
          { content: "Three", status: "pending" },
        ],
      }),
    );
    service.observeBlock(toolCall("TodoWrite", { todos: [{ content: "One", status: "completed" }] }));

    expect(titlesAndStatuses()).toEqual([["One", "completed"]]);
  });

  it("broadcasts the whole roster, the way agents.updated does", () => {
    service.observeBlock(toolCall("TodoWrite", { todos: [{ content: "One", status: "pending" }] }));
    const [event] = h.eventsOn("tasks.updated") as { sessionId: string; tasks: Task[] }[];
    expect(event?.sessionId).toBe(sessionId);
    expect(event?.tasks.map((t) => t.title)).toEqual(["One"]);
  });

  it("two agents in a round table keep separate lists", () => {
    const second = h.store.sessions.addAgent(sessionId, { backend: "codex", model: "gpt" });
    const secondTurn = h.store.turns.create({
      sessionId,
      agentId: second.id,
      role: "agent",
      status: "streaming",
    });

    service.observeBlock(toolCall("TodoWrite", { todos: [{ content: "Lead item", status: "pending" }] }));
    service.observeBlock(
      toolCall("TodoWrite", { todos: [{ content: "Peer item", status: "pending" }] }, secondTurn.id),
    );

    const tasks = h.store.tasks.listBySession(sessionId);
    expect(tasks).toHaveLength(2);
    expect(new Set(tasks.map((t) => t.agentId))).toEqual(new Set([agentId, second.id]));
  });

  it("ignores a tool call that is not a plan at all", () => {
    service.observeBlock(toolCall("Bash", { command: "ls" }));
    expect(h.store.tasks.listBySession(sessionId)).toEqual([]);
  });

  it("survives a malformed plan without failing the turn", () => {
    service.observeBlock(toolCall("TodoWrite", { todos: "not an array" }));
    service.observeBlock(toolCall("TodoWrite", { todos: [{ nothing: true }, 42] }));
    expect(h.store.tasks.listBySession(sessionId)).toEqual([]);
  });
});

describe("Codex plan", () => {
  it("maps update_plan steps, including the inProgress spelling", () => {
    service.observeBlock(
      toolCall("update_plan", {
        explanation: "here is the plan",
        plan: [
          { step: "Explore the repo", status: "completed" },
          { step: "Change the code", status: "inProgress" },
          { step: "Verify", status: "pending" },
        ],
      }),
    );

    const tasks = h.store.tasks.listBySession(sessionId);
    expect(tasks.map((t) => [t.title, t.status])).toEqual([
      ["Explore the repo", "completed"],
      ["Change the code", "in_progress"],
      ["Verify", "pending"],
    ]);
    expect(tasks.every((t) => t.source === "codex_plan")).toBe(true);
  });

  it("a Claude plan and a Codex plan in one session do not overwrite each other", () => {
    service.observeBlock(toolCall("TodoWrite", { todos: [{ content: "Claude item", status: "pending" }] }));
    service.observeBlock(toolCall("update_plan", { plan: [{ step: "Codex item", status: "pending" }] }));
    expect(titlesAndStatuses()).toEqual([
      ["Claude item", "pending"],
      ["Codex item", "pending"],
    ]);
  });
});

describe("sub-agent completion", () => {
  function subagent(status: "spawned" | "done" | "error", description: string): Block {
    const ts = Date.now();
    return {
      id: newId("block"),
      turnId,
      sessionId,
      kind: "subagent",
      index: 1,
      agentId: null,
      name: "worker",
      backend: "claude",
      model: "haiku",
      description,
      status,
      createdAt: ts,
      updatedAt: ts,
    };
  }

  it("closes the plan item it was doing", () => {
    service.observeBlock(
      toolCall("TodoWrite", {
        todos: [
          { content: "Run the tests", status: "in_progress" },
          { content: "Write the docs", status: "pending" },
        ],
      }),
    );
    service.observeBlock(subagent("done", "Run the tests"));

    expect(titlesAndStatuses()).toEqual([
      ["Run the tests", "completed"],
      ["Write the docs", "pending"],
    ]);
  });

  it("a failed sub-agent cancels rather than completes", () => {
    service.observeBlock(toolCall("TodoWrite", { todos: [{ content: "Run the tests", status: "pending" }] }));
    service.observeBlock(subagent("error", "Run the tests"));
    expect(titlesAndStatuses()).toEqual([["Run the tests", "cancelled"]]);
  });

  it("invents nothing when no task matches — TaskSource has no subagent value", () => {
    service.observeBlock(subagent("done", "Something nobody planned"));
    expect(h.store.tasks.listBySession(sessionId)).toEqual([]);
  });

  it("ignores a sub-agent that has not finished", () => {
    service.observeBlock(toolCall("TodoWrite", { todos: [{ content: "Run the tests", status: "pending" }] }));
    service.observeBlock(subagent("spawned", "Run the tests"));
    expect(titlesAndStatuses()).toEqual([["Run the tests", "pending"]]);
  });
});

describe("manual edits", () => {
  it("tasks.update patches a row and re-broadcasts the roster", () => {
    const manual = h.store.tasks.create({ sessionId, title: "Typed by hand" });
    const updated = service.update({ id: manual.id, patch: { status: "completed" } });
    expect(updated.status).toBe("completed");
    expect((h.eventsOn("tasks.updated").at(-1) as { tasks: Task[] }).tasks).toHaveLength(1);
  });

  it("derivation never touches a manual task", () => {
    h.store.tasks.create({ sessionId, title: "Typed by hand" });
    service.observeBlock(toolCall("TodoWrite", { todos: [{ content: "Derived", status: "pending" }] }));
    expect(titlesAndStatuses().sort()).toEqual([
      ["Derived", "pending"],
      ["Typed by hand", "pending"],
    ]);
  });
});

describe("pure helpers", () => {
  it("sourceForTool sees through an MCP prefix", () => {
    expect(sourceForTool("TodoWrite")).toBe("todo_write");
    expect(sourceForTool("mcp__something__TodoWrite")).toBe("todo_write");
    expect(sourceForTool("update_plan")).toBe("codex_plan");
    expect(sourceForTool("Bash")).toBeNull();
  });

  it("normaliseStatus reads both vocabularies and defaults to pending", () => {
    expect(normaliseStatus("in_progress")).toBe("in_progress");
    expect(normaliseStatus("inProgress")).toBe("in_progress");
    expect(normaliseStatus("completed")).toBe("completed");
    expect(normaliseStatus("something new")).toBe("pending");
    expect(normaliseStatus(undefined)).toBe("pending");
  });

  it("readTodos / readPlan answer null for a shape they do not recognise", () => {
    expect(readTodos({ nope: 1 })).toBeNull();
    expect(readPlan({ nope: 1 })).toBeNull();
    expect(readPlan({ plan: ["a bare string step"] })).toEqual([
      { title: "a bare string step", status: "pending" },
    ]);
  });

  it("derivedTaskId is stable and prefixed", () => {
    expect(derivedTaskId("ses_1", "agt_1", "todo_write", 0)).toBe(
      derivedTaskId("ses_1", "agt_1", "todo_write", 0),
    );
    expect(derivedTaskId("ses_1", "agt_1", "todo_write", 0)).not.toBe(
      derivedTaskId("ses_1", "agt_1", "todo_write", 1),
    );
    expect(derivedTaskId("ses_1", null, "codex_plan", 0).startsWith("tsk_")).toBe(true);
  });
});
