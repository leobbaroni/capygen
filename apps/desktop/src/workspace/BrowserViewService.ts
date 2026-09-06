/**
 * The Browser pane (SPEC R16, and the second half of G6: "opens it in the
 * browser pane").
 *
 * Omnigent's pattern, adopted deliberately: a native `WebContentsView` added
 * to the window's own view tree and positioned over a placeholder box the
 * renderer measures with `getBoundingClientRect()`, **not** a `<webview>` tag.
 * `<webview>` is deprecated in Electron, is a different (and slower) process
 * model, and inherits the renderer's session; a `WebContentsView` is the
 * supported one.
 *
 * The cost of that choice is that the view floats *above* the DOM: it does not
 * scroll or clip with the page, so the renderer must send `browser.setBounds`
 * whenever its box moves and `browser.detach` when the pane unmounts. That is
 * why bounds live on the contract rather than being inferred here.
 *
 * Three safety rules, none of them optional:
 *
 *   1. **its own partition.** Each view gets `persist:capygen-browser-<viewId>`,
 *      so a site the user previews can neither read nor write the app's own
 *      session — cookies, storage and service workers are all separate;
 *   2. **http/https only.** Any other scheme (`file:`, `capygen-widget:`, a
 *      custom protocol handler a page tries to trigger) is refused and handed
 *      to the OS via `shell.openExternal`, which is the user's own decision to
 *      make;
 *   3. **no popups.** `setWindowOpenHandler` denies every new window and opens
 *      the URL externally instead, so a preview cannot spawn a chromeless
 *      Electron window with no address bar;
 *   4. **no permissions.** Electron's documented default, when a session has
 *      no permission handler, is to *approve every request*. R16 calls this
 *      pane "an embedded webview with URL bar", not a localhost-only preview,
 *      so a page here could ask for camera, microphone, geolocation or
 *      notifications and be granted them silently — the opposite of what an
 *      address bar leads a user to expect. Both handlers deny outright.
 *
 * Views are keyed by **window and** `viewId`, not `viewId` alone: two shell
 * windows (the tray's "New Window", R2) render the same component tree, and
 * React's `useId` is deterministic by call order, so both would otherwise
 * claim the same key and the second window's pane would drive the first
 * window's view.
 */
import type { BaseWindow, WebContentsView as WebContentsViewClass } from "electron";
import type { Bounds } from "@capygen/shared";
import type { Broadcast, EngineLogger } from "../engine/types.js";

/**
 * The two permission entry points this service uses on a partitioned session,
 * declared structurally rather than as `Pick<Session, …>`: Electron's own
 * handler signatures carry a 40-member permission union and a `details`
 * argument this file has no use for, and `main.ts` adapts the real `Session`
 * to this shape in one place (so the adapter, not every caller, is where the
 * Electron types live).
 */
export interface PartitionSessionLike {
  setPermissionRequestHandler(
    handler: (
      webContents: unknown,
      permission: string,
      callback: (granted: boolean) => void,
    ) => void,
  ): void;
  setPermissionCheckHandler(handler: () => boolean): void;
}

/** The Electron surface this service uses, injected so the file stays
 *  unit-testable and so `main.ts` remains the only place that imports the
 *  real classes. */
export interface BrowserViewDeps {
  /**
   * The window the *calling renderer* belongs to; `null` when there is no
   * window open yet (a pane cannot be visible then either). `main.ts`
   * resolves it from the in-flight IPC event's sender — never from
   * "whichever window happens to be first".
   */
  window: () => BaseWindow | null;
  WebContentsView: typeof WebContentsViewClass;
  /** The partitioned session a new view will use, so its permission handlers
   *  can be installed before anything loads. */
  sessionFromPartition: (partition: string) => PartitionSessionLike;
  openExternal: (url: string) => void;
  broadcast: Broadcast;
  log: EngineLogger;
}

/** What `browser.*` needs from a service; `handlers.ts` takes this shape so it
 *  keeps its "no Electron import" rule. */
