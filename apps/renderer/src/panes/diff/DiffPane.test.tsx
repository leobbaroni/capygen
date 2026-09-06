import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspacePaneParams } from "@/workspace/types";
import { DiffPane } from "./DiffPane";

const invoke = vi.fn();
const on = vi.fn<(channel: string, listener: (payload: any) => void) => () => void>();
vi.mock("@/lib/ipc", () => ({
  ipc: () => ({ invoke, on }),
  hasBridge: () => true,
}));

const params: WorkspacePaneParams = { projectId: "proj-1", sessionId: "sess-1" };

beforeEach(() => {
  invoke.mockReset();
  on.mockReset();
  on.mockReturnValue(() => undefined);
});

function renderPane() {
  return render(<DiffPane params={params} api={{} as never} containerApi={{} as never} />);
}

describe("DiffPane", () => {
  it("shows a quiet message when the project is not a git repository", async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === "git.status") return Promise.resolve(null);
      return Promise.resolve({ ok: true });
    });
    renderPane();
    expect(await screen.findByTestId("diff-not-a-repo")).toBeInTheDocument();
  });

  it("lists git.status entries with a badge per status code", async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === "git.status") {
        return Promise.resolve({
          branch: "main",
          ahead: 0,
          behind: 0,
          entries: [
            { path: "src/App.tsx", status: "M" },
            { path: "src/new.ts", status: "??" },
          ],
        });
      }
      return Promise.resolve({ ok: true });
    });
    renderPane();
    const rows = await screen.findAllByTestId("diff-status-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("src/App.tsx");
    expect(rows[0]).toHaveTextContent("Modified");
    expect(rows[1]).toHaveTextContent("Untracked");
    expect(screen.getByTestId("diff-branch")).toHaveTextContent("main");
  });

  it("clicking an entry fetches and renders its unified diff", async () => {
    invoke.mockImplementation((channel: string, args: { path?: string }) => {
      if (channel === "git.status") {
        return Promise.resolve({
          branch: "main",
          ahead: 0,
          behind: 0,
          entries: [{ path: "src/App.tsx", status: "M" }],
        });
      }
      if (channel === "git.diff") {
        expect(args.path).toBe("src/App.tsx");
        return Promise.resolve([
          { path: "src/App.tsx", unified: "@@ -1,2 +1,2 @@\n-old\n+new\n" },
        ]);
      }
      return Promise.resolve({ ok: true });
    });
    renderPane();
    const row = await screen.findByTestId("diff-status-row");
    fireEvent.click(row);

    await waitFor(() => expect(screen.getByTestId("diff-pane-view")).toBeInTheDocument());
    expect(screen.getByTestId("diff-pane-view")).toHaveTextContent("+new");
    expect(screen.getByTestId("diff-pane-view")).toHaveTextContent("-old");
  });

  it("commits with the typed message and refreshes the status list", async () => {
    let committed = false;
    invoke.mockImplementation((channel: string, args: { message?: string }) => {
      if (channel === "git.status") {
        return Promise.resolve({
          branch: "main",
          ahead: 0,
          behind: 0,
          entries: committed ? [] : [{ path: "src/App.tsx", status: "M" }],
        });
      }
      if (channel === "git.commit") {
        expect(args.message).toBe("fix: thing");
        committed = true;
        return Promise.resolve({ ok: true, sha: "abc123" });
      }
      return Promise.resolve({ ok: true });
    });
    renderPane();
    await screen.findByTestId("diff-status-row");

    fireEvent.change(screen.getByTestId("diff-commit-message"), { target: { value: "fix: thing" } });
    fireEvent.click(screen.getByTestId("diff-commit-submit"));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("git.commit", { projectId: "proj-1", message: "fix: thing" }));
    await waitFor(() => expect(screen.getByTestId("diff-status-list")).toHaveTextContent("No changes."));
  });

  it("refreshes on fs.changed", async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === "git.status") {
        return Promise.resolve({ branch: "main", ahead: 0, behind: 0, entries: [] });
      }
      return Promise.resolve({ ok: true });
    });
    renderPane();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("git.status", { projectId: "proj-1" }));
    invoke.mockClear();

    const call = on.mock.calls.find(([channel]) => channel === "fs.changed");
    expect(call).toBeTruthy();
    call![1]({ projectId: "proj-1" });

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("git.status", { projectId: "proj-1" }));
  });

  it("shows an error banner without crashing when git.status rejects", async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === "git.status") return Promise.reject(new Error("git not found"));
      return Promise.resolve({ ok: true });
    });
    renderPane();
    expect(await screen.findByTestId("diff-error")).toHaveTextContent("git not found");
  });
});
