/**
 * A lazily-expanding directory tree (matches `FolderTree`'s VS Code-style
 * indent guides + chevron, `reference/omnigent/web/src/shell/FolderTree.tsx`
 * — reimplemented against `fs.list` rather than ported, per the reference
 * being layout/behaviour guidance, never a dependency).
 *
 * A directory's children are fetched on first expand and cached by path;
 * `refreshToken` re-fetches every currently-expanded directory (and the root,
 * via the caller re-passing `entries`) when `FilesPane` sees an `fs.changed`
 * event — the tree does not diff individual chokidar events itself, a whole
 * re-list of the open directories is simpler and still bounded (R23-R26: the
 * backend caps entries per directory, not just per watcher).
 *
 * Not virtualised: `fs.list`'s own per-directory cap (`FileListResult.
 * truncated`) already bounds the worst case, so a dedicated virtualisation
 * dependency was not worth adding for this phase — a directory at the cap
 * says so (`"N+ entries, truncated"`) instead of silently hiding the rest.
 */
import { useEffect, useState } from "react";
import { ChevronRightIcon, FolderIcon, FolderOpenIcon } from "lucide-react";
import type { FileEntry } from "@capygen/shared";
import { cn } from "@/lib/utils";
import { ipc } from "@/lib/ipc";
import { fileIconFor } from "./fileIcons";

const INDENT_STEP = 14;
const BASE_PAD = 6;

export interface FileTreeProps {
  projectId: string;
  entries: FileEntry[];
  onOpenFile: (path: string) => void;
  refreshToken?: number;
}

