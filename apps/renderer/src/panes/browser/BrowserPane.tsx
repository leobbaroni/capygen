/**
 * Browser pane (SPEC R16): a URL bar (Enter navigates, shows title/loading,
 * back/forward/reload, devtools, open-external) over a placeholder box whose
 * bounds are reported to `browser.attach`/`browser.setBounds` — the main
 * process overlays a native `WebContentsView` on top of it (Omnigent's
 * pattern, `reference/omnigent/web/src/components/BrowserPane/BrowserPane.tsx`
 * — never the deprecated `<webview>`).
 *
 * Lifecycle: the toolbar is always mounted so a URL can be typed from a cold
 * start; the measuring placeholder attaches once dockview reports this
 * panel's tab visible (`api.isVisible`/`onDidVisibilityChange` — dockview
 * keeps every tab in a stacked group mounted and toggles this instead of
 * unmounting, precisely so a component like this one can react) and detaches
 * when the tab hides or this component unmounts (CONTEXT.md's Pane —
 * "detach on unmount/hide ... visible → attach", per this task's brief).
 * Bounds are pushed on attach and re-synced on resize/scroll/layout via a
 * `ResizeObserver` plus window `resize`/`scroll` listeners, coalesced to one
 * measurement per animation frame — never a raw per-scroll-event flood into
 * the main process (SPEC R23-R26).
 *
 * A dev server's own "Open in Browser pane" link (the Servers pane) reaches
 * this component through `browserBus`, a same-window pub/sub — see that
 * file's doc comment for why.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  GlobeIcon,
  RotateCwIcon,
  WrenchIcon,
} from "lucide-react";
import { ipc } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { registerPane } from "@/workspace/registry";
import type { WorkspacePaneProps } from "@/workspace/types";
import { onOpenInBrowserPane } from "../browserBus";

/** Adds `https://` to a bare `example.com`-style typed value; leaves
 *  anything that already looks like a URL (has a scheme) alone. */
