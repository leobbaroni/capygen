/**
 * Where a widget document is served from.
 *
 * Deliberately duplicated from `apps/desktop/src/ipc/widgets.ts` (`WIDGET_SCHEME`
 * / `widgetHost`): the renderer has no dependency on the desktop package — it
 * only talks to it over typed IPC — and adding one would drag Node-only code
 * into the browser bundle for six lines of string handling. `url.test.ts`
 * pins the exact format both sides must agree on; the desktop's own test pins
 * the same strings from the other end.
 *
 * Why a scheme at all, rather than `srcdoc`: an `about:srcdoc` frame inherits
 * the *parent's* CSP, and the renderer ships `script-src 'self'`, so a widget's
 * inline script never runs. Measured in docs/spikes/mcp-apps.md §a4.
 */
export const WIDGET_SCHEME = "capygen-widget";

/** `blk_1f2e…` → `blk1f2e…`, a legal host label with no separators. */
export function widgetHost(blockId: string): string {
  const stripped = blockId.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return stripped.length > 0 && stripped.length <= 63 ? stripped : "";
}

/** The iframe `src` for one widget block, or `null` when the id is unusable. */
export function widgetUrl(blockId: string): string | null {
  const host = widgetHost(blockId);
  return host ? `${WIDGET_SCHEME}://${host}/index.html` : null;
}
