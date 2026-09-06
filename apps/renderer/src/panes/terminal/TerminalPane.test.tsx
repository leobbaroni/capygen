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
}

const xtermState = vi.hoisted(() => ({ instances: [] as FakeTerminalInstance[] }));

vi.mock("@xterm/xterm", () => {
  class FakeTerminal implements FakeTerminalInstance {
    cols = 80;
    rows = 24;
    written: string[] = [];
    dataHandlers: ((data: string) => void)[] = [];
    disposed = false;
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

beforeEach(() => {
  xtermState.instances.length = 0;
  listeners.clear();
  createCount = 0;
  ipcInvoke.mockReset();
  ipcOn.mockClear();
  ipcInvoke.mockImplementation((channel: string, args: Record<string, unknown>) => {
    if (channel === "terminal.create") {
      createCount += 1;
      return Promise.resolve({
        id: `term-${createCount}`,
        projectId: args.projectId,
        sessionId: args.sessionId ?? null,
        title: `Terminal ${createCount}`,
        cwd: "C:/proj",
        shell: "pwsh.exe",
        cols: 80,
        rows: 24,
      });
    }
    if (channel === "terminal.write") return Promise.resolve({ ok: true });
    if (channel === "terminal.resize") return Promise.resolve({ ok: true });
    if (channel === "terminal.kill") return Promise.resolve({ ok: true });
    return Promise.reject(new Error(`unexpected channel ${channel}`));
  });
});

const params: WorkspacePaneParams = { projectId: "p1", sessionId: "s1" };
const api = {} as DockviewPanelApi;
const containerApi = {} as DockviewApi;
const props = { params, api, containerApi };

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

  it("'claude here' types the CLI command into the active terminal", async () => {
    const user = userEvent.setup();
    render(<TerminalPane {...props} />);
    await waitFor(() => expect(xtermState.instances).toHaveLength(1));
    ipcInvoke.mockClear();

    await user.click(screen.getByTestId("terminal-open-claude"));

    expect(ipcInvoke).toHaveBeenCalledWith("terminal.write", { id: "term-1", data: "claude\r" });
  });
});
