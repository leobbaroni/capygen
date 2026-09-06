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
import { suppressBrowserOverlay } from "./browserOverlay";
import { getPaneRegistration, listPaneRegistrations } from "./registry";
import type { WorkspacePaneParams } from "./types";

/** Per project, not one global key: a width that suits a wide monorepo on the
 *  big monitor is not the width the little utility repo wants. */
function widthStorageKey(projectId: string): string {
  return `capygen.workspace.width.${projectId}`;
}
/** What the single global key used to be; read once so an existing user's
 *  width is not silently forgotten on upgrade. */
const LEGACY_WIDTH_STORAGE_KEY = "capygen.workspace.width";
/** 300, not a rounder 280: `AgentsPane` (SPEC R13, unmodified — see
 *  `panes/agents/AgentsWorkspacePane.tsx`) keeps its historical 288px fixed
 *  width, and this is the smallest host width that never clips it. */
const MIN_WIDTH = 300;
/** [C] 1200, not 720: a Browser pane or a Terminal at 720px is a demo, not a
 *  workspace — R16's panes are meant to be worked in, and dockview lets a
 *  user split them further inside this width. */
const MAX_WIDTH = 1200;
/** [C] Wide enough that the toolbar's ten buttons fit beside the caption
 *  clearance the toolbar now reserves (see `titlebar-clearance` below). */
const DEFAULT_WIDTH = 560;
/** One save per settle, not one per drag frame (R23-R26). */
const SAVE_DEBOUNCE_MS = 400;
/**
 * [C] What the chat column keeps no matter how wide the workspace is asked to
 * be. `MAX_WIDTH` alone is not a bound on anything: the aside is `shrink-0`,
 * so a 1200px workspace on a later-shrunk 1280px window squeezes the
 * transcript *and* the composer to zero and pushes the workspace's own "+"
 * and close buttons off the right edge, where `.app-shell`'s `overflow-hidden`
 * clips them — with the offending value persisted, there is then no way back.
 */
const MIN_CHAT_WIDTH = 360;

/** The widest this host may be given the room the window actually has. */
function maxWidthFor(availableWidth: number): number {
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) return MAX_WIDTH;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, availableWidth - MIN_CHAT_WIDTH));
}

function clampWidth(width: number, availableWidth: number): number {
  return Math.min(maxWidthFor(availableWidth), Math.max(MIN_WIDTH, width));
}

/** Per-viewer convenience only (SPEC's `localStorage` guidance) — never
 *  reachable during SSR/tests where `window` may throw on a locked-down
 *  storage backend. */
function readStoredWidth(projectId: string): number {
  try {
    const raw =
      window.localStorage.getItem(widthStorageKey(projectId)) ??
      window.localStorage.getItem(LEGACY_WIDTH_STORAGE_KEY);
    const parsed = raw ? Number(raw) : NaN;
    const wanted = Number.isFinite(parsed) ? parsed : DEFAULT_WIDTH;
    // Clamped against the window here too: a value stored on a 1920px display
    // must not open a 1280px one with no chat column at all.
    return clampWidth(wanted, window.innerWidth);
  } catch {
    return DEFAULT_WIDTH;
  }
}

