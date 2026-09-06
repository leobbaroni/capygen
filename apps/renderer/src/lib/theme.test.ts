/**
 * `applyTheme` is pure DOM manipulation — tested directly against jsdom's
 * `document.documentElement` without mounting anything, matching Task B2's
 * "theme application" test requirement. `useApplyGlobalTheme` (the IPC-wired
 * hook) is exercised indirectly by `AppShell` — see that component; nothing
 * else in the settings pages calls it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyTheme } from "./theme";

function reset(): void {
  const root = document.documentElement;
  root.classList.remove("dark");
  root.removeAttribute("data-theme");
  root.style.removeProperty("--desktop-ui-font-size");
  document.getElementById("capygen-reduced-motion")?.remove();
}

describe("applyTheme", () => {
  beforeEach(reset);
  afterEach(reset);

  it("adds .dark for theme='dark' and removes it for 'light'", () => {
    applyTheme({ theme: "dark", palette: "default", fontScale: 1, reducedMotion: false });
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    applyTheme({ theme: "light", palette: "default", fontScale: 1, reducedMotion: false });
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("sets data-theme to a named palette, and omits it entirely for 'default'", () => {
    applyTheme({ theme: "light", palette: "dracula", fontScale: 1, reducedMotion: false });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dracula");

    applyTheme({ theme: "light", palette: "default", fontScale: 1, reducedMotion: false });
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("scales index.css's --desktop-ui-font-size (base 13px) by fontScale", () => {
    applyTheme({ theme: "light", palette: "default", fontScale: 1, reducedMotion: false });
    expect(document.documentElement.style.getPropertyValue("--desktop-ui-font-size")).toBe("13px");

    applyTheme({ theme: "light", palette: "default", fontScale: 1.5, reducedMotion: false });
    expect(document.documentElement.style.getPropertyValue("--desktop-ui-font-size")).toBe("19.5px");
  });

  it("inserts a reduced-motion style element only while reducedMotion is on", () => {
    applyTheme({ theme: "light", palette: "default", fontScale: 1, reducedMotion: true });
    const style = document.getElementById("capygen-reduced-motion");
    expect(style).not.toBeNull();
    expect(style?.textContent).toContain("animation-duration: 0.01ms");

    applyTheme({ theme: "light", palette: "default", fontScale: 1, reducedMotion: false });
    expect(document.getElementById("capygen-reduced-motion")).toBeNull();
  });

  it("does not duplicate the reduced-motion style element across repeated calls", () => {
    applyTheme({ theme: "light", palette: "default", fontScale: 1, reducedMotion: true });
    applyTheme({ theme: "dark", palette: "default", fontScale: 1, reducedMotion: true });
    expect(document.querySelectorAll("#capygen-reduced-motion")).toHaveLength(1);
  });
});
