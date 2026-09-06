import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticsInfo } from "@capygen/shared";
import { DiagnosticsSection } from "./DiagnosticsSection";

const invoke = vi.fn();
vi.mock("@/lib/ipc", () => ({
  ipc: () => ({ invoke, on: () => () => {} }),
  hasBridge: () => true,
}));

const INFO: DiagnosticsInfo = {
  versions: { app: "0.12.1", electron: "44.2.0", node: "24.20.0", claude: "2.1.261" },
  paths: { userData: "C:/Users/tuga/AppData/Roaming/capygen", dbFile: "capygen.db" },
  harnessAvailability: [
    { backend: "claude", available: true },
    { backend: "codex", available: false, reason: "Codex is not signed in" },
    { backend: "api", available: false, reason: "No API key configured" },
  ],
  dbSizeBytes: 2_500_000,
  logDir: "C:/Users/tuga/AppData/Roaming/capygen/logs",
};

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((channel: string) => {
    if (channel === "diagnostics.get") return Promise.resolve(INFO);
    return Promise.resolve({ ok: true });
  });
});

describe("DiagnosticsSection", () => {
  it("renders versions, paths, backend availability and DB size", async () => {
    render(<DiagnosticsSection />);
    expect(await screen.findByTestId("settings-diagnostics")).toBeInTheDocument();
    expect(screen.getByTestId("diagnostics-versions")).toHaveTextContent("44.2.0");
    expect(screen.getByTestId("diagnostics-paths")).toHaveTextContent("capygen.db");
    expect(screen.getByTestId("diagnostics-harnesses")).toHaveTextContent("Codex is not signed in");
    expect(screen.getByTestId("diagnostics-db-size")).toHaveTextContent("2.4 MB");
  });

  it("Copy calls diagnostics.copy and shows a confirmation", async () => {
    const user = userEvent.setup();
    render(<DiagnosticsSection />);
    await screen.findByTestId("settings-diagnostics");

    await user.click(screen.getByTestId("diagnostics-copy"));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("diagnostics.copy", {}));
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });
});
