/**
 * How the Files pane tells an *already-open* Editor pane to add a tab.
 *
 * `WorkspaceHost.openFileInEditor` is the only writer: a freshly-created
 * Editor panel gets the path through its own `params.initialFilePath`
 * instead (no race — the panel does not exist yet to race against), so this
 * bus only ever needs to reach a component that is already mounted. One
 * dockview instance is ever live at a time (`WorkspaceHost` is the chat
 * page's single workspace), so there is nothing to scope this by — a second
 * subscriber would only exist if two workspaces were mounted at once, which
 * the app never does.
 */
const listeners = new Set<(path: string) => void>();

export function requestOpenFile(path: string): void {
  for (const listener of listeners) listener(path);
}

/** Returns an unsubscribe function. */
export function onOpenFileRequest(listener: (path: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
