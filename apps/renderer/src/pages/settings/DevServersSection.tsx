/**
 * Settings ▸ Dev servers (Task B2 item 2, SPEC R19).
 *
 * [review] This page used to render a live-looking Switch and Select whose
 * only effect was a `capygen:settings:devServers` key in `localStorage` that
 * **nothing reads**: `DevServerService.detect` (apps/desktop/src/workspace/
 * DevServerService.ts) detects unconditionally and the Browser pane opens
 * regardless, so turning "Auto-detect on open" off changed nothing at all. The
 * footnote said the value was "stored locally on this machine for now", which
 * reads as *saved but not synced* rather than *has no effect*.
 *
 * Wiring the two preferences for real needs a `GlobalSettings.devServers`
 * section (`packages/shared/src/domain.ts`) plus a `DevServerService` that
 * consults it — a shared-contract change no task in this phase owns. So the
 * page now uses the same `ArrivesLaterNote` treatment every other
 * not-yet-built section uses (`PlaceholderSections.tsx`), and states what the
 * app does today, which is the truth rather than a control that lies.
 */
import { Link } from "react-router-dom";
import { ArrivesLaterNote, SectionIntro } from "@/components/settings/primitives";

export function DevServersSection() {
  return (
    <div data-testid="settings-dev-servers">
      <SectionIntro
        title="Dev servers"
        description="Defaults for the Servers pane (R18) — per-project overrides still come from the project itself."
      />
      <ArrivesLaterNote phase="a GlobalSettings.devServers section" what="Dev-server defaults" />
      <div className="mt-4 rounded-lg border border-border-weak bg-card/50 px-3.5 py-3 text-sm text-muted-foreground">
        <p className="mb-2 font-medium text-foreground">What capygen does today</p>
        <ul className="flex list-disc flex-col gap-1 pl-5">
          <li>
            Opening a project always looks for a dev server (
            <code className="font-mono">.claude/launch.json</code>, package scripts,{" "}
            <code className="font-mono">docker-compose</code>) — there is no way to turn the scan
            off yet.
          </li>
          <li>
            Starting a server opens the Browser pane at its URL once the port answers.
          </li>
          <li>
            Both are per-project today: start, stop and the preview URL live in the{" "}
            <Link to="/" className="text-foreground underline underline-offset-2">
              Servers pane
            </Link>
            , not here.
          </li>
        </ul>
      </div>
    </div>
  );
}
