import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DevServerWithRun } from "@capygen/shared";
import type { DockviewApi, DockviewPanelApi } from "dockview-react";
import type { WorkspacePaneParams } from "@/workspace/types";
import { ServersPane } from "./ServersPane";
import { onOpenInBrowserPane } from "../browserBus";
// Side effect only: registers the `browser` pane so `openUrlInBrowserPane`
// can create its panel in the "Browser tab is closed" test below.
import "../browser/BrowserPane";

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

function row(overrides: Partial<DevServerWithRun["server"]> = {}, run: DevServerWithRun["run"] = null): DevServerWithRun {
  return {
    server: {
      id: "srv1",
      projectId: "p1",
      name: "web",
      source: "package.json",
      command: "npm",
      args: ["run", "dev"],
      cwd: "C:/proj",
      createdAt: 1,
      updatedAt: 1,
      ...overrides,
    },
    run,
  };
}

const rows: DevServerWithRun[] = [row()];

beforeEach(() => {
  listeners.clear();
  ipcInvoke.mockReset();
  ipcOn.mockClear();
  ipcInvoke.mockImplementation((channel: string) => {
    if (channel === "servers.detect") return Promise.resolve(rows);
    return Promise.reject(new Error(`unexpected channel ${channel}`));
  });
});

const params: WorkspacePaneParams = { projectId: "p1", sessionId: "s1" };
const api = {} as DockviewPanelApi;

/** [C] The pane now opens URLs through `workspace/openInBrowser`, which
 *  creates the Browser panel when it is closed and only falls back to the
 *  `browserBus` when one already exists — so the fake container has to
 *  answer both questions. `hasBrowser` picks which branch is under test. */
function fakeContainerApi(hasBrowser: boolean): DockviewApi & { addPanel: ReturnType<typeof vi.fn> } {
  const addPanel = vi.fn();
  const setActive = vi.fn();
  return {
    addPanel,
    getPanel: (id: string) => (hasBrowser && id === "browser" ? { api: { setActive } } : undefined),
  } as unknown as DockviewApi & { addPanel: ReturnType<typeof vi.fn> };
}

const containerApi = fakeContainerApi(true);
const props = { params, api, containerApi };

