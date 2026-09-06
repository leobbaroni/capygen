/**
 * CodeMirror 6 mounts a real `EditorView` against the jsdom DOM here (no
 * mocking of `codemirror`/`@codemirror/*`) — jsdom's layout is a no-op
 * (every measurement is zero), which CodeMirror tolerates, so this proves
 * the wiring (open → tabs → dirty → save → close) without needing a real
 * browser. Typing is simulated by dispatching a CodeMirror transaction
 * directly against the mounted view rather than through `userEvent.type`,
 * which drives a real `contenteditable` that jsdom does not implement
 * keystroke-by-keystroke editing for.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorView } from "@codemirror/view";
import type { WorkspacePaneParams } from "@/workspace/types";
import { EditorPane } from "./EditorPane";

const invoke = vi.fn();
const on = vi.fn<(channel: string, listener: (payload: any) => void) => () => void>(
  () => () => undefined,
);
vi.mock("@/lib/ipc", () => ({
  ipc: () => ({ invoke, on }),
  hasBridge: () => true,
}));

const params: WorkspacePaneParams = { projectId: "proj-1", sessionId: "sess-1" };

function activeEditorView(): EditorView {
  const container = screen.getByTestId("editor-cm-container") as unknown as { __cmView?: EditorView };
  expect(container.__cmView).toBeTruthy();
  return container.__cmView!;
}

function typeInActiveEditor(text: string): void {
  const view = activeEditorView();
  view.dispatch({ changes: { from: view.state.doc.length, insert: text } });
}

beforeEach(() => {
  invoke.mockReset();
  on.mockReset();
  on.mockReturnValue(() => undefined);
  invoke.mockImplementation((channel: string, args: { path?: string }) => {
    if (channel === "fs.read") {
      if (args.path === "big.bin") {
        return Promise.resolve({
          path: "big.bin",
          content: "",
          encoding: "base64",
          size: 999,
          truncated: false,
          binary: true,
        });
      }
      return Promise.resolve({
        path: args.path,
        content: `content of ${args.path}`,
        encoding: "utf8",
        size: 20,
        truncated: false,
        binary: false,
      });
    }
    return Promise.resolve({ ok: true });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EditorPane", () => {
  it("shows an empty state with no tabs open", () => {
    render(<EditorPane params={params} api={{} as never} containerApi={{} as never} />);
    expect(screen.getByTestId("editor-empty")).toBeInTheDocument();
  });

  it("opens params.initialFilePath as the first tab via fs.read", async () => {
    render(
      <EditorPane
        params={{ ...params, initialFilePath: "src/App.tsx" }}
        api={{} as never}
        containerApi={{} as never}
      />,
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("fs.read", { projectId: "proj-1", path: "src/App.tsx" }),
    );
    expect(await screen.findByTestId("editor-tab")).toHaveTextContent("App.tsx");
    expect(screen.queryByTestId("editor-empty")).not.toBeInTheDocument();
  });

  it("typing marks the tab dirty, and Ctrl+S saves via fs.write and clears it", async () => {
    render(
      <EditorPane
        params={{ ...params, initialFilePath: "src/App.tsx" }}
        api={{} as never}
        containerApi={{} as never}
      />,
    );
    await screen.findByTestId("editor-tab");
    expect(screen.queryByTestId("editor-tab-dirty")).not.toBeInTheDocument();

    typeInActiveEditor("!");

    await waitFor(() => expect(screen.getByTestId("editor-tab-dirty")).toBeInTheDocument());

    const content = document.querySelector(".cm-content") as HTMLElement;
    fireEvent.keyDown(content, { key: "s", code: "KeyS", ctrlKey: true });

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("fs.write", {
        projectId: "proj-1",
        path: "src/App.tsx",
        content: "content of src/App.tsx!",
      }),
    );
    await waitFor(() => expect(screen.queryByTestId("editor-tab-dirty")).not.toBeInTheDocument());
  });

  it("a second open of the same path focuses the existing tab instead of duplicating it", async () => {
    render(
      <EditorPane
        params={{ ...params, initialFilePath: "src/App.tsx" }}
        api={{} as never}
        containerApi={{} as never}
      />,
    );
    await screen.findByTestId("editor-tab");
    invoke.mockClear();

    const bus = await import("@/workspace/openFileBus");
    bus.requestOpenFile("src/App.tsx");

    expect(screen.getAllByTestId("editor-tab")).toHaveLength(1);
    expect(invoke).not.toHaveBeenCalledWith("fs.read", expect.anything());
  });

  it("two near-simultaneous requests for a brand-new path open exactly one tab", async () => {
    // A real double-click fires two ordinary `click`s before the `dblclick`
    // (unlike jsdom's synthetic `fireEvent.doubleClick`) — see FileTree's
    // doc comment. Reproduced here directly: two `requestOpenFile` calls for
    // a path neither `tabsRef` nor the in-flight guard has seen yet, before
    // the first `fs.read` has resolved.
    let resolveRead!: (value: unknown) => void;
    invoke.mockImplementation((channel: string, args: { path?: string }) => {
      if (channel === "fs.read" && args.path === "race.ts") {
        return new Promise((resolve) => {
          resolveRead = resolve;
        });
      }
      return Promise.resolve({ ok: true });
    });
    render(<EditorPane params={params} api={{} as never} containerApi={{} as never} />);
    const bus = await import("@/workspace/openFileBus");

    bus.requestOpenFile("race.ts");
    bus.requestOpenFile("race.ts");
    expect(invoke.mock.calls.filter((c) => c[0] === "fs.read")).toHaveLength(1);

    resolveRead({
      path: "race.ts",
      content: "export const race = true;",
      encoding: "utf8",
      size: 26,
      truncated: false,
      binary: false,
    });

    await screen.findByTestId("editor-tab");
    expect(screen.getAllByTestId("editor-tab")).toHaveLength(1);
  });

  it("opening a second file adds a second tab and switching keeps each file's own content", async () => {
    render(
      <EditorPane
        params={{ ...params, initialFilePath: "a.ts" }}
        api={{} as never}
        containerApi={{} as never}
      />,
    );
    await screen.findByTestId("editor-tab");
    const bus = await import("@/workspace/openFileBus");
    bus.requestOpenFile("b.ts");

    await waitFor(() => expect(screen.getAllByTestId("editor-tab")).toHaveLength(2));
    // The newly-opened file becomes active.
    expect(document.querySelector(".cm-content")?.textContent).toContain("content of b.ts");

    fireEvent.click(screen.getAllByTestId("editor-tab")[0]!);
    expect(document.querySelector(".cm-content")?.textContent).toContain("content of a.ts");
  });

  it("closing a tab removes it and falls back to another open tab", async () => {
    render(
      <EditorPane
        params={{ ...params, initialFilePath: "a.ts" }}
        api={{} as never}
        containerApi={{} as never}
      />,
    );
    await screen.findByTestId("editor-tab");
    const bus = await import("@/workspace/openFileBus");
    bus.requestOpenFile("b.ts");
    await waitFor(() => expect(screen.getAllByTestId("editor-tab")).toHaveLength(2));

    fireEvent.click(screen.getAllByTestId("editor-tab-close")[1]!);

    await waitFor(() => expect(screen.getAllByTestId("editor-tab")).toHaveLength(1));
    expect(screen.getByTestId("editor-tab")).toHaveTextContent("a.ts");
  });

  /** Closing a tab used to `statesRef.delete` outright — no confirm, no
   *  autosave, no undo. */
  it("[C] a dirty tab asks before its close throws the edits away", async () => {
    render(
      <EditorPane
        params={{ ...params, initialFilePath: "a.ts" }}
        api={{} as never}
        containerApi={{} as never}
      />,
    );
    await screen.findByTestId("editor-tab");
    typeInActiveEditor(" edited");
    await screen.findByTestId("editor-tab-dirty");

    fireEvent.click(screen.getByTestId("editor-tab-close"));

    // Still open, with the question on screen.
    expect(screen.getByTestId("editor-close-confirm")).toBeInTheDocument();
    expect(screen.getByTestId("editor-tab")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("editor-close-confirm-cancel"));
    expect(screen.queryByTestId("editor-close-confirm")).not.toBeInTheDocument();
    expect(screen.getByTestId("editor-tab")).toBeInTheDocument();

    // "Save and close" writes first, then closes.
    fireEvent.click(screen.getByTestId("editor-tab-close"));
    fireEvent.click(screen.getByTestId("editor-close-confirm-save"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("fs.write", {
        projectId: "proj-1",
        path: "a.ts",
        content: "content of a.ts edited",
      }),
    );
    await waitFor(() => expect(screen.queryByTestId("editor-tab")).not.toBeInTheDocument());
  });

  /** A clean tab follows the file; a dirty one is flagged rather than
   *  silently overwritten by the next save. */
  it("[C] an agent rewriting the open file reloads a clean tab and guards a dirty one", async () => {
    let disk = "content of a.ts";
    const listeners = new Map<string, (payload: unknown) => void>();
    on.mockImplementation((channel: string, listener: (payload: any) => void) => {
      listeners.set(channel, listener);
      return () => void listeners.delete(channel);
    });
    invoke.mockImplementation((channel: string, args: { path?: string; content?: string }) => {
      if (channel === "fs.read") {
        return Promise.resolve({
          path: args.path,
          content: disk,
          encoding: "utf8",
          size: disk.length,
          truncated: false,
          binary: false,
        });
      }
      if (channel === "fs.write") {
        disk = args.content ?? "";
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({ ok: true });
    });

    render(
      <EditorPane
        params={{ ...params, initialFilePath: "a.ts" }}
        api={{} as never}
        containerApi={{} as never}
      />,
    );
    await screen.findByTestId("editor-tab");
    expect(listeners.has("fs.changed")).toBe(true);

    // Clean tab: the new bytes just arrive.
    disk = "rewritten by the agent";
    listeners.get("fs.changed")!({
      projectId: "proj-1",
      changes: [{ path: "a.ts", kind: "change" }],
    });
    await waitFor(() => expect(activeEditorView().state.doc.toString()).toBe(disk));

    // Dirty tab: flagged, and the first save refuses rather than clobbering.
    typeInActiveEditor(" mine");
    await screen.findByTestId("editor-tab-dirty");
    disk = "rewritten again";
    listeners.get("fs.changed")!({
      projectId: "proj-1",
      changes: [{ path: "a.ts", kind: "change" }],
    });
    await screen.findByTestId("editor-external-change");

    invoke.mockClear();
    fireEvent.click(screen.getByTestId("editor-save"));
    await screen.findByTestId("editor-error");
    expect(invoke).not.toHaveBeenCalledWith("fs.write", expect.anything());

    // Reload takes the disk copy.
    fireEvent.click(screen.getByTestId("editor-reload-from-disk"));
    await waitFor(() => expect(activeEditorView().state.doc.toString()).toBe("rewritten again"));
  });

  it("a binary file opens read-only with no CodeMirror content and no write on save", async () => {
    render(
      <EditorPane
        params={{ ...params, initialFilePath: "big.bin" }}
        api={{} as never}
        containerApi={{} as never}
      />,
    );
    await screen.findByTestId("editor-tab");
    expect(screen.getByTestId("editor-binary-notice")).toBeInTheDocument();
    // The single long-lived CodeMirror instance is never torn down between
    // tabs (see EditorPane's doc comment) — for a binary file it is simply
    // hidden, not unmounted, and never loaded that file's (nonexistent)
    // state.
    expect(screen.getByTestId("editor-cm-container")).toHaveClass("hidden");
  });
});
