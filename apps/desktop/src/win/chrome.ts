/**
 * Seamless window chrome on Windows.
 *
 * Ported from Omnigent-windows/app/src/win/chrome.js. Electron's Window Controls
 * Overlay: `titleBarStyle: "hidden"` + `titleBarOverlay` draws only the
 * minimize / maximize / close buttons over the page's top-right corner, and the
 * page supplies the drag region. capygen's renderer owns its own drag strip in
 * CSS, but the shell still injects a fallback stylesheet so any page it loads
 * (an error page, a future setup page) is draggable and keeps its controls clear
 * of the caption buttons.
 *
 * The caption buttons are then *blended*: the page is sampled at the top-right
 * corner and the overlay is repainted with whatever colour is actually there, so
 * the buttons disappear into the page instead of sitting on a grey band.
 */
import type { BrowserWindow } from "electron";

/** Height of the overlay strip. Matches the renderer's 2.25rem title band. */
export const OVERLAY_HEIGHT = 36;
/** Width Windows reserves for the three caption buttons (~138px at 100%). */
export const CAPTION_WIDTH_REM = 9;

const THEMES = {
  light: { color: "#ffffff", symbolColor: "#1b1b1f" },
  dark: { color: "#0e1013", symbolColor: "#e6e6ea" },
} as const;

export interface OverlayColors {
  color: string;
  symbolColor: string;
  height: number;
}

export function overlayColors(dark: boolean): OverlayColors {
  return { ...THEMES[dark ? "dark" : "light"], height: OVERLAY_HEIGHT };
}

/**
 * Parse a computed CSS colour (`rgb()` / `rgba()` / `#rrggbb`) into opaque hex.
 * Returns null for transparent or unparseable values so the caller falls back to
 * the theme colour.
 */
export function cssColorToHex(css: string | null | undefined): string | null {
  if (!css) return null;
  const s = String(css).trim();
  const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
  if (hex) {
    if (hex[2] !== undefined && parseInt(hex[2], 16) === 0) return null;
    return `#${hex[1]!.toLowerCase()}`;
  }
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
  if (!m) return null;
  if (m[4] !== undefined && Number(m[4]) === 0) return null;
  const to2 = (n: string) =>
    Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, "0");
  return `#${to2(m[1]!)}${to2(m[2]!)}${to2(m[3]!)}`;
}

/** Caption-glyph colour with enough contrast against `hexBackground`. */
export function symbolColorFor(hexBackground: string): string {
  const r = parseInt(hexBackground.slice(1, 3), 16);
  const g = parseInt(hexBackground.slice(3, 5), 16);
  const b = parseInt(hexBackground.slice(5, 7), 16);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.5 ? THEMES.light.symbolColor : THEMES.dark.symbolColor;
}

/**
 * Runs in the page: find the effective background colour under the caption
 * buttons by walking up from the element at the top-right corner until an
 * opaque background is found, then falling back to body/html.
 */
export const SAMPLE_BACKGROUND_JS = `(() => {
  const opaque = (c) => c && c !== "transparent" && !/rgba\\([^)]*,\\s*0\\s*\\)$/.test(c);
  const chain = [];
  const x = Math.max(0, window.innerWidth - 20);
  let el = document.elementFromPoint(x, 4);
  while (el) { chain.push(el); el = el.parentElement; }
  chain.push(document.body, document.documentElement);
  for (const node of chain) {
    if (!node) continue;
    const c = getComputedStyle(node).backgroundColor;
    if (opaque(c)) return c;
  }
  return null;
})()`;

/**
 * Fallback drag region for any page the shell loads. capygen's own renderer
 * declares `-webkit-app-region` in its stylesheet; this covers everything else
 * and is harmless when duplicated.
 */
export const APP_PAGE_CSS = `
/* [win] Window Controls Overlay: a drag strip across the top, stopping short of
   the caption buttons. Drag regions are geometric, so interactive elements opt
   out explicitly. */
body::before {
  content: "";
  position: fixed;
  top: 0;
  left: 0;
  right: ${CAPTION_WIDTH_REM}rem;
  height: 2.25rem;
  -webkit-app-region: drag;
  z-index: 0;
  pointer-events: none;
}
:is(a, button, input, textarea, select, [role="button"], [role="option"], [contenteditable]) {
  -webkit-app-region: no-drag;
}
.titlebar-clearance { padding-right: ${CAPTION_WIDTH_REM}rem; }
`;

/** BrowserWindow options for the seamless look. */
export function windowOptions(dark: boolean): {
  titleBarStyle: "hidden";
  titleBarOverlay: OverlayColors;
  autoHideMenuBar: boolean;
} {
  return {
    titleBarStyle: "hidden",
    titleBarOverlay: overlayColors(dark),
    autoHideMenuBar: true,
  };
}

/** Update the caption-button colours. No-op on a window without an overlay. */
export function syncOverlay(win: BrowserWindow, dark: boolean): void {
  try {
    if (win.isDestroyed() || typeof win.setTitleBarOverlay !== "function") return;
    win.setTitleBarOverlay(overlayColors(dark));
  } catch {
    /* frameless window without overlay support */
  }
}

const lastOverlay = new WeakMap<BrowserWindow, string>();

/**
 * Sample the page under the caption buttons and repaint the overlay with that
 * colour. Idempotent per window: only calls setTitleBarOverlay on a change.
 */
export async function blendOverlay(
  win: BrowserWindow,
  dark: boolean,
): Promise<string | null> {
  try {
    if (win.isDestroyed() || typeof win.setTitleBarOverlay !== "function") return null;
    const css = (await win.webContents.executeJavaScript(SAMPLE_BACKGROUND_JS, true)) as
      | string
      | null;
    if (win.isDestroyed()) return null;
    const color = cssColorToHex(css) ?? overlayColors(dark).color;
    if (lastOverlay.get(win) === color) return null;
    lastOverlay.set(win, color);
    win.setTitleBarOverlay({
      color,
      symbolColor: symbolColorFor(color),
      height: OVERLAY_HEIGHT,
    });
    return color;
  } catch {
    /* page not ready / navigating / no overlay support */
    return null;
  }
}

export interface AttachDeps {
  isDark: () => boolean;
  log?: (msg: string) => void;
}

/**
 * Wire a window: inject the fallback CSS on every main-frame load, then keep the
 * caption buttons blended — immediately, again once the SPA has hydrated, and at
 * a low cadence afterwards so theme switches and in-app navigation are tracked.
 */
export function attach(win: BrowserWindow, { isDark, log = () => {} }: AttachDeps): void {
  const wc = win.webContents;
  let timer: NodeJS.Timeout | null = null;
  const stop = (): void => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  wc.on("did-finish-load", () => {
    void wc
      .insertCSS(APP_PAGE_CSS)
      .then(() => log("[win] chrome css applied"))
      .catch(() => {
        /* page went away mid-insert */
      });

    stop();
    const blend = () =>
      blendOverlay(win, isDark()).then((color) => {
        if (color) log(`[win] caption overlay blended to ${color}`);
      });
    void blend();
    setTimeout(() => void blend(), 1200).unref?.();
    timer = setInterval(() => void blend(), 4000);
    timer.unref?.();
  });

  win.once("closed", stop);
  syncOverlay(win, isDark());
}
