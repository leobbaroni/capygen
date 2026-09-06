/**
 * The sandboxed iframe a widget lives in, plus the bridge that talks to it.
 *
 * Sandbox: `allow-scripts allow-forms` and nothing else. No `allow-same-origin`
 * — that is the whole security model. Without it the document's origin is
 * opaque: `window.origin === "null"`, `localStorage` throws, and it can reach
 * neither the app's storage nor another widget's (measured in
 * docs/spikes/mcp-apps.md §a4). No `allow-popups`, `allow-modals` or
 * `allow-top-navigation` either, so a widget cannot open windows, block the UI
 * with `alert()`, or navigate the app away; links go through `ui/open-link`,
 * which the main process vets before handing them to the OS browser.
 *
 * The document itself is *not* inlined with `srcdoc`. A srcdoc frame inherits
 * the parent's CSP (`script-src 'self'`), which blocks every widget's inline
 * script; the main process serves it from `capygen-widget://<block>/index.html`
 * with the resource's own policy instead.
 */
import { useEffect, useRef, useState } from "react";
import { attachWidgetHost, type WidgetBridgeOptions } from "./bridge";
import { widgetUrl } from "./url";

/** Height before the widget has told us its own, and the range we allow. */
export const DEFAULT_WIDGET_HEIGHT = 220;
export const MIN_WIDGET_HEIGHT = 80;
export const MAX_WIDGET_HEIGHT = 720;

export function clampWidgetHeight(height: number | undefined): number {
  if (!Number.isFinite(height) || height === undefined) return DEFAULT_WIDGET_HEIGHT;
  return Math.min(MAX_WIDGET_HEIGHT, Math.max(MIN_WIDGET_HEIGHT, Math.ceil(height)));
}

export type WidgetFrameProps = Omit<WidgetBridgeOptions, "iframe" | "onResize"> & {
  /** `allow` attribute the resource asked for; empty grants nothing. */
  allow?: string;
  initialHeight?: number;
  title?: string;
};

export function WidgetFrame(props: WidgetFrameProps) {
  const { blockId, allow, initialHeight, title, ...bridgeOptions } = props;
  const ref = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(() => clampWidgetHeight(initialHeight));
  const src = widgetUrl(blockId);

  // The bridge is attached once per block. `bridgeOptions` deliberately is not
  // a dependency: a re-render that produced a new `toolResult` object identity
  // must not tear down a live widget and lose its state.
  const latest = useRef(bridgeOptions);
  latest.current = bridgeOptions;

  useEffect(() => {
    const iframe = ref.current;
    if (!iframe || !src) return;
    const handle = attachWidgetHost({
      ...latest.current,
      blockId,
      iframe,
      onResize: (size) => {
        if (typeof size.height === "number") setHeight(clampWidgetHeight(size.height));
      },
    });
    // The app's theme lives on <html>; push a host-context change when it moves
    // so a widget using the spec's CSS variables repaints with the app.
    const observer = new MutationObserver(() => handle.syncTheme());
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme"],
    });
    // Only navigate once the listener is live, or the view's `ui/initialize`
    // can land before the transport is connected.
    iframe.src = src;
    return () => {
      observer.disconnect();
      handle.close();
    };
  }, [blockId, src]);

  if (!src) return null;

  return (
    <iframe
      ref={ref}
      data-testid="widget-frame"
      title={title ?? "MCP App widget"}
      sandbox="allow-scripts allow-forms"
      {...(allow ? { allow } : {})}
      referrerPolicy="no-referrer"
      className="w-full rounded-md border border-border bg-card"
      style={{ height }}
    />
  );
}
