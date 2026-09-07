import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { WorktreeChip } from "./WorktreeChip";
const invoke = vi.fn();
vi.mock("@/lib/ipc", () => ({ ipc: () => ({ invoke }) }));
const main = { path: "C:/repo", kind: "main", branch: "main", projectId: "p", headCommit: "a".repeat(40), detached: false, locked: false, lockReason: null, prunable: false, pruneReason: null };
const linked = { ...main, path: "C:/feature", kind: "linked", branch: "feature", projectId: null };
const project = { id: "new", path: linked.path, name: "feature", layout: null, devServers: null, createdAt: 0, updatedAt: 0 };
beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (channel) => channel === "worktrees.list" ? [main, linked] : { worktree: linked, project });
});
it("registers a Git-listed worktree before selecting its concrete project", async () => {
  const select = vi.fn();
  render(<WorktreeChip projectId="p" onSelect={select} />);
  await userEvent.click(screen.getByTestId("worktree-chip"));
  await userEvent.click(await screen.findByRole("button", { name: "Use feature" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("worktrees.register", { sourceProjectId: "p", path: "C:/feature" }));
  expect(select).toHaveBeenCalledWith(project);
  expect(invoke.mock.calls.some(([channel]) => channel === "sessions.create")).toBe(false);
});
it("creates from the explicit branch/base and leaves destination picking to main", async () => {
  const select = vi.fn();
  render(<WorktreeChip projectId="p" onSelect={select} />);
  await userEvent.click(screen.getByTestId("worktree-chip"));
  await userEvent.type(screen.getByLabelText("Branch name"), "codex/feature");
  await userEvent.click(screen.getByRole("button", { name: "Choose destination and create" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("worktrees.create", { sourceProjectId: "p", branch: { mode: "new", name: "codex/feature", base: "HEAD" } }));
  expect(select).toHaveBeenCalledWith(project);
});
it("keeps the current project when the native destination picker is cancelled", async () => {
  invoke.mockImplementation(async (channel) => channel === "worktrees.list" ? [main] : null);
  const select = vi.fn();
  render(<WorktreeChip projectId="p" onSelect={select} />);
  await userEvent.click(screen.getByTestId("worktree-chip"));
  await userEvent.type(screen.getByLabelText("Branch name"), "codex/feature");
  await userEvent.click(screen.getByRole("button", { name: "Choose destination and create" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("worktrees.create", expect.anything()));
  expect(select).not.toHaveBeenCalled();
});