describe("ServersPane (SPEC R18)", () => {
  it("detects servers on open", async () => {
    render(<ServersPane {...props} />);

    expect(await screen.findByText("web")).toBeInTheDocument();
    expect(ipcInvoke).toHaveBeenCalledWith("servers.detect", { projectId: "p1" });
    expect(screen.getByText("package.json")).toBeInTheDocument();
    expect(screen.getByText(/npm run dev/)).toBeInTheDocument();
  });

  it("refreshes on demand", async () => {
    const user = userEvent.setup();
    render(<ServersPane {...props} />);
    await screen.findByText("web");
    ipcInvoke.mockClear();

    await user.click(screen.getByTestId("servers-refresh"));

    await waitFor(() => expect(ipcInvoke).toHaveBeenCalledWith("servers.detect", { projectId: "p1" }));
  });

  it("starts a server and shows its Open-in-Browser link once a URL is known", async () => {
    ipcInvoke.mockImplementation((channel: string) => {
      if (channel === "servers.detect") return Promise.resolve(rows);
      if (channel === "servers.start") {
        return Promise.resolve({ serverId: "srv1", status: "running", pid: 123, url: "http://localhost:5173" });
      }
      return Promise.reject(new Error(`unexpected channel ${channel}`));
    });
    const user = userEvent.setup();
    render(<ServersPane {...props} />);
    await screen.findByText("web");

    await user.click(screen.getByTestId("server-start"));

    expect(await screen.findByTestId("server-open-browser")).toBeInTheDocument();
    expect(screen.getByTestId("server-stop")).toBeInTheDocument();
    expect(screen.queryByTestId("server-start")).not.toBeInTheDocument();
  });

  it("opening the browser link reaches the Browser pane via browserBus", async () => {
    ipcInvoke.mockImplementation((channel: string) => {
      if (channel === "servers.detect") return Promise.resolve([row({}, { serverId: "srv1", status: "running", url: "http://localhost:5173" })]);
      return Promise.reject(new Error(`unexpected channel ${channel}`));
    });
    const user = userEvent.setup();
    const received = vi.fn();
    const off = onOpenInBrowserPane(received);
    render(<ServersPane {...props} />);
    await screen.findByTestId("server-open-browser");

    await user.click(screen.getByTestId("server-open-browser"));

    expect(received).toHaveBeenCalledWith("http://localhost:5173");
    off();
  });

  it("stops a running server", async () => {
    ipcInvoke.mockImplementation((channel: string) => {
      if (channel === "servers.detect") return Promise.resolve([row({}, { serverId: "srv1", status: "running" })]);
      if (channel === "servers.stop") return Promise.resolve({ serverId: "srv1", status: "stopped" });
      return Promise.reject(new Error(`unexpected channel ${channel}`));
    });
    const user = userEvent.setup();
    render(<ServersPane {...props} />);
    await screen.findByTestId("server-stop");

    await user.click(screen.getByTestId("server-stop"));

    await waitFor(() => expect(screen.getByTestId("server-start")).toBeInTheDocument());
  });

  it("shows a port-conflict error with an Open existing URL fallback", async () => {
    ipcInvoke.mockImplementation((channel: string) => {
      if (channel === "servers.detect")
        return Promise.resolve([row({ url: "http://localhost:5173" })]);
      if (channel === "servers.start") return Promise.reject(new Error("port 5173 already in use by PID 4242"));
      return Promise.reject(new Error(`unexpected channel ${channel}`));
    });
    const user = userEvent.setup();
    render(<ServersPane {...props} />);
    await screen.findByTestId("server-start");

    await user.click(screen.getByTestId("server-start"));

    expect(await screen.findByTestId("server-error")).toHaveTextContent("PID 4242");
    expect(screen.getByTestId("server-open-existing-url")).toBeInTheDocument();
  });

  it("live servers.status events update the row without a re-fetch", async () => {
    render(<ServersPane {...props} />);
    await screen.findByText("web");

    act(() => {
      emit("servers.status", { run: { serverId: "srv1", status: "running", url: "http://localhost:5173" } });
    });

    expect(await screen.findByTestId("server-open-browser")).toBeInTheDocument();
  });

  it("[C] auto-opens the Browser pane when a server this pane started reports its URL (G6)", async () => {
    ipcInvoke.mockImplementation((channel: string) => {
      if (channel === "servers.detect") return Promise.resolve(rows);
      // Discovery has not finished when `start` returns — the URL arrives on
      // the `servers.status` event, which is what G6 keys the open on.
      if (channel === "servers.start") return Promise.resolve({ serverId: "srv1", status: "starting" });
      return Promise.reject(new Error(`unexpected channel ${channel}`));
    });
    const user = userEvent.setup();
    const received = vi.fn();
    const off = onOpenInBrowserPane(received);
    render(<ServersPane {...props} />);
    await screen.findByText("web");

    await user.click(screen.getByTestId("server-start"));
    act(() => {
      emit("servers.status", { run: { serverId: "srv1", status: "running", url: "http://localhost:5199" } });
    });

    expect(received).toHaveBeenCalledWith("http://localhost:5199");
    off();
  });

  it("[C] does not hijack the Browser pane for a server it did not start", async () => {
    const received = vi.fn();
    const off = onOpenInBrowserPane(received);
    render(<ServersPane {...props} />);
    await screen.findByText("web");

    act(() => {
      emit("servers.status", { run: { serverId: "srv1", status: "running", url: "http://localhost:5199" } });
    });

    expect(received).not.toHaveBeenCalled();
    off();
  });

  it("[C] creates the Browser panel when it is closed instead of shouting into the void", async () => {
    const closedContainer = fakeContainerApi(false);
    ipcInvoke.mockImplementation((channel: string) => {
      if (channel === "servers.detect")
        return Promise.resolve([row({}, { serverId: "srv1", status: "running", url: "http://localhost:5173" })]);
      return Promise.reject(new Error(`unexpected channel ${channel}`));
    });
    const user = userEvent.setup();
    render(<ServersPane params={params} api={api} containerApi={closedContainer} />);
    await screen.findByTestId("server-open-browser");

    await user.click(screen.getByTestId("server-open-browser"));

    expect(closedContainer.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "browser",
        component: "browser",
        params: expect.objectContaining({ initialUrl: "http://localhost:5173" }),
      }),
    );
  });

  it("opens the log drawer, fetching the initial tail once", async () => {
    ipcInvoke.mockImplementation((channel: string) => {
      if (channel === "servers.detect") return Promise.resolve(rows);
      if (channel === "servers.logs") return Promise.resolve({ lines: ["> npm run dev", "ready on :5173"] });
      return Promise.reject(new Error(`unexpected channel ${channel}`));
    });
    const user = userEvent.setup();
    render(<ServersPane {...props} />);
    await screen.findByText("web");

    await user.click(screen.getByTestId("server-logs-toggle"));

    const drawer = await screen.findByTestId("server-logs");
    expect(within(drawer).getByText("ready on :5173")).toBeInTheDocument();
    expect(ipcInvoke).toHaveBeenCalledWith("servers.logs", { serverId: "srv1", tail: 200 });
  });

  it("appends live servers.log lines to an open drawer", async () => {
    ipcInvoke.mockImplementation((channel: string) => {
      if (channel === "servers.detect") return Promise.resolve(rows);
      if (channel === "servers.logs") return Promise.resolve({ lines: [] });
      return Promise.reject(new Error(`unexpected channel ${channel}`));
    });
    const user = userEvent.setup();
    render(<ServersPane {...props} />);
    await screen.findByText("web");
    await user.click(screen.getByTestId("server-logs-toggle"));
    await screen.findByTestId("server-logs");

    act(() => {
      emit("servers.log", { serverId: "srv1", line: "compiled successfully" });
    });

    expect(await screen.findByText("compiled successfully")).toBeInTheDocument();
  });

  it("removes a custom server", async () => {
    ipcInvoke.mockImplementation((channel: string) => {
      if (channel === "servers.detect") return Promise.resolve([row({ source: "custom" })]);
      if (channel === "servers.remove") return Promise.resolve({ ok: true });
      return Promise.reject(new Error(`unexpected channel ${channel}`));
    });
    const user = userEvent.setup();
    render(<ServersPane {...props} />);
    await screen.findByTestId("server-remove");

    await user.click(screen.getByTestId("server-remove"));

    await waitFor(() => expect(screen.queryByText("web")).not.toBeInTheDocument());
  });

  it("does not offer Remove on a detected (non-custom) server", async () => {
    render(<ServersPane {...props} />);
    await screen.findByText("web");
    expect(screen.queryByTestId("server-remove")).not.toBeInTheDocument();
  });

  it("adds a custom server via the form", async () => {
    ipcInvoke.mockImplementation((channel: string, args: Record<string, unknown>) => {
      if (channel === "servers.detect") return Promise.resolve(rows);
      if (channel === "servers.saveCustom") {
        return Promise.resolve({
          id: "srv2",
          projectId: "p1",
          ...(args.server as object),
          createdAt: 1,
          updatedAt: 1,
        });
      }
      return Promise.reject(new Error(`unexpected channel ${channel}`));
    });
    const user = userEvent.setup();
    render(<ServersPane {...props} />);
    await screen.findByText("web");

    await user.click(screen.getByTestId("servers-add-toggle"));
    await user.type(screen.getByTestId("server-add-name"), "worker");
    await user.type(screen.getByTestId("server-add-command"), "node");
    await user.type(screen.getByTestId("server-add-args"), "worker.js");
    await user.click(screen.getByTestId("server-add-submit"));

    await waitFor(() =>
      expect(ipcInvoke).toHaveBeenCalledWith("servers.saveCustom", {
        projectId: "p1",
        server: {
          name: "worker",
          source: "custom",
          command: "node",
          args: ["worker.js"],
          cwd: ".",
        },
      }),
    );
    expect(await screen.findByText("worker")).toBeInTheDocument();
    expect(screen.queryByTestId("server-add-form")).not.toBeInTheDocument();
  });

  it("shows the empty state when nothing is detected", async () => {
    ipcInvoke.mockImplementation((channel: string) => {
      if (channel === "servers.detect") return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected channel ${channel}`));
    });
    render(<ServersPane {...props} />);

    expect(await screen.findByTestId("servers-empty")).toBeInTheDocument();
  });
});
