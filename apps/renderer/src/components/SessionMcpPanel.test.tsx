import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Agent, AgentToolCatalogue } from "@capygen/shared";
import {
  SessionMcpPanel,
  describeServer,
  disabledLabel,
  parseCommandLine,
  readSessionServers,
  validateDraft,
} from "./SessionMcpPanel";

const agent = (mcpServers?: unknown, backend: "claude" | "codex" = "claude"): Agent => ({
  id: "agt_1", sessionId: "ses_1", name: "Assistant", backend,
  model: "claude-opus-5", role: "lead", createdAt: 1, updatedAt: 1,
  config: mcpServers === undefined ? null : { [backend]: { mcpServers } },
} as unknown as Agent);

const panel = (props: Partial<Parameters<typeof SessionMcpPanel>[0]> = {}) => {
  const onChange = vi.fn();
  const onRefresh = vi.fn();
  render(<SessionMcpPanel
    agent={agent({ docs: { command: "node", args: ["docs.js"] } })}
    catalogue={null} onChange={onChange} onRefresh={onRefresh} {...props} />);
  return { onChange, onRefresh };
};

describe("editing one server never rewrites the others", () => {
  /**
   * The regression this file exists for. Every write replaces the whole
   * `mcpServers` map, so rebuilding each entry as `{command, args, disabled}`
   * silently destroyed the `url`, `transport` and `cwd` of every *other*
   * server the moment one was added, removed or toggled.
   */
  const mixed = {
    remote: { transport: "http", url: "https://example.invalid/mcp" },
    local: { command: "node", args: ["a.js"], cwd: "C:\\work", startupTimeoutMs: 9000 },
  };

  it("keeps every other server's fields when one is added", () => {
    const { onChange } = panel({ agent: agent(mixed) });
    fireEvent.change(screen.getByTestId("session-mcp-name"), { target: { value: "extra" } });
    fireEvent.change(screen.getByTestId("session-mcp-command"), { target: { value: "node b.js" } });
    fireEvent.click(screen.getByTestId("session-mcp-add"));
    expect(onChange).toHaveBeenCalledWith({
      remote: { transport: "http", url: "https://example.invalid/mcp" },
      local: { command: "node", args: ["a.js"], cwd: "C:\\work", startupTimeoutMs: 9000 },
      extra: { command: "node", args: ["b.js"] },
    });
  });

  it("keeps every other server's fields when one is toggled", () => {
    const { onChange } = panel({ agent: agent(mixed) });
    fireEvent.click(screen.getByTestId("session-mcp-toggle-local"));
    expect(onChange).toHaveBeenCalledWith({
      remote: { transport: "http", url: "https://example.invalid/mcp" },
      local: {
        command: "node", args: ["a.js"], cwd: "C:\\work", startupTimeoutMs: 9000, disabled: true,
      },
    });
  });

  it("keeps every other server's fields when one is removed", () => {
    const { onChange } = panel({ agent: agent(mixed) });
    fireEvent.click(screen.getByTestId("session-mcp-remove-local"));
    expect(onChange).toHaveBeenCalledWith({
      remote: { transport: "http", url: "https://example.invalid/mcp" },
    });
  });

  it("removes only the disabled flag when re-enabling, leaving the rest", () => {
    const { onChange } = panel({
      agent: agent({ local: { command: "node", cwd: "C:\\work", disabled: true } }),
    });
    fireEvent.click(screen.getByTestId("session-mcp-toggle-local"));
    expect(onChange).toHaveBeenCalledWith({ local: { command: "node", cwd: "C:\\work" } });
  });

  it("describes an http server by its url rather than an empty command", () => {
    expect(describeServer(readSessionServers(agent(mixed))[0]!))
      .toBe("http · https://example.invalid/mcp");
    expect(describeServer(readSessionServers(agent(mixed))[1]!)).toBe("node a.js");
  });
});

