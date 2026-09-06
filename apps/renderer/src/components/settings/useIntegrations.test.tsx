/**
 * Phase 7-P0, renderer half: the settings sections' invocation boundary.
 *
 * What these cases hold:
 *
 *  - every `integrations.*` read carries this **window's** selected project id,
 *    and carries none at all when nothing is selected (global-only, never
 *    "whatever project was touched last");
 *  - a slower answer for a scope the page has left never replaces the current
 *    data — switching project or backend mid-flight used to let the stale
 *    result land last and render another project's servers under this heading;
 *  - an `integrations.changed` for another project is ignored, while a global
 *    one (`projectId: null`) refreshes every scope, because every project read
 *    layers on top of the global files.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@capygen/shared";
import { useAppStore } from "@/store/appStore";
import { useIntegrations } from "./useIntegrations";

const invoke = vi.fn();
let listeners: ((payload: unknown) => void)[] = [];
vi.mock("@/lib/ipc", () => ({
  ipc: () => ({
    invoke,
    on: (_channel: string, fn: (payload: unknown) => void) => {
      listeners.push(fn);
      return () => {
        listeners = listeners.filter((l) => l !== fn);
      };
    },
  }),
  hasBridge: () => true,
}));

function project(id: string): Project {
  return { id, name: id, path: `C:/tmp/${id}`, layout: null, devServers: null, createdAt: 0, updatedAt: 0 };
}

function snapshot(marker: string): unknown {
  return {
    mcpServers: [
      { backend: "claude", scope: "project", name: marker, transport: "stdio", command: "node", args: [], env: {}, enabled: true, source: "x" },
    ],
    plugins: [],
    skills: [],
    tools: [],
    lastSync: null,
  };
}

/** Renders the hook and shows the one server name its snapshot carries. */
function Probe(): React.ReactElement {
  const { data, loading } = useIntegrations("claude");
  return (
    <div data-testid="probe">
      {loading && !data ? "loading" : (data?.mcpServers[0]?.name ?? "empty")}
    </div>
  );
}

beforeEach(() => {
  listeners = [];
  invoke.mockReset();
  useAppStore.setState({ selectedProjectId: null, projects: [] });
});

describe("useIntegrations sends an explicit scope", () => {
  it("omits projectId entirely when no project is selected", async () => {
    invoke.mockResolvedValue(snapshot("global-one"));
    render(<Probe />);
    await screen.findByText("global-one");
    expect(invoke).toHaveBeenCalledWith("integrations.list", { backend: "claude" });
  });

  it("sends this window's project on the read and on the refresh", async () => {
    useAppStore.setState({ selectedProjectId: "p-a", projects: [project("p-a")] });
    invoke.mockResolvedValue(snapshot("from-a"));

    function RefreshProbe(): React.ReactElement {
      const { data, refreshFromBackend } = useIntegrations("claude");
      return (
        <button type="button" onClick={() => void refreshFromBackend()}>
          {data?.mcpServers[0]?.name ?? "…"}
        </button>
      );
    }
    render(<RefreshProbe />);
    const button = await screen.findByText("from-a");
    expect(invoke).toHaveBeenCalledWith("integrations.list", {
      backend: "claude",
      projectId: "p-a",
    });

    await act(async () => {
      button.click();
    });
    expect(invoke).toHaveBeenCalledWith("integrations.refresh", {
      backend: "claude",
      projectId: "p-a",
    });
  });
});

