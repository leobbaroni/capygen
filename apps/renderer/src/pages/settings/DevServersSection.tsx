/**
 * Settings ▸ Dev servers (Task B2 item 2, SPEC R19): global defaults for the
 * Servers pane's own auto-detection (R18) and what the Browser pane does
 * once a server starts.
 *
 * `GlobalSettingsSchema` (Phase 6's contracts pass, `packages/shared/src/
 * domain.ts`) has no `devServers` section — R19's acceptance line names this
 * page but the settings contract's own field list (its doc comment,
 * "Steps: … Harnesses/MCP/Skills/Plugins/Tools/API keys/ Dev servers/
 * Diagnostics") does not enumerate one, and this task owns no file that
 * could add it (`packages/shared` is out of scope here — CLAUDE.md /
 * PLAN.md's ownership split leaves the schema to whichever task lands
 * `GlobalSettings.devServers`). Rather than a dead page, these two
 * preferences are kept in `localStorage` (per-viewer, like the workspace
 * layout's other client-only conveniences) with a note that they will move
 * into `GlobalSettings` once that field exists — swap `readPrefs`/
 * `writePrefs` for `useGlobalSettings` at that point and this page's JSX is
 * otherwise unchanged.
 */
import { useState } from "react";
import { SectionIntro } from "@/components/settings/primitives";
import { ConfigRow, SettingSelect, SettingToggle } from "@/components/settings/primitives";

const STORAGE_KEY = "capygen:settings:devServers";

interface DevServerPrefs {
  autoDetect: boolean;
  browserBehavior: "auto-open" | "manual";
}

const DEFAULT_PREFS: DevServerPrefs = { autoDetect: true, browserBehavior: "auto-open" };

function readPrefs(): DevServerPrefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<DevServerPrefs>;
    return { ...DEFAULT_PREFS, ...parsed };
  } catch {
    return DEFAULT_PREFS;
  }
}

function writePrefs(prefs: DevServerPrefs): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Best-effort: a private window or blocked site data just means the
    // preference does not survive a reload — never breaks the page.
  }
}

export function DevServersSection() {
  const [prefs, setPrefs] = useState<DevServerPrefs>(() => readPrefs());

  function update(patch: Partial<DevServerPrefs>): void {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    writePrefs(next);
  }

  return (
    <div data-testid="settings-dev-servers">
      <SectionIntro
        title="Dev servers"
        description="Defaults for the Servers pane (R18) — per-project overrides still come from the project itself."
      />
      <ConfigRow
        label="Auto-detect on open"
        description="Look for a launch.json / package.json / docker-compose dev script when a project opens."
        testId="row-auto-detect"
      >
        <SettingToggle
          checked={prefs.autoDetect}
          onChange={(checked) => update({ autoDetect: checked })}
          data-testid="toggle-auto-detect"
          aria-label="Auto-detect dev servers on open"
        />
      </ConfigRow>
      <ConfigRow
        label="Browser pane on start"
        description="What happens to the Browser pane once a started server's port answers."
        testId="row-browser-behavior"
      >
        <SettingSelect
          value={prefs.browserBehavior}
          onChange={(value) => update({ browserBehavior: value as DevServerPrefs["browserBehavior"] })}
          options={[
            { value: "auto-open", label: "Open it automatically (R18)" },
            { value: "manual", label: "Leave it — open manually" },
          ]}
          data-testid="select-browser-behavior"
          aria-label="Browser pane behaviour on server start"
        />
      </ConfigRow>
      <p className="mt-4 text-xs text-muted-foreground">
        Stored locally on this machine for now — pending a <code className="font-mono">GlobalSettings.devServers</code>{" "}
        section, so it is not yet synced through <code className="font-mono">settings.patch</code>.
      </p>
    </div>
  );
}
