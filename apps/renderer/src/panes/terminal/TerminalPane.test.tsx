/**
 * xterm needs a real canvas/WebGL context and font metrics that jsdom does
 * not provide, so every terminal library (`@xterm/xterm` and its three
 * addons) is mocked here — this test proves capygen's own wiring (create on
 * mount, data/exit events reach the terminal, typed input reaches
 * `terminal.write`, resize reaches `terminal.resize`, closing a tab reaches
 * `terminal.kill`), not xterm's own rendering.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DockviewApi, DockviewPanelApi } from "dockview-react";
import type { WorkspacePaneParams } from "@/workspace/types";
import { TerminalPane } from "./TerminalPane";

interface FakeTerminalInstance {
  cols: number;
  rows: number;
  written: string[];
  dataHandlers: ((data: string) => void)[];
  disposed: boolean;
  /** [C] The pane focuses the *active* tab's terminal so the pane opens
   *  ready to type into (xterm only takes keystrokes through its own hidden
   *  textarea, which nothing else focuses). */
  focusCount: number;
}

const xtermState = vi.hoisted(() => ({ instances: [] as FakeTerminalInstance[] }));

vi.mock("@xterm/xterm", () => {
  class FakeTerminal implements FakeTerminalInstance {
    cols = 80;
    rows = 24;
    written: string[] = [];
    dataHandlers: ((data: string) => void)[] = [];
    disposed = false;
    focusCount = 0;
    constructor(_options: unknown) {
      xtermState.instances.push(this);
    }
    loadAddon(): void {}
    open(): void {}
    write(data: string): void {
      this.written.push(data);
    }
    onData(cb: (data: string) => void) {
      this.dataHandlers.push(cb);
      return { dispose: () => undefined };
    }
    attachCustomKeyEventHandler(): void {}
    focus(): void {
      this.focusCount += 1;
    }
    getSelection(): string {
      return "";
    }
    dispose(): void {
      this.disposed = true;
    }
  }
  return { Terminal: FakeTerminal };
});
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit(): void {}
  },
}));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {},
}));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss(): void {}
    dispose(): void {}
  },
}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

const ipcInvoke = vi.fn();
const listeners = new Map<string, Set<(payload: unknown) => void>>();
const ipcOn = vi.fn((event: string, listener: (payload: unknown) => void) => {
  const bucket = listeners.get(event) ?? new Set();
  bucket.add(listener);
  listeners.set(event, bucket);
  return () => bucket.delete(listener);
});
function emit(event: string, payload: unknown): void {
  for (const listener of listeners.get(event) ?? []) listener(payload);
}
vi.mock("@/lib/ipc", () => ({
  ipc: () => ({ invoke: ipcInvoke, on: ipcOn }),
  hasBridge: () => true,
}));

let createCount = 0;
/** What `terminal.list` answers — the pane adopts these instead of spawning
 *  a fresh shell (see the pane's module comment). */
let existingTerminals: unknown[] = [];

beforeEach(() => {
  xtermState.instances.length = 0;
  listeners.clear();
  createCount = 0;
  existingTerminals = [];
  ipcInvoke.mockReset();
  ipcOn.mockClear();
  ipcInvoke.mockImplementation((channel: string, args: Record<string, unknown>) => {
    if (channel === "terminal.create" || channel === "terminal.attach") {
      createCount += 1;
      return Promise.resolve({
        id: `term-${createCount}`,
        projectId: args.projectId,
        sessionId: args.sessionId ?? null,
        title: channel === "terminal.attach" ? `${args.backend} CLI` : `Terminal ${createCount}`,
        cwd: "C:/proj",
        shell: "pwsh.exe",
        cols: 80,
        rows: 24,
      });
    }
    if (channel === "terminal.list") return Promise.resolve(existingTerminals);
    if (channel === "terminal.write") return Promise.resolve({ ok: true });
    if (channel === "terminal.resize") return Promise.resolve({ ok: true });
    if (channel === "terminal.kill") return Promise.resolve({ ok: true });
    return Promise.reject(new Error(`unexpected channel ${channel}`));
  });
});

/** A stand-in for the slice of `DockviewPanelApi` a pane reads: `isVisible`,
 *  plus the event dockview fires when a stacked tab's visibility flips.
 *  Dockview never unmounts a hidden tab (`WorkspaceHost` sets
 *  `defaultRenderer="always"`), so visibility — not mounting — is what a pane
 *  holding a live resource has to react to. */
function fakePanelApi(initialVisible = true): DockviewPanelApi & {
  setVisible: (v: boolean) => void;
} {
  const handlers = new Set<(e: { isVisible: boolean }) => void>();
  let isVisible = initialVisible;
  return {
    get isVisible() {
      return isVisible;
    },
    onDidVisibilityChange: (listener: (e: { isVisible: boolean }) => void) => {
      handlers.add(listener);
      return { dispose: () => handlers.delete(listener) };
    },
    onDidDimensionsChange: () => ({ dispose: () => undefined }),
    setVisible(next: boolean) {
      isVisible = next;
      for (const h of handlers) h({ isVisible: next });
    },
  } as unknown as DockviewPanelApi & { setVisible: (v: boolean) => void };
}

const params: WorkspacePaneParams = { projectId: "p1", sessionId: "s1" };
const containerApi = {} as DockviewApi;
const props = { params, api: fakePanelApi(), containerApi };