describe("stale answers never replace current data", () => {
  it("drops the answer for the project the page has already left", async () => {
    let releaseA: (value: unknown) => void = () => undefined;
    invoke.mockImplementation((_channel: string, args: { projectId?: string }) => {
      if (args.projectId === "p-a") return new Promise((resolve) => (releaseA = resolve));
      return Promise.resolve(snapshot("from-b"));
    });

    useAppStore.setState({ selectedProjectId: "p-a", projects: [project("p-a"), project("p-b")] });
    render(<Probe />);
    // A's read is parked; the user switches this window to B, whose read wins.
    act(() => {
      useAppStore.setState({ selectedProjectId: "p-b" });
    });
    await screen.findByText("from-b");

    // A's answer arrives late. It must not be rendered — it is the previous
    // project's data, and the page is on B.
    await act(async () => {
      releaseA(snapshot("from-a"));
    });
    expect(screen.getByTestId("probe").textContent).toBe("from-b");
  });

  /**
   * [review] The ticket alone is not enough. The killer ordering is: a refresh
   * (or a mutation's `await reload()`) started on project A resolves *after*
   * the page has moved to B and B's read has already landed. That old closure
   * then runs `reload` for A, takes the newest ticket, and writes A's data over
   * B's — with the ticket check passing, because it *is* the newest request.
   * Only a check against the page's **current** scope stops it.
   */
  it("ignores an old refresh's reload that resolves after the switch", async () => {
    let releaseRefresh: (() => void) | null = null;
    invoke.mockImplementation((channel: string, args: { projectId?: string }) => {
      if (channel === "integrations.refresh") {
        return new Promise<void>((resolve) => {
          releaseRefresh = resolve;
        });
      }
      return Promise.resolve(snapshot(args.projectId === "p-b" ? "from-b" : "from-a"));
    });

    function RefreshProbe(): React.ReactElement {
      const { data, refreshFromBackend } = useIntegrations("claude");
      return (
        <div>
          <div data-testid="probe">{data?.mcpServers[0]?.name ?? "empty"}</div>
          <button type="button" data-testid="do-refresh" onClick={() => void refreshFromBackend()}>
            refresh
          </button>
        </div>
      );
    }

    useAppStore.setState({ selectedProjectId: "p-a", projects: [project("p-a"), project("p-b")] });
    render(<RefreshProbe />);
    await screen.findByText("from-a");

    // A refresh for A is parked in the main process…
    act(() => {
      screen.getByTestId("do-refresh").click();
    });
    await waitFor(() =>
      expect(invoke.mock.calls.some(([channel]) => channel === "integrations.refresh")).toBe(true),
    );

    // …the window moves to B, and B's read lands.
    act(() => {
      useAppStore.setState({ selectedProjectId: "p-b" });
    });
    await screen.findByText("from-b");

    // Now A's refresh finally resolves and runs its captured `reload`.
    await act(async () => {
      releaseRefresh?.();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(
        invoke.mock.calls.filter(
          ([channel, args]) =>
            channel === "integrations.list" && (args as { projectId?: string }).projectId === "p-a",
        ).length,
      ).toBe(1),
    );
    expect(screen.getByTestId("probe").textContent).toBe("from-b");
  });

  it("clears the previous scope's rows the moment the project changes", async () => {
    let releaseB: ((value: unknown) => void) | null = null;
    invoke.mockImplementation((_channel: string, args: { projectId?: string }) => {
      if (args.projectId === "p-b") return new Promise((resolve) => (releaseB = resolve));
      return Promise.resolve(snapshot("from-a"));
    });
    useAppStore.setState({ selectedProjectId: "p-a", projects: [project("p-a"), project("p-b")] });
    render(<Probe />);
    await screen.findByText("from-a");

    // While B's read is in flight the page must not still be offering A's rows
    // — a row (or a dialog opened from one) acted on now would be addressed to
    // a project this window has left.
    act(() => {
      useAppStore.setState({ selectedProjectId: "p-b" });
    });
    expect(screen.getByTestId("probe").textContent).toBe("loading");
    await act(async () => {
      releaseB?.(snapshot("from-b"));
    });
    expect(screen.getByTestId("probe").textContent).toBe("from-b");
  });
});

describe("integrations.changed is filtered by scope", () => {
  it("ignores another project's change and reloads on a global one", async () => {
    useAppStore.setState({ selectedProjectId: "p-a", projects: [project("p-a")] });
    invoke.mockResolvedValue(snapshot("from-a"));
    render(<Probe />);
    await screen.findByText("from-a");
    const reads = () =>
      invoke.mock.calls.filter(([channel]) => channel === "integrations.list").length;
    const before = reads();

    act(() => {
      for (const fn of listeners) {
        fn({ backend: "claude", kinds: ["mcpServers"], projectId: "p-b" });
      }
    });
    await waitFor(() => expect(reads()).toBe(before));

    act(() => {
      for (const fn of listeners) {
        fn({ backend: "claude", kinds: ["mcpServers"], projectId: null });
      }
    });
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
  });
});
