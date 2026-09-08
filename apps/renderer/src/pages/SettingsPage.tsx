/**
 * Settings hub (Phase 6, SPEC R19-R21, R28-R30). The nav pane on the left is
 * `shell/settingsNav.tsx`'s grouped `SETTINGS_NAV_GROUPS`; the body on the
 * right routes `/settings/:section` to one component per id. Every id in
 * `SETTINGS_SECTIONS` has a body here — Task B2's "nav test lists every
 * section id" is `shell/settingsNav.test.tsx`; this file's own test asserts
 * every id renders *something* when routed to, so the two can't drift apart.
 */
import type { ComponentType } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import { SelectedProjectNote } from "@/components/settings/primitives";
import { cn } from "@/lib/utils";
import { findSettingsSection, SETTINGS_NAV_GROUPS } from "@/shell/settingsNav";
import { ProvidersSection } from "./settings/ProvidersSection";
import { GeneralSection } from "./settings/GeneralSection";
import { AppearanceSection } from "./settings/AppearanceSection";
import { GitSection } from "./settings/GitSection";
import { ShortcutsSection } from "./settings/ShortcutsSection";
import { ArchivedSection } from "./settings/ArchivedSection";
import { HarnessesSection } from "./settings/HarnessesSection";
import { McpSection } from "./settings/McpSection";
import { SkillsSection } from "./settings/SkillsSection";
import { PluginsSection } from "./settings/PluginsSection";
import { ToolsSection } from "./settings/ToolsSection";
import { DevServersSection } from "./settings/DevServersSection";
import { PrereqsSection } from "./settings/PrereqsSection";
import { DiagnosticsSection } from "./settings/DiagnosticsSection";
import { ImportSection } from "./settings/ImportSection";
import { MembersSection } from "./settings/MembersSection";
import { PoliciesSection } from "./settings/PoliciesSection";
import { SharingSection } from "./settings/SharingSection";
import {
  AccountSection,
  LegacyIntegrationsSection,
  LocalCliSection,
  UpdatesSection,
} from "./settings/PlaceholderSections";

/** Re-exported for anything that still imports the flat list from here
 *  (the earlier Phase 6 placeholder shipped it from this file). */
export { SETTINGS_SECTIONS } from "@/shell/settingsNav";

const SECTION_BODIES: Record<string, ComponentType> = {
  general: GeneralSection,
  appearance: AppearanceSection,
  git: GitSection,
  shortcuts: ShortcutsSection,
  import: ImportSection,
  integrations: LegacyIntegrationsSection,
  account: AccountSection,
  harnesses: HarnessesSection,
  mcp: McpSection,
  skills: SkillsSection,
  plugins: PluginsSection,
  tools: ToolsSection,
  "api-keys": ProvidersSection,
  "dev-servers": DevServersSection,
  prereqs: PrereqsSection,
  diagnostics: DiagnosticsSection,
  cli: LocalCliSection,
  updates: UpdatesSection,
  members: MembersSection,
  policies: PoliciesSection,
  sharing: SharingSection,
  archived: ArchivedSection,
};

/**
 * The sections whose data is read and written **per project** (Phase 7-P0):
 * they send this window's selected project id on every `integrations.*` call,
 * so the page names the project they are scoped to.
 */
const PROJECT_SCOPED_SECTIONS = new Set(["mcp", "skills", "plugins", "tools"]);

export function SettingsPage() {
  const navigate = useNavigate();
  const { section = "general" } = useParams();
  const current = findSettingsSection(section);
  const Body = SECTION_BODIES[current.id];

  return (
    <div className="flex min-h-0 min-w-0 flex-1" data-testid="settings-page">
      <nav
        aria-label="Settings sections"
        data-testid="settings-nav"
        // The drag strip is fixed across the top 36px of the window, so the
        // first link would sit under it and clicking it would drag the window
        // instead of navigating.
        className="titlebar-top-clearance hidden w-60 shrink-0 flex-col gap-4 overflow-y-auto border-r border-border-weak p-3 md:flex"
      >
        {SETTINGS_NAV_GROUPS.map((group) => (
          <div key={group.title} className="flex flex-col gap-0.5">
            <h2 className="px-2 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {group.title}
            </h2>
            {group.items.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.id}
                  to={`/settings/${item.id}`}
                  data-testid={`settings-nav-${item.id}`}
                  data-section-id={item.id}
                  className={({ isActive }) =>
                    cn(
                      "sidebar-row flex items-center gap-2 rounded-md px-2 py-1 text-sm",
                      isActive
                        ? "bg-accent text-accent-foreground"
                        : "text-foreground hover:bg-accent/60",
                    )
                  }
                >
                  <Icon className="size-3.5 shrink-0" />
                  {item.label}
                </NavLink>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="titlebar-clearance min-h-0 min-w-0 flex-1 overflow-y-auto p-4 max-md:!pt-12 max-md:!pr-4 sm:p-8" data-testid="settings-body">
        <select aria-label="Settings section" value={current.id} onChange={(event) => navigate(`/settings/${event.target.value}`)} className="mb-4 w-full rounded-md border border-border bg-background p-2 md:hidden">
          {SETTINGS_NAV_GROUPS.map((group) => <optgroup key={group.title} label={group.title}>{group.items.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</optgroup>)}
        </select>
        <h1 className="mb-1 text-3xl font-normal tracking-[-0.03em]">{current.label}</h1>
        <div className="mt-6 max-w-2xl">
          {PROJECT_SCOPED_SECTIONS.has(current.id) ? <SelectedProjectNote /> : null}
          {Body ? <Body /> : null}
        </div>
      </div>
    </div>
  );
}
