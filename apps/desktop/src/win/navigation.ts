/**
 * Which URLs a shell window is allowed to become.
 *
 * A capygen window carries the preload, and the preload unconditionally
 * exposes the whole typed IPC surface — sessions, settings, permission
 * answers — to whatever document is loaded in it. `setWindowOpenHandler`
 * covers `target=_blank`, but a plain link in model or tool output, a
 * redirect, or a script setting `location` is a *top-level navigation*, which
 * Electron allows by default: the attacker's page would then get the bridge,
 * outside the renderer's own CSP (a per-document meta tag that does not
 * survive navigation).
 *
 * So: only our own SPA may ever occupy a window. This module is the pure
 * decision, kept out of main.ts so it can be tested without Electron.
 */
import path from "node:path";

export interface RendererTarget {
  kind: "url" | "file";
  /** The dev server URL, or the absolute path of the built index.html. */
  value: string;
}

/** Is `raw` the renderer itself (same dev origin, or the built index file)? */
export function isAppUrl(raw: string, target: RendererTarget): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  if (target.kind === "url") {
    // Same origin as the Vite dev server: HMR and in-app routing stay inside.
    try {
      return url.origin === new URL(target.value).origin;
    } catch {
      return false;
    }
  }

  if (url.protocol !== "file:") return false;
  // `file:///C:/…/index.html` → pathname `/C:/…/index.html`.
  const here = decodeURIComponent(url.pathname).replace(/^[\\/](?=[A-Za-z]:)/, "");
  return normalise(here) === normalise(target.value);
}

function normalise(p: string): string {
  return path.resolve(p).toLowerCase();
}
