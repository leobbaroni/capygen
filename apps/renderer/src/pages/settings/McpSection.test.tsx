/**
 * Settings ▸ MCP servers: `integrations.*` mocked. Covers Task B2's named
 * "MCP add dialog validation" requirement — Save stays disabled until the
 * transport-appropriate required field is filled.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerEntry } from "@capygen/shared";
import { useAppStore } from "@/store/appStore";
import { McpSection, envRecord, parseArgs, readOnlyReason, scopeOptionsFor, secretMutation } from "./McpSection";

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
  // [review] An `sse` entry used to get an Edit button whose form collapsed it
  // to stdio with an empty command; saving rewrote the registration.
  {
    backend: "claude",
    name: "legacy-sse",
    transport: "sse",
    url: "https://example.com/sse",
    scope: "user",
    source: "~/.claude.json",
    enabled: true,
  },
];

function selectProject(projectId: string | null): void {
  useAppStore.setState({
    selectedProjectId: projectId,
    projects:
      projectId === null
        ? []
        : [
            { id: projectId, name: projectId, path: `C:/tmp/${projectId}`, layout: null, devServers: null, createdAt: 0, updatedAt: 0 },
            { id: "p-b", name: "p-b", path: "C:/tmp/p-b", layout: null, devServers: null, createdAt: 0, updatedAt: 0 },
          ],
  });
}

beforeEach(() => {
  selectProject(null);
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

  // -------------------------------------------------------------------------
  // [review] Fixes from the Phase 6 review wave.
  // -------------------------------------------------------------------------

  it("shows an sse entry read-only rather than an Edit form that would rewrite it as stdio", async () => {
    render(<McpSection />);
    const row = await screen.findByTestId("mcp-row-legacy-sse");
    expect(within(row).getByText(/sse servers are shown read-only/i)).toBeInTheDocument();
    expect(within(row).queryByTestId("mcp-edit-legacy-sse")).not.toBeInTheDocument();
    expect(within(row).queryByTestId("mcp-remove-legacy-sse")).not.toBeInTheDocument();
  });

  it("renders a failed inline action on the row instead of dropping it", async () => {
    const user = userEvent.setup();
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
      if (channel === "integrations.mcp.remove") {
        return Promise.reject(new Error("plugin-scope MCP servers belong to the plugin"));
      }
      return Promise.resolve({ ok: true });
    });
    render(<McpSection />);
    await screen.findByTestId("mcp-row-filesystem");

    await user.click(screen.getByTestId("mcp-remove-filesystem"));

    expect(await screen.findByTestId("mcp-row-error-filesystem")).toHaveTextContent(
      /belong to the plugin/,
    );
  });

  it("Refresh asks the backend again", async () => {
    const user = userEvent.setup();
    render(<McpSection />);
    await screen.findByTestId("mcp-row-filesystem");

    await user.click(screen.getByTestId("mcp-sync-button"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("integrations.refresh", { backend: "claude" }),
    );
  });

  it("sends args: [] when the Arguments field is cleared, and the env pairs", async () => {
    const user = userEvent.setup();
    render(<McpSection />);
    await screen.findByTestId("mcp-row-filesystem");

    await user.click(screen.getByTestId("mcp-edit-filesystem"));
    const dialog = await screen.findByTestId("mcp-dialog");
    await user.clear(within(dialog).getByTestId("mcp-input-args"));
    await user.click(within(dialog).getByTestId("mcp-env-add"));
    await user.type(within(dialog).getByTestId("mcp-env-key-0"), "API_KEY");
    await user.type(within(dialog).getByTestId("mcp-env-value-0"), "s3cret");
    await user.click(within(dialog).getByTestId("mcp-dialog-save"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "integrations.mcp.update",
        expect.objectContaining({
          // `[]`, not `undefined`: both stores merge with `patch.args ?? existing.args`.
          patch: expect.objectContaining({ args: [], env: { API_KEY: "s3cret" } }),
        }),
      ),
    );
  });
});

describe("scope options follow what the backend's store can actually write", () => {
  it("offers only User for codex and api, and needs a project for Claude's other two", () => {
    expect(scopeOptionsFor("codex", true).map((o) => o.value)).toEqual(["user"]);
    expect(scopeOptionsFor("api", true).map((o) => o.value)).toEqual(["user"]);
    expect(scopeOptionsFor("claude", false).map((o) => o.value)).toEqual(["user"]);
    expect(scopeOptionsFor("claude", true).map((o) => o.value)).toEqual([
      "user",
      "project",
      "local",
    ]);
  });
});

describe("readOnlyReason", () => {
  it("names every row capygen's stores refuse to write", () => {
    const base: McpServerEntry = {
      backend: "api",
      name: "x",
      transport: "stdio",
      scope: "user",
      source: "s",
      enabled: true,
    };
    expect(readOnlyReason(base)).toBeNull();
    expect(readOnlyReason({ ...base, inherited: true })).toMatch(/inherited/i);
    expect(readOnlyReason({ ...base, scope: "plugin" })).toMatch(/plugin/i);
    expect(readOnlyReason({ ...base, transport: "sse" })).toMatch(/sse/i);
    expect(readOnlyReason({ ...base, transport: "claudeai-proxy" })).toMatch(/claude\.ai/i);
  });
});

describe("envRecord", () => {
  it("drops blank keys and keeps the rest verbatim", () => {
    expect(envRecord([{ key: " API_KEY ", value: "v" }, { key: "  ", value: "ignored" }])).toEqual({
      API_KEY: "v",
    });
  });
});

describe("parseArgs", () => {
  it("keeps spaces and Windows paths inside one line", () => {
    expect(parseArgs("--flag\nC:\\Program Files\\server.js\nvalue with spaces")).toEqual([
      "--flag", "C:\\Program Files\\server.js", "value with spaces",
    ]);
  });
});

describe("secretMutation", () => {
  it("preserves blank existing values, replaces edited values, and removes deleted keys", () => {
    expect(secretMutation([
      { key: "KEEP", value: "" },
      { key: "CHANGE", value: "next" },
      { key: "NEW", value: "value" },
    ], ["KEEP", "CHANGE", "REMOVE"])).toEqual({ CHANGE: "next", NEW: "value", REMOVE: null });
  });
});

/**
 * [review] The add/edit dialog is filled in over seconds, and the selected
 * project (or the backend tab) can move under it in that time. Reading the live
 * scope at submit wrote the row the user was looking at in project A into
 * project B — into a file they never opened. The dialog is addressed to the
 * scope it opened on, and a scope that has moved refuses instead of guessing.
 */
