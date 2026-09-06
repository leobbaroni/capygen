/**
 * Settings ▸ MCP servers: `integrations.*` mocked. Covers Task B2's named
 * "MCP add dialog validation" requirement — Save stays disabled until the
 * transport-appropriate required field is filled.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerEntry } from "@capygen/shared";
import { McpSection } from "./McpSection";

const invoke = vi.fn();
vi.mock("@/lib/ipc", () => ({
  ipc: () => ({ invoke, on: () => () => {} }),
  hasBridge: () => true,
}));

const CLAUDE_SERVERS: McpServerEntry[] = [
  {
    backend: "claude",
    name: "filesystem",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem"],
    scope: "user",
    source: "~/.claude/settings.json",
    enabled: true,
    status: "connected",
  },
  {
    backend: "claude",
    name: "higgsfield",
    transport: "claudeai-proxy",
    scope: "user",
    source: "live",
    enabled: true,
    status: "connected",
  },
];

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((channel: string, args: { backend: string }) => {
    if (channel === "integrations.list") {
      return Promise.resolve({
        mcpServers: args.backend === "claude" ? CLAUDE_SERVERS : [],
        plugins: [],
        skills: [],
        tools: [],
        lastSync: null,
      });
    }
    if (channel === "integrations.mcp.add" || channel === "integrations.mcp.update") {
      return Promise.resolve(CLAUDE_SERVERS[0]);
    }
    if (channel === "integrations.mcp.test") {
      return Promise.resolve({ ok: true, status: "connected", tools: ["read_file", "write_file"] });
    }
    return Promise.resolve({ ok: true });
  });
});

describe("McpSection", () => {
  it("lists claude's MCP servers with scope/source/status", async () => {
    render(<McpSection />);
    expect(await screen.findByTestId("mcp-row-filesystem")).toBeInTheDocument();
    const row = screen.getByTestId("mcp-row-filesystem");
    expect(within(row).getByText("user")).toBeInTheDocument();
    expect(within(row).getByText("connected")).toBeInTheDocument();
  });

  it("shows a managed-elsewhere note for a claudeai-proxy entry with no edit/remove", async () => {
    render(<McpSection />);
    const row = await screen.findByTestId("mcp-row-higgsfield");
    expect(within(row).getByText(/managed on claude\.ai/i)).toBeInTheDocument();
    expect(within(row).queryByTestId("mcp-edit-higgsfield")).not.toBeInTheDocument();
    expect(within(row).queryByTestId("mcp-remove-higgsfield")).not.toBeInTheDocument();
  });

  it("switches backend tabs and reloads that backend's empty list", async () => {
    const user = userEvent.setup();
    render(<McpSection />);
    await screen.findByTestId("mcp-row-filesystem");

    await user.click(screen.getByTestId("mcp-tab-codex"));

    expect(await screen.findByTestId("mcp-panel-codex")).toHaveTextContent(/no mcp servers/i);
    expect(invoke).toHaveBeenCalledWith("integrations.list", { backend: "codex" });
  });

  it("Test button reports the connection result", async () => {
    const user = userEvent.setup();
    render(<McpSection />);
    await screen.findByTestId("mcp-row-filesystem");

    await user.click(screen.getByTestId("mcp-test-filesystem"));

    expect(await screen.findByTestId("mcp-test-result-filesystem")).toHaveTextContent("Connected — 2 tools");
    expect(invoke).toHaveBeenCalledWith("integrations.mcp.test", { backend: "claude", name: "filesystem", scope: "user" });
  });

  it("Remove calls integrations.mcp.remove and reloads", async () => {
    const user = userEvent.setup();
    render(<McpSection />);
    await screen.findByTestId("mcp-row-filesystem");

    await user.click(screen.getByTestId("mcp-remove-filesystem"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("integrations.mcp.remove", { backend: "claude", scope: "user", name: "filesystem" }),
    );
  });

  describe("add dialog validation", () => {
    it("keeps Save disabled with no name, enables it once a stdio command is filled in, and submits", async () => {
      const user = userEvent.setup();
      render(<McpSection />);
      await screen.findByTestId("mcp-row-filesystem");

      await user.click(screen.getByTestId("mcp-add-button"));
      const dialog = await screen.findByTestId("mcp-dialog");
      expect(within(dialog).getByTestId("mcp-dialog-save")).toBeDisabled();

      await user.type(within(dialog).getByTestId("mcp-input-name"), "new-server");
      // Name alone is not enough for the default stdio transport — command is required too.
      expect(within(dialog).getByTestId("mcp-dialog-save")).toBeDisabled();

      await user.type(within(dialog).getByTestId("mcp-input-command"), "npx");
      expect(within(dialog).getByTestId("mcp-dialog-save")).toBeEnabled();

      await user.click(within(dialog).getByTestId("mcp-dialog-save"));

      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith(
          "integrations.mcp.add",
          expect.objectContaining({
            backend: "claude",
            scope: "user",
            entry: expect.objectContaining({ name: "new-server", transport: "stdio", command: "npx" }),
          }),
        ),
      );
    });

    it("requires a valid http(s) URL for the http transport instead of a command", async () => {
      const user = userEvent.setup();
      render(<McpSection />);
      await screen.findByTestId("mcp-row-filesystem");

      await user.click(screen.getByTestId("mcp-add-button"));
      const dialog = await screen.findByTestId("mcp-dialog");
      await user.type(within(dialog).getByTestId("mcp-input-name"), "http-server");
      await user.selectOptions(within(dialog).getByTestId("mcp-select-transport"), "http");
      expect(within(dialog).getByTestId("mcp-dialog-save")).toBeDisabled();

      await user.type(within(dialog).getByTestId("mcp-input-url"), "not-a-url");
      expect(within(dialog).getByTestId("mcp-dialog-save")).toBeDisabled();

      await user.clear(within(dialog).getByTestId("mcp-input-url"));
      await user.type(within(dialog).getByTestId("mcp-input-url"), "https://example.com/mcp");
      expect(within(dialog).getByTestId("mcp-dialog-save")).toBeEnabled();
    });

    it("Cancel closes the dialog without saving", async () => {
      const user = userEvent.setup();
      render(<McpSection />);
      await screen.findByTestId("mcp-row-filesystem");

      await user.click(screen.getByTestId("mcp-add-button"));
      await screen.findByTestId("mcp-dialog");
      await user.click(screen.getByTestId("mcp-dialog-cancel"));

      expect(screen.queryByTestId("mcp-dialog")).not.toBeInTheDocument();
      expect(invoke).not.toHaveBeenCalledWith("integrations.mcp.add", expect.anything());
    });
  });

  it("edit dialog pre-fills the existing server and calls integrations.mcp.update", async () => {
    const user = userEvent.setup();
    render(<McpSection />);
    await screen.findByTestId("mcp-row-filesystem");

    await user.click(screen.getByTestId("mcp-edit-filesystem"));
    const dialog = await screen.findByTestId("mcp-dialog");
    expect(within(dialog).getByTestId("mcp-input-name")).toHaveValue("filesystem");
    expect(within(dialog).getByTestId("mcp-input-command")).toHaveValue("npx");

    await user.click(within(dialog).getByTestId("mcp-dialog-save"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "integrations.mcp.update",
        expect.objectContaining({ backend: "claude", scope: "user", name: "filesystem" }),
      ),
    );
  });
});
