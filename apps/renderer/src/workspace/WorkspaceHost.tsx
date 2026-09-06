/**
 * The workspace host (SPEC R16-R17, item B2.1): a resizable region to the
 * right of the transcript hosting dockview, with a toolbar of pane toggles
 * and a "+" menu, mounted from `ChatPage`'s existing "Agents" header button.
 *
 * Panes are registered by kind (`registry.ts`) — importing `@/panes` here
 * (a side-effect import) is what actually runs each pane module's
 * `registerPane` call, so `WorkspaceHost` never has to know the concrete
 * pane components, only their `PaneKind`s. Every dockview panel's `id`
 * *is* its `PaneKind` (`files`, `editor`, `diff`, `agents`, …): every pane
 * this task or B3 registers is a singleton — one Files pane, one Editor
 * pane (which owns its own tab strip for multiple open files internally,
 * not one dockview panel per file) — so "is this kind open" is exactly
 * "does `containerApi.getPanel(kind)` exist".
 *
 * Layout persistence: `dockview`'s own `toJSON()`/`fromJSON()` round-trip
 * (`WorkspaceLayoutSchema.layoutJson` is deliberately `unknown` — capygen
 * never models dockview's serialized shape by hand) through `layout.get`/
 * `layout.set`, debounced on `onDidLayoutChange` so a drag does not write on
 * every frame (SPEC R23-R26). A missing or corrupt saved layout falls back
 * to `buildDefaultLayout` rather than surfacing an error — the workspace is
 * furniture, not data worth failing a session open over.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type FC,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewHeaderActionsProps,
  type IDockviewPanelProps,
  type SerializedDockview,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { Maximize2Icon, Minimize2Icon, PlusIcon, XIcon } from "lucide-react";
import type { PaneKind } from "@capygen/shared";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import "./dockviewTheme.css";
import "@/panes";
import { buildDefaultLayout } from "./defaultLayout";
import { getPaneRegistration, listPaneRegistrations } from "./registry";
import type { WorkspacePaneParams } from "./types";

const WIDTH_STORAGE_KEY = "capygen.workspace.width";
/** 300, not a rounder 280: `AgentsPane` (SPEC R13, unmodified — see
 *  `panes/agents/AgentsWorkspacePane.tsx`) keeps its historical 288px fixed
 *  width, and this is the smallest host width that never clips it. */
const MIN_WIDTH = 300;
const MAX_WIDTH = 720;
const DEFAULT_WIDTH = 384;
/** One save per settle, not one per drag frame (R23-R26). */
const SAVE_DEBOUNCE_MS = 400;

/** Per-viewer convenience only (SPEC's `localStorage` guidance) — never
 *  reachable during SSR/tests where `window` may throw on a locked-down
 *  storage backend. */
function readStoredWidth(): number {
  try {
    const raw = window.localStorage.getItem(WIDTH_STORAGE_KEY);
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, parsed)) : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

function writeStoredWidth(width: number): void {
  try {
    window.localStorage.setItem(WIDTH_STORAGE_KEY, String(Math.round(width)));
  } catch {
    // Per-viewer convenience only — a blocked store just means the next
    // session opens at the default width again.
  }
}

export interface WorkspaceHostProps {
  projectId: string;
  sessionId: string;
  onClose: () => void;
}