describe("an entry holding hidden credentials is not rewritten", () => {
  /**
   * `redactInlineAgentMcpCredentials` deletes `env`/`headers` and leaves
   * name-only markers, so the renderer never holds the values. Writing the
   * markers back would persist invented keys; writing without them would drop
   * the user's credentials. Neither is this panel's decision.
   */
  const legacy = { secretive: { command: "node", envKeys: ["API_TOKEN"] } };

  it("locks the editor and says which server and why", () => {
    const { onChange } = panel({ agent: agent(legacy) });
    expect(screen.getByTestId("session-mcp-locked").textContent)
      .toMatch(/"secretive" stores credentials.*Settings ▸ MCP servers/s);
    fireEvent.click(screen.getByTestId("session-mcp-remove-secretive"));
    fireEvent.click(screen.getByTestId("session-mcp-toggle-secretive"));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("session-mcp-add")).toBeDisabled();
  });

  it("does not print the redacted key names into the row", () => {
    panel({ agent: agent(legacy) });
    expect(screen.getByTestId("session-mcp-item-secretive").textContent).not.toMatch(/API_TOKEN/);
  });

  it("reads the marker without treating it as configuration", () => {
    const [server] = readSessionServers(agent(legacy));
    expect(server!.holdsHiddenCredentials).toBe(true);
    expect(readSessionServers(agent({ plain: { command: "node" } }))[0]!.holdsHiddenCredentials)
      .toBe(false);
  });
});

describe("a disable is a request, not an observed outcome", () => {
  const off = { docs: { command: "node", disabled: true } };

  it("separates the request from what Codex reports", () => {
    // Codex merges a per-thread config with the home's config.toml, so
    // omission suppresses nothing and the `enabled` key's per-thread effect is
    // pending restart. The observed backend status stays visible.
    panel({
      agent: agent(off, "codex"),
      catalogue: { kind: "ok", truncated: false, servers: [
        { name: "docs", state: "connected", tools: ["a"], truncated: false },
      ] },
    });
    const label = screen.getByTestId("session-mcp-state-docs").textContent ?? "";
    expect(label).toMatch(/Disable requested/);
    expect(label).toMatch(/backend reports: Connected/);
  });

  it("states the effect plainly for Claude, whose resolved set is authoritative", () => {
    expect(disabledLabel("claude", "Not running")).toMatch(/^Disabled for this session/);
    expect(disabledLabel("codex", "Not running")).toMatch(/^Disable requested/);
    // Either way the observation is carried, never replaced by the request.
    expect(disabledLabel("claude", "Connected · 2 tools")).toMatch(/Connected · 2 tools/);
  });
});

describe("names and command lines are validated the way the engine validates them", () => {
  it("rejects the reserved names the engine also refuses", () => {
    for (const name of ["__proto__", "constructor", "prototype", "toString"]) {
      expect(validateDraft(name, "node x.js", []), name).toMatch(/reserved/);
    }
  });

  it("refuses an unmatched quote instead of tokenising it into nonsense", () => {
    const broken = parseCommandLine('"C:\\Program Files\\node.exe server.js');
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.reason).toMatch(/unmatched quote/);
    expect(validateDraft("svc", '"C:\\Program Files\\node.exe', [])).toMatch(/unmatched quote/);
  });

  it("keeps a properly quoted path whole", () => {
    const parsed = parseCommandLine('"C:\\Program Files\\node.exe" server.js');
    expect(parsed).toEqual({ ok: true, command: "C:\\Program Files\\node.exe", args: ["server.js"] });
  });

  it("does not add a server whose command line cannot be parsed", () => {
    const { onChange } = panel({ agent: agent() });
    fireEvent.change(screen.getByTestId("session-mcp-name"), { target: { value: "svc" } });
    fireEvent.change(screen.getByTestId("session-mcp-command"), { target: { value: 'node "a.js' } });
    fireEvent.click(screen.getByTestId("session-mcp-add"));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("session-mcp-problem").textContent).toMatch(/unmatched quote/);
  });
});

