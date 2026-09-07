import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { useAppStore } from "@/store/appStore";
import { ImportSection } from "./ImportSection";

const invoke = vi.fn();
vi.mock("@/lib/ipc", () => ({ ipc: () => ({ invoke }), hasBridge: () => true }));
const preview = {
  handle: "a".repeat(32), destinationProjectId: "p", backend: "codex",
  title: "Historical session", sourcePath: "C:/transcript.jsonl",
  counts: { messages: 2, thinking: 1, activities: 3, notices: 0, truncatedTexts: 1 },
  warnings: [{ code: "unknown", message: "One record was omitted" }],
  changedSnapshot: true,
};
beforeEach(() => {
  invoke.mockReset();
  useAppStore.setState({ selectedProjectId: "p", projects: [{ id: "p", name: "Project", path: "C:/project", layout: null, devServers: null, createdAt: 0, updatedAt: 0 }] });
  invoke.mockImplementation(async (channel) => channel === "imports.pick" ? preview : { ok: true });
});
it("previews the native selection and commits only its opaque handle", async () => {
  invoke.mockImplementation(async (channel) => channel === "imports.pick" ? preview : { session: { id: "s" }, duplicate: false });
  render(<MemoryRouter><ImportSection /></MemoryRouter>);
  await userEvent.click(screen.getByRole("button", { name: "Choose transcript" }));
  expect(invoke).toHaveBeenCalledWith("imports.pick", { projectId: "p" });
  expect(await screen.findByText("One record was omitted")).toBeVisible();
  expect(screen.getByText(/changed since/)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Import snapshot" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("imports.commit", { handle: preview.handle }));
});
it("cancels a preview when leaving the page", async () => {
  const view = render(<MemoryRouter><ImportSection /></MemoryRouter>);
  await userEvent.click(screen.getByRole("button", { name: "Choose transcript" }));
  await screen.findByText("Historical session");
  view.unmount();
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("imports.cancel", { handle: preview.handle }));
});
it("requires a destination project before opening the native picker", () => {
  useAppStore.setState({ selectedProjectId: null, projects: [] });
  render(<MemoryRouter><ImportSection /></MemoryRouter>);
  expect(screen.getByRole("button", { name: "Choose transcript" })).toBeDisabled();
});