export function WorkspaceHost({ projectId, sessionId, onClose }: WorkspaceHostProps) {
  const apiRef = useRef<DockviewApi | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [width, setWidth] = useState(readStoredWidth);
  const [ready, setReady] = useState(false);
  const [openKinds, setOpenKinds] = useState<ReadonlySet<PaneKind>>(new Set());
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const resizing = useRef(false);

  const params: WorkspacePaneParams = useMemo(
    () => ({ projectId, sessionId }),
    [projectId, sessionId],
  );
  const panes = useMemo(() => listPaneRegistrations(), []);
  const components = useMemo(() => {
    const map: Record<string, FC<IDockviewPanelProps>> = {};
    for (const pane of panes) map[pane.kind] = pane.component as FC<IDockviewPanelProps>;
    return map;
  }, [panes]);

  const refreshOpenKinds = useCallback((api: DockviewApi) => {
    setOpenKinds(new Set(api.panels.map((p) => p.id as PaneKind)));
  }, []);

  const scheduleSave = useCallback(
    (api: DockviewApi) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        void ipc()
          .invoke("layout.set", { projectId, layoutJson: api.toJSON() })
          .catch(() => undefined);
      }, SAVE_DEBOUNCE_MS);
    },
    [projectId],
  );

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

  const handleReady = useCallback(
    (event: DockviewReadyEvent) => {
      const api = event.api;
      apiRef.current = api;
      api.onDidAddPanel(() => refreshOpenKinds(api));
      api.onDidRemovePanel(() => refreshOpenKinds(api));
      api.onDidLayoutChange(() => scheduleSave(api));
      setReady(true);
    },
    [refreshOpenKinds, scheduleSave],
  );

  // Restore (or default) the layout once dockview is ready. Re-runs if the
  // project changes under an already-mounted host (it does not today —
  // `ChatPage` remounts the whole host per session — but a project switch
  // is the one case worth being correct about anyway).
  useEffect(() => {
    if (!ready) return;
    const api = apiRef.current;
    if (!api) return;
    let cancelled = false;
    void ipc()
      .invoke("layout.get", { projectId })
      .then((saved) => {
        if (cancelled) return;
        applySavedOrDefaultLayout(api, saved?.layoutJson, params);
        refreshOpenKinds(api);
      })
      .catch(() => {
        if (cancelled) return;
        buildDefaultLayout(api, params);
        refreshOpenKinds(api);
      });
    return () => {
      cancelled = true;
    };
    // `params` is derived from the same [projectId, sessionId] this effect
    // already keys on; including the object itself would re-run every
    // render (a fresh object each time).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, projectId, refreshOpenKinds]);

  const openPane = useCallback(
    (kind: PaneKind) => {
      const api = apiRef.current;
      const reg = getPaneRegistration(kind);
      if (!api || !reg) return;
      const existing = api.getPanel(kind);
      if (existing) {
        existing.api.setActive();
        return;
      }
      api.addPanel({ id: kind, component: kind, title: reg.title, params });
    },
    [params],
  );

  /** Not "open = close": a pane that is open but sitting behind another tab
   *  in its group gets focused, exactly like re-clicking a taskbar icon
   *  raises the window instead of nothing happening. Only the pane that is
   *  *already the active tab* closes on its own toggle. */
  const togglePane = useCallback(
    (kind: PaneKind) => {
      const api = apiRef.current;
      if (!api) return;
      const existing = api.getPanel(kind);
      if (existing) {
        if (api.activePanel?.id === kind) existing.api.close();
        else existing.api.setActive();
        return;
      }
      openPane(kind);
    },
    [openPane],
  );

  function startResize(e: ReactPointerEvent<HTMLDivElement>): void {
    e.preventDefault();
    resizing.current = true;
    const startX = e.clientX;
    const startWidth = width;
    function onMove(ev: PointerEvent): void {
      if (!resizing.current) return;
      // The handle sits on the host's left edge — dragging left (negative
      // delta) grows the host, matching a right-docked panel's resize feel.
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + (startX - ev.clientX)));
      setWidth(next);
    }
    function onUp(): void {
      resizing.current = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setWidth((w) => {
        writeStoredWidth(w);
        return w;
      });
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  const closablePanes = panes.filter((p) => !openKinds.has(p.kind));

  return (
    <aside
      data-testid="workspace-host"
      className="relative flex shrink-0 flex-col border-l border-border-weak bg-card"
      style={{ width }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize workspace"
        data-testid="workspace-resize-handle"
        onPointerDown={startResize}
        className="absolute inset-y-0 left-0 z-10 w-1 -translate-x-1/2 cursor-col-resize hover:bg-ring/40"
      />
      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border-weak px-2">
        {panes.map((pane) => {
          const open = openKinds.has(pane.kind);
          const Icon = pane.icon;
          return (
            <Button
              key={pane.kind}
              variant={open ? "secondary" : "ghost"}
              size="icon-sm"
              aria-label={pane.title}
              aria-pressed={open}
              title={pane.title}
              data-testid={`workspace-pane-toggle-${pane.kind}`}
              onClick={() => togglePane(pane.kind)}
            >
              <Icon className="size-3.5" />
            </Button>
          );
        })}
        <div className="relative ml-auto">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Add pane"
            aria-expanded={addMenuOpen}
            data-testid="workspace-add-pane"
            onClick={() => setAddMenuOpen((v) => !v)}
          >
            <PlusIcon className="size-3.5" />
          </Button>
          {addMenuOpen ? (
            <div
              data-testid="workspace-add-menu"
              className="absolute top-full right-0 z-30 mt-1 w-44 rounded-lg border border-border bg-popover p-1 text-sm text-popover-foreground shadow-menu"
            >
              {closablePanes.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">Every pane is open.</p>
              ) : (
                closablePanes.map((pane) => {
                  const Icon = pane.icon;
                  return (
                    <button
                      key={pane.kind}
                      type="button"
                      data-testid={`workspace-add-menu-${pane.kind}`}
                      onClick={() => {
                        openPane(pane.kind);
                        setAddMenuOpen(false);
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
                    >
                      <Icon className="size-3.5 text-muted-foreground" />
                      {pane.title}
                    </button>
                  );
                })
              )}
            </div>
          ) : null}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label="Close workspace"
          data-testid="workspace-close"
        >
          <XIcon className="size-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <DockviewReact
          className="capygen-dockview"
          components={components}
          rightHeaderActionsComponent={GroupHeaderActions}
          onReady={handleReady}
        />
      </div>
    </aside>
  );
}

/** A saved layout may name a pane kind an older or newer build removed, or
 *  simply fail `JSON`-shape validation inside dockview's own deserializer —
 *  either reads as "start fresh", never as a thrown error surfacing to the
 *  session. */
function applySavedOrDefaultLayout(
  api: DockviewApi,
  layoutJson: unknown,
  params: WorkspacePaneParams,
): void {
  if (layoutJson && typeof layoutJson === "object") {
    try {
      api.fromJSON(layoutJson as SerializedDockview);
      if (api.panels.length > 0) return;
    } catch {
      api.clear();
    }
  }
  buildDefaultLayout(api, params);
}

/**
 * Visible maximize/restore per group (SPEC item B2.1). Dockview's built-in
 * tab context menu (right-click → float/popout/close) needs the
 * `dockview-enterprise` "ContextMenu" module, which is a paid add-on this
 * app does not depend on — `getTabContextMenuItems` was tried and removed
 * (it throws "requires the ContextMenu module" at runtime without it).
 * Floating still works through dockview's built-in drag-out (drag a tab
 * past the group's edge); only the *menu* affordance for it is unavailable.
 */
function GroupHeaderActions({ api, containerApi }: IDockviewHeaderActionsProps) {
  const [, forceUpdate] = useReducer((c: number) => c + 1, 0);
  useEffect(() => {
    const disposable = containerApi.onDidMaximizedGroupChange(() => forceUpdate());
    return () => disposable.dispose();
  }, [containerApi]);
  const maximized = api.isMaximized();
  return (
    <button
      type="button"
      aria-label={maximized ? "Restore group" : "Maximize group"}
      title={maximized ? "Restore" : "Maximize"}
      data-testid="workspace-group-maximize"
      onClick={() => (maximized ? api.exitMaximized() : api.maximize())}
      className={cn(
        "mr-1 flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {maximized ? <Minimize2Icon className="size-3.5" /> : <Maximize2Icon className="size-3.5" />}
    </button>
  );
}
