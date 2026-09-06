/**
 * Settings ▸ Archived sessions (R19). Unlike most of this hub, this one is
 * fully real today — `appStore` already carries `archiveSession` and
 * `setShowArchived`/`sessions.list{includeArchived}` (Phase 2/4's own
 * additions), so this page is a thin read/write view over the existing
 * store rather than a new IPC surface.
 */
import { useEffect } from "react";
import { ArchiveRestoreIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionIntro, SettingsCard } from "@/components/settings/primitives";
import { useAppStore } from "@/store/appStore";

export function ArchivedSection() {
  const sessions = useAppStore((s) => s.sessions);
  const setShowArchived = useAppStore((s) => s.setShowArchived);
  const archiveSession = useAppStore((s) => s.archiveSession);

  useEffect(() => {
    void setShowArchived(true);
    return () => void setShowArchived(false);
  }, [setShowArchived]);

  const archived = sessions.filter((s) => s.archived);

  return (
    <div data-testid="settings-archived">
      <SectionIntro title="Archived sessions" description="Unarchive to bring one back to the sidebar." />
      {archived.length === 0 ? (
        <p className="text-sm text-muted-foreground">No archived sessions.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {archived.map((session) => (
            <SettingsCard
              key={session.id}
              testId={`archived-row-${session.id}`}
              title={session.title || "Untitled session"}
              subtitle={new Date(session.updatedAt).toLocaleString()}
              action={
                <Button
                  size="sm"
                  variant="outline"
                  data-testid={`archived-restore-${session.id}`}
                  onClick={() => void archiveSession(session.id, false)}
                >
                  <ArchiveRestoreIcon className="size-3.5" />
                  Unarchive
                </Button>
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