describe("editing writes through the ordinary agent config", () => {
  it("adds a credential-free stdio server with its arguments split", () => {
    const { onChange } = panel({ agent: agent() });
    fireEvent.change(screen.getByTestId("session-mcp-name"), { target: { value: "docs" } });
    fireEvent.change(screen.getByTestId("session-mcp-command"),
      { target: { value: "npx -y @scope/server" } });
    fireEvent.click(screen.getByTestId("session-mcp-add"));
    expect(onChange).toHaveBeenCalledWith({
      docs: { command: "npx", args: ["-y", "@scope/server"] },
    });
  });

  it("refuses a credential rather than storing it", () => {
    const { onChange } = panel({ agent: agent() });
    fireEvent.change(screen.getByTestId("session-mcp-name"), { target: { value: "svc" } });
    fireEvent.change(screen.getByTestId("session-mcp-command"),
      { target: { value: "node svc.js --api-key abc123" } });
    fireEvent.click(screen.getByTestId("session-mcp-add"));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("session-mcp-problem").textContent)
      .toMatch(/Settings ▸ MCP servers/);
  });

  it("refuses a duplicate name and a nameless or commandless entry", () => {
    expect(validateDraft("docs", "node x.js", ["docs"])).toMatch(/already has a server/);
    expect(validateDraft("  ", "node x.js", [])).toMatch(/Give the server a name/);
    expect(validateDraft("docs", "   ", [])).toMatch(/Give the command/);
    expect(validateDraft("bad name", "node x.js", [])).toMatch(/letters, numbers/);
    expect(validateDraft("docs", "node x.js", [])).toBeNull();
  });

  it("reads what is stored, including a disabled entry", () => {
    const [entry] = readSessionServers(agent({ off: { command: "x", disabled: true } }));
    expect(entry).toMatchObject({ name: "off", command: "x", args: [], disabled: true });
    expect(readSessionServers(agent())).toEqual([]);
  });
});

describe("runtime state is a different question from configuration", () => {
  it("keeps every runtime state distinct", () => {
    const cases: Array<[AgentToolCatalogue, RegExp]> = [
      [{ kind: "notStarted" }, /Not started/],
      [{ kind: "unsupported" }, /Not reported/],
      [{ kind: "error" }, /Could not be read/],
      [{ kind: "cancelled" }, /Check cancelled/],
      [{ kind: "stale" }, /Out of date/],
    ];
    for (const [value, expected] of cases) {
      const { unmount } = render(<SessionMcpPanel
        agent={agent({ docs: { command: "node" } })}
        catalogue={value} onChange={() => {}} onRefresh={() => {}} />);
      expect(screen.getByTestId("session-mcp-state-docs").textContent).toMatch(expected);
      unmount();
    }
  });

  it("shows a connected server's tool count, and says when one is not running", () => {
    panel({ catalogue: { kind: "ok", truncated: false, servers: [
      { name: "docs", state: "connected", tools: ["search", "fetch"], truncated: false },
    ] } });
    expect(screen.getByTestId("session-mcp-state-docs").textContent).toMatch(/Connected · 2 tools/);
  });

  it("says nothing was checked before a refresh", () => {
    panel();
    expect(screen.getByTestId("session-mcp-state-docs").textContent).toMatch(/Not checked/);
  });

  it("refreshes only when asked", () => {
    const { onRefresh } = panel();
    expect(onRefresh).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("session-mcp-refresh"));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

describe("editing waits for the session to be quiet", () => {
  it("locks every control and says why", () => {
    const { onChange } = panel({ disabledReason: "Finish the running turn before changing servers." });
    expect(screen.getByTestId("session-mcp-locked").textContent).toMatch(/Finish the running turn/);
    for (const id of ["session-mcp-add", "session-mcp-toggle-docs", "session-mcp-remove-docs"]) {
      expect(screen.getByTestId(id)).toBeDisabled();
    }
    fireEvent.click(screen.getByTestId("session-mcp-remove-docs"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("surfaces a save failure", () => {
    panel({ error: "That server could not be saved." });
    expect(screen.getByTestId("session-mcp-error").textContent).toMatch(/could not be saved/);
  });
});
