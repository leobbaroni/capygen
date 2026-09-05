/**
 * Sessions sidebar (P3, skeleton). Layout mirrors Omnigent's
 * reference/omnigent/web/src/shell/Sidebar.tsx: a `conversations-sidebar` panel
 * carrying the brand gradient, flush to the window edge, pushing main aside.
 * Search, filters, project grouping and archive land with P3 proper.
 */
import { NavLink, useNavigate } from "react-router-dom";
import { Plus, Settings as SettingsIcon } from "lucide-react";
import type { Session } from "@capygen/shared";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface SidebarProps {
  sessions: Session[];
  activeSessionId: string | null;
}

export function Sidebar({ sessions, activeSessionId }: SidebarProps) {
  const navigate = useNavigate();

  return (
    <aside
      aria-label="Sessions"
      data-testid="sidebar"
      className="conversations-sidebar flex w-[260px] shrink-0 flex-col border-r border-border bg-card select-none"
    >
      {/* Sits under the caption buttons only on the right edge of the window;
          the sidebar is on the left, so it just needs the title-bar height. */}
      <div className="flex h-9 items-center px-3" />

      <div className="px-2 pb-2">
        <Button
          variant="outline"
          className="w-full justify-start"
          onClick={() => navigate("/")}
          data-testid="new-session"
        >
          <Plus className="ui-icon" />
          New session
        </Button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2">
        {sessions.length === 0 ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">No sessions yet.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {sessions.map((session) => (
              <li key={session.id}>
                <NavLink
                  to={`/c/${session.id}`}
                  data-testid="session-row"
                  className={cn(
                    "sidebar-row block truncate rounded-md px-2 py-1 text-sm",
                    session.id === activeSessionId
                      ? "bg-sidebar-active text-sidebar-active-foreground"
                      : "text-foreground hover:bg-accent hover:text-accent-foreground",
                  )}
                >
                  {session.title || "Untitled session"}
                </NavLink>
              </li>
            ))}
          </ul>
        )}
      </nav>

      <div className="border-t border-border-weak p-2">
        <Button
          variant="ghost"
          className="w-full justify-start"
          onClick={() => navigate("/settings/general")}
          data-testid="open-settings"
        >
          <SettingsIcon className="ui-icon" />
          Settings
        </Button>
      </div>
    </aside>
  );
}
