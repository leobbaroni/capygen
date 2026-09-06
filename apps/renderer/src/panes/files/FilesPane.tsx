/**
 * Files pane (SPEC R16, item B2.2): a lazy directory tree over `fs.list`
 * plus a search box over `fs.search`, matching `FilesPanel`/`FolderTree`/
 * `FlatFileList`'s look (`reference/omnigent/web/src/shell/`) — reimplemented
 * against capygen's own IPC contract, never importing the reference.
 *
 * Double-click (or the context menu's "Open") on a file routes through
 * `openFileInEditor`, which either focuses the already-open Editor pane or
 * creates it — the one place this pane reaches outside itself, via its own
 * `containerApi` (`IDockviewPanelProps`, not a global store).
 *
 * [C] `fs.changed` is coalesced here, and *read*. `FsService` already batches
 * at 250 ms, so sustained activity outside the ignore list (a formatter, a
 * non-ignored build directory, someone editing in another editor) arrives
 * about four times a second — and the naive handler answered each batch with
 * a full root `fs.list` **plus** one `fs.list` per expanded directory, thrown
 * at the main process indefinitely whether or not the change touched any of
 * them. The batch says exactly which paths moved, so only the directories
 * that actually contain one are re-listed, and only after the burst settles
 * (R23-R26). While the tab is hidden the work is deferred entirely —
 * `WorkspaceHost` mounts every pane with `defaultRenderer="always"`, so
 * "mounted" is not "on screen".
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { FolderIcon, SearchIcon } from "lucide-react";
import type { FileEntry } from "@capygen/shared";
import { ipc } from "@/lib/ipc";
import { openFileInEditor } from "@/workspace/openInEditor";
import { registerPane } from "@/workspace/registry";
import type { WorkspacePaneProps } from "@/workspace/types";
import { FileTree } from "./FileTree";

const SEARCH_DEBOUNCE_MS = 200;
/** One refresh per burst of watcher batches, not one per batch. */
const REFRESH_DEBOUNCE_MS = 300;

/** `"src/main.ts"` → `"src"`, `"README.md"` → `""` (the project root). */
function parentDir(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

export function FilesPane({ params, api, containerApi }: WorkspacePaneProps) {
  const { projectId } = params;
  const [root, setRoot] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<FileEntry[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  /** Directories the last settled burst actually touched; `FileTree` re-lists
   *  only the expanded ones that appear here. */
  const [changedDirs, setChangedDirs] = useState<readonly string[]>([]);
  const searchSeq = useRef(0);
  const pendingDirs = useRef<Set<string>>(new Set());
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [visible, setVisible] = useState(api.isVisible);
  useEffect(() => {
    setVisible(api.isVisible);
    const disposable = api.onDidVisibilityChange((event) => setVisible(event.isVisible));
    return () => disposable.dispose();
  }, [api]);

  const load = useCallback(async () => {
    try {
      const result = await ipc().invoke("fs.list", { projectId, dir: "" });
      setRoot(result.entries);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Apply whatever the watcher has reported since the last flush. */
  const flushChanges = useCallback(() => {
    const dirs = [...pendingDirs.current];
    pendingDirs.current.clear();
    if (dirs.length === 0) return;
    // The root list is this component's own state, so it is refreshed here
    // rather than through the tree's token.
    if (dirs.includes("")) void load();
    setChangedDirs(dirs);
    setRefreshToken((t) => t + 1);
  }, [load]);

  useEffect(() => {
    let disposed = false;
    void ipc()
      .invoke("fs.watch", { projectId })
      .catch(() => undefined);
    const unsubscribe = ipc().on("fs.changed", (event) => {
      if (disposed || event.projectId !== projectId) return;
      for (const change of event.changes) {
        pendingDirs.current.add(parentDir(change.path));
        // A directory appearing or disappearing changes its *parent's* list
        // and, if it was open, its own.
        if (change.kind === "addDir" || change.kind === "unlinkDir") {
          pendingDirs.current.add(change.path);
        }
      }
      if (refreshTimer.current) return;
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = null;
        // Hidden tab: keep the pending set and let the visibility effect
        // below flush it once the pane is on screen again.
        if (!api.isVisible) return;
        flushChanges();
      }, REFRESH_DEBOUNCE_MS);
    });
    return () => {
      disposed = true;
      unsubscribe();
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
      void ipc()
        .invoke("fs.unwatch", { projectId })
        .catch(() => undefined);
    };
  }, [projectId, api, flushChanges]);

  // Catch up on everything that happened while this tab was behind another.
  useEffect(() => {
    if (!visible) return;
    flushChanges();
  }, [visible, flushChanges]);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === "") {
      setSearchResults(null);
      setSearching(false);
      return;
    }
    const seq = ++searchSeq.current;
    setSearching(true);
    const handle = setTimeout(() => {
      void ipc()
        .invoke("fs.search", { projectId, query: trimmed, limit: 200 })
        .then((result) => {
          if (searchSeq.current !== seq) return;
          setSearchResults(result.entries);
          setSearching(false);
        })
        .catch(() => {
          if (searchSeq.current !== seq) return;
          setSearchResults([]);
          setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query, projectId]);

  function openFile(path: string): void {
    openFileInEditor(containerApi, params, path);
  }

  return (
    <div className="flex h-full flex-col" data-testid="files-pane">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border-weak px-2 py-1.5">
        <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search files…"
          aria-label="Search files"
          data-testid="files-search-input"
          className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1" data-testid="files-tree-container">
        {error ? (
          <p role="alert" className="px-2 py-2 text-xs text-destructive">
            {error}
          </p>
        ) : query.trim() !== "" ? (
          searching ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">Searching…</p>
          ) : (
            <ul data-testid="files-search-results">
              {(searchResults ?? []).length === 0 ? (
                <li className="px-2 py-2 text-xs text-muted-foreground">No matches.</li>
              ) : (
                (searchResults ?? []).map((entry) => (
                  <li
                    key={entry.path}
                    data-testid="file-search-result-row"
                    className="flex cursor-pointer items-center gap-1.5 px-2 py-1 text-xs text-foreground hover:bg-accent/50"
                    onClick={() => entry.kind === "file" && openFile(entry.path)}
                  >
                    <span className="min-w-0 flex-1 truncate">{entry.path}</span>
                  </li>
                ))
              )}
            </ul>
          )
        ) : root === null ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">Loading…</p>
        ) : (
          <FileTree
            projectId={projectId}
            entries={root}
            onOpenFile={openFile}
            refreshToken={refreshToken}
            changedDirs={changedDirs}
          />
        )}
      </div>
    </div>
  );
}

registerPane({ kind: "files", title: "Files", icon: FolderIcon, component: FilesPane });
