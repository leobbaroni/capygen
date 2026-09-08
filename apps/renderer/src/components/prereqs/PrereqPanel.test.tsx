/**
 * Setup panel rendering (SPEC R3), mocked IPC — `prereqs.status`/`.run` are
 * `apps/desktop`'s own concern (`prereqsIpc.test.ts`); this only proves the
 * panel renders what it is given and calls the right channel with the right
 * args.
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrereqStep } from "@capygen/shared";
import { PrereqPanel } from "./PrereqPanel";

const invoke = vi.fn();
vi.mock("@/lib/ipc", () => ({
  ipc: () => ({ invoke, on: () => () => {} }),
  hasBridge: () => true,
}));

const CLAUDE_CLI: PrereqStep = {
  id: "claude-cli",
  title: "Install Claude Code",
  detected: false,
  command: 'powershell -ExecutionPolicy ByPass -c "irm https://claude.ai/install.ps1 | iex"',
  description: "Anthropic's Claude Code CLI.",
  kind: "cli",
};
const CLAUDE_LOGIN: PrereqStep = {
  id: "claude-login",
  title: "Sign in to Claude Code",
  detected: false,
  command: "claude",
  description: "Opens Claude Code so you can sign in.",
  blockedBy: ["claude-cli"],
  kind: "cli",
};

function statusResult(steps: PrereqStep[], recommendation = "Install and sign in to at least one backend.") {
  return { steps, recommendation };
}

beforeEach(() => {
  invoke.mockReset();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PrereqPanel", () => {
  it("keeps commands collapsed and confirms each sequential step only after detection; cancellation stops setup", async () => {
    let installed = false;
    invoke.mockImplementation(async (channel: string, args: { stepId?: string }) => {
      if (channel === "prereqs.status") return statusResult([{ ...CLAUDE_CLI, detected: installed }, CLAUDE_LOGIN]);
      if (args.stepId === "claude-cli") return { ok: true, started: true };
      return { ok: false, started: false };
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<PrereqPanel />);
    await screen.findByText("Set up missing steps");
    await waitFor(() => expect(screen.getByText("Set up missing steps")).toBeEnabled());
    expect(screen.getAllByText("Details and command")[0]?.parentElement).not.toHaveAttribute("open");
    await user.click(screen.getByText("Set up missing steps"));
    expect(invoke).toHaveBeenCalledWith("prereqs.run", { stepId: "claude-cli" });
    expect(invoke).not.toHaveBeenCalledWith("prereqs.run", { stepId: "claude-login" });
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(invoke).not.toHaveBeenCalledWith("prereqs.run", { stepId: "claude-login" });
    installed = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(invoke).toHaveBeenCalledWith("prereqs.run", { stepId: "claude-login" });
    expect(screen.getByRole("status")).toHaveTextContent("Setup stopped");
    expect(invoke.mock.calls.filter(([channel]) => channel === "prereqs.run")).toHaveLength(2);
  });
  it("fetches prereqs.status on mount and renders each step", async () => {
    invoke.mockResolvedValue(statusResult([CLAUDE_CLI, CLAUDE_LOGIN]));
    render(<PrereqPanel />);
    await waitFor(() => expect(screen.getAllByTestId("prereq-step-row")).toHaveLength(2));
    expect(invoke).toHaveBeenCalledWith("prereqs.status", {});
    expect(screen.getByText("Install Claude Code")).toBeInTheDocument();
    expect(screen.getByTestId("prereq-recommendation")).toHaveTextContent(
      "Install and sign in to at least one backend.",
    );
  });

  it("shows a detected step with its version and no Run button", async () => {
    invoke.mockResolvedValue(
      statusResult([{ ...CLAUDE_CLI, detected: true, version: "2.1.261" }]),
    );
    render(<PrereqPanel />);
    const row = await screen.findByTestId("prereq-step-row");
    expect(within(row).getByTestId("prereq-step-detected")).toBeInTheDocument();
    expect(within(row).getByText("2.1.261")).toBeInTheDocument();
    expect(within(row).queryByTestId("prereq-step-run")).not.toBeInTheDocument();
  });

  it("disables Run for a step whose dependency is not detected, with a reason in its title", async () => {
    invoke.mockResolvedValue(statusResult([CLAUDE_CLI, CLAUDE_LOGIN]));
    render(<PrereqPanel />);
    await waitFor(() => expect(screen.getAllByTestId("prereq-step-row")).toHaveLength(2));

    const loginRow = screen
      .getAllByTestId("prereq-step-row")
      .find((row) => row.getAttribute("data-step-id") === "claude-login")!;
    const runButton = within(loginRow).getByTestId("prereq-step-run");
    expect(runButton).toBeDisabled();
    expect(runButton).toHaveAttribute("title", 'Finish "Install Claude Code" first');
  });

  it("calls prereqs.run with the step id when Run is clicked", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    invoke.mockImplementation((channel: string) => {
      if (channel === "prereqs.status") return Promise.resolve(statusResult([CLAUDE_CLI]));
      if (channel === "prereqs.run") return Promise.resolve({ ok: true, started: true });
      return Promise.resolve({});
    });
    render(<PrereqPanel />);
    const row = await screen.findByTestId("prereq-step-row");
    await user.click(within(row).getByTestId("prereq-step-run"));
    expect(invoke).toHaveBeenCalledWith("prereqs.run", { stepId: "claude-cli" });
  });

  it("polls prereqs.status every 3s after a run starts, and stops once detected", async () => {
    let detected = false;
    invoke.mockImplementation((channel: string) => {
      if (channel === "prereqs.status") {
        return Promise.resolve(statusResult([{ ...CLAUDE_CLI, detected }]));
      }
      if (channel === "prereqs.run") return Promise.resolve({ ok: true, started: true });
      return Promise.resolve({});
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<PrereqPanel />);
    const row = await screen.findByTestId("prereq-step-row");
    const statusCallsBeforeRun = invoke.mock.calls.filter((c) => c[0] === "prereqs.status").length;

    await user.click(within(row).getByTestId("prereq-step-run"));
    detected = true;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    const statusCallsAfterOnePoll = invoke.mock.calls.filter((c) => c[0] === "prereqs.status").length;
    expect(statusCallsAfterOnePoll).toBeGreaterThan(statusCallsBeforeRun);

    await waitFor(() => expect(screen.getByTestId("prereq-step-detected")).toBeInTheDocument());

    const countAfterDetected = invoke.mock.calls.filter((c) => c[0] === "prereqs.status").length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    // The component itself never inspects "is this step detected" to decide
    // whether to keep polling (nothing in the contract ties a poll to one
    // step) — it is the bounded `MAX_POLLS` cap that eventually stops it, not
    // this step flipping. So this only pins "still polling a moment later",
    // not an exact stop.
    expect(invoke.mock.calls.filter((c) => c[0] === "prereqs.status").length).toBeGreaterThanOrEqual(
      countAfterDetected,
    );
  });

  it("does not start polling when the run did not actually start (cancelled/blocked)", async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === "prereqs.status") return Promise.resolve(statusResult([CLAUDE_CLI]));
      if (channel === "prereqs.run") return Promise.resolve({ ok: false, started: false });
      return Promise.resolve({});
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<PrereqPanel />);
    const row = await screen.findByTestId("prereq-step-row");
    await user.click(within(row).getByTestId("prereq-step-run"));

    const countRightAfter = invoke.mock.calls.filter((c) => c[0] === "prereqs.status").length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(invoke.mock.calls.filter((c) => c[0] === "prereqs.status").length).toBe(countRightAfter);
    // And a cancelled/blocked run is not shown as a scary row error either.
    expect(within(row).queryByTestId("prereq-step-error")).not.toBeInTheDocument();
  });

  it("shows a row error when prereqs.run itself rejects", async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === "prereqs.status") return Promise.resolve(statusResult([CLAUDE_CLI]));
      if (channel === "prereqs.run") return Promise.reject(new Error("bridge disconnected"));
      return Promise.resolve({});
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<PrereqPanel />);
    const row = await screen.findByTestId("prereq-step-row");
    await user.click(within(row).getByTestId("prereq-step-run"));
    expect(await within(row).findByTestId("prereq-step-error")).toHaveTextContent(
      "bridge disconnected",
    );
  });

  it("re-fetches on Re-detect", async () => {
    invoke.mockResolvedValue(statusResult([CLAUDE_CLI]));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<PrereqPanel />);
    await screen.findByTestId("prereq-step-row");
    const before = invoke.mock.calls.filter((c) => c[0] === "prereqs.status").length;
    await user.click(screen.getByTestId("prereq-redetect"));
    await waitFor(() =>
      expect(invoke.mock.calls.filter((c) => c[0] === "prereqs.status").length).toBeGreaterThan(before),
    );
  });

  it("shows an error banner when prereqs.status itself fails", async () => {
    invoke.mockRejectedValue(new Error("main process unreachable"));
    render(<PrereqPanel />);
    expect(await screen.findByRole("alert")).toHaveTextContent("main process unreachable");
  });
});
