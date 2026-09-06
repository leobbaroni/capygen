import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, Task } from "@capygen/shared";
import type { DockviewApi, DockviewPanelApi } from "dockview-react";
import type { WorkspacePaneParams } from "@/workspace/types";
import { TasksPane } from "./TasksPane";

const ipcInvoke = vi.fn();
const listeners = new Map<string, Set<(payload: unknown) => void>>();
const ipcOn = vi.fn((event: string, listener: (payload: unknown) => void) => {
  const bucket = listeners.get(event) ?? new Set();
  bucket.add(listener);
  listeners.set(event, bucket);
  return () => bucket.delete(listener);
});
function emit(event: string, payload: unknown): void {
  for (const listener of listeners.get(event) ?? []) listener(payload);
}
vi.mock("@/lib/ipc", () => ({
  ipc: () => ({ invoke: ipcInvoke, on: ipcOn }),
  hasBridge: () => true,
}));

function task(overrides: Partial<Task>): Task {
  return {
    id: "t1",
    sessionId: "s1",
    agentId: null,
    title: "Write the plan",
    status: "pending",
    source: "manual",
    order: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const agent: Agent = {
  id: "a1",
  sessionId: "s1",
  name: "capy",
  displayName: "Capy",
  mentionName: "capy",
  backend: "claude",
  model: "claude-opus-4-5",
  role: "lead",
  order: 0,
  config: null,
  createdAt: 0,
};

const tasks: Task[] = [
  task({ id: "t1", title: "Write the plan", status: "pending" }),
  task({ id: "t2", title: "Build the thing", status: "in_progress", agentId: "a1" }),
  task({ id: "t3", title: "Ship it", status: "completed" }),
];

beforeEach(() => {
  listeners.clear();
  ipcInvoke.mockReset();
  ipcOn.mockClear();
  ipcInvoke.mockImplementation((channel: string, args: Record<string, unknown>) => {
    if (channel === "tasks.list") return Promise.resolve(tasks);
    if (channel === "agents.list") return Promise.resolve([agent]);
    if (channel === "tasks.update") {
      const existing = tasks.find((t) => t.id === args.id);
      if (!existing) return Promise.reject(new Error(`unknown task: ${String(args.id)}`));
      return Promise.resolve({ ...existing, ...(args.patch as object), updatedAt: 2 });
    }
    return Promise.reject(new Error(`unexpected channel ${channel}`));
  });
});

const params: WorkspacePaneParams = { projectId: "p1", sessionId: "s1" };
const api = {} as DockviewPanelApi;
const containerApi = {} as DockviewApi;
const props = { params, api, containerApi };

describe("TasksPane (SPEC R16)", () => {
  it("groups tasks by status", async () => {
    render(<TasksPane {...props} />);

    expect(await screen.findByTestId("tasks-group-pending")).toHaveTextContent("Write the plan");
    expect(screen.getByTestId("tasks-group-in_progress")).toHaveTextContent("Build the thing");
    expect(screen.getByTestId("tasks-group-completed")).toHaveTextContent("Ship it");
    expect(screen.queryByTestId("tasks-group-cancelled")).not.toBeInTheDocument();
  });

  it("shows the completed/total count and an agent badge", async () => {
    render(<TasksPane {...props} />);
    await screen.findByTestId("tasks-group-pending");

    expect(screen.getByText("Tasks (1/3)")).toBeInTheDocument();
    const inProgressRow = within(screen.getByTestId("tasks-group-in_progress")).getByTestId("task-row");
    expect(within(inProgressRow).getByTestId("task-agent-badge")).toHaveTextContent("@capy");
  });

  it("fetches this pane's own session, not every task in the project", async () => {
    render(<TasksPane {...props} />);
    await screen.findByTestId("tasks-group-pending");

    expect(ipcInvoke).toHaveBeenCalledWith("tasks.list", { sessionId: "s1" });
  });

  it("replaces the list on a matching tasks.updated event", async () => {
    render(<TasksPane {...props} />);
    await screen.findByTestId("tasks-group-pending");

    act(() => {
      emit("tasks.updated", {
        sessionId: "s1",
        tasks: [task({ id: "t9", title: "Fresh from the agent", status: "pending" })],
      });
    });

    expect(await screen.findByText("Fresh from the agent")).toBeInTheDocument();
    expect(screen.queryByText("Write the plan")).not.toBeInTheDocument();
  });

  it("ignores a tasks.updated event for a different session", async () => {
    render(<TasksPane {...props} />);
    await screen.findByTestId("tasks-group-pending");

    act(() => {
      emit("tasks.updated", { sessionId: "other-session", tasks: [] });
    });

    expect(screen.getByText("Write the plan")).toBeInTheDocument();
  });

  it("cycles a task's status forward via tasks.update", async () => {
    const user = userEvent.setup();
    render(<TasksPane {...props} />);
    const pendingRow = within(await screen.findByTestId("tasks-group-pending")).getByTestId("task-row");

    await user.click(within(pendingRow).getByTestId("task-status-toggle"));

    await waitFor(() =>
      expect(ipcInvoke).toHaveBeenCalledWith("tasks.update", { id: "t1", patch: { status: "in_progress" } }),
    );
  });

  it("edits a task's title inline", async () => {
    const user = userEvent.setup();
    render(<TasksPane {...props} />);
    const pendingRow = within(await screen.findByTestId("tasks-group-pending")).getByTestId("task-row");

    await user.click(within(pendingRow).getByTestId("task-title"));
    const input = within(pendingRow).getByTestId("task-title-input");
    await user.clear(input);
    await user.type(input, "Write the real plan{Enter}");

    await waitFor(() =>
      expect(ipcInvoke).toHaveBeenCalledWith("tasks.update", {
        id: "t1",
        patch: { title: "Write the real plan" },
      }),
    );
  });

  it("cancels a task", async () => {
    const user = userEvent.setup();
    render(<TasksPane {...props} />);
    const pendingRow = within(await screen.findByTestId("tasks-group-pending")).getByTestId("task-row");

    await user.click(within(pendingRow).getByTestId("task-cancel"));

    await waitFor(() =>
      expect(ipcInvoke).toHaveBeenCalledWith("tasks.update", { id: "t1", patch: { status: "cancelled" } }),
    );
  });

  it("keeps manual add disabled — no tasks.create channel exists yet", async () => {
    render(<TasksPane {...props} />);
    await screen.findByTestId("tasks-group-pending");

    expect(screen.getByTestId("tasks-add-input")).toBeDisabled();
  });

  it("shows the empty state when there are no tasks", async () => {
    ipcInvoke.mockImplementation((channel: string) => {
      if (channel === "tasks.list") return Promise.resolve([]);
      if (channel === "agents.list") return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected channel ${channel}`));
    });
    render(<TasksPane {...props} />);

    expect(await screen.findByTestId("tasks-empty")).toBeInTheDocument();
  });

  it("surfaces a load error instead of hanging", async () => {
    ipcInvoke.mockImplementation((channel: string) => {
      if (channel === "tasks.list") return Promise.reject(new Error("db is locked"));
      if (channel === "agents.list") return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected channel ${channel}`));
    });
    render(<TasksPane {...props} />);

    expect(await screen.findByTestId("tasks-error")).toHaveTextContent("db is locked");
  });
});
