/**
 * "Get the native browser view out of the way for a moment."
 *
 * [C] The Browser pane is a native `WebContentsView` composited *above* the
 * page (Omnigent's pattern — see `panes/browser/BrowserPane.tsx`), so every
 * DOM overlay that happens to intersect its box is painted underneath it and
 * cannot be clicked: the workspace toolbar's "+" menu, the Files pane's
 * context menu, and dockview's own drag-over drop indicators (which are DOM
 * elements styled by `--dv-drag-over-*`) all disappeared behind whatever page
 * the pane was showing.
 *
 * Rather than teach every overlay about the native view, they hold a
 * *suppression* while they are open. The Browser pane listens, parks its view
 * at zero size for the duration, and restores its real bounds when the last
 * holder lets go. It is a counter, not a boolean, because two overlays can
 * legitimately overlap (a context menu opened during a drag).
 *
 * Same-window pub/sub, exactly like `panes/browserBus.ts`: it never crosses
 * the IPC bridge and never enters a model's context (R26).
 */
const bus = new EventTarget();
const EVENT = "capygen:browser-overlay";

let holders = 0;

function publish(): void {
  bus.dispatchEvent(new CustomEvent<boolean>(EVENT, { detail: holders > 0 }));
}

/**
 * Hide the native browser view while an overlay is open. Returns the release
 * function; calling it twice is harmless (the second call is ignored), so it
 * can be handed straight to a `useEffect` cleanup.
 */
export function suppressBrowserOverlay(): () => void {
  holders += 1;
  publish();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders = Math.max(0, holders - 1);
    publish();
  };
}

/** True while any overlay is holding the view down. */
export function isBrowserOverlaySuppressed(): boolean {
  return holders > 0;
}

/** Subscribe from a Browser pane instance. Returns an unsubscribe function. */
export function onBrowserOverlayChange(listener: (suppressed: boolean) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<boolean>).detail);
  bus.addEventListener(EVENT, handler);
  return () => bus.removeEventListener(EVENT, handler);
}

/** Tests only: forget every holder between cases. */
export function __resetBrowserOverlayForTests(): void {
  holders = 0;
}
