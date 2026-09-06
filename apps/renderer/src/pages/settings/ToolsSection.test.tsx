/**
 * Settings ▸ Tools: covers Task B2's named "tools policy editing" requirement
 * — changing a row's decision select, adding a new policy, and removing one.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolPolicyEntry } from "@capygen/shared";
import { useAppStore } from "@/store/appStore";
import { ToolsSection } from "./ToolsSection";

const invoke = vi.fn();
vi.mock("@/lib/ipc", () => ({
  ipc: () => ({ invoke, on: () => () => {} }),
  hasBridge: () => true,
}));

const CLAUDE_POLICIES: ToolPolicyEntry[] = [
  { backend: "claude", pattern: "Bash(rm *)", decision: "deny", scope: "global" },
];

/** This window's selected project (7-P0); `null` unless a case sets one. */
function selectProject(projectId: string | null): void {
  useAppStore.setState({
    selectedProjectId: projectId,
    projects:
      projectId === null
        ? []
        : [
            { id: projectId, name: "alpha", path: "C:/tmp/alpha", layout: null, devServers: null, createdAt: 0, updatedAt: 0 },
          ],
  });
}

beforeEach(() => {
  selectProject(null);
  invoke.mockReset();
  invoke.mockImplementation((channel: string, args: { backend?: string }) => {
    if (channel === "integrations.list") {
      return Promise.resolve({
        mcpServers: [],
        plugins: [],
        skills: [],
        tools: args.backend === "claude" ? CLAUDE_POLICIES : [],
        lastSync: null,
      });
    }
    if (channel === "integrations.tools.setPolicy") {
      return Promise.resolve({ backend: "claude", pattern: "Bash(rm *)", decision: "allow", scope: "global" });
    }
    return Promise.resolve({ ok: true });
  });
});