function writeStoredWidth(projectId: string, width: number): void {
  try {
    window.localStorage.setItem(widthStorageKey(projectId), String(Math.round(width)));
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
  const [width, setWidth] = useState(() => readStoredWidth(projectId));
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

  const saveNow = useCallback(
    (api: DockviewApi) => {
      void ipc()
        .invoke("layout.set", { projectId, layoutJson: api.toJSON() })
        .catch(() => undefined);
    },
    [projectId],
  );

  const scheduleSave = useCallback(
    (api: DockviewApi) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        saveNow(api);
      }, SAVE_DEBOUNCE_MS);
    },
    [saveNow],
  );

  // [C] Flush, do not drop. "Rearrange the panes, then close the workspace"
  // is one gesture, and it takes well under the 400 ms debounce — clearing
  // the timer without sending would throw the rearrangement away and restore
  // the *previous* layout next time, which is precisely what R17 promises not
  // to do. The same cleanup runs on a session/project switch, where the
  // pending write is just as real.
  useEffect(
    () => () => {
      if (!saveTimer.current) return;
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
      const api = apiRef.current;
      if (api) saveNow(api);
    },
    [saveNow],
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

  // [C] Re-clamp whenever the window changes size. Without this, a width
  // chosen on a maximised 1920px window survives a restore to 1280px and
  // leaves the chat column at 0px with the workspace's own "+" and close
  // buttons clipped past the right edge — unrecoverable, and persisted.
  useEffect(() => {
    const onResize = (): void => {
      setWidth((current) => {
        const next = clampWidth(current, window.innerWidth);
        if (next !== current) writeStoredWidth(projectId, next);
        return next;
      });
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [projectId]);

  // The "+" menu is a DOM overlay, and the Browser pane's native view is
  // composited above the DOM — so the menu has to ask the view to step aside
  // for as long as it is open (see `browserOverlay.ts`).
  useEffect(() => {
    if (!addMenuOpen) return;
    return suppressBrowserOverlay();
  }, [addMenuOpen]);

  function startResize(e: ReactPointerEvent<HTMLDivElement>): void {
    e.preventDefault();
    resizing.current = true;
    const startX = e.clientX;
    const startWidth = width;
    function onMove(ev: PointerEvent): void {
      if (!resizing.current) return;
      // The handle sits on the host's left edge — dragging left (negative
      // delta) grows the host, matching a right-docked panel's resize feel.
      setWidth(clampWidth(startWidth + (startX - ev.clientX), window.innerWidth));
    }
    function onUp(): void {
      resizing.current = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setWidth((w) => {
        writeStoredWidth(projectId, w);
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
      {/*
        * [C] The toolbar shares the window's title-bar row, so it has to play
        * by that row's two rules or its buttons are dead to a mouse:
        *   - `.titlebar-drag` is a *fixed, window-wide* strip at z-index 40
        *     with `-webkit-app-region: drag`. A drag region is geometric —
        *     Windows takes the press before the page sees it — so anything
        *     under it is unclickable. `titlebar-clearance` paints above it
        *     (z-41) and re-declares the drag region for its own empty space,
        *     which `index.css`'s `no-drag` rule then opts every button out of;
        *   - Electron draws the caption buttons over the top *right* corner,
        *     which is exactly where this aside is when it is open. So the
        *     clearance is reserved here, and `ChatPage`'s header drops its own
        *     copy of it (`titlebar-clearance-no-caption`) while we are mounted.
        * The toggles scroll rather than overflow at the minimum width.
        */}
      <div className="titlebar-clearance flex h-9 shrink-0 items-center gap-0.5 border-b border-border-weak px-2">
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
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
        </div>
        <div className="relative">
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
          /*
           * [C] `always`, not dockview's default `onlyWhenVisible`. The
           * default *unmounts* every panel that is not the active tab of its
           * group, which is wrong for every pane capygen has that owns a live
           * resource rather than a view of some data:
           *   - a Terminal loses its xterm instance, and with it the whole
           *     scrollback, every time the user looks at another tab (the pty
           *     survives, so the output of what it kept doing is simply gone);
           *   - a Servers pane stops receiving `servers.status`/`servers.log`
           *     while hidden, so a server started from it can finish starting
           *     with nobody listening — which is exactly how "start it and
           *     watch the Browser tab" used to lose the URL;
           *   - a Browser pane's `WebContentsView` is detached and recreated,
           *     losing its history.
           * `always` keeps them mounted and hidden, which is also what the
           * panes' own `api.isVisible` handling was written against.
           */
          defaultRenderer="always"
          onReady={handleReady}
        />
      </div>
    </aside>
  );
}

/**
 * A saved layout may name a pane kind an older or newer build removed, or
 * simply fail `JSON`-shape validation inside dockview's own deserializer —
 * either reads as "start fresh", never as a thrown error surfacing to the
 * session.
 *
 * [C] "Restored" is whether `fromJSON` *ran*, not whether it produced panels.
 * Closing every pane through the toolbar toggles is a legal thing to do, and
 * dockview's `onDidRemovePanel` also fires `onDidLayoutChange`, so that state
 * is saved like any other: a zero-panel `layoutJson` is a deliberate empty
 * workspace, not a failed restore. Deriving the flag from `panels.length` put
 * Files+Agents back on every single relaunch, undoing the user's choice for
 * good (R17: "layout persists per project across restarts").
 */
function applySavedOrDefaultLayout(
  api: DockviewApi,
  layoutJson: unknown,
  params: WorkspacePaneParams,
): void {
  if (layoutJson && typeof layoutJson === "object") {
    let restored = false;
    try {
      api.fromJSON(rebindSerializedParams(layoutJson, params) as SerializedDockview);
      restored = true;
    } catch {
      api.clear();
    }
    // Outside the `catch`: a fault in the rebind is a bug in capygen, not a
    // corrupt saved layout, and must not be laundered into "start fresh".
    if (restored) {
      rebindParams(api, params);
      return;
    }
  }
  buildDefaultLayout(api, params);
}

/**
 * [C] The restore trap. `toJSON()` serialises each panel's `params` — which
 * is where every pane reads its `projectId`/`sessionId` from — so a layout
 * saved yesterday replays *yesterday's* ids. A Terminal pane restored that
 * way would `terminal.create` against a project that may no longer exist,
 * and a Tasks pane would subscribe to a dead session.
 *
 * The rewrite happens **in the JSON, before `fromJSON`**, not only after it:
 * a pane's "open one terminal" effect has a `[]` dependency list, so it acts
 * on whatever it saw on its *first* render and never reconsiders. Patching
 * afterwards relies on dockview creating every panel synchronously inside
 * `fromJSON` while React has not committed yet — true today, and exactly
 * the kind of ordering that breaks silently and in the wrong project.
 *
 * Non-identity params (`initialFilePath`, `initialUrl`, anything else a pane
 * stashed) are preserved: this only overwrites the two identity fields.
 */
function rebindSerializedParams(layoutJson: object, params: WorkspacePaneParams): object {
  const panels = (layoutJson as { panels?: Record<string, { params?: unknown }> }).panels;
  if (!panels || typeof panels !== "object") return layoutJson;
  return {
    ...layoutJson,
    panels: Object.fromEntries(
      Object.entries(panels).map(([id, panel]) => [
        id,
        {
          ...panel,
          params: {
            ...(typeof panel?.params === "object" && panel.params ? panel.params : {}),
            projectId: params.projectId,
            sessionId: params.sessionId,
          },
        },
      ]),
    ),
  };
}

/** Belt and braces for the same trap: a panel dockview materialised without
 *  going through the serialized `panels` map still gets the current ids.
 *  `updateParameters` merges, so nothing else a pane stashed is lost. */
function rebindParams(api: DockviewApi, params: WorkspacePaneParams): void {
  for (const panel of api.panels) {
    panel.api.updateParameters({ projectId: params.projectId, sessionId: params.sessionId });
  }
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
