import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DockviewApi } from "dockview-react";
import { registerPane } from "@/workspace/registry";
import type { WorkspacePaneParams } from "@/workspace/types";
import { FilesPane } from "./FilesPane";

// `openFileInEditor` (used by the double-click test) looks the Editor pane
// up in the real registry — register a stand-in so that lookup succeeds
// without pulling in the real (CodeMirror-backed) EditorPane.
registerPane({ kind: "editor", title: "Editor", icon: () => null, component: () => null });

const invoke = vi.fn();
const on = vi.fn<(channel: string, listener: (payload: any) => void) => () => void>();
vi.mock("@/lib/ipc", () => ({
  ipc: () => ({ invoke, on }),
  hasBridge: () => true,
}));

const params: WorkspacePaneParams = { projectId: "proj-1", sessionId: "sess-1" };

function fakeContainerApi(): DockviewApi {
  return {
    getPanel: vi.fn(() => undefined),
    addPanel: vi.fn(),
  } as unknown as DockviewApi;
}

beforeEach(() => {
  invoke.mockReset();
  on.mockReset();
  on.mockReturnValue(() => undefined);
  invoke.mockImplementation((channel: string, args: { dir?: string }) => {
    if (channel === "fs.list") {
      if (args.dir === "") {
        return Promise.resolve({
          entries: [
            { path: "src", name: "src", kind: "dir" },
            { path: "README.md", name: "README.md", kind: "file" },
          ],
          truncated: false,
        });
      }
      if (args.dir === "src") {
        return Promise.resolve({
          entries: [{ path: "src/index.ts", name: "index.ts", kind: "file" }],
          truncated: false,
        });
      }
      return Promise.resolve({ entries: [], truncated: false });
    }
    if (channel === "fs.search") {
      return Promise.resolve({
        entries: [{ path: "src/index.ts", name: "index.ts", kind: "file" }],
        truncated: false,
      });
    }
    return Promise.resolve({ ok: true });
  });
});

afterEach(() => {
  vi.clearAllTimers();
});

describe("FilesPane", () => {
  it("lists the project root via fs.list on mount", async () => {
    render(<FilesPane params={params} api={{} as never} containerApi={fakeContainerApi()} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("fs.list", { projectId: "proj-1", dir: "" }));
    expect(await screen.findByText("src")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
  });

  it("lazily lists a directory's children on expand", async () => {
    render(<FilesPane params={params} api={{} as never} containerApi={fakeContainerApi()} />);
    await screen.findByText("src");
    expect(invoke).not.toHaveBeenCalledWith("fs.list", { projectId: "proj-1", dir: "src" });

    fireEvent.click(screen.getByText("src"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("fs.list", { projectId: "proj-1", dir: "src" }),
    );
    expect(await screen.findByText("index.ts")).toBeInTheDocument();
  });

  it("double-clicking a file opens it in the Editor pane exactly once", async () => {
    const containerApi = fakeContainerApi();
    render(<FilesPane params={params} api={{} as never} containerApi={containerApi} />);
    const readme = await screen.findByText("README.md");

    // A real double-click fires two ordinary `click` events before the
    // `dblclick` — `fireEvent.doubleClick` alone does not reproduce that,
    // which is exactly what let a single click *also* opening a file slip
    // through this pane's own test suite (see FileTree.tsx's doc comment).
    fireEvent.click(readme);
    fireEvent.click(readme);
    fireEvent.doubleClick(readme);

    expect(containerApi.addPanel).toHaveBeenCalledTimes(1);
    expect(containerApi.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "editor",
        component: "editor",
        params: expect.objectContaining({ initialFilePath: "README.md" }),
      }),
    );
  });

  it("a single click on a file does not open it", async () => {
    const containerApi = fakeContainerApi();
    render(<FilesPane params={params} api={{} as never} containerApi={containerApi} />);
    const readme = await screen.findByText("README.md");

    fireEvent.click(readme);

    expect(containerApi.addPanel).not.toHaveBeenCalled();
  });

  it("searches via fs.search and renders matches, debounced", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<FilesPane params={params} api={{} as never} containerApi={fakeContainerApi()} />);
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("fs.list", { projectId: "proj-1", dir: "" }),
    );

    fireEvent.change(screen.getByTestId("files-search-input"), { target: { value: "index" } });
    expect(invoke).not.toHaveBeenCalledWith("fs.search", expect.anything());

    await vi.advanceTimersByTimeAsync(250);

    expect(invoke).toHaveBeenCalledWith("fs.search", { projectId: "proj-1", query: "index", limit: 200 });
    await vi.waitFor(() => expect(screen.getByTestId("files-search-results")).toHaveTextContent("src/index.ts"));
    vi.useRealTimers();
  });

  it("watches the project and refreshes the tree on fs.changed", async () => {
    render(<FilesPane params={params} api={{} as never} containerApi={fakeContainerApi()} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("fs.watch", { projectId: "proj-1" }));
    const callsBefore = invoke.mock.calls.filter(
      (c) => c[0] === "fs.list" && (c[1] as { dir: string }).dir === "",
    ).length;

    const call = on.mock.calls.find(([channel]) => channel === "fs.changed");
    expect(call).toBeTruthy();
    call![1]({ projectId: "proj-1", changes: [{ path: "README.md", kind: "change" }] });

    await waitFor(() => {
      const callsAfter = invoke.mock.calls.filter(
        (c) => c[0] === "fs.list" && (c[1] as { dir: string }).dir === "",
      ).length;
      expect(callsAfter).toBeGreaterThan(callsBefore);
    });
  });

  it("shows an error instead of hanging when fs.list fails", async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === "fs.list") return Promise.reject(new Error("disk unavailable"));
      return Promise.resolve({ ok: true });
    });
    render(<FilesPane params={params} api={{} as never} containerApi={fakeContainerApi()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("disk unavailable");
  });
});