export interface BrowserViewHandlers {
  attach(args: { viewId: string; bounds: Bounds; url?: string }): { ok: boolean };
  detach(args: { viewId: string }): { ok: boolean };
  navigate(args: { viewId: string; url: string }): { ok: boolean };
  setBounds(args: { viewId: string; bounds: Bounds }): { ok: boolean };
  devtools(args: { viewId: string }): { ok: boolean };
  dispose(): void;
}

/** The `url` values that are commands rather than addresses. */
const CONTROL_WORDS = new Set(["back", "forward", "reload"]);

export function createBrowserViewService(deps: BrowserViewDeps): BrowserViewHandlers {
  interface Entry {
    view: InstanceType<typeof WebContentsViewClass>;
    window: BaseWindow;
    viewId: string;
  }
  /** Keyed `<window id> <viewId>`; see the module comment on why the
   *  `viewId` alone is not unique across windows. */
  const views = new Map<string, Entry>();

  function keyFor(window: BaseWindow, viewId: string): string {
    // A fake window in tests has no `id`; 0 is as good a namespace as any
    // when there is only ever one of them.
    return `${(window as { id?: number }).id ?? 0} ${viewId}`;
  }

  /** The entry this call means: the current window's, falling back to a
   *  unique match by `viewId` when the window has already gone (a detach
   *  racing a window close). */
  function entryFor(viewId: string): Entry | undefined {
    const window = deps.window();
    if (window) {
      const own = views.get(keyFor(window, viewId));
      if (own) return own;
    }
    const matches = [...views.values()].filter((entry) => entry.viewId === viewId);
    return matches.length === 1 ? matches[0] : undefined;
  }

  function emitState(viewId: string): void {
    const entry = entryFor(viewId);
    const view = entry?.view;
    if (!view) return;
    const contents = view.webContents;
    if (contents.isDestroyed()) return;
    deps.broadcast("browser.state", {
      viewId,
      url: contents.getURL(),
      title: contents.getTitle(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      loading: contents.isLoading(),
    });
  }

  function create(viewId: string): InstanceType<typeof WebContentsViewClass> {
    const partition = `persist:capygen-browser-${viewId}`;
    // Before the view exists, so nothing can load and ask first. Electron
    // approves *every* request on a session with no handler registered, so
    // this is not hardening — it is the difference between "a page here can
    // silently turn on the camera" and "it cannot".
    const partitionSession = deps.sessionFromPartition(partition);
    partitionSession.setPermissionRequestHandler((_contents, permission, callback) => {
      deps.log.warn(`[browser] denied permission ${permission} for ${viewId}`);
      callback(false);
    });
    partitionSession.setPermissionCheckHandler(() => false);

    const view = new deps.WebContentsView({
      webPreferences: {
        // No preload, no Node, no shared session: this is somebody else's page.
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        partition,
      },
    });
    const contents = view.webContents;

    contents.setWindowOpenHandler(({ url }) => {
      if (isWebUrl(url)) deps.openExternal(url);
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      if (isWebUrl(url)) return;
      event.preventDefault();
      deps.log.warn(`[browser] blocked navigation to ${url}`);
      deps.openExternal(url);
    });
    contents.on("will-redirect", (event, url) => {
      if (isWebUrl(url)) return;
      event.preventDefault();
      deps.log.warn(`[browser] blocked redirect to ${url}`);
    });

    for (const event of [
      "did-navigate",
      "did-navigate-in-page",
      "did-start-loading",
      "did-stop-loading",
      "did-finish-load",
      "page-title-updated",
    ] as const) {
      contents.on(event as never, () => emitState(viewId));
    }
    contents.on("did-fail-load", (_e, code, description, url) => {
      // A failed load is a normal thing for a browser to show; the pane needs
      // the toolbar state back either way.
      deps.log.warn(`[browser] ${viewId} load failed ${code} ${description} ${url}`);
      emitState(viewId);
    });
    return view;
  }

  const handlers: BrowserViewHandlers = {
    attach(args) {
      const window = deps.window();
      if (!window) return { ok: false };
      const key = keyFor(window, args.viewId);
      let entry = views.get(key);
      if (!entry) {
        const view = create(args.viewId);
        entry = { view, window, viewId: args.viewId };
        views.set(key, entry);
        window.contentView.addChildView(view);
        deps.log.info(`[browser] attached ${args.viewId}`);
      }
      entry.view.setBounds(toRect(args.bounds));
      if (args.url !== undefined) {
        if (!isWebUrl(args.url)) throw new Error(`browser.attach: refused ${args.url}`);
        void entry.view.webContents.loadURL(args.url);
      }
      return { ok: true };
    },

    detach(args) {
      const entry = entryFor(args.viewId);
      if (!entry) return { ok: true };
      views.delete(keyFor(entry.window, entry.viewId));
      try {
        if (!entry.window.isDestroyed()) entry.window.contentView.removeChildView(entry.view);
      } catch (err) {
        deps.log.warn(`[browser] detach ${args.viewId}: ${(err as Error).message}`);
      }
      // Without this the renderer process behind the view stays alive for the
      // life of the app — one leaked process per pane the user ever opened.
      if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
      deps.log.info(`[browser] detached ${args.viewId}`);
      return { ok: true };
    },

    navigate(args) {
      const view = entryFor(args.viewId)?.view;
      if (!view) return { ok: false };
      const contents = view.webContents;
      const word = args.url.toLowerCase();
      if (CONTROL_WORDS.has(word)) {
        if (word === "back" && contents.navigationHistory.canGoBack()) {
          contents.navigationHistory.goBack();
        } else if (word === "forward" && contents.navigationHistory.canGoForward()) {
          contents.navigationHistory.goForward();
        } else if (word === "reload") {
          contents.reload();
        }
        emitState(args.viewId);
        return { ok: true };
      }
      const url = normaliseUrl(args.url);
      if (!isWebUrl(url)) throw new Error(`browser.navigate: refused ${args.url}`);
      void contents.loadURL(url);
      return { ok: true };
    },

    setBounds(args) {
      const view = entryFor(args.viewId)?.view;
      if (!view) return { ok: false };
      view.setBounds(toRect(args.bounds));
      return { ok: true };
    },

    devtools(args) {
      const view = entryFor(args.viewId)?.view;
      if (!view) return { ok: false };
      const contents = view.webContents;
      if (contents.isDevToolsOpened()) contents.closeDevTools();
      else contents.openDevTools({ mode: "detach" });
      return { ok: true };
    },

    dispose() {
      for (const entry of [...views.values()]) {
        views.delete(keyFor(entry.window, entry.viewId));
        try {
          if (!entry.window.isDestroyed()) entry.window.contentView.removeChildView(entry.view);
        } catch (err) {
          deps.log.warn(`[browser] dispose ${entry.viewId}: ${(err as Error).message}`);
        }
        if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
      }
    },
  };
  return handlers;
}

/** Only http(s) ever reaches a view. */
export function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * A URL bar accepts `localhost:5173` and `example.com`; both mean http. A
 * string that already carries any other scheme is left alone so `isWebUrl`
 * refuses it rather than this function silently rewriting it.
 *
 * The awkward case is that `localhost:5173` *looks* exactly like a scheme —
 * `[a-z]+:` — which is why the test is not "has a colon". A real scheme is
 * either followed by `//` or by something that is not a port number; a
 * host:port is a colon followed by digits. Getting this wrong makes the most
 * common thing anyone will ever type into this bar (the dev server's address)
 * fail as an unsupported scheme.
 */
export function normaliseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return trimmed;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

/** Electron wants integers; a fractional `getBoundingClientRect()` would
 *  otherwise leave a one-pixel seam that shimmers as the pane resizes. */
function toRect(bounds: Bounds): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height)),
  };
}
