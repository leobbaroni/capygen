/**
 * Continuing from a received bundle (P15).
 *
 * The distinction the dialog has to make unmistakable is that this is a *new*
 * session, not a resumed one. The cases below pin the payload it sends, the
 * quotation it shows, and the gating that stops it starting something the
 * machine cannot actually run.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { useAppStore } from "@/store/appStore";
import { SharedContinueDialog } from "./SharedContinueDialog";

const invoke = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", () => ({
  ipc: () => ({ invoke, on: () => () => {} }),
  hasBridge: () => true,
}));
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navigate,
}));

const view = () =>
  render(
    <MemoryRouter>
      <SharedContinueDialog sessionId="ses_shared" open onOpenChange={() => {}} />
    </MemoryRouter>,
  );

beforeEach(() => {
  navigate.mockReset();
  invoke.mockReset();
  useAppStore.setState({
    projects: [{ id: "prj_1", name: "capygen", path: "C:/dev/capygen", layout: null, devServers: null, createdAt: 0, updatedAt: 0 }],
    selectedProjectId: "prj_1",
    harnesses: [
      { backend: "claude", label: "Claude Code", available: true, reason: null,
        defaultModel: "claude-opus-5", models: [{ id: "claude-opus-5", label: "Opus 5" }] },
      { backend: "codex", label: "Codex", available: false, reason: "not installed",
        defaultModel: "", models: [] },
    ] as never,
  });
  invoke.mockImplementation((channel: string) => {
    if (channel === "sharing.reference") {
      return Promise.resolve({ text: "--- shared transcript ---\nassistant: hello", truncated: true });
    }
    if (channel === "sharing.continue") {
      return Promise.resolve({ session: { id: "ses_new" }, agents: [{ id: "agt_new" }] });
    }
    return Promise.resolve({});
  });
});

describe("SharedContinueDialog", () => {
  it("says plainly that this starts a new session and resumes nothing", async () => {
    view();
    const panel = await screen.findByTestId("shared-continue");
    expect(panel).toHaveTextContent(/new.*session/i);
    expect(panel).toHaveTextContent(/is not resumed/i);
    expect(panel).toHaveTextContent(/nothing in it can configure a backend or run a tool/i);
    expect(panel).toHaveTextContent(/does not send a model request/i);
  });

  it("shows the bounded quotation main built, and says it was shortened", async () => {
    view();
    expect(await screen.findByTestId("shared-continue-reference"))
      .toHaveTextContent("assistant: hello");
    expect(invoke).toHaveBeenCalledWith("sharing.reference", { sessionId: "ses_shared" });
    expect(screen.getByTestId("shared-continue")).toHaveTextContent(/shortened to fit/i);
  });

  it("creates the session with a brand-new agent this machine chose", async () => {
    const user = userEvent.setup();
    view();
    await screen.findByTestId("shared-continue-reference");
    await user.selectOptions(screen.getByLabelText("Harness"), "claude");
    await user.selectOptions(screen.getByLabelText("Model"), "claude-opus-5");
    await user.click(screen.getByTestId("shared-continue-create"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("sharing.continue", {
        sessionId: "ses_shared",
        projectId: "prj_1",
        agent: { name: "Assistant", backend: "claude", model: "claude-opus-5", role: "lead", config: null },
      }),
    );
    // Nothing from the sender is named in the payload — no bundle id, no agent
    // id, no conversation to resume.
    const payload = JSON.stringify(invoke.mock.calls.find((c) => c[0] === "sharing.continue")?.[1]);
    expect(payload).not.toMatch(/bundleId|nativeId|resume/i);
    expect(navigate).toHaveBeenCalledWith("/c/ses_new");
  });

  it("will not start until a project, harness and model are chosen", async () => {
    const user = userEvent.setup();
    view();
    await screen.findByTestId("shared-continue-reference");
    expect(screen.getByTestId("shared-continue-create")).toBeDisabled();

    await user.selectOptions(screen.getByLabelText("Harness"), "claude");
    // The default model comes with the harness, so this is now startable.
    await waitFor(() => expect(screen.getByTestId("shared-continue-create")).not.toBeDisabled());
    expect(invoke.mock.calls.some((c) => c[0] === "sharing.continue")).toBe(false);
  });

  it("does not offer a harness this machine cannot run", async () => {
    view();
    await screen.findByTestId("shared-continue-reference");
    const codex = screen.getByRole("option", { name: /Codex/ }) as HTMLOptionElement;
    expect(codex).toBeDisabled();
    expect(codex.textContent).toContain("not installed");
  });

  it("surfaces a refusal instead of navigating to a session that was not made", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation((channel: string) => {
      if (channel === "sharing.reference") return Promise.resolve({ text: "quoted", truncated: false });
      if (channel === "sharing.continue") {
        return Promise.reject(new Error("continuation source must be a received shared bundle"));
      }
      return Promise.resolve({});
    });
    view();
    await screen.findByTestId("shared-continue-reference");
    await user.selectOptions(screen.getByLabelText("Harness"), "claude");
    await user.click(screen.getByTestId("shared-continue-create"));

    expect(await screen.findByTestId("shared-continue-error"))
      .toHaveTextContent(/received shared bundle/);
    expect(navigate).not.toHaveBeenCalled();
  });
});