describe("McpDialog carries the scope it opened on", () => {
  it("sends the captured projectId with the add", async () => {
    const user = userEvent.setup();
    selectProject("p-a");
    render(<McpSection />);
    await screen.findByTestId("mcp-row-filesystem");
    await user.click(screen.getByTestId("mcp-add-button"));
    const dialog = await screen.findByTestId("mcp-dialog");
    await user.type(within(dialog).getByTestId("mcp-input-name"), "capyfixture");
    await user.type(within(dialog).getByTestId("mcp-input-command"), "node");
    await user.click(within(dialog).getByTestId("mcp-dialog-save"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "integrations.mcp.add",
        expect.objectContaining({ backend: "claude", projectId: "p-a" }),
      ),
    );
  });

  it("closes rather than writing when the selected project moves under it", async () => {
    const user = userEvent.setup();
    selectProject("p-a");
    render(<McpSection />);
    await screen.findByTestId("mcp-row-filesystem");
    await user.click(screen.getByTestId("mcp-add-button"));
    const dialog = await screen.findByTestId("mcp-dialog");
    await user.type(within(dialog).getByTestId("mcp-input-name"), "capyfixture");
    await user.type(within(dialog).getByTestId("mcp-input-command"), "node");

    // Another part of the window moves this window to project B.
    await waitFor(async () => {
      useAppStore.setState({ selectedProjectId: "p-b" });
    });

    await waitFor(() => expect(screen.queryByTestId("mcp-dialog")).not.toBeInTheDocument());
    expect(
      invoke.mock.calls.filter(([channel]) => channel === "integrations.mcp.add"),
    ).toEqual([]);
  });
});
