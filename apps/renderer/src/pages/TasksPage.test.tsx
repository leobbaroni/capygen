import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { TasksPage } from "./TasksPage";
const invoke = vi.fn(async (channel: string) => channel === "tasks.list" ? [
  { id: "one", sessionId: "s1", title: "Inspect parser", status: "pending", source: "todo_write", updatedAt: 2 },
  { id: "two", sessionId: "s2", title: "Verify output", status: "completed", source: "codex_plan", updatedAt: 1 },
] : []);
vi.mock("@/lib/ipc", () => ({ ipc: () => ({ invoke, on: () => () => {} }) }));
it("lists agent todos from different sessions and links each to its source", async () => {
  render(<MemoryRouter><TasksPage /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Inspect parser")).toBeTruthy());
  expect(screen.getByText("Verify output")).toBeTruthy();
  expect(screen.getAllByRole("link", { name: "Open session" }).map((link) => link.getAttribute("href"))).toEqual(["/c/s1", "/c/s2"]);
  expect(invoke).toHaveBeenCalledWith("tasks.list", {});
});
