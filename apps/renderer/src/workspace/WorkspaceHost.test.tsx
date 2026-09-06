/**
 * `dockview-react` itself is mocked: `WorkspaceHost`'s own job — registering
 * every pane kind, restoring/defaulting the layout, wiring the toolbar's
 * toggles, debouncing `layout.set` — is what's under test, not dockview's own
 * grid math (real dockview against real DOM layout belongs in the Playwright
 * screenshot fixture, `/dev/workspace`, and the Phase 5 Integrate task's e2e).
 * The mock captures the real props `WorkspaceHost` passes and exposes a small
 * fake `DockviewApi` whose `addPanel`/`getPanel`/`fromJSON` behave enough
 * like the real thing for `defaultLayout.ts` and `WorkspaceHost`'s own logic
 * to run unmodified against it.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetPaneRegistryForTests, registerPane } from "./registry";
import { WorkspaceHost } from "./WorkspaceHost";

const invoke = vi.fn();
vi.mock("@/lib/ipc", () => ({
  ipc: () => ({ invoke, on: () => () => undefined }),
  hasBridge: () => true,
}));

let lastProps: Record<string, unknown> | null = null;
vi.mock("dockview-react", () => ({
  DockviewReact: (props: Record<string, unknown>) => {
    lastProps = props;
    return null;
  },
}));

interface FakePanel {
  id: string;
  api: {
    id: string;
    setActive: () => void;
    close: () => void;
    /** [C] Dockview merges these into the panel's stored params; the host
     *  calls it after a restore so a layout saved under a previous session
     *  does not hand every pane a dead `projectId`/`sessionId`. */
    updateParameters: (params: Record<string, unknown>) => void;
  };
  params: Record<string, unknown>;
}

function createFakeApi() {
  const panels: FakePanel[] = [];
  const addListeners: Array<() => void> = [];
  const removeListeners: Array<() => void> = [];
  const layoutChangeListeners: Array<() => void> = [];
  let active: FakePanel | null = null;

  const api = {
    get panels() {
      return panels;
    },
    get activePanel() {
      return active;
    },
    addPanel: vi.fn((opts: { id: string; params?: Record<string, unknown> }) => {
      const panel: FakePanel = {
        id: opts.id,
        params: { ...(opts.params ?? {}) },
        api: {
          id: opts.id,
          updateParameters: vi.fn((next: Record<string, unknown>) => {
            panel.params = { ...panel.params, ...next };
          }),
          // Real dockview activates a freshly-added panel by default.
          setActive: vi.fn(() => {
            active = panel;
          }),
          close: vi.fn(() => {
            const idx = panels.findIndex((p) => p.id === opts.id);
            if (idx >= 0) panels.splice(idx, 1);
            if (active?.id === opts.id) active = null;
            removeListeners.forEach((l) => l());
            layoutChangeListeners.forEach((l) => l());
          }),
        },
      };
      panels.push(panel);
      active = panel;
      addListeners.forEach((l) => l());
      layoutChangeListeners.forEach((l) => l());
      return panel;
    }),
    getPanel: vi.fn((id: string) => panels.find((p) => p.id === id)),
    onDidAddPanel: vi.fn((cb: () => void) => {
      addListeners.push(cb);
      return { dispose: vi.fn() };
    }),
    onDidRemovePanel: vi.fn((cb: () => void) => {
      removeListeners.push(cb);
      return { dispose: vi.fn() };
    }),
    onDidLayoutChange: vi.fn((cb: () => void) => {
      layoutChangeListeners.push(cb);
      return { dispose: vi.fn() };
    }),
    fromJSON: vi.fn(),
    toJSON: vi.fn(() => ({ marker: true })),
    clear: vi.fn(() => {
      panels.length = 0;
    }),
  };
  return api;
}

function FakePaneComponent({ params }: { params: { projectId: string } }) {
  return <div data-testid="fake-pane">{params.projectId}</div>;
}

