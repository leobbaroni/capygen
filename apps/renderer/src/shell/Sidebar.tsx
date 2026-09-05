/**
 * Sessions sidebar (P3). Layout mirrors Omnigent's
 * reference/omnigent/web/src/shell/Sidebar.tsx: a `conversations-sidebar`
 * panel carrying the brand gradient, flush to the window edge, pushing main
 * aside. Search filters by title; sessions group under the project they
 * belong to (falling back to a "Loose sessions" bucket for a project the
 * list hasn't loaded yet); archived sessions are hidden unless the toggle at
 * the bottom is on, and each row grows an archive button on hover.
 */
import { useMemo, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { ArchiveIcon, ArchiveRestoreIcon, Plus, SearchIcon, Settings as SettingsIcon } from "lucide-react";
import type { Project, Session } from "@capygen/shared";
import { BrandLogo } from "@/brand/BrandLogo";
import { Wordmark } from "@/brand/Wordmark";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/appStore";

export interface SidebarProps {
  sessions: Session[];
  activeSessionId: string | null;
}

const UNFILED_GROUP = "__capygen_unfiled__";

export function Sidebar({ sessions, activeSessionId }: SidebarProps) {
  const navigate = useNavigate();
  const projects = useAppStore((s) => s.projects);
  const showArchived = useAppStore((s) => s.showArchived);
  const setShowArchived = useAppStore((s) => s.setShowArchived);
  const archiveSession = useAppStore((s) => s.archiveSession);
  const [query, setQuery] = useState("");

  const projectById = useMemo(() => {
    const map = new Map<string, Project>();
    for (const p of projects) map.set(p.id, p);
    return map;
  }, [projects]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const visible = sessions.filter((s) => {
      if (!showArchived && s.archived) return false;
      if (q === "") return true;
      return (s.title || "Untitled session").toLowerCase().includes(q);
    });
    const byProject = new Map<string, Session[]>();
    for (const session of visible) {
      const key = projectById.has(session.projectId) ? session.projectId : UNFILED_GROUP;
      const bucket = byProject.get(key);
      if (bucket) bucket.push(session);
      else byProject.set(key, [session]);
    }
    return Array.from(byProject.entries()).map(([projectId, rows]) => ({
      projectId,
      name: projectId === UNFILED_GROUP ? "Loose sessions" : (projectById.get(projectId)?.name ?? "Unknown project"),
      rows,
    }));
  }, [sessions, showArchived, query, projectById]);

  return (
    <aside
      aria-label="Sessions"
      data-testid="sidebar"
      className="conversations-sidebar flex w-[260px] shrink-0 flex-col border-r border-border bg-card select-none"
    >
      {/* Sits under the caption buttons only on the right edge of the window;
          the sidebar is on the left, so it just needs the title-bar height.
          The brand lockup lives here — the small mark plus the wordmark, the
          same pair Omnigent's sidebar carries at the top of the rail. */}
      <div className="flex h-9 items-center gap-1.5 px-3" data-testid="sidebar-brand">
        <BrandLogo variant="icon" />
        <Wordmark className="text-sm text-foreground" testId="brand-wordmark" />
      </div>

      <div className="flex flex-col gap-2 px-2 pb-2">
        <Button
          variant="outline"
          className="w-full justify-start"
          onClick={() => navigate("/")}
          data-testid="new-session"
        >
          <Plus className="ui-icon" />
          New session
        </Button>
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sessions"
            aria-label="Search sessions"
            data-testid="sidebar-search"
            className="h-7 w-full rounded-md border border-border-weak bg-background pr-2 pl-7 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring"
          />
        </div>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2">
        {groups.length === 0 ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">
            {sessions.length === 0 ? "No sessions yet." : "No sessions match your search."}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {groups.map((group) => (
              <div key={group.projectId}>
                <p className="truncate px-2 pb-1 text-xs font-medium text-muted-foreground">
                  {group.name}
                </p>
                <ul className="flex flex-col gap-0.5">
                  {group.rows.map((session) => (
                    <li key={session.id} className="group/row relative">
                      <NavLink
                        to={`/c/${session.id}`}
                        data-testid="session-row"
                        data-archived={session.archived || undefined}
                        className={cn(
                          "sidebar-row flex items-center gap-1 truncate rounded-md py-1 pr-7 pl-2 text-sm",
                          session.id === activeSessionId
                            ? "bg-sidebar-active text-sidebar-active-foreground"
                            : "text-foreground hover:bg-accent hover:text-accent-foreground",
                          session.archived && "opacity-60",
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {session.title || "Untitled session"}
                        </span>
                      </NavLink>
                      <button
                        type="button"
                        title={session.archived ? "Unarchive" : "Archive"}
                        aria-label={session.archived ? "Unarchive session" : "Archive session"}
                        data-testid="session-archive-toggle"
                        onClick={(e) => {
                          e.preventDefault();
                          void archiveSession(session.id, !session.archived);
                        }}
                        className="absolute top-1/2 right-1 -translate-y-1/2 rounded-md p-1 text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground group-hover/row:opacity-100 focus-visible:opacity-100"
                      >
                        {session.archived ? (
                          <ArchiveRestoreIcon className="size-3.5" />
                        ) : (
                          <ArchiveIcon className="size-3.5" />
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </nav>

      <label className="flex items-center gap-2 border-t border-border-weak px-4 py-2 text-sm text-muted-foreground">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(e) => void setShowArchived(e.target.checked)}
          data-testid="sidebar-show-archived"
        />
        Show archived
      </label>

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
