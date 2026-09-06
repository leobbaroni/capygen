/**
 * Cross-pane bridge for "open this URL in the Browser pane" (the Servers
 * pane's brief item: a dev server row's own link opens the Browser pane).
 *
 * The Servers pane and the Browser pane are two independent dockview tabs
 * with no shared parent state (there is no workspace store yet — see
 * `panes/types.ts`), so this is a tiny same-window pub/sub instead of a prop
 * or a store field. It never crosses the IPC bridge and never touches
 * anything outside `panes/**`.
 */
const bus = new EventTarget();
const EVENT = "capygen:open-in-browser-pane";

/** Ask whichever Browser pane instance is listening to navigate to `url`. */
export function openInBrowserPane(url: string): void {
  bus.dispatchEvent(new CustomEvent<string>(EVENT, { detail: url }));
}

/** Subscribe from a Browser pane instance. Returns an unsubscribe function. */
export function onOpenInBrowserPane(listener: (url: string) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<string>).detail);
  bus.addEventListener(EVENT, handler);
  return () => bus.removeEventListener(EVENT, handler);
}
