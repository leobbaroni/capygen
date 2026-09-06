/**
 * Live theme application for the Settings hub's Appearance section (Phase 6,
 * SPEC R19/R30). Three effects, all driven by `GlobalSettings.appearance`
 * (`settings.getAll`/`settings.patch`, `@capygen/shared`) rather than the
 * flat Phase-2 `Settings.theme` `AppShell` used to read directly:
 *
 *  - light/dark: `.dark` on `<html>` — exactly the class
 *    `themePalettes.generated.css` keys its default palette off
 *    (`:root:not(.dark):not([data-theme])` / `.dark:not([data-theme])`).
 *    `"system"` resolves against `prefers-color-scheme` and re-resolves live
 *    if the OS preference flips while the setting stays "system".
 *  - palette: `data-theme="<palette>"` on `<html>` — the named palettes
 *    (`dracula`/`github`/`catppuccin`/`gruvbox`/`nord`/`custom`) the same
 *    file keys off `[data-theme="…"]` combined with `.dark`/`:not(.dark)`;
 *    `"default"` (the shipping default) removes the attribute rather than
 *    writing `data-theme="default"`, since no rule in that file matches it.
 *  - font scale: multiplies `index.css`'s `--desktop-ui-font-size` (its own
 *    doc comment already anticipates this: "Settings ▸ Appearance overrides
 *    this at runtime on documentElement").
 *
 * Reduced motion has no token in `index.css` to key off — rather than
 * editing that shared file from this task's narrow ownership
 * (`apps/renderer/src/lib/theme.ts`), a scoped `<style>` element is
 * inserted/removed, the standard a11y trick of collapsing every animation/
 * transition duration to effectively zero.
 */
import { useEffect, useRef } from "react";
import type { GlobalAppearance } from "@capygen/shared";
import { hasBridge, ipc } from "@/lib/ipc";

/** `index.css`'s `--desktop-ui-font-size` default — the 1.0 point `fontScale` scales from. */
const BASE_UI_FONT_PX = 13;
const REDUCED_MOTION_STYLE_ID = "capygen-reduced-motion";
const REDUCED_MOTION_CSS =
  "*, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; scroll-behavior: auto !important; }";

export type AppearanceLike = Pick<GlobalAppearance, "theme" | "palette" | "fontScale" | "reducedMotion">;

function prefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/**
 * Imperatively apply one `GlobalAppearance` snapshot to `document.documentElement`.
 * Pure DOM side effect, no IPC — the hook below is what wires it to the live
 * settings stream; exported on its own so a settings-page test (or a fixture
 * dev route) can call it directly without mounting a subscriber.
 */
export function applyTheme(appearance: AppearanceLike): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;

  const dark = appearance.theme === "dark" || (appearance.theme === "system" && prefersDark());
  root.classList.toggle("dark", dark);

  if (appearance.palette && appearance.palette !== "default") {
    root.setAttribute("data-theme", appearance.palette);
  } else {
    root.removeAttribute("data-theme");
  }

  root.style.setProperty("--desktop-ui-font-size", `${BASE_UI_FONT_PX * appearance.fontScale}px`);

  let style = document.getElementById(REDUCED_MOTION_STYLE_ID) as HTMLStyleElement | null;
  if (appearance.reducedMotion) {
    if (!style) {
      style = document.createElement("style");
      style.id = REDUCED_MOTION_STYLE_ID;
      style.textContent = REDUCED_MOTION_CSS;
      document.head.appendChild(style);
    }
  } else {
    style?.remove();
  }
}

/**
 * Mount once (in `AppShell`) to keep the DOM in sync with
 * `GlobalSettings.appearance` for the life of the window: fetches it once via
 * `settings.getAll`, re-applies on every `settings.changed` broadcast (so the
 * Appearance section's own `settings.patch` calls take effect immediately,
 * same window or not), and re-resolves light/dark when the OS preference
 * changes while `theme === "system"`.
 *
 * A missing bridge (SPA opened outside Electron) or a failed fetch leaves
 * `index.css`'s shipping defaults in place rather than throwing — Appearance
 * is a nice-to-have on top of a page that must still render.
 */
export function useApplyGlobalTheme(): void {
  const currentRef = useRef<AppearanceLike | null>(null);

  useEffect(() => {
    if (!hasBridge()) return;
    let cancelled = false;
    const client = ipc();

    function reapplyForOsChange(): void {
      if (currentRef.current?.theme === "system") applyTheme(currentRef.current);
    }

    const media =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-color-scheme: dark)")
        : null;
    media?.addEventListener("change", reapplyForOsChange);

    void client
      .invoke("settings.getAll", {})
      .then((settings) => {
        if (cancelled) return;
        currentRef.current = settings.appearance;
        applyTheme(settings.appearance);
      })
      .catch(() => undefined);

    const off = client.on("settings.changed", ({ settings }) => {
      currentRef.current = settings.appearance;
      applyTheme(settings.appearance);
    });

    return () => {
      cancelled = true;
      media?.removeEventListener("change", reapplyForOsChange);
      off();
    };
  }, []);
}
