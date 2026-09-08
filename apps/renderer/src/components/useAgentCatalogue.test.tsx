/**
 * The composer's MCP catalogue plumbing (P17 / R28).
 *
 * The catalogue is informational: it tells a person what an agent has, and it
 * must never become a way to run one, never reach a prompt, and never start a
 * backend's servers as a side effect of opening a menu.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { AgentToolCatalogue } from "@capygen/shared";
import { Composer } from "./Composer";
import { SlashMenu } from "./SlashMenu";
import {
  catalogueStatusText,
  catalogueToolRows,
  useAgentCatalogue,
} from "./useAgentCatalogue";

const invoke = vi.hoisted(() => vi.fn());
const shell = vi.hoisted(() => ({ bridge: true }));
vi.mock("@/lib/ipc", () => ({
  ipc: () => ({ invoke, on: () => () => {} }),
  hasBridge: () => shell.bridge,
}));

const ok = (servers: { name: string; tools: string[] }[]): AgentToolCatalogue => ({
  kind: "ok",
  truncated: false,
  servers: servers.map((s) => ({ ...s, state: "connected" as const, truncated: false })),
});

beforeEach(() => {
  shell.bridge = true;
  invoke.mockReset();
  invoke.mockImplementation((channel: string) => channel === "dictation.availability"
    ? Promise.resolve({ available: false, languages: [], message: "fixture" })
    : Promise.resolve(ok([{ name: "docs", tools: ["search"] }])));
});

describe("useAgentCatalogue", () => {
  it("reads without initializing, so opening a menu starts no servers", async () => {
    renderHook(() => useAgentCatalogue("ses_1", "agt_1"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("agents.catalogue", {
        sessionId: "ses_1", agentId: "agt_1", initialize: false,
      }),
    );
  });

  it("asks nothing when there is no session or no bridge", async () => {
    renderHook(() => useAgentCatalogue(null, "agt_1"));
    shell.bridge = false;
    renderHook(() => useAgentCatalogue("ses_1", "agt_1"));
    await waitFor(() => expect(invoke).not.toHaveBeenCalled());
  });

  it("never shows one agent's servers under another agent's name", async () => {
    const pending: Array<(value: AgentToolCatalogue) => void> = [];
    invoke.mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));

    const { result, rerender } = renderHook(
      ({ agentId }: { agentId: string }) => useAgentCatalogue("ses_1", agentId),
      { initialProps: { agentId: "agt_1" } },
    );
    rerender({ agentId: "agt_2" });

    // The first agent's answer arrives after the switch; it must be dropped.
    await act(async () => { pending[0]?.(ok([{ name: "first", tools: ["a"] }])); });
    expect(result.current.catalogue).toBeNull();

    await act(async () => { pending[1]?.(ok([{ name: "second", tools: ["b"] }])); });
    expect(catalogueToolRows(result.current.catalogue)).toEqual([
      { serverName: "second", name: "b" },
    ]);
  });

  it("stops loading when the session goes away mid-request", async () => {
    const pending: Array<(value: AgentToolCatalogue) => void> = [];
    invoke.mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));

    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string | null }) => useAgentCatalogue(sessionId, "agt_1"),
      { initialProps: { sessionId: "ses_1" as string | null } },
    );
    await waitFor(() => expect(result.current.loading).toBe(true));

    // Leaving the session while the read is in flight. The outstanding read
    // belongs to a key nobody is on any more, so its own cleanup is skipped —
    // the spinner used to stay up forever.
    rerender({ sessionId: null });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.catalogue).toBeNull();

    // And the abandoned answer changes nothing when it finally lands.
    await act(async () => { pending[0]?.(ok([{ name: "docs", tools: ["search"] }])); });
    expect(result.current.catalogue).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("does not report another agent's read as this one's progress", async () => {
    const pending: Array<(value: AgentToolCatalogue) => void> = [];
    invoke.mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));

    const { result, rerender } = renderHook(
      ({ agentId }: { agentId: string }) => useAgentCatalogue("ses_1", agentId),
      { initialProps: { agentId: "agt_1" } },
    );
    await waitFor(() => expect(result.current.loading).toBe(true));
    rerender({ agentId: "agt_2" });

    // The first agent's answer settles its own key, never the new one's.
    await act(async () => { pending[0]?.(ok([{ name: "first", tools: ["a"] }])); });
    expect(result.current.loading).toBe(true);
    expect(result.current.catalogue).toBeNull();

    await act(async () => { pending[1]?.(ok([{ name: "second", tools: ["b"] }])); });
    expect(result.current.loading).toBe(false);
    expect(catalogueToolRows(result.current.catalogue)).toEqual([
      { serverName: "second", name: "b" },
    ]);
  });

  it("drops an answer from before the session was left and re-entered", async () => {
    const pending: Array<(value: AgentToolCatalogue) => void> = [];
    invoke.mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));

    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string | null }) => useAgentCatalogue(sessionId, "agt_1"),
      { initialProps: { sessionId: "ses_1" as string | null } },
    );
    await waitFor(() => expect(result.current.loading).toBe(true));

    // Leave, then come back to the very same key. The first read's key matches
    // again, so only its ticket can tell it apart from the read now in flight.
    rerender({ sessionId: null });
    rerender({ sessionId: "ses_1" });
    await waitFor(() => expect(result.current.loading).toBe(true));

    await act(async () => { pending[0]?.(ok([{ name: "stale", tools: ["old"] }])); });
    expect(result.current.catalogue).toBeNull();
    expect(result.current.loading).toBe(true);

    await act(async () => { pending[1]?.(ok([{ name: "fresh", tools: ["new"] }])); });
    expect(catalogueToolRows(result.current.catalogue)).toEqual([
      { serverName: "fresh", name: "new" },
    ]);
  });

  it("reports a failed read as an error, not as an empty catalogue", async () => {
    invoke.mockImplementation(() => Promise.reject(new Error("no runtime")));
    const { result } = renderHook(() => useAgentCatalogue("ses_1", "agt_1"));
    await waitFor(() => expect(result.current.catalogue).toEqual({ kind: "error" }));
    // Distinct from "connected with nothing configured".
    expect(catalogueStatusText(result.current.catalogue)).toMatch(/could not be read/i);
  });

  it("initializes only on an explicit refresh", async () => {
    const { result } = renderHook(() => useAgentCatalogue("ses_1", "agt_1"));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    await act(async () => { await result.current.refresh({ initialize: true }); });
    expect(invoke).toHaveBeenLastCalledWith("agents.catalogue", {
      sessionId: "ses_1", agentId: "agt_1", initialize: true,
    });
  });
});

describe("catalogue states stay distinct", () => {
  it.each([
    ["unsupported", /does not report/i],
    ["notStarted", /has not started/i],
    ["error", /could not be read/i],
    ["cancelled", /did not finish/i],
    ["stale", /out of date/i],
  ] as const)("%s reads as its own state", (kind, pattern) => {
    expect(catalogueStatusText({ kind } as AgentToolCatalogue)).toMatch(pattern);
    // None of them is a tool list.
    expect(catalogueToolRows({ kind } as AgentToolCatalogue)).toEqual([]);
  });

  it("tells a configured-but-empty catalogue apart from a failure", () => {
    expect(catalogueStatusText(ok([]))).toMatch(/No MCP servers are configured/i);
    // A populated one needs no explanation at all.
    expect(catalogueStatusText(ok([{ name: "docs", tools: ["search"] }]))).toBeNull();
  });

  it("flattens servers into rows that name the server they came from", () => {
    expect(catalogueToolRows(ok([
      { name: "docs", tools: ["search", "fetch"] },
      { name: "fs", tools: ["read"] },
    ]))).toEqual([
      { serverName: "docs", name: "search" },
      { serverName: "docs", name: "fetch" },
      { serverName: "fs", name: "read" },
    ]);
  });
});

describe("SlashMenu shows tools without offering to run them", () => {
  const noop = () => {};

  it("renders tool rows that cannot be chosen", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <SlashMenu
        commands={[]}
        mcpTools={[{ serverName: "docs", name: "search" }]}
        highlightedIndex={-1}
        onSelect={onSelect}
        onHover={noop}
      />,
    );
    const row = screen.getByTestId("slash-menu-mcp-tool");
    expect(row).toHaveTextContent("search");
    expect(row).toHaveTextContent("docs");
    // A tool is something the agent calls; the row is not a control.
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(row.tagName).not.toBe("BUTTON");
    expect(row.querySelector("button")).toBeNull();
    await user.click(row);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("shows why there are no rows rather than an empty section", () => {
    render(
      <SlashMenu
        commands={[]}
        mcpTools={[]}
        mcpStatus="This backend does not report its MCP tools."
        highlightedIndex={-1}
        onSelect={noop}
        onHover={noop}
      />,
    );
    expect(screen.getByTestId("slash-menu-mcp-status"))
      .toHaveTextContent(/does not report/i);
    expect(screen.queryByTestId("slash-menu-mcp-tool")).toBeNull();
  });

  it("omits the section entirely when there is nothing to say", () => {
    render(
      <SlashMenu
        commands={[{ name: "/model", source: "builtin" } as never]}
        highlightedIndex={0}
        onSelect={noop}
        onHover={noop}
      />,
    );
    expect(screen.queryByTestId("slash-menu-mcp-section")).toBeNull();
  });
});

describe("Composer shows MCP tools on a backend with no slash commands", () => {
  const submit = vi.fn();

  beforeEach(() => submit.mockReset());

  const composer = (props: Record<string, unknown> = {}) =>
    render(
      <Composer
        onSubmit={submit}
        commands={[]}
        mcpTools={[{ serverName: "docs", name: "search" }]}
        {...props}
      />,
    );

  it("opens an informational menu with no commands to offer", async () => {
    const user = userEvent.setup();
    composer();
    await user.type(screen.getByRole("textbox"), "/");
    // The API backend publishes no slash commands; the tools were invisible.
    expect(screen.getByTestId("slash-menu-mcp-tool")).toHaveTextContent("search");
    expect(screen.queryByTestId("slash-menu-item")).toBeNull();
  });

  it("shows a status-only menu when the backend cannot report tools", async () => {
    const user = userEvent.setup();
    composer({ mcpTools: [], mcpStatus: "This backend does not report its MCP tools." });
    await user.type(screen.getByRole("textbox"), "/");
    expect(screen.getByTestId("slash-menu-mcp-status")).toHaveTextContent(/does not report/i);
  });

  it("keeps Enter submitting, since nothing in the menu is selectable", async () => {
    const user = userEvent.setup();
    composer();
    await user.type(screen.getByRole("textbox"), "/");
    await user.keyboard("{Enter}");
    // No command exists to invent, so Enter means what it always meant.
    expect(submit).toHaveBeenCalledWith("/");
  });

  it("leaves the arrow keys to the textarea", async () => {
    const user = userEvent.setup();
    composer();
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    await user.type(box, "/");
    await user.keyboard("{ArrowDown}{ArrowUp}");
    // Nothing is highlighted, so nothing can be chosen by accident.
    expect(box.value).toBe("/");
    expect(submit).not.toHaveBeenCalled();
  });

  it("closes on Escape even with only informational rows", async () => {
    const user = userEvent.setup();
    composer();
    await user.type(screen.getByRole("textbox"), "/");
    expect(screen.getByTestId("slash-menu")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("slash-menu")).toBeNull();
  });

  it("stays closed when there is neither a command nor anything to say", async () => {
    const user = userEvent.setup();
    composer({ mcpTools: [], mcpStatus: null });
    await user.type(screen.getByRole("textbox"), "/");
    expect(screen.queryByTestId("slash-menu")).toBeNull();
  });

  it("does not put the catalogue anywhere near the submitted text", async () => {
    const user = userEvent.setup();
    composer();
    await user.type(screen.getByRole("textbox"), "/ hello");
    await user.keyboard("{Enter}");
    // Informational only: nothing about a server or tool reaches the model.
    expect(submit).toHaveBeenCalledWith("/ hello");
  });
});
