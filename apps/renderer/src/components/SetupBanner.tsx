/**
 * Landing banner (SPEC R3): "Set up Claude Code or Codex to start" whenever
 * neither backend is available yet — read off `appStore.harnesses`, the same
 * `harness.list` snapshot Settings ▸ Harnesses reads, so this never spawns a
 * second Codex probe of its own. `harnesses` starts empty until that call
 * resolves (`appStore.init`), so `loaded` gates the check the same way
 * `HarnessesSection`'s `info === undefined` → "Checking…" does — an empty
 * array must not read as "nothing available" before the fetch lands.
 *
 * Clicking it opens Settings ▸ Prerequisites (`/settings/prereqs` — the
 * section id `apps/renderer/src/shell/settingsNav.tsx` already reserves for
 * `PrereqPanel`).
 *
 * On a genuinely fresh machine — neither CLI installed at all, not merely
 * "installed but not signed in" — this renders the full `PrereqPanel` inline
 * instead of a link-out banner (task B3 item 3: "first-run... the landing
 * shows the panel inline"), so a brand-new user can finish setup without
 * leaving the landing screen. That distinction needs `prereqs.status`
 * (`harness.list` alone cannot tell "not installed" from "installed, not
 * signed in"), fetched only once neither backend is available — the common
 * case, something is already set up, never pays for it.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { TriangleAlertIcon } from "lucide-react";
import { ipc } from "@/lib/ipc";
import { useAppStore } from "@/store/appStore";
import { PrereqPanel } from "./prereqs/PrereqPanel";

export function SetupBanner() {
  const navigate = useNavigate();
  const harnesses = useAppStore((s) => s.harnesses);
  const loaded = harnesses.length > 0;
  const noneAvailable = loaded && harnesses.every((h) => !h.available);

  const [freshMachine, setFreshMachine] = useState(false);

  useEffect(() => {
    if (!noneAvailable) return;
    let cancelled = false;
    void ipc()
      .invoke("prereqs.status", {})
      .then(({ steps }) => {
        if (cancelled) return;
        const cliInstalled = steps.some(
          (s) => (s.id === "claude-cli" || s.id === "codex-cli") && s.detected,
        );
        setFreshMachine(!cliInstalled);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [noneAvailable]);

  if (!noneAvailable) return null;

  if (freshMachine) {
    return (
      <div
        data-testid="setup-banner-inline"
        className="w-full rounded-lg border border-border-weak bg-card p-4"
      >
        <div className="mb-3 flex items-center gap-2">
          <TriangleAlertIcon className="size-4 shrink-0 text-warning" />
          <p className="text-sm font-medium text-foreground">Set up Claude Code or Codex to start</p>
        </div>
        <PrereqPanel />
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => navigate("/settings/prereqs")}
      data-testid="setup-banner"
      className="flex w-full items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-warning/15"
    >
      <TriangleAlertIcon className="size-4 shrink-0 text-warning" />
      <span className="flex-1">Set up Claude Code or Codex to start</span>
      <span className="text-xs text-muted-foreground">Open Settings ▸ Prerequisites</span>
    </button>
  );
}
