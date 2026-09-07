import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function renderPane(projectId = params.projectId) {
  return render(
    <DiffPane
      params={{ ...params, projectId }}
      api={{} as never}
      containerApi={{} as never}
    />,
  );
}

/** A `git.status` answer with the given paths, all plain modifications. */
function statusOf(...paths: string[]) {
  return {
    branch: "main",
    ahead: 0,
    behind: 0,
    entries: paths.map((path) => ({ path, status: "M" })),
  };
}

/** The paths currently ticked, read off the rendered checkboxes. */
function checkedPaths(): string[] {
  return screen
    .getAllByTestId("diff-status-check")
    .filter((box) => (box as HTMLInputElement).checked)
    .map((box) => box.getAttribute("data-path") ?? "");
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

    // Named paths, not `git commit --all`: the pane commits exactly the rows
    // it shows as ticked, which is also what makes an untracked file
    // committable (`GitService.commit` stages them first).
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("git.commit", {
        projectId: "proj-1",
        message: "fix: thing",
        paths: ["src/App.tsx"],
      }),
    );
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

describe("DiffPane selection across refreshes", () => {
  it("keeps the user's ticks and leaves a newly discovered file unticked", async () => {
    let entries = statusOf("a.ts", "b.ts");
    invoke.mockImplementation((channel: string) => {
      if (channel === "git.status") return Promise.resolve(entries);
      return Promise.resolve({ ok: true });
    });
    renderPane();
    await screen.findByTestId("diff-status-list");
    // Untouched: everything git reports is ticked.
    await waitFor(() => expect(checkedPaths()).toEqual(["a.ts", "b.ts"]));

    fireEvent.click(screen.getAllByTestId("diff-status-check")[1]!);
    expect(checkedPaths()).toEqual(["a.ts"]);

    // A refresh that also discovers c.ts must not re-tick b.ts or tick c.ts:
    // committing a file the user never saw is the failure this prevents.
    entries = statusOf("a.ts", "b.ts", "c.ts");
    fireEvent.click(screen.getByTestId("diff-refresh"));
    await waitFor(() => expect(screen.getAllByTestId("diff-status-check")).toHaveLength(3));
    expect(checkedPaths()).toEqual(["a.ts"]);
  });

  it("drops a ticked path that git no longer reports", async () => {
    let entries = statusOf("a.ts", "b.ts");
    invoke.mockImplementation((channel: string) => {
      if (channel === "git.status") return Promise.resolve(entries);
      return Promise.resolve({ ok: true });
    });
    renderPane();
    await screen.findByTestId("diff-status-list");
    fireEvent.click(screen.getAllByTestId("diff-status-check")[1]!);
    expect(checkedPaths()).toEqual(["a.ts"]);

    entries = statusOf("b.ts");
    fireEvent.click(screen.getByTestId("diff-refresh"));
    await waitFor(() => expect(screen.getAllByTestId("diff-status-check")).toHaveLength(1));
    expect(checkedPaths()).toEqual([]);
  });

  it("commits exactly the ticked paths", async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === "git.status") return Promise.resolve(statusOf("a.ts", "b.ts", "c.ts"));
      return Promise.resolve({ ok: true, sha: "abc" });
    });
    renderPane();
    await screen.findByTestId("diff-status-list");
    fireEvent.click(screen.getAllByTestId("diff-status-check")[1]!);

    fireEvent.change(screen.getByTestId("diff-commit-message"), {
      target: { value: "only two" },
    });
    fireEvent.click(screen.getByTestId("diff-commit-submit"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("git.commit", {
        projectId: "proj-1",
        message: "only two",
        paths: ["a.ts", "c.ts"],
      }),
    );
  });
});

