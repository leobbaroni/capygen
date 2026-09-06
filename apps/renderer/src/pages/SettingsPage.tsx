/**
 * Settings hub placeholder (P5/P6). The nav lists every section id SPEC R19
 * requires so the nav test has something to assert against from the start; each
 * section's body arrives in Phase 6.
 */
import { NavLink, useParams } from "react-router-dom";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/appStore";
import { ProvidersSection } from "./settings/ProvidersSection";

/** R19: Omnigent's sections plus capygen's own. Order is the nav order. */
export const SETTINGS_SECTIONS = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "git", label: "Git" },
  { id: "shortcuts", label: "Shortcuts" },
  { id: "import", label: "Import" },
  { id: "integrations", label: "Integrations" },
  { id: "account", label: "Account" },
  { id: "cli", label: "Local CLI" },
  { id: "updates", label: "Updates" },
  { id: "members", label: "Members" },
  { id: "policies", label: "Policies" },
  { id: "sharing", label: "Sharing" },
  { id: "archived", label: "Archived" },
  { id: "harnesses", label: "Harnesses" },
  { id: "mcp", label: "MCP servers" },
  { id: "skills", label: "Skills" },
  { id: "plugins", label: "Plugins" },
  { id: "api-keys", label: "API keys" },
  { id: "dev-servers", label: "Dev servers" },
  { id: "diagnostics", label: "Diagnostics" },
] as const;

export function SettingsPage() {
  const { section = "general" } = useParams();
  const settings = useAppStore((s) => s.settings);
  const current = SETTINGS_SECTIONS.find((s) => s.id === section) ?? SETTINGS_SECTIONS[0];

  return (
    <div className="flex min-h-0 flex-1" data-testid="settings-page">
      <nav
        aria-label="Settings sections"
        data-testid="settings-nav"
        // The drag strip is fixed across the top 36px of the window, so the
        // first link would sit under it and clicking it would drag the window
        // instead of navigating.
        className="titlebar-top-clearance w-56 shrink-0 overflow-y-auto border-r border-border-weak p-2"
      >
        {SETTINGS_SECTIONS.map((s) => (
          <NavLink
            key={s.id}
            to={`/settings/${s.id}`}
            data-section-id={s.id}
            className={({ isActive }) =>
              cn(
                "sidebar-row block rounded-md px-2 py-1 text-sm",
                isActive
                  ? "bg-accent text-accent-foreground"
                  : "text-foreground hover:bg-accent/60",
              )
            }
          >
            {s.label}
          </NavLink>
        ))}
      </nav>

      <div className="titlebar-clearance min-h-0 flex-1 overflow-y-auto p-8">
        <h1 className="text-3xl font-normal tracking-[-0.03em]">{current.label}</h1>
        {current.id === "api-keys" ? (
          <div className="mt-6">
            <ProvidersSection />
          </div>
        ) : (
          <>
            <p className="mt-2 text-sm text-muted-foreground">
              This section lands in Phase 6 (SPEC R19–R21).
            </p>
            <pre className="mt-6 max-w-xl overflow-x-auto rounded-lg bg-code-bg p-3 text-sm">
              {JSON.stringify(settings, null, 2)}
            </pre>
          </>
        )}
      </div>
    </div>
  );
}
