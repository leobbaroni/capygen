/**
 * Session settings sheet (SPEC item B2.4): hop cap, parallel agents, and the
 * session-wide sub-agent routing default (`SessionSettings`, ADR-0002)
 * reachable from the chat header gear. A lightweight anchored panel, not a
 * modal — every field change round-trips straight through
 * `sessions.updateSettings` (`SessionSettingsPatchSchema`, merge-patched so
 * editing one field never resets another).
 */
import type { SessionSettings, SessionSettingsPatch } from "@capygen/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { SessionMcpPanel, type SessionMcpPanelProps } from "./SessionMcpPanel";



export interface SessionSettingsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: SessionSettings;
  onChange: (patch: SessionSettingsPatch) => void;
  /**
   * The session's own MCP servers, for the agent the sheet is open for.
   *
   * Optional so every existing caller compiles unchanged: without it the sheet
   * renders exactly what it rendered before. The panel is deliberately handed
   * whole rather than assembled here — this sheet owns layout, not the IPC or
   * the runtime state behind that section.
   */
  mcp?: SessionMcpPanelProps | null;
  onCustomMode?: () => void;
}

export function SessionSettingsSheet({
  open,
  onOpenChange,
  settings,
  onChange,
  mcp,
  onCustomMode,
}: SessionSettingsSheetProps) {
  if (!open) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent data-testid="session-settings-sheet" aria-label="Session settings" className="max-w-md overflow-y-auto text-sm">
      <div className="flex items-center justify-between pb-2">
        <DialogTitle>Session settings</DialogTitle>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => onOpenChange(false)}
          aria-label="Close settings"
          data-testid="session-settings-close"
        >
          ×
        </Button>
      </div>
      {onCustomMode && <Button variant="outline" className="mb-3 w-full" onClick={onCustomMode}>Custom mode</Button>}

      <label className="flex items-center justify-between gap-2 py-1.5">
        <span className="text-muted-foreground">
          Hop cap
          <span className="block text-xs">Maximum consecutive agent handoffs</span>
        </span>
        <input
          type="number"
          min={1}
          max={20}
          value={settings.hopCap}
          data-testid="session-settings-hopcap"
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n) && n >= 1 && n <= 20) onChange({ hopCap: n });
          }}
          className="h-7 w-16 shrink-0 rounded-md border border-border-weak bg-background px-2 text-right outline-none focus-visible:border-ring"
        />
      </label>

      <label className="flex items-center justify-between gap-2 py-1.5">
        <span className="text-muted-foreground">Parallel agents</span>
        <input
          type="checkbox"
          checked={settings.parallelAgents}
          data-testid="session-settings-parallel"
          onChange={(e) => onChange({ parallelAgents: e.target.checked })}
        />
      </label>

      <div>
        {mcp ? (
          <div className="mt-3 border-t border-border-weak pt-3">
            <SessionMcpPanel {...mcp} />
          </div>
        ) : null}
      </div>
    </DialogContent>
    </Dialog>
  );
}