describe("ToolsSection", () => {
  it("explains Claude's permission modes above the table on the Claude tab", async () => {
    render(<ToolsSection />);
    expect(await screen.findByTestId("claude-permission-modes")).toHaveTextContent("bypassPermissions");
  });

  it("lists existing policies with pattern/scope/decision", async () => {
    render(<ToolsSection />);
    const row = await screen.findByTestId("tool-policy-row-Bash(rm *)");
    expect(row).toHaveTextContent("global");
    expect(screen.getByTestId("tool-policy-decision-Bash(rm *)")).toHaveValue("deny");
  });

  it("editing a row's decision select calls integrations.tools.setPolicy", async () => {
    const user = userEvent.setup();
    render(<ToolsSection />);
    await screen.findByTestId("tool-policy-row-Bash(rm *)");

    await user.selectOptions(screen.getByTestId("tool-policy-decision-Bash(rm *)"), "allow");

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("integrations.tools.setPolicy", {
        backend: "claude",
        scope: "global",
        pattern: "Bash(rm *)",
        decision: "allow",
      }),
    );
  });

  it("adding a new policy is disabled with a blank pattern and submits once filled in", async () => {
    const user = userEvent.setup();
    render(<ToolsSection />);
    await screen.findByTestId("tool-policy-row-Bash(rm *)");

    expect(screen.getByTestId("tool-policy-add")).toBeDisabled();

    await user.type(screen.getByTestId("tool-policy-input-pattern"), "WebFetch(*)");
    await user.selectOptions(screen.getByTestId("tool-policy-input-decision"), "ask");
    expect(screen.getByTestId("tool-policy-add")).toBeEnabled();
    await user.click(screen.getByTestId("tool-policy-add"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("integrations.tools.setPolicy", {
        backend: "claude",
        scope: "global",
        pattern: "WebFetch(*)",
        decision: "ask",
      }),
    );
  });

  it("removing a policy calls integrations.tools.removePolicy", async () => {
    const user = userEvent.setup();
    render(<ToolsSection />);
    await screen.findByTestId("tool-policy-row-Bash(rm *)");

    await user.click(screen.getByTestId("tool-policy-remove-Bash(rm *)"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("integrations.tools.removePolicy", {
        backend: "claude",
        scope: "global",
        pattern: "Bash(rm *)",
      }),
    );
  });

  it("Codex tab has no permission-modes note and shows the empty state", async () => {
    const user = userEvent.setup();
    render(<ToolsSection />);
    await screen.findByTestId("tool-policy-row-Bash(rm *)");

    await user.click(screen.getByTestId("tools-tab-codex"));

    expect(screen.queryByTestId("claude-permission-modes")).not.toBeInTheDocument();
    expect(await screen.findByTestId("tools-panel-codex")).toHaveTextContent(/no tool policies/i);
  });

  // -------------------------------------------------------------------------
  // [review] Fixes from the Phase 6 review wave.
  // -------------------------------------------------------------------------

  it("says a Codex policy is not enforced yet and offers no Add form there", async () => {
    const user = userEvent.setup();
    render(<ToolsSection />);
    await screen.findByTestId("tool-policy-row-Bash(rm *)");
    // Claude *is* enforced, so its form is there.
    expect(screen.getByTestId("tool-policy-add")).toBeInTheDocument();
    expect(screen.queryByTestId("tools-not-enforced")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("tools-tab-codex"));

    expect(await screen.findByTestId("tools-not-enforced")).toHaveTextContent(/phase 9/i);
    expect(screen.queryByTestId("tool-policy-add")).not.toBeInTheDocument();
  });

  it("never offers session scope, which no turn reads", async () => {
    selectProject("p-alpha");
    render(<ToolsSection />);
    await screen.findByTestId("tool-policy-row-Bash(rm *)");
    const options = Array.from(
      screen.getByTestId("tool-policy-input-scope").querySelectorAll("option"),
    ).map((o) => o.getAttribute("value"));
    expect(options).toEqual(["global", "project"]);
  });

  // 7-P0: a `project` policy is written into `<project>/.claude/settings.json`,
  // and the main process refuses that write without an explicit project id.
  // Offering the scope with nothing selected would only offer an error.
  it("offers only global scope while no project is selected", async () => {
    render(<ToolsSection />);
    await screen.findByTestId("tool-policy-row-Bash(rm *)");
    const options = Array.from(
      screen.getByTestId("tool-policy-input-scope").querySelectorAll("option"),
    ).map((o) => o.getAttribute("value"));
    expect(options).toEqual(["global"]);
  });

  it("sends the selected project id on every read and write", async () => {
    selectProject("p-alpha");
    render(<ToolsSection />);
    await screen.findByTestId("tool-policy-row-Bash(rm *)");
    expect(invoke).toHaveBeenCalledWith(
      "integrations.list",
      expect.objectContaining({ backend: "claude", projectId: "p-alpha" }),
    );

    await userEvent.type(screen.getByTestId("tool-policy-input-pattern"), "Bash(ls)");
    await userEvent.click(screen.getByTestId("tool-policy-add"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "integrations.tools.setPolicy",
        expect.objectContaining({ pattern: "Bash(ls)", projectId: "p-alpha" }),
      ),
    );
  });

  it("sends no project id at all when none is selected", async () => {
    render(<ToolsSection />);
    await screen.findByTestId("tool-policy-row-Bash(rm *)");
    const [, args] = invoke.mock.calls.find(([channel]) => channel === "integrations.list") ?? [];
    expect(args).toEqual({ backend: "claude" });
  });

  it("badges an existing session-scope row as not enforced", async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === "integrations.list") {
        return Promise.resolve({
          mcpServers: [],
          plugins: [],
          skills: [],
          tools: [
            { backend: "claude", pattern: "Bash(x)", decision: "ask", scope: "session" },
          ] satisfies ToolPolicyEntry[],
          lastSync: null,
        });
      }
      return Promise.resolve({ ok: true });
    });
    render(<ToolsSection />);
    expect(await screen.findByTestId("tool-policy-unenforced-Bash(x)")).toBeInTheDocument();
  });

  it("shows a failed row action on the row instead of dropping it", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation((channel: string, args: { backend?: string }) => {
      if (channel === "integrations.list") {
        return Promise.resolve({
          mcpServers: [],
          plugins: [],
          skills: [],
          tools: args.backend === "claude" ? CLAUDE_POLICIES : [],
          lastSync: null,
        });
      }
      if (channel === "integrations.tools.removePolicy") {
        return Promise.reject(new Error("no settings file for the global policy scope"));
      }
      return Promise.resolve({ ok: true });
    });
    render(<ToolsSection />);
    await screen.findByTestId("tool-policy-row-Bash(rm *)");

    await user.click(screen.getByTestId("tool-policy-remove-Bash(rm *)"));

    expect(await screen.findByTestId("tool-policy-error-Bash(rm *)")).toHaveTextContent(
      /no settings file/,
    );
  });
});
