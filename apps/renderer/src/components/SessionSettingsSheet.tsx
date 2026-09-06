/**
 * Session settings sheet (SPEC item B2.4): hop cap, parallel agents, and the
 * session-wide sub-agent routing default (`SessionSettings`, ADR-0002)
 * reachable from the chat header gear. A lightweight anchored panel, not a
 * modal — every field change round-trips straight through
 * `sessions.updateSettings` (`SessionSettingsPatchSchema`, merge-patched so
 * editing one field never resets another).
 */
import type { Backend, SessionSettings, SessionSettingsPatch } from "@capygen/shared";
import { Button } from "@/components/ui/button";
import { BACKEND_LABEL } from "@/lib/agentDisplay";

const BACKENDS: Backend[] = ["claude", "codex", "api"];

export interface SessionSettingsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: SessionSettings;
  onChange: (patch: SessionSettingsPatch) => void;
}

export function SessionSettingsSheet({
  open,
  onOpenChange,
  settings,
  onChange,
}: SessionSettingsSheetProps) {
  if (!open) return null;
  const routingBackend = settings.routing?.subagents?.backend ?? "";
  const routingModel = settings.routing?.subagents?.model ?? "";

  function setRouting(next: { backend?: string; model?: string }): void {
    const backend = next.backend !== undefined ? next.backend : routingBackend;
    const model = next.model !== undefined ? next.model : routingModel;
    onChange({
      routing: {
        ...settings.routing,
        subagents: {
          ...(backend ? { backend: backend as Backend } : {}),
          ...(model ? { model } : {}),
        },
      },
    });
  }

  return (
    <div
      data-testid="session-settings-sheet"
      className="absolute top-full right-0 z-30 mt-1 w-72 rounded-lg border border-border bg-popover p-3 text-sm text-popover-foreground shadow-menu"
    >
      <div className="flex items-center justify-between pb-2">
        <span className="font-medium text-foreground">Round-table settings</span>
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

      <label className="flex items-center justify-between gap-2 py-1.5">
        <span className="text-muted-foreground">
          Hop cap
          <span className="block text-xs">Agent-to-agent chain limit (SPEC R11)</span>
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

      <div className="border-t border-border-weak pt-2">
        <p className="pb-1 text-muted-foreground">Sub-agent routing default</p>
        <div className="flex items-center gap-1.5">
          <select
            value={routingBackend}
            aria-label="Sub-agent routing backend"
            data-testid="session-settings-routing-backend"
            onChange={(e) => setRouting({ backend: e.target.value })}
            className="h-7 flex-1 rounded-md border border-border-weak bg-background px-1.5 text-xs outline-none"
          >
            <option value="">Inherit per agent</option>
            {BACKENDS.map((b) => (
              <option key={b} value={b}>
                {BACKEND_LABEL[b]}
              </option>
            ))}
          </select>
          <input
            type="text"
            aria-label="Sub-agent routing model"
            placeholder="model (optional)"
            value={routingModel}
            data-testid="session-settings-routing-model"
            onChange={(e) => setRouting({ model: e.target.value })}
            className="h-7 flex-1 rounded-md border border-border-weak bg-background px-1.5 text-xs outline-none"
          />
        </div>
      </div>
    </div>
  );
}