function normalizeTypedUrl(raw: string): string {
  const trimmed = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  if (/^localhost(:\d+)?(\/|$)/i.test(trimmed) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return `https://${trimmed}`;
}

export function BrowserPane({ api }: WorkspacePaneProps) {
  const viewId = useId();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const lastBoundsRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const editingRef = useRef(false);
  const attachedRef = useRef(false);
  const frameRef = useRef(0);

  // dockview keeps every tab in a stacked group mounted and reports
  // visibility through the panel's own api instead of unmounting — exactly
  // so a component holding a native resource (this one) can attach/detach
  // in step with the tab, rather than the moment it happens to be created.
  const [visible, setVisible] = useState(api.isVisible);
  useEffect(() => {
    setVisible(api.isVisible);
    const disposable = api.onDidVisibilityChange((event) => setVisible(event.isVisible));
    return () => disposable.dispose();
  }, [api]);

  const [addressBarValue, setAddressBarValue] = useState("");
  const [currentUrl, setCurrentUrl] = useState("");
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [attached, setAttached] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const syncBounds = useCallback((force = false) => {
    const el = containerRef.current;
    if (!el || !attachedRef.current) return;
    const rect = el.getBoundingClientRect();
    const bounds = {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const last = lastBoundsRef.current;
    if (
      !force &&
      last &&
      last.x === bounds.x &&
      last.y === bounds.y &&
      last.width === bounds.width &&
      last.height === bounds.height
    ) {
      return;
    }
    lastBoundsRef.current = bounds;
    void ipc()
      .invoke("browser.setBounds", { viewId, bounds })
      .catch(() => undefined);
  }, [viewId]);

  const measureNow = useCallback((): { x: number; y: number; width: number; height: number } => {
    const rect = containerRef.current?.getBoundingClientRect();
    return {
      x: Math.round(rect?.left ?? 0),
      y: Math.round(rect?.top ?? 0),
      width: Math.round(rect?.width ?? 0),
      height: Math.round(rect?.height ?? 0),
    };
  }, []);

  const scheduleSync = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      syncBounds();
    });
  }, [syncBounds]);

  // Attach when the tab becomes visible; detach when it hides or unmounts —
  // a hidden dockview tab must not keep a compositor layer alive underneath.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void ipc()
      .invoke("browser.attach", {
        viewId,
        bounds: measureNow(),
        ...(currentUrl ? { url: currentUrl } : {}),
      })
      .then(() => {
        if (cancelled) return;
        attachedRef.current = true;
        setAttached(true);
        setError(null);
        // A couple of frames for the pane's own open transition to settle
        // before the first real bounds land.
        requestAnimationFrame(() => requestAnimationFrame(() => syncBounds(true)));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
      attachedRef.current = false;
      lastBoundsRef.current = null;
      setAttached(false);
      void ipc().invoke("browser.detach", { viewId }).catch(() => undefined);
    };
    // Deliberately excludes `currentUrl`: attach is a one-time create per
    // visible span, not a per-navigation event — navigation goes through
    // `browser.navigate` instead (see `navigate` below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, viewId, measureNow, syncBounds]);

  // Reconcile bounds on resize/scroll/layout changes, coalesced to one
  // measurement per frame (R23-R26: no per-event IPC flood).
  useEffect(() => {
    if (!attached) return;
    const el = containerRef.current;
    if (!el) return;
    // jsdom (the renderer test environment) has no ResizeObserver — window
    // resize/scroll still cover it there.
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleSync);
    ro?.observe(el);
    window.addEventListener("resize", scheduleSync);
    window.addEventListener("scroll", scheduleSync, true);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", scheduleSync);
      window.removeEventListener("scroll", scheduleSync, true);
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = 0;
      }
    };
  }, [attached, scheduleSync]);

  // Live toolbar state from the main process (R6-adjacent: the pane must not
  // poll for title/url/loading — one push event per navigation).
  useEffect(() => {
    return ipc().on("browser.state", (state) => {
      if (state.viewId !== viewId) return;
      setTitle(state.title);
      setLoading(state.loading);
      setCanGoBack(state.canGoBack);
      setCanGoForward(state.canGoForward);
      setCurrentUrl(state.url);
      if (!editingRef.current) setAddressBarValue(state.url);
    });
  }, [viewId]);

  const navigate = useCallback(
    (url: string) => {
      setError(null);
      if (!attachedRef.current) {
        void ipc()
          .invoke("browser.attach", { viewId, bounds: measureNow(), url })
          .then(() => {
            attachedRef.current = true;
            setAttached(true);
          })
          .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
        return;
      }
      void ipc()
        .invoke("browser.navigate", { viewId, url })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    },
    [viewId, measureNow],
  );

  // The Servers pane's "Open in Browser pane" link.
  useEffect(() => onOpenInBrowserPane((url) => navigate(url)), [navigate]);

  function submitAddressBar(): void {
    const raw = addressBarValue.trim();
    if (!raw) return;
    const url = normalizeTypedUrl(raw);
    setAddressBarValue(url);
    navigate(url);
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="browser-pane" data-view-id={viewId}>
      <div className="flex shrink-0 items-center gap-1 border-b border-border-weak bg-card px-2 py-1.5">
        <button
          type="button"
          onClick={() => navigate("back")}
          disabled={!canGoBack}
          aria-label="Go back"
          title="Back"
          data-testid="browser-back"
          className="flex size-6 items-center justify-center rounded text-foreground hover:bg-muted disabled:pointer-events-none disabled:opacity-40"
        >
          <ChevronLeftIcon className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => navigate("forward")}
          disabled={!canGoForward}
          aria-label="Go forward"
          title="Forward"
          data-testid="browser-forward"
          className="flex size-6 items-center justify-center rounded text-foreground hover:bg-muted disabled:pointer-events-none disabled:opacity-40"
        >
          <ChevronRightIcon className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => navigate("reload")}
          disabled={!attached}
          aria-label="Reload"
          title="Reload"
          data-testid="browser-reload"
          className="flex size-6 items-center justify-center rounded text-foreground hover:bg-muted disabled:pointer-events-none disabled:opacity-40"
        >
          <RotateCwIcon className={cn("size-4", loading && "animate-spin")} />
        </button>
        <input
          type="text"
          value={addressBarValue}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          placeholder="Enter a URL"
          aria-label="Address bar"
          data-testid="browser-url-input"
          onChange={(e) => setAddressBarValue(e.target.value)}
          onFocus={() => {
            editingRef.current = true;
          }}
          onBlur={() => {
            editingRef.current = false;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submitAddressBar();
              e.currentTarget.blur();
            }
          }}
          className="h-6 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring"
        />
        <button
          type="button"
          onClick={() => void ipc().invoke("browser.devtools", { viewId }).catch(() => undefined)}
          disabled={!attached}
          aria-label="Toggle DevTools"
          title="Toggle DevTools"
          data-testid="browser-devtools"
          className="flex size-6 items-center justify-center rounded text-foreground hover:bg-muted disabled:pointer-events-none disabled:opacity-40"
        >
          <WrenchIcon className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => {
            // Best-effort: no dedicated IPC channel opens the OS default
            // browser (out of this pane's owned files) — `window.open` is
            // what Electron's `setWindowOpenHandler` (main process) sees.
            if (currentUrl) window.open(currentUrl, "_blank", "noopener,noreferrer");
          }}
          disabled={!currentUrl}
          aria-label="Open in external browser"
          title="Open in external browser"
          data-testid="browser-open-external"
          className="flex size-6 items-center justify-center rounded text-foreground hover:bg-muted disabled:pointer-events-none disabled:opacity-40"
        >
          <ExternalLinkIcon className="size-4" />
        </button>
      </div>

      {title ? (
        <div
          data-testid="browser-title"
          className="shrink-0 truncate border-b border-border-weak bg-card px-2 py-0.5 text-xs text-muted-foreground"
        >
          {title}
        </div>
      ) : null}

      {error ? (
        <p role="alert" data-testid="browser-error" className="shrink-0 px-2 py-1 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      {/*
       * Always mounted, attached or not — LAYOUT TRAP (verified against
       * Omnigent's own version of this pane): the native `WebContentsView`
       * paints OVER this box, so its bounds must be real the instant
       * `browser.attach` fires. Rendering it only after `attached` flips
       * true would mean the very first `attach` call always measures a
       * not-yet-mounted ref (all zeros) — one extra `setBounds` round trip
       * later fixes it, but a 1x1 native view flashes into existence first.
       */}
      <div ref={containerRef} data-testid="browser-container" className="relative min-h-0 min-w-0 flex-1">
        {!attached ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-card px-6 py-8 text-center text-muted-foreground">
            <GlobeIcon className="size-8 text-muted-foreground/50" />
            <p className="text-sm">Enter a URL above to get started.</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

registerPane({ kind: "browser", title: "Browser", icon: GlobeIcon, component: BrowserPane });
