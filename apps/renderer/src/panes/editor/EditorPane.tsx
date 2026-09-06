/**
 * Editor pane (SPEC R16, item B2.3): one CodeMirror 6 instance shared across
 * every open file — switching tabs calls `view.setState(...)` on a cached
 * `EditorState` per path rather than mounting a fresh editor per tab, so
 * undo history and scroll position survive a tab switch without keeping N
 * live CodeMirror instances around.
 *
 * There is exactly one `editor` dockview panel (`WorkspaceHost`'s panel ids
 * are pane kinds); "tabs per open file" is this component's own tab strip,
 * not dockview panels — see `openInEditor.ts`'s doc comment. A file opens
 * two ways: `params.initialFilePath` (set when the Files pane created this
 * panel fresh) and `onOpenFileRequest` (the Files pane reaching an
 * already-open panel).
 *
 * Binary and over-the-cap (`FileReadResult.truncated`) files never get a
 * CodeMirror state at all — editing a truncated read and saving it back
 * would silently cut the file down to what `fs.read`'s cap happened to
 * return, so those tabs render a plain notice instead of a read-only editor
 * that merely *looks* safe.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { FileCodeIcon, Loader2Icon, XIcon } from "lucide-react";
import { EditorState } from "@codemirror/state";
import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { ipc } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { onOpenFileRequest } from "@/workspace/openFileBus";
import { registerPane } from "@/workspace/registry";
import type { WorkspacePaneProps } from "@/workspace/types";
import { editorExtensions } from "./codeMirrorSetup";

interface TabInfo {
  path: string;
  dirty: boolean;
  binary: boolean;
  readOnly: boolean;
  size: number;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function EditorPane({ params }: WorkspacePaneProps) {
  const { projectId } = params;
  const initialFilePath =
    typeof params.initialFilePath === "string" ? params.initialFilePath : undefined;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const statesRef = useRef<Map<string, EditorState>>(new Map());
  const savedContentRef = useRef<Map<string, string>>(new Map());
  const activePathRef = useRef<string | null>(null);

  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [cursor, setCursor] = useState<{ line: number; col: number } | null>(null);
  const [savingPaths, setSavingPaths] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  activePathRef.current = activePath;
  const tabsRef = useRef<TabInfo[]>(tabs);
  tabsRef.current = tabs;
  /** Paths with an `fs.read` in flight — `tabsRef` alone only reflects
   *  *committed* opens, so two near-simultaneous requests for the same path
   *  (see `FileTree.tsx`'s doc comment on why a double-click used to be
   *  three) would otherwise both pass the "already open?" check and each
   *  add their own tab. */
  const pendingOpensRef = useRef<Set<string>>(new Set());

  const recomputeDirty = useCallback((path: string) => {
    const state = statesRef.current.get(path);
    const saved = savedContentRef.current.get(path);
    if (!state || saved === undefined) return;
    const dirty = state.doc.toString() !== saved;
    setTabs((prev) => prev.map((t) => (t.path === path ? { ...t, dirty } : t)));
  }, []);

  const saveFile = useCallback(
    async (path: string) => {
      const state = statesRef.current.get(path);
      if (!state) return;
      const content = state.doc.toString();
      setSavingPaths((prev) => new Set(prev).add(path));
      setError(null);
      try {
        await ipc().invoke("fs.write", { projectId, path, content });
        savedContentRef.current.set(path, content);
        recomputeDirty(path);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSavingPaths((prev) => {
          const next = new Set(prev);
          next.delete(path);
          return next;
        });
      }
    },
    [projectId, recomputeDirty],
  );

  const openPath = useCallback(
    async (path: string) => {
      if (tabsRef.current.some((t) => t.path === path)) {
        activate(path);
        return;
      }
      if (pendingOpensRef.current.has(path)) return;
      pendingOpensRef.current.add(path);
      setError(null);
      try {
        const result = await ipc().invoke("fs.read", { projectId, path });
        const readOnly = result.binary || result.truncated;
        if (!result.binary) {
          const state = EditorState.create({
            doc: result.content,
            extensions: [
              basicSetup,
              EditorView.editable.of(!readOnly),
              EditorState.readOnly.of(readOnly),
              keymap.of([
                {
                  key: "Mod-s",
                  preventDefault: true,
                  run: () => {
                    void saveFile(path);
                    return true;
                  },
                },
              ]),
              EditorView.updateListener.of((update) => {
                statesRef.current.set(path, update.state);
                if (update.docChanged) recomputeDirty(path);
                if (path === activePathRef.current && (update.selectionSet || update.docChanged)) {
                  const head = update.state.selection.main.head;
                  const line = update.state.doc.lineAt(head);
                  setCursor({ line: line.number, col: head - line.from + 1 });
                }
              }),
              ...editorExtensions(path),
            ],
          });
          statesRef.current.set(path, state);
          savedContentRef.current.set(path, result.content);
        }
        setTabs((prev) => [...prev, { path, dirty: false, binary: result.binary, readOnly, size: result.size }]);
        activate(path);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        pendingOpensRef.current.delete(path);
      }
    },
    [projectId, recomputeDirty, saveFile],
  );

  function activate(path: string): void {
    setActivePath(path);
    activePathRef.current = path;
    const state = statesRef.current.get(path);
    if (state && viewRef.current) {
      viewRef.current.setState(state);
      const head = state.selection.main.head;
      const line = state.doc.lineAt(head);
      setCursor({ line: line.number, col: head - line.from + 1 });
    } else {
      setCursor(null);
    }
  }

  function closeTab(path: string): void {
    statesRef.current.delete(path);
    savedContentRef.current.delete(path);
    setTabs((prev) => {
      const next = prev.filter((t) => t.path !== path);
      if (activePathRef.current === path) {
        const fallback = next[next.length - 1]?.path ?? null;
        if (fallback) activate(fallback);
        else {
          setActivePath(null);
          activePathRef.current = null;
          setCursor(null);
          viewRef.current?.setState(EditorState.create({ extensions: [basicSetup] }));
        }
      }
      return next;
    });
  }

  // The one CodeMirror instance for this panel's whole lifetime.
  useEffect(() => {
    if (!containerRef.current) return;
    const view = new EditorView({
      state: EditorState.create({ extensions: [basicSetup] }),
      parent: containerRef.current,
    });
    viewRef.current = view;
    // Test seam only: jsdom cannot simulate real contenteditable typing
    // (a keydown there never mutates the DOM the way a real browser's does),
    // so `EditorPane.test.tsx` dispatches transactions straight at the view
    // it finds here instead. Nothing in production code reads this.
    (containerRef.current as unknown as { __cmView?: EditorView }).__cmView = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Mount-once: `containerRef` is stable for the component's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (initialFilePath) void openPath(initialFilePath);
    const unsubscribe = onOpenFileRequest((path) => void openPath(path));
    return unsubscribe;
    // Mount-once: a later `initialFilePath` change would need a fresh panel
    // anyway (`openInEditor.ts` only ever sets it for a brand-new panel).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeTab = tabs.find((t) => t.path === activePath) ?? null;
  const ext = activeTab ? activeTab.path.split(".").pop() ?? "" : "";

  return (
    <div className="flex h-full flex-col" data-testid="editor-pane">
      {tabs.length > 0 ? (
        <div
          className="flex shrink-0 items-stretch overflow-x-auto border-b border-border-weak"
          data-testid="editor-tabs"
        >
          {tabs.map((tab) => (
            <div
              key={tab.path}
              data-testid="editor-tab"
              data-path={tab.path}
              data-active={tab.path === activePath || undefined}
              onClick={() => activate(tab.path)}
              className={cn(
                "flex max-w-48 shrink-0 cursor-pointer items-center gap-1.5 border-r border-border-weak px-2.5 py-1.5 text-xs",
                tab.path === activePath
                  ? "bg-background text-foreground"
                  : "text-muted-foreground hover:bg-accent/40",
              )}
              title={tab.path}
            >
              <FileCodeIcon className="size-3 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{basename(tab.path)}</span>
              {savingPaths.has(tab.path) ? (
                <Loader2Icon className="size-3 shrink-0 animate-spin" />
              ) : tab.dirty ? (
                <span
                  data-testid="editor-tab-dirty"
                  aria-label="Unsaved changes"
                  className="size-1.5 shrink-0 rounded-full bg-warning"
                />
              ) : null}
              <button
                type="button"
                aria-label={`Close ${basename(tab.path)}`}
                data-testid="editor-tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.path);
                }}
                className="shrink-0 rounded p-0.5 hover:bg-accent"
              >
                <XIcon className="size-3" />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {error ? (
        <p role="alert" data-testid="editor-error" className="shrink-0 px-2 py-1 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <div className="relative min-h-0 flex-1">
        {tabs.length === 0 ? (
          <div
            data-testid="editor-empty"
            className="flex h-full items-center justify-center text-sm text-muted-foreground"
          >
            No file open. Double-click a file in the Files pane.
          </div>
        ) : null}
        {activeTab?.binary ? (
          <div
            data-testid="editor-binary-notice"
            className="flex h-full items-center justify-center text-sm text-muted-foreground"
          >
            Binary file — not shown.
          </div>
        ) : null}
        <div
          ref={containerRef}
          data-testid="editor-cm-container"
          className={cn("h-full", (tabs.length === 0 || activeTab?.binary) && "hidden")}
        />
      </div>

      {activeTab && !activeTab.binary ? (
        <div
          className="flex shrink-0 items-center gap-3 border-t border-border-weak px-2 py-1 text-[11px] text-muted-foreground"
          data-testid="editor-status-bar"
        >
          {activeTab.readOnly ? <span data-testid="editor-readonly-badge">Read-only</span> : null}
          {ext ? <span className="uppercase">{ext}</span> : null}
          <span className="ml-auto tabular-nums" data-testid="editor-cursor-pos">
            {cursor ? `Ln ${cursor.line}, Col ${cursor.col}` : ""}
          </span>
        </div>
      ) : null}
    </div>
  );
}

registerPane({ kind: "editor", title: "Editor", icon: FileCodeIcon, component: EditorPane });
