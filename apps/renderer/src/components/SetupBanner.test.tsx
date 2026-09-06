/**
 * The landing banner (SPEC R3) — when it shows at all, whether it is the
 * compact link-out banner or the full inline panel, and that clicking it
 * navigates to Settings ▸ Prerequisites.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessInfo, PrereqStep } from "@capygen/shared";
import { useAppStore } from "@/store/appStore";
import { SetupBanner } from "./SetupBanner";

const invoke = vi.fn();
vi.mock("@/lib/ipc", () => ({
  ipc: () => ({ invoke, on: () => () => {} }),
  hasBridge: () => true,
}));

const AVAILABLE: HarnessInfo = {
  backend: "claude",
  label: "Claude Code",
  available: true,
  models: [{ id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" }],
  defaultModel: "claude-sonnet-4-5",
};
const UNAVAILABLE_CLAUDE: HarnessInfo = { ...AVAILABLE, available: false, reason: "not signed in" };
const UNAVAILABLE_CODEX: HarnessInfo = {
  backend: "codex",
  label: "Codex",
  available: false,
  reason: "not signed in",
  models: [],
  defaultModel: "",
};
const UNAVAILABLE_API: HarnessInfo = {
  backend: "api",
  label: "API model",
  available: false,
  reason: "no key",
  models: [],
  defaultModel: "",
};

function step(over: Partial<PrereqStep>): PrereqStep {
  return {
    id: "claude-cli",
    title: "Install Claude Code",
    detected: false,
    command: "x",
    description: "",
    kind: "cli",
    ...over,
  };
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderBanner() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<SetupBanner />} />
        <Route path="/settings/:section" element={<div data-testid="settings-stub" />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue({ steps: [], recommendation: "" });
  useAppStore.setState({ harnesses: [] });
});

describe("SetupBanner", () => {
  it("renders nothing before harness.list has resolved", () => {
    renderBanner();
    expect(screen.queryByTestId("setup-banner")).not.toBeInTheDocument();
    expect(screen.queryByTestId("setup-banner-inline")).not.toBeInTheDocument();
  });

  it("renders nothing once at least one backend is available", () => {
    useAppStore.setState({ harnesses: [AVAILABLE, UNAVAILABLE_CODEX, UNAVAILABLE_API] });
    renderBanner();
    expect(screen.queryByTestId("setup-banner")).not.toBeInTheDocument();
    expect(screen.queryByTestId("setup-banner-inline")).not.toBeInTheDocument();
  });

  it("shows the compact banner when a CLI is installed but nothing is signed in", async () => {
    invoke.mockResolvedValue({
      steps: [step({ id: "claude-cli", detected: true }), step({ id: "codex-cli", detected: false })],
      recommendation: "",
    });
    useAppStore.setState({ harnesses: [UNAVAILABLE_CLAUDE, UNAVAILABLE_CODEX, UNAVAILABLE_API] });
    renderBanner();
    expect(await screen.findByTestId("setup-banner")).toHaveTextContent(
      "Set up Claude Code or Codex to start",
    );
    expect(screen.queryByTestId("setup-banner-inline")).not.toBeInTheDocument();
  });

  it("navigates to Settings ▸ Prerequisites when the compact banner is clicked", async () => {
    invoke.mockResolvedValue({
      steps: [step({ id: "claude-cli", detected: true })],
      recommendation: "",
    });
    useAppStore.setState({ harnesses: [UNAVAILABLE_CLAUDE, UNAVAILABLE_CODEX, UNAVAILABLE_API] });
    const user = userEvent.setup();
    renderBanner();
    await user.click(await screen.findByTestId("setup-banner"));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/settings/prereqs"));
  });

  it("shows the full panel inline on a genuinely fresh machine (no CLI installed at all)", async () => {
    invoke.mockResolvedValue({
      steps: [step({ id: "claude-cli", detected: false }), step({ id: "codex-cli", detected: false })],
      recommendation: "Install and sign in to at least one backend.",
    });
    useAppStore.setState({ harnesses: [UNAVAILABLE_CLAUDE, UNAVAILABLE_CODEX, UNAVAILABLE_API] });
    renderBanner();
    expect(await screen.findByTestId("setup-banner-inline")).toBeInTheDocument();
    expect(screen.queryByTestId("setup-banner")).not.toBeInTheDocument();
    // The inline panel is the real PrereqPanel, not a stand-in.
    expect(await screen.findByTestId("prereq-panel")).toBeInTheDocument();
  });
});
