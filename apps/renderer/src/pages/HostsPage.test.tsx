import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { HarnessInfo } from "@capygen/shared";
import { HostsPage } from "./HostsPage";
import { useAppStore } from "@/store/appStore";

const harnesses: HarnessInfo[] = [
  { backend: "claude", label: "Claude Code", available: true, models: [{ id: "sonnet", label: "Sonnet" }], defaultModel: "sonnet" },
  { backend: "codex", label: "Codex", available: false, reason: "Not signed in", models: [], defaultModel: "gpt-5" },
  { backend: "api", label: "API models", available: true, models: [{ id: "claude-sonnet", label: "Claude Sonnet" }, { id: "gpt-5", label: "GPT-5" }], defaultModel: "claude-sonnet", providers: ["anthropic"] },
];

const invoke = vi.fn(async (channel: string) => {
  expect(channel).toBe("harness.list");
  return harnesses;
});

vi.mock("@/lib/ipc", () => ({
  ipc: () => ({ invoke }),
  hasBridge: () => true,
}));

function renderPage() {
  return render(<MemoryRouter><HostsPage /></MemoryRouter>);
}

beforeEach(() => {
  invoke.mockClear();
  useAppStore.setState({ harnesses: [] });
});

it("shows this machine's backend status and model counts", async () => {
  useAppStore.setState({ harnesses });
  renderPage();
  expect(screen.getByRole("heading", { name: "Hosts" })).toBeVisible();
  expect(screen.getByText("Local machine")).toBeVisible();
  expect(screen.getByTestId("host-status-claude")).toHaveTextContent("Available");
  expect(screen.getByTestId("host-status-codex")).toHaveTextContent("Not signed in");
  expect(screen.getByTestId("host-model-count-api")).toHaveTextContent("2 models");
  expect(screen.queryByRole("button", { name: /terminal attach/i })).not.toBeInTheDocument();
});

it("shows an unchecked status when the initial probe fails", async () => {
  invoke.mockRejectedValueOnce(new Error("probe failed"));
  renderPage();
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("probe failed"));
  expect(screen.getByTestId("host-status-claude")).toHaveTextContent("Not checked");
});

it("refreshes the catalogue and reports failures", async () => {
  renderPage();
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("harness.list", {}));
  expect(screen.getByTestId("host-status-claude")).toHaveTextContent("Available");
  invoke.mockRejectedValueOnce(new Error("probe failed"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh host status" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("probe failed"));
});
