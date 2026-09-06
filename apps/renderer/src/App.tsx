/**
 * Routes. HashRouter, not BrowserRouter: the built app is loaded over `file://`
 * where a path-based router's deep links have nothing to resolve against.
 */
import { useEffect } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "@/shell/AppShell";
import { LandingPage } from "@/pages/LandingPage";
import { ChatPage } from "@/pages/ChatPage";
import { DevAgentsPage } from "@/pages/DevAgentsPage";
import { DevCardsPage } from "@/pages/DevCardsPage";
import { DevWorkspacePage } from "@/pages/DevWorkspacePage";
import { SettingsPage } from "@/pages/SettingsPage";
import { useAppStore } from "@/store/appStore";

export function App() {
  const init = useAppStore((s) => s.init);

  useEffect(() => {
    void init();
  }, [init]);

  return (
    <HashRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<LandingPage />} />
          <Route path="/c/:sessionId" element={<ChatPage />} />
          <Route path="/settings" element={<Navigate to="/settings/general" replace />} />
          <Route path="/settings/:section" element={<SettingsPage />} />
          {/* Fixture page for every card kind (B4 evidence) — dev-only, never
              part of a production build. */}
          {import.meta.env.DEV ? <Route path="/dev/cards" element={<DevCardsPage />} /> : null}
          {/* Fixture round-table session for the Agents pane (B2 evidence) —
              dev-only, never part of a production build. */}
          {import.meta.env.DEV ? <Route path="/dev/agents" element={<DevAgentsPage />} /> : null}
          {/* Fixture project for the dockview workspace (Phase 5, B2
              evidence) — dev-only, never part of a production build. */}
          {import.meta.env.DEV ? <Route path="/dev/workspace" element={<DevWorkspacePage />} /> : null}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