describe("TerminalPane (SPEC R16)", () => {
  it("creates a terminal on mount, scoped to the project/session", async () => {
    render(<TerminalPane {...props} />);

    await waitFor(() =>
      expect(ipcInvoke).toHaveBeenCalledWith("terminal.create", {
        projectId: "p1",
        sessionId: "s1",
        cols: 80,
        rows: 24,
      }),
    );
    expect(await screen.findByTestId("terminal-instance")).toBeInTheDocument();
  });

  /**
   * A pty outlives this component, so re-opening the pane has to find the
   * shell it left running rather than spawn another one nobody can reach.
   */
  it("[C] adopts this project's running terminals instead of spawning another", async () => {
    existingTerminals = [
      {
        id: "term-existing",
        projectId: "p1",
        sessionId: "s1",
        title: "pwsh.exe",
        cwd: "C:/proj",
        shell: "pwsh.exe",
        cols: 80,
        rows: 24,
      },
    ];
    render(<TerminalPane {...props} api={fakePanelApi()} />);

    await waitFor(() => expect(ipcInvoke).toHaveBeenCalledWith("terminal.list", { projectId: "p1" }));
    await waitFor(() => expect(screen.getAllByTestId("terminal-tab")).toHaveLength(1));
    expect(ipcInvoke).not.toHaveBeenCalledWith("terminal.create", expect.anything());
    // The adopted id is what the data/exit subscriptions are keyed on.
    act(() => {
      emit("terminal.data", { id: "term-existing", data: "back again\r\n" });
    });
    expect(xtermState.instances[0]?.written).toContain("back again\r\n");
  });

  /** `defaultRenderer="always"` keeps a hidden tab mounted, so a restored
   *  layout would otherwise spawn a shell behind another tab. */
  it("[C] waits for the tab to be visible before opening its first shell", async () => {
    const api = fakePanelApi(false);
    render(<TerminalPane {...props} api={api} />);
    await Promise.resolve();
    expect(ipcInvoke).not.toHaveBeenCalledWith("terminal.create", expect.anything());

    act(() => api.setVisible(true));

    await waitFor(() => expect(ipcInvoke).toHaveBeenCalledWith("terminal.create", expect.anything()));
  });

  it("pushes a resize once the terminal is fitted", async () => {
    render(<TerminalPane {...props} />);
    await waitFor(() => expect(xtermState.instances).toHaveLength(1));

    await waitFor(() =>
      expect(ipcInvoke).toHaveBeenCalledWith("terminal.resize", { id: "term-1", cols: 80, rows: 24 }),
    );
  });

  it("writes incoming terminal.data into the xterm instance", async () => {
    render(<TerminalPane {...props} />);
    await waitFor(() => expect(xtermState.instances).toHaveLength(1));

    act(() => {
      emit("terminal.data", { id: "term-1", data: "hello\r\n" });
    });

    expect(xtermState.instances[0]?.written).toContain("hello\r\n");
  });

  it("sends typed input through terminal.write", async () => {
    render(<TerminalPane {...props} />);
    await waitFor(() => expect(xtermState.instances).toHaveLength(1));
    ipcInvoke.mockClear();

    act(() => {
      xtermState.instances[0]?.dataHandlers[0]?.("ls\r");
    });

    await waitFor(() => expect(ipcInvoke).toHaveBeenCalledWith("terminal.write", { id: "term-1", data: "ls\r" }));
  });

  it("shows an exit banner and marks the tab on terminal.exit", async () => {
    render(<TerminalPane {...props} />);
    await waitFor(() => expect(xtermState.instances).toHaveLength(1));

    act(() => {
      emit("terminal.exit", { id: "term-1", exitCode: 0 });
    });

    expect(await screen.findByText("exit 0")).toBeInTheDocument();
  });

  it("opens a new tab with its own terminal.create call", async () => {
    const user = userEvent.setup();
    render(<TerminalPane {...props} />);
    await waitFor(() => expect(xtermState.instances).toHaveLength(1));

    await user.click(screen.getByTestId("terminal-new"));

    await waitFor(() => expect(xtermState.instances).toHaveLength(2));
    expect(screen.getAllByTestId("terminal-tab")).toHaveLength(2);
  });

  it("kills the pty when a tab is closed", async () => {
    render(<TerminalPane {...props} />);
    await waitFor(() => expect(xtermState.instances).toHaveLength(1));

    const user = userEvent.setup();
    await user.click(screen.getByTestId("terminal-tab-close"));

    expect(ipcInvoke).toHaveBeenCalledWith("terminal.kill", { id: "term-1" });
    await waitFor(() => expect(screen.queryByTestId("terminal-tab")).not.toBeInTheDocument());
  });

  it("'claude here' opens a dedicated raw terminal", async () => {
    const user = userEvent.setup();
    render(<TerminalPane {...props} />);
    await waitFor(() => expect(xtermState.instances).toHaveLength(1));
    ipcInvoke.mockClear();

    await user.click(screen.getByTestId("terminal-open-claude"));

    expect(ipcInvoke).toHaveBeenCalledWith("terminal.attach", { projectId: props.params.projectId, sessionId: props.params.sessionId, backend: "claude", cols: 80, rows: 24 });
    expect(ipcInvoke).not.toHaveBeenCalledWith("terminal.write", expect.anything());
    await waitFor(() => expect(screen.getByText("claude CLI")).toBeInTheDocument());
  });
});
