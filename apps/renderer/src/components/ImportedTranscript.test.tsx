import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { ImportedTranscript } from "./ImportedTranscript";
import { useAppStore } from "@/store/appStore";
const invoke = vi.fn();
vi.mock("@/lib/ipc", () => ({ ipc: () => ({ invoke }), hasBridge: () => true }));
beforeEach(() => {
  useAppStore.setState({ selectedProjectId: "p", projects: [{ id: "p", name: "Project", path: "C:/p", layout: null, devServers: null, createdAt: 0, updatedAt: 0 }], harnesses: [{ backend: "codex", label: "Codex", available: true, models: [{ id: "model", label: "Model" }], defaultModel: "model" }] });
  invoke.mockReset();
  invoke.mockImplementation(async (channel) => {
    if (channel === "imports.get") return { title: "History", backend: "codex", nativeId: "native", sourcePath: "C:/history.jsonl", sourceSha256: "a".repeat(64), importedAt: 0, counts: { entries: 1 }, warnings: [] };
    if (channel === "imports.entries") return [{ index: 0, kind: "activity", name: "Bash", label: "Bash", text: "<script>run()</script>", at: null, truncated: false }];
    if (channel === "imports.reference") return { text: "Quoted history", truncated: false };
    if (channel === "imports.continue") return { session: { id: "new" }, agents: [] };
    return [];
  });
});
it("renders historical activity as inert text without a run control", async () => {
  const view = render(<MemoryRouter><ImportedTranscript sessionId="s" /></MemoryRouter>);
  expect(await screen.findByText("<script>run()</script>")).toBeVisible();
  expect(view.container.querySelector("script")).toBeNull();
  expect(screen.queryByRole("button", { name: /run|approve/i })).toBeNull();
});
it("previews the reference and creates a fresh session only after selection", async () => {
  render(<MemoryRouter><ImportedTranscript sessionId="s" /></MemoryRouter>);
  await userEvent.click(await screen.findByRole("button", { name: "Continue in new session" }));
  expect(await screen.findByText("Quoted history")).toBeVisible();
  await userEvent.selectOptions(screen.getByLabelText("Harness"), "codex");
  await userEvent.click(screen.getByRole("button", { name: "Create new session" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("imports.continue", { sessionId: "s", projectId: "p", agent: { name: "Assistant", backend: "codex", model: "model", role: "lead", config: null } }));
  expect(invoke.mock.calls.some(([channel]) => channel === "chat.send")).toBe(false);
});
it("keeps the explicitly chosen API provider with its model", async () => {
  useAppStore.setState({ harnesses: [{ backend: "api", label: "API", available: true, providers: ["anthropic", "openai"], models: [{ id: "gpt-5.2", label: "GPT" }], defaultModel: "gpt-5.2" }] });
  render(<MemoryRouter><ImportedTranscript sessionId="s" /></MemoryRouter>);
  await userEvent.click(await screen.findByRole("button", { name: "Continue in new session" }));
  await screen.findByText("Quoted history");
  await userEvent.selectOptions(screen.getByLabelText("Harness"), "api");
  await userEvent.selectOptions(screen.getByLabelText("API provider"), "openai");
  await userEvent.click(screen.getByRole("button", { name: "Create new session" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("imports.continue", expect.objectContaining({ agent: expect.objectContaining({ model: "gpt-5.2", config: { api: { provider: "openai" } } }) })));
});
