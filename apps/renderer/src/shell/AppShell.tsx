/**
 * The app shell. Same skeleton as Omnigent's
 * reference/omnigent/web/src/shell/AppShell.tsx: `app-shell` paints the brand
 * canvas, the sessions sidebar pushes main aside, and the routed page fills the
 * rest.
 *
 * The one Windows-specific piece: the drag strip. Electron hides the native
 * title bar and draws only the caption buttons over the top-right corner
 * (apps/desktop/src/win/chrome.ts), so the page supplies the window's drag
 * surface — a fixed strip that stops short of the buttons. Everything below and
 * right of it stays clickable.
 */
import { useEffect } from "react";
import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { useAppStore } from "@/store/appStore";

export function AppShell() {
  const sessions = useAppStore((s) => s.sessions);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const theme = useAppStore((s) => s.settings.theme);

  // `.dark` on <html> is what the copied Omnigent palettes key off.
  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (): void => {
      const dark = theme === "dark" || (theme === "system" && media.matches);
      root.classList.toggle("dark", dark);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  return (
    <div className="app-shell relative flex h-dvh bg-sidebar text-foreground">
      <div className="titlebar-drag" aria-hidden="true" />
      <Sidebar sessions={sessions} activeSessionId={activeSessionId} />
      <main className="relative flex min-w-0 flex-1 flex-col bg-background">
        <Outlet />
      </main>
    </div>
  );
}
