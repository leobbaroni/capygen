/**
 * Maps capygen's copied Omnigent CSS tokens (`index.css`, `themePalettes.
 * generated.css`) onto xterm's `ITheme`. Read live via `getComputedStyle`
 * rather than hard-coded hex, so a theme switch (`.dark` toggled on
 * `<html>`, or a palette switch — `themePalettes.generated.css` defines more
 * than light/dark) is picked up by re-calling this, not by a second copy of
 * the palette.
 *
 * The values that come back (`oklch(...)`, `color-mix(...)`) are handed to
 * xterm's theme as plain strings; Chromium (Electron 44) accepts both as
 * canvas/WebGL fill colours directly, so no extra resolution step is needed.
 */
import type { ITheme } from "@xterm/xterm";

function cssVar(name: string, fallback: string): string {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
}

/**
 * [C] xterm measures glyphs by writing the family into a `CanvasRenderingContext2D.font`
 * string (and into the WebGL atlas), where `var(--font-mono)` is not a value
 * a canvas can resolve — Chromium silently drops the whole declaration and
 * falls back to a proportional face, which makes the cursor land in the
 * wrong column. So the family is resolved to real font names here, exactly
 * like every colour on this page.
 */
export function readXtermFontFamily(): string {
  return cssVar("--font-mono", "ui-monospace, SFMono-Regular, Consolas, monospace");
}

export function readXtermTheme(): ITheme {
  const foreground = cssVar("--foreground", "#27272a");
  const background = cssVar("--code-bg", "#0000000f");
  return {
    foreground,
    background,
    cursor: foreground,
    cursorAccent: cssVar("--background", "#ffffff"),
    selectionBackground: cssVar("--accent", "#d7edfe"),
    black: cssVar("--background", "#ffffff"),
    red: cssVar("--status-red", "#f04858"),
    green: cssVar("--status-green", "#2ea65c"),
    yellow: cssVar("--status-yellow", "#d4972a"),
    blue: cssVar("--status-blue", "#3b8ff5"),
    magenta: cssVar("--brand-accent", "#df3c85"),
    cyan: cssVar("--info", "#3b8ff5"),
    white: foreground,
    brightBlack: cssVar("--muted-foreground", "#71717a"),
    brightRed: cssVar("--status-red", "#f04858"),
    brightGreen: cssVar("--status-green", "#2ea65c"),
    brightYellow: cssVar("--status-yellow", "#d4972a"),
    brightBlue: cssVar("--status-blue", "#3b8ff5"),
    brightMagenta: cssVar("--brand-accent", "#df3c85"),
    brightCyan: cssVar("--info", "#3b8ff5"),
    brightWhite: foreground,
  };
}
