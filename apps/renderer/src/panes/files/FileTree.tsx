/**
 * A lazily-expanding directory tree (matches `FolderTree`'s VS Code-style
 * indent guides + chevron, `reference/omnigent/web/src/shell/FolderTree.tsx`
 * — reimplemented against `fs.list` rather than ported, per the reference
 * being layout/behaviour guidance, never a dependency).
 *
 * A directory's children are fetched on first expand and cached by path;
 * a new `refreshToken` re-fetches the expanded directories `changedDirs`
 * names (and the root, via the caller re-passing `entries`) when `FilesPane`
 * sees a settled burst of `fs.changed` events. `changedDirs` is what keeps
 * this bounded: re-listing *every* open directory on every batch was one
 * `fs.list` per expanded folder about four times a second under sustained
 * file activity, for changes that mostly touched none of them (R23-R26).
 * Omitting `changedDirs` still re-lists everything open, which is the right
 * fallback for a caller that does not know what moved.
 *
 * Not virtualised: `fs.list`'s own per-directory cap (`FileListResult.
 * truncated`) already bounds the worst case, so a dedicated virtualisation
 * dependency was not worth adding for this phase — a directory at the cap
 * says so (`"N+ entries, truncated"`) instead of silently hiding the rest.
 */
import { useEffect, useRef, useState } from "react";
import { ChevronRightIcon, FolderIcon, FolderOpenIcon } from "lucide-react";
import type { FileEntry } from "@capygen/shared";
import { cn } from "@/lib/utils";
import { ipc } from "@/lib/ipc";
import { suppressBrowserOverlay } from "@/workspace/browserOverlay";
import { fileIconFor } from "./fileIcons";

const INDENT_STEP = 14;
const BASE_PAD = 6;

export interface FileTreeProps {
  projectId: string;
  entries: FileEntry[];
  onOpenFile: (path: string) => void;
  refreshToken?: number;
  /** Project-relative directories the last watcher burst touched. Omitted
   *  means "unknown — refresh everything open". */
  changedDirs?: readonly string[];
}

/** A menu is `position: fixed` at the pointer; the Files pane is docked at
 *  the window's right edge, so without this a right-click on the right half
 *  of a row put half the menu outside the window (and past x≈1560 in a
 *  1600px window, all of it). */
function clampToViewport(
  x: number,
  y: number,
  width: number,
  height: number,
): { left: number; top: number } {
  const margin = 4;
  const maxLeft = Math.max(margin, (window.innerWidth || width) - width - margin);
  const maxTop = Math.max(margin, (window.innerHeight || height) - height - margin);
  return { left: Math.min(x, maxLeft), top: Math.min(y, maxTop) };
}

function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function FileTree({
  projectId,
  entries,
  onOpenFile,
  refreshToken,
  changedDirs,
}: FileTreeProps) {
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

  // Re-fetch the open directories the change actually touched — see the
  // module doc comment.
  useEffect(() => {
    if (refreshToken === undefined) return;
    const touched = changedDirs === undefined ? null : new Set(changedDirs);
    for (const path of expanded) {
      if (touched && !touched.has(path)) continue;
      void loadDir(path);
    }
    // `loadDir`/`expanded`/`changedDirs` intentionally excluded: this effect's
    // only job is to react to a *new* refreshToken value, not to loop on its
    // own writes (and `changedDirs` is a fresh array on every parent render).
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
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Measured, then corrected: `w-40` is known but the height is not (a
  // directory row has one fewer item), so the first paint places it at the
  // pointer and this pulls it back inside the window before it can be seen
  // clipped.
  const [pos, setPos] = useState(() => clampToViewport(x, y, 160, 96));
  useEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos(clampToViewport(x, y, rect.width, rect.height));
  }, [x, y]);

  // Escape closes it, like every other menu in the app.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // The Browser pane's native view is composited above the DOM, so a menu
  // that overlaps it would be painted underneath and eat the clicks meant
  // for it (`workspace/browserOverlay.ts`).
  useEffect(() => suppressBrowserOverlay(), []);

  return (
    <>
      {/* A click-catching backdrop closes the menu; it must sit under the
          menu itself so the menu's own buttons still receive their click.
          A *second* right-click has to close it too — otherwise it lands on
          the backdrop, opens nothing, and leaves the first menu stuck. */}
      <div
        className="fixed inset-0 z-40"
        data-testid="file-context-menu-backdrop"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        ref={menuRef}
        role="menu"
        data-testid="file-context-menu"
        style={{ left: pos.left, top: pos.top }}
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
