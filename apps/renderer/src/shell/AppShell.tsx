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
import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { MenuIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Sidebar } from "./Sidebar";
import { useAppStore } from "@/store/appStore";
import { useApplyGlobalTheme } from "@/lib/theme";

export function AppShell() {
  const [navigationOpen, setNavigationOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setNavigationOpen(false), [location.pathname]);
  const sessions = useAppStore((s) => s.sessions);
  const activeSessionId = useAppStore((s) => s.activeSessionId);

  // Phase 6: `.dark`/`data-theme`/font-scale/reduced-motion, live from
  // `GlobalSettings.appearance` (Settings ▸ Appearance) rather than the flat
  // Phase-2 `Settings.theme` this used to read directly — see
  // `lib/theme.ts`'s doc comment.
  useApplyGlobalTheme();

  return (
    // `overflow-hidden`: nothing a page renders may scroll the *shell*
    // sideways — a wide child (the Agents pane at 1280px) took the sessions
    // sidebar off-screen with it. Panes clip or scroll inside their own box.
    <div className="app-shell relative flex h-dvh overflow-hidden bg-sidebar text-foreground">
      <div className="titlebar-drag" aria-hidden="true" />
      <div className="hidden min-h-0 md:flex"><Sidebar sessions={sessions} activeSessionId={activeSessionId} /></div>
      <Button variant="ghost" size="sm" aria-label="Open navigation" className="absolute top-1 left-2 z-[42] md:hidden" onClick={() => setNavigationOpen(true)}><MenuIcon className="size-4" /></Button>
      <Dialog open={navigationOpen} onOpenChange={setNavigationOpen}>
        <DialogContent aria-label="Navigation" className="h-[85vh] w-[280px] gap-0 overflow-hidden p-0">
          <DialogTitle className="sr-only">Navigation</DialogTitle>
          <Button variant="ghost" onClick={() => setNavigationOpen(false)}>Close navigation</Button>
          <div className="flex min-h-0 flex-1"><Sidebar sessions={sessions} activeSessionId={activeSessionId} /></div>
        </DialogContent>
      </Dialog>
      <main className="relative flex min-w-0 flex-1 flex-col bg-background">
        <Outlet />
      </main>
    </div>
  );
}