describe("DiffPane on a project switch", () => {
  it("clears the previous project's selection instead of carrying it over", async () => {
    invoke.mockImplementation((channel: string, payload: any) => {
      if (channel === "git.status") {
        return Promise.resolve(
          payload.projectId === "proj-1" ? statusOf("a.ts", "b.ts") : statusOf("x.ts", "y.ts"),
        );
      }
      return Promise.resolve({ ok: true });
    });
    const view = renderPane("proj-1");
    await screen.findByTestId("diff-status-list");
    fireEvent.click(screen.getAllByTestId("diff-status-check")[0]!);
    expect(checkedPaths()).toEqual(["b.ts"]);

    view.rerender(
      <DiffPane
        params={{ ...params, projectId: "proj-2" }}
        api={{} as never}
        containerApi={{} as never}
      />,
    );
    await waitFor(() => expect(checkedPaths()).toEqual(["x.ts", "y.ts"]));
    // The new project starts untouched, so its own files are ticked and none
    // of the old project's paths survive anywhere in the list.
    expect(screen.queryByText("a.ts")).not.toBeInTheDocument();
    expect(screen.queryByText("b.ts")).not.toBeInTheDocument();
  });

  it("never commits the old project's paths after a switch", async () => {
    const commits: unknown[] = [];
    invoke.mockImplementation((channel: string, payload: any) => {
      if (channel === "git.status") {
        return Promise.resolve(
          payload.projectId === "proj-1" ? statusOf("a.ts") : statusOf("x.ts"),
        );
      }
      if (channel === "git.commit") commits.push(payload);
      return Promise.resolve({ ok: true });
    });
    const view = renderPane("proj-1");
    await screen.findByTestId("diff-status-list");
    fireEvent.change(screen.getByTestId("diff-commit-message"), {
      target: { value: "old project" },
    });

    view.rerender(
      <DiffPane
        params={{ ...params, projectId: "proj-2" }}
        api={{} as never}
        containerApi={{} as never}
      />,
    );
    await waitFor(() => expect(checkedPaths()).toEqual(["x.ts"]));
    // The message was cleared with the rest of the old project's state, so the
    // button is disabled and nothing can be sent by a stray click.
    expect(screen.getByTestId("diff-commit-message")).toHaveValue("");
    fireEvent.click(screen.getByTestId("diff-commit-submit"));
    await waitFor(() => expect(commits).toEqual([]));
  });

  it("drops a status response that arrives after the project changed", async () => {
    // A plain `let` narrows to `never` after the executor assigns it, so the
    // deferred resolver is held in a box TypeScript cannot narrow away.
    const deferred: { resolve?: (value: unknown) => void } = {};
    invoke.mockImplementation((channel: string, payload: any) => {
      if (channel === "git.status") {
        if (payload.projectId === "proj-1") {
          return new Promise((resolve) => {
            deferred.resolve = resolve;
          });
        }
        return Promise.resolve(statusOf("x.ts"));
      }
      return Promise.resolve({ ok: true });
    });
    const view = renderPane("proj-1");
    view.rerender(
      <DiffPane
        params={{ ...params, projectId: "proj-2" }}
        api={{} as never}
        containerApi={{} as never}
      />,
    );
    await waitFor(() => expect(checkedPaths()).toEqual(["x.ts"]));

    // proj-1 answers late; its files must not appear under proj-2.
    deferred.resolve?.(statusOf("a.ts", "b.ts"));
    await waitFor(() => expect(checkedPaths()).toEqual(["x.ts"]));
    expect(screen.queryByText("a.ts")).not.toBeInTheDocument();
  });

  it("drops a diff response that arrives after another row was clicked", async () => {
    const deferredA: { resolve?: (value: unknown) => void } = {};
    invoke.mockImplementation((channel: string, payload: any) => {
      if (channel === "git.status") return Promise.resolve(statusOf("a.ts", "b.ts"));
      if (channel === "git.diff") {
        if (payload.path === "a.ts") {
          return new Promise((resolve) => {
            deferredA.resolve = resolve;
          });
        }
        return Promise.resolve([{ path: "b.ts", unified: "--- a/b.ts\n+++ b/b.ts\n@@ -0,0 +1 @@\n+b" }]);
      }
      return Promise.resolve({ ok: true });
    });
    renderPane();
    await screen.findByTestId("diff-status-list");

    fireEvent.click(screen.getAllByTestId("diff-status-row")[0]!);
    fireEvent.click(screen.getAllByTestId("diff-status-row")[1]!);
    await screen.findByTestId("diff-pane-view");

    // a.ts answers late; b.ts's patch must stay on screen under b.ts's name.
    deferredA.resolve?.([{ path: "a.ts", unified: "--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1 @@\n+a" }]);
    await waitFor(() => expect(screen.getByTestId("diff-pane-view")).toBeInTheDocument());
    expect(screen.getByTestId("diff-body").textContent).toContain("b.ts");
    expect(screen.getByTestId("diff-body").textContent).not.toContain("+a");
  });
  it.each(["success", "failure"])("ignores an old commit's %s after switching away and back", async (outcome) => {
    const deferred: { resolve?: (value: unknown) => void; reject?: (error: Error) => void } = {};
    invoke.mockImplementation((channel: string) => {
      if (channel === "git.status") return Promise.resolve(statusOf("a.ts"));
      if (channel === "git.commit") return new Promise((resolve, reject) => {
        deferred.resolve = resolve;
        deferred.reject = reject;
      });
      return Promise.resolve({ ok: true });
    });
    const view = renderPane();
    await screen.findByTestId("diff-status-list");
    fireEvent.change(screen.getByTestId("diff-commit-message"), { target: { value: "old commit" } });
    fireEvent.click(screen.getByTestId("diff-commit-submit"));
    expect(invoke).toHaveBeenCalledWith("git.commit", expect.objectContaining({ message: "old commit" }));
    for (const projectId of ["proj-2", "proj-1"]) {
      view.rerender(<DiffPane params={{ ...params, projectId }} api={{} as never} containerApi={{} as never} />);
      await screen.findByTestId("diff-status-list");
    }
    fireEvent.change(screen.getByTestId("diff-commit-message"), { target: { value: "new draft" } });
    expect(screen.getByTestId("diff-commit-submit")).toBeEnabled();
    await act(async () => {
      if (outcome === "success") deferred.resolve?.({ ok: true });
      else deferred.reject?.(new Error("old project failure"));
    });
    expect(screen.getByTestId("diff-commit-message")).toHaveValue("new draft");
    expect(screen.queryByTestId("diff-error")).not.toBeInTheDocument();
    expect(screen.getByTestId("diff-commit-submit")).toBeEnabled();
  });

});