beforeEach(() => {
  __resetPaneRegistryForTests();
  registerPane({ kind: "files", title: "Files", icon: () => null, component: FakePaneComponent });
  registerPane({ kind: "agents", title: "Agents", icon: () => null, component: FakePaneComponent });
  registerPane({ kind: "editor", title: "Editor", icon: () => null, component: FakePaneComponent });
  invoke.mockReset();
  invoke.mockImplementation((channel: string) => {
    if (channel === "layout.get") return Promise.resolve(null);
    if (channel === "layout.set") {
      return Promise.resolve({ projectId: "p1", layoutJson: {}, updatedAt: 0 });
    }
    return Promise.resolve({ ok: true });
  });
  lastProps = null;
});

afterEach(() => {
  __resetPaneRegistryForTests();
});

function ready() {
  const api = createFakeApi();
  (lastProps!.onReady as (e: { api: typeof api }) => void)({ api });
  return api;
}

describe("WorkspaceHost", () => {
  it("registers every pane kind as a dockview component", () => {
    render(<WorkspaceHost projectId="p1" sessionId="s1" onClose={vi.fn()} />);
    const components = lastProps!.components as Record<string, unknown>;
    expect(Object.keys(components).sort()).toEqual(["agents", "editor", "files"]);
  });

  it("builds the default layout (Files + Agents, Agents active) when nothing was saved", async () => {
    render(<WorkspaceHost projectId="p1" sessionId="s1" onClose={vi.fn()} />);
    const api = ready();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("layout.get", { projectId: "p1" }));
    await waitFor(() => expect(api.panels.map((p) => p.id)).toEqual(["files", "agents"]));
  });

  it("restores a saved layout instead of the default", async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === "layout.get") {
        return Promise.resolve({ projectId: "p1", layoutJson: { saved: true }, updatedAt: 0 });
      }
      return Promise.resolve({ ok: true });
    });
    render(<WorkspaceHost projectId="p1" sessionId="s1" onClose={vi.fn()} />);
    const api = ready();
    api.fromJSON.mockImplementation((data: { saved?: boolean }) => {
      if (data.saved) api.addPanel({ id: "editor" });
    });
    await waitFor(() => expect(api.fromJSON).toHaveBeenCalledWith({ saved: true }));
    expect(api.panels.map((p) => p.id)).toEqual(["editor"]);
  });

  it("[C] rebinds a restored panel's projectId/sessionId, keeping its own params", async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === "layout.get") {
        return Promise.resolve({ projectId: "p1", layoutJson: { saved: true }, updatedAt: 0 });
      }
      return Promise.resolve({ ok: true });
    });
    render(<WorkspaceHost projectId="p1" sessionId="s1" onClose={vi.fn()} />);
    const api = ready();
    api.fromJSON.mockImplementation((data: { saved?: boolean }) => {
      if (!data.saved) return;
      // What `toJSON` would have serialised in a *previous* session.
      api.addPanel({
        id: "editor",
        params: { projectId: "p-old", sessionId: "s-old", initialFilePath: "src/main.ts" },
      });
    });
    await waitFor(() => expect(api.fromJSON).toHaveBeenCalled());

    await waitFor(() =>
      expect(api.panels[0]!.params).toEqual({
        projectId: "p1",
        sessionId: "s1",
        initialFilePath: "src/main.ts",
      }),
    );
  });

  it("[C] rewrites the ids inside the saved JSON, so a panel is never *created* with a stale one", async () => {
    // The post-`fromJSON` rebind above is not enough on its own: a pane's
    // "open one terminal" effect has a `[]` dependency list, so it acts on
    // what it saw on its first render and never reconsiders. The ids have to
    // be right in the JSON dockview builds the panel from.
    const saved = {
      grid: { root: { type: "leaf", data: { views: ["terminal"] } } },
      panels: {
        terminal: {
          id: "terminal",
          contentComponent: "terminal",
          params: { projectId: "p-old", sessionId: "s-old" },
        },
      },
    };
    invoke.mockImplementation((channel: string) => {
      if (channel === "layout.get") {
        return Promise.resolve({ projectId: "p1", layoutJson: saved, updatedAt: 0 });
      }
      return Promise.resolve({ ok: true });
    });
    render(<WorkspaceHost projectId="p1" sessionId="s1" onClose={vi.fn()} />);
    const api = ready();
    api.fromJSON.mockImplementation((data: { panels?: Record<string, { params?: unknown }> }) => {
      for (const [id, panel] of Object.entries(data.panels ?? {})) {
        api.addPanel({ id, params: panel.params as Record<string, unknown> });
      }
    });
    await waitFor(() => expect(api.fromJSON).toHaveBeenCalled());
    // The argument `fromJSON` saw — not what was patched afterwards.
    const passed = api.fromJSON.mock.calls[0]![0] as {
      panels: Record<string, { params: Record<string, string> }>;
    };
    expect(passed.panels.terminal!.params).toEqual({ projectId: "p1", sessionId: "s1" });
    // …and the caller's own object was not mutated on the way through.
    expect(saved.panels.terminal.params).toEqual({ projectId: "p-old", sessionId: "s-old" });
  });

  /**
   * Closing every pane through the toolbar toggles is legal, and dockview's
   * `onDidRemovePanel` also fires `onDidLayoutChange` — so that state is
   * saved like any other. Treating "0 panels" as a failed restore put
   * Files+Agents back on every relaunch and undid the user's choice for good.
   */
  it("[C] restores a saved layout that legitimately has no panels, instead of re-defaulting", async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === "layout.get") {
        return Promise.resolve({
          projectId: "p1",
          layoutJson: { grid: { root: { type: "branch", data: [] } }, panels: {} },
          updatedAt: 0,
        });
      }
      return Promise.resolve({ ok: true });
    });
    render(<WorkspaceHost projectId="p1" sessionId="s1" onClose={vi.fn()} />);
    const api = ready();
    // A real `fromJSON` of an empty layout adds nothing and throws nothing.
    api.fromJSON.mockImplementation(() => undefined);

    await waitFor(() => expect(api.fromJSON).toHaveBeenCalled());
    // Give the default-layout path every chance to run before asserting it
    // did not.
    await Promise.resolve();
    expect(api.panels).toHaveLength(0);
    expect(api.addPanel).not.toHaveBeenCalled();
  });

  /** "Rearrange the panes, then close the workspace" is one gesture and takes
   *  well under the 400 ms debounce; dropping the pending write threw the
   *  rearrangement away (R17). */
  it("[C] flushes a pending layout.set on unmount instead of dropping it", async () => {
    const { unmount } = render(<WorkspaceHost projectId="p1" sessionId="s1" onClose={vi.fn()} />);
    const api = ready();
    await waitFor(() => expect(api.panels.length).toBeGreaterThan(0));
    invoke.mockClear();

    fireEvent.click(screen.getByTestId("workspace-pane-toggle-editor"));
    // Still inside the debounce window: nothing written yet.
    expect(invoke.mock.calls.filter((c) => c[0] === "layout.set")).toHaveLength(0);

    unmount();

    const writes = invoke.mock.calls.filter((c) => c[0] === "layout.set");
    expect(writes).toHaveLength(1);
    expect(writes[0]![1]).toEqual({ projectId: "p1", layoutJson: { marker: true } });
  });

  /** A width chosen on a wide window must not survive onto a narrow one and
   *  squeeze the chat column (and the workspace's own close button) away. */
  it("[C] re-clamps the stored width against the window", async () => {
    window.localStorage.setItem("capygen.workspace.width.p1", "1200");
    const originalWidth = window.innerWidth;
    try {
      Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
      render(<WorkspaceHost projectId="p1" sessionId="s1" onClose={vi.fn()} />);
      const host = screen.getByTestId("workspace-host");
      // 1280 - 360 (the chat column's floor) = 920, not the stored 1200.
      await waitFor(() => expect(host.style.width).toBe("920px"));

      Object.defineProperty(window, "innerWidth", { value: 900, configurable: true });
      fireEvent(window, new Event("resize"));
      // Never below the host's own minimum, even when the window is tiny.
      await waitFor(() => expect(host.style.width).toBe("540px"));
    } finally {
      Object.defineProperty(window, "innerWidth", { value: originalWidth, configurable: true });
      window.localStorage.removeItem("capygen.workspace.width.p1");
    }
  });

  it("falls back to the default layout when the saved one fails to restore", async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === "layout.get") {
        return Promise.resolve({ projectId: "p1", layoutJson: { corrupt: true }, updatedAt: 0 });
      }
      return Promise.resolve({ ok: true });
    });
    render(<WorkspaceHost projectId="p1" sessionId="s1" onClose={vi.fn()} />);
    const api = ready();
    api.fromJSON.mockImplementation(() => {
      throw new Error("bad layout");
    });
    await waitFor(() => expect(api.panels.map((p) => p.id)).toEqual(["files", "agents"]));
  });

  it("a toolbar toggle opens a pane that is not open, and closes it again", async () => {
    render(<WorkspaceHost projectId="p1" sessionId="s1" onClose={vi.fn()} />);
    const api = ready();
    await waitFor(() => expect(api.panels.length).toBeGreaterThan(0));

    fireEvent.click(screen.getByTestId("workspace-pane-toggle-editor"));
    await waitFor(() => expect(api.getPanel("editor")).toBeTruthy());

    fireEvent.click(screen.getByTestId("workspace-pane-toggle-editor"));
    await waitFor(() => expect(api.getPanel("editor")).toBeUndefined());
  });

  it("toggling a pane that is open but not the active tab focuses it instead of closing it", async () => {
    render(<WorkspaceHost projectId="p1" sessionId="s1" onClose={vi.fn()} />);
    const api = ready();
    // Default layout: Files + Agents, Agents active.
    await waitFor(() => expect(api.panels.map((p) => p.id)).toEqual(["files", "agents"]));
    expect(api.activePanel?.id).toBe("agents");

    fireEvent.click(screen.getByTestId("workspace-pane-toggle-files"));

    expect(api.getPanel("files")).toBeTruthy();
    expect(api.activePanel?.id).toBe("files");
  });

  it("the '+' menu lists only panes that are not already open, and opens the one clicked", async () => {
    render(<WorkspaceHost projectId="p1" sessionId="s1" onClose={vi.fn()} />);
    const api = ready();
    await waitFor(() => expect(api.panels.length).toBeGreaterThan(0));

    fireEvent.click(screen.getByTestId("workspace-add-pane"));
    // Files and Agents are already open (the default layout) — only Editor
    // is offered.
    expect(screen.getByTestId("workspace-add-menu-editor")).toBeInTheDocument();
    expect(screen.queryByTestId("workspace-add-menu-files")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("workspace-add-menu-editor"));
    await waitFor(() => expect(api.getPanel("editor")).toBeTruthy());
    // The menu closes after picking one.
    expect(screen.queryByTestId("workspace-add-menu")).not.toBeInTheDocument();
  });

  it("debounces layout.set: one add is one write, not one per internal event", async () => {
    render(<WorkspaceHost projectId="p1" sessionId="s1" onClose={vi.fn()} />);
    const api = ready();
    await waitFor(() => expect(api.panels.length).toBeGreaterThan(0));
    invoke.mockClear();

    fireEvent.click(screen.getByTestId("workspace-pane-toggle-editor"));

    await waitFor(
      () =>
        expect(invoke).toHaveBeenCalledWith(
          "layout.set",
          expect.objectContaining({ projectId: "p1" }),
        ),
      { timeout: 2000 },
    );
    const writes = invoke.mock.calls.filter((c) => c[0] === "layout.set");
    expect(writes).toHaveLength(1);
  });

  it("the close button calls onClose", () => {
    const onClose = vi.fn();
    render(<WorkspaceHost projectId="p1" sessionId="s1" onClose={onClose} />);
    fireEvent.click(screen.getByTestId("workspace-close"));
    expect(onClose).toHaveBeenCalled();
  });
});
