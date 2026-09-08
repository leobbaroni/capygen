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
import { DevSettingsPage } from "@/pages/DevSettingsPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { TasksPage } from "@/pages/TasksPage";
import { InboxPage } from "@/pages/InboxPage";
import { UsagePage } from "@/pages/UsagePage";
import { AutomationsPage } from "@/pages/AutomationsPage";
import { ToolsPage } from "@/pages/ToolsPage";
import { ExtensionPage } from "@/pages/ExtensionPage";
import { ExtensionNavigationEvents } from "@/shell/ExtensionNavigation";
import { HostsPage } from "@/pages/HostsPage";
import { ApprovePage } from "@/pages/ApprovePage";
import { useAppStore } from "@/store/appStore";

export function App() {
  const init = useAppStore((s) => s.init);

  useEffect(() => {
    void init();
  }, [init]);

  return (
    <HashRouter>
      <ExtensionNavigationEvents />
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<LandingPage />} />
          <Route path="/c/:sessionId" element={<ChatPage />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="/usage" element={<UsagePage />} />
          <Route path="/automations" element={<AutomationsPage />} />
          <Route path="/tools" element={<ToolsPage />} />
          <Route path="/tools/:category" element={<ToolsPage />} />
          <Route path="/extensions" element={<Navigate to="/tools/pages" replace />} />
          <Route path="/settings/integrations" element={<Navigate to="/tools" replace />} />
          <Route path="/extensions/page/:extensionId/:pageId" element={<ExtensionPage />} />
          <Route path="/hosts" element={<HostsPage />} />
          <Route path="/approve" element={<ApprovePage />} />
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
          {/* Fixture-backed Settings hub (Phase 6, B2 evidence) — dev-only,
              never part of a production build. */}
          {import.meta.env.DEV ? (
            <Route path="/dev/settings/:section" element={<DevSettingsPage />} />
          ) : null}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