function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function FileTree({ projectId, entries, onOpenFile, refreshToken }: FileTreeProps) {
  const [childrenByPath, setChildrenByPath] = useState<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [truncatedDirs, setTruncatedDirs] = useState<Set<string>>(new Set());

  async function loadDir(path: string): Promise<void> {
    setLoadingDirs((prev) => new Set(prev).add(path));
    try {
      const result = await ipc().invoke("fs.list", { projectId, dir: path });
      setChildrenByPath((prev) => ({ ...prev, [path]: result.entries }));
      setTruncatedDirs((prev) => {
        const next = new Set(prev);
        if (result.truncated) next.add(path);
        else next.delete(path);
        return next;
      });
    } finally {
      setLoadingDirs((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    }
  }

  function toggleDir(path: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    if (!childrenByPath[path]) void loadDir(path);
  }

  // Re-fetch every directory the user has open — see the module doc comment.
  useEffect(() => {
    if (refreshToken === undefined) return;
    for (const path of expanded) void loadDir(path);
    // `loadDir`/`expanded` intentionally excluded: this effect's only job is
    // to react to a *new* refreshToken value, not to loop on its own writes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  return (
    <ul data-testid="files-tree" role="tree">
      {sortEntries(entries).map((entry) => (
        <FileTreeRow
          key={entry.path}
          entry={entry}
          depth={0}
          expanded={expanded}
          childrenByPath={childrenByPath}
          loadingDirs={loadingDirs}
          truncatedDirs={truncatedDirs}
          onToggleDir={toggleDir}
          onOpenFile={onOpenFile}
        />
      ))}
    </ul>
  );
}

function FileTreeRow({
  entry,
  depth,
  expanded,
  childrenByPath,
  loadingDirs,
  truncatedDirs,
  onToggleDir,
  onOpenFile,
}: {
  entry: FileEntry;
  depth: number;
  expanded: Set<string>;
  childrenByPath: Record<string, FileEntry[]>;
  loadingDirs: Set<string>;
  truncatedDirs: Set<string>;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const isDir = entry.kind === "dir";
  const isOpen = expanded.has(entry.path);
  const Icon = isDir ? (isOpen ? FolderOpenIcon : FolderIcon) : fileIconFor(entry.name);
  const pad = depth * INDENT_STEP + BASE_PAD;

  // A single click only ever toggles a directory — a file's single click is
  // a no-op (row highlight aside), and *only* double-click or a keyboard
  // Enter/Space opens it. This was not just a style choice: a real browser's
  // double-click fires two ordinary `click` events before the `dblclick`
  // (jsdom's synthetic `fireEvent.doubleClick` does not, which is why the
  // race this avoids never showed up in this pane's own unit test), so a
  // single click that *also* opened the file made every double-click call
  // `onOpenFile` three times — racing three `fs.read`s for the same path
  // against the Editor pane's own "is this path already a tab" check and
  // opening it as two duplicate tabs (a real browser via Playwright caught
  // this; `tests/e2e` and `dev-workspace-screenshots.mjs` are what a mocked
  // `fireEvent` cannot).
  function activateClick(): void {
    if (isDir) onToggleDir(entry.path);
  }

  function activateKeyboard(): void {
    if (isDir) onToggleDir(entry.path);
    else onOpenFile(entry.path);
  }

  return (
    <li data-testid="file-tree-row" data-path={entry.path} data-kind={entry.kind}>
      <div
        role="treeitem"
        aria-expanded={isDir ? isOpen : undefined}
        tabIndex={0}
        style={{ paddingLeft: pad }}
        className="flex cursor-pointer items-center gap-1 rounded-md py-0.5 pr-2 text-xs text-foreground hover:bg-accent/50"
        onClick={activateClick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            activateKeyboard();
          }
        }}
        onDoubleClick={() => !isDir && onOpenFile(entry.path)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {isDir ? (
          <ChevronRightIcon
            className={cn("size-3 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")}
          />
        ) : (
          <span className="w-3 shrink-0" aria-hidden />
        )}
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      </div>
      {isDir && isOpen ? (
        <ul role="group">
          {loadingDirs.has(entry.path) && !childrenByPath[entry.path] ? (
            <li style={{ paddingLeft: pad + INDENT_STEP }} className="py-0.5 text-xs text-muted-foreground">
              Loading…
            </li>
          ) : (
            sortEntries(childrenByPath[entry.path] ?? []).map((child) => (
              <FileTreeRow
                key={child.path}
                entry={child}
                depth={depth + 1}
                expanded={expanded}
                childrenByPath={childrenByPath}
                loadingDirs={loadingDirs}
                truncatedDirs={truncatedDirs}
                onToggleDir={onToggleDir}
                onOpenFile={onOpenFile}
              />
            ))
          )}
          {truncatedDirs.has(entry.path) ? (
            <li
              style={{ paddingLeft: pad + INDENT_STEP }}
              className="py-0.5 text-xs text-muted-foreground"
              data-testid="files-tree-truncated"
            >
              List truncated.
            </li>
          ) : null}
        </ul>
      ) : null}
      {menu ? (
        <FileContextMenu
          x={menu.x}
          y={menu.y}
          entry={entry}
          onClose={() => setMenu(null)}
          onOpenFile={onOpenFile}
        />
      ) : null}
    </li>
  );
}

function FileContextMenu({
  x,
  y,
  entry,
  onClose,
  onOpenFile,
}: {
  x: number;
  y: number;
  entry: FileEntry;
  onClose: () => void;
  onOpenFile: (path: string) => void;
}) {
  return (
    <>
      {/* A click-catching backdrop closes the menu; it must sit under the
          menu itself so the menu's own buttons still receive their click. */}
      <div className="fixed inset-0 z-40" data-testid="file-context-menu-backdrop" onClick={onClose} />
      <div
        role="menu"
        data-testid="file-context-menu"
        style={{ left: x, top: y }}
        className="fixed z-50 w-40 rounded-lg border border-border bg-popover p-1 text-xs text-popover-foreground shadow-menu"
      >
        {entry.kind === "file" ? (
          <button
            type="button"
            role="menuitem"
            data-testid="file-context-open"
            className="flex w-full items-center rounded-md px-2 py-1.5 text-left hover:bg-accent"
            onClick={() => {
              onOpenFile(entry.path);
              onClose();
            }}
          >
            Open
          </button>
        ) : null}
        <button
          type="button"
          role="menuitem"
          data-testid="file-context-copy-path"
          className="flex w-full items-center rounded-md px-2 py-1.5 text-left hover:bg-accent"
          onClick={() => {
            void navigator.clipboard?.writeText(entry.path).catch(() => undefined);
            onClose();
          }}
        >
          Copy path
        </button>
      </div>
    </>
  );
}
