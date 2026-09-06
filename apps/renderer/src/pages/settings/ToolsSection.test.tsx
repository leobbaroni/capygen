/**
 * Settings ▸ Tools: covers Task B2's named "tools policy editing" requirement
 * — changing a row's decision select, adding a new policy, and removing one.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolPolicyEntry } from "@capygen/shared";
import { ToolsSection } from "./ToolsSection";

const invoke = vi.fn();
vi.mock("@/lib/ipc", () => ({
  ipc: () => ({ invoke, on: () => () => {} }),
  hasBridge: () => true,
}));

const CLAUDE_POLICIES: ToolPolicyEntry[] = [
  { backend: "claude", pattern: "Bash(rm *)", decision: "deny", scope: "global" },
];

beforeEach(() => {
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
});
