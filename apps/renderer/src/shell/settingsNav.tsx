/**
 * The Settings hub's nav model (Phase 6, SPEC R19): every section id, grouped
 * for the sidebar the way `reference/omnigent/web/src/shell/settingsNav.tsx`
 * groups its own (General / Desktop / Admin / Archived) — adapted rather than
 * copied, since Omnigent swaps its *conversations* sidebar for this nav on
 * `/settings` and capygen's `SettingsPage` renders its own nav pane inline
 * instead (`AppShell`'s sidebar stays the sessions list either way).
 *
 * `SETTINGS_SECTIONS` is the flat list `SettingsPage` and its test both read
 * — "nav test lists every section id" (Task B2) asserts against this array,
 * so the two can never drift.
 */
import {
  ArchiveIcon,
  BlocksIcon,
  BotIcon,
  CableIcon,
  DownloadIcon,
  GaugeIcon,
  GitBranchIcon,
  KeyIcon,
  KeyboardIcon,
  ListChecksIcon,
  PaletteIcon,
  PlugIcon,
  ServerIcon,
  SettingsIcon,
  Share2Icon,
  ShieldCheckIcon,
  SparklesIcon,
  StethoscopeIcon,
  TerminalIcon,
  UserCogIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";

export interface SettingsSectionMeta {
  id: string;
  label: string;
  icon: LucideIcon;
}

export interface SettingsNavGroup {
  title: string;
  items: SettingsSectionMeta[];
}

/**
 * Every section id, in nav order. Omnigent's own ids come first (R19's exact
 * list: general, appearance, git, shortcuts, import, integrations, account,
 * cli, updates, members, policies, sharing, archived), then capygen's own
 * additions (R19 continued: Harnesses, MCP servers, Skills, Plugins, API
 * keys, Dev servers, Diagnostics) plus two more Task B2 asks for by name
 * (Tools, Prerequisites) that R19's prose does not spell out but its
 * acceptance line ("plus Harnesses, MCP servers, Skills, Plugins, API keys,
 * Dev servers, Diagnostics") did not anticipate splitting Tools out of
 * Harnesses, nor prerequisites (R3) living in the hub at all.
 */
export const SETTINGS_NAV_GROUPS: SettingsNavGroup[] = [
  {
    title: "General",
    items: [
      { id: "general", label: "General", icon: SettingsIcon },
      { id: "appearance", label: "Appearance", icon: PaletteIcon },
      { id: "git", label: "Git", icon: GitBranchIcon },
      { id: "shortcuts", label: "Keyboard shortcuts", icon: KeyboardIcon },
      { id: "import", label: "Import sessions", icon: DownloadIcon },
      { id: "integrations", label: "Integrations", icon: BlocksIcon },
      { id: "account", label: "Account", icon: UserCogIcon },
    ],
  },
  {
    title: "Harnesses & tools",
    items: [
      { id: "harnesses", label: "Harnesses", icon: BotIcon },
      { id: "mcp", label: "MCP servers", icon: CableIcon },
      { id: "skills", label: "Skills", icon: SparklesIcon },
      { id: "plugins", label: "Plugins", icon: PlugIcon },
      { id: "tools", label: "Tools", icon: ListChecksIcon },
      { id: "api-keys", label: "Providers & API keys", icon: KeyIcon },
    ],
  },
  {
    title: "Workspace",
    items: [
      { id: "dev-servers", label: "Dev servers", icon: ServerIcon },
      { id: "prereqs", label: "Prerequisites", icon: GaugeIcon },
      { id: "diagnostics", label: "Diagnostics", icon: StethoscopeIcon },
    ],
  },
  {
    title: "Desktop",
    items: [
      { id: "cli", label: "Local CLI", icon: TerminalIcon },
      { id: "updates", label: "Updates", icon: DownloadIcon },
    ],
  },
  {
    title: "Admin",
    items: [
      { id: "members", label: "Members", icon: UsersIcon },
      { id: "policies", label: "Policies", icon: ShieldCheckIcon },
      { id: "sharing", label: "Sharing", icon: Share2Icon },
    ],
  },
  {
    title: "Archived",
    items: [{ id: "archived", label: "Archived sessions", icon: ArchiveIcon }],
  },
];

/** Flat list of every section, in nav order — what the nav test and
 *  `SettingsPage`'s route matching both read. */
export const SETTINGS_SECTIONS: SettingsSectionMeta[] = SETTINGS_NAV_GROUPS.flatMap(
  (g) => g.items,
);

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

/** `SETTINGS_SECTIONS[0]` ("General") is a compile-time-known non-empty
 *  literal array, so the `!` here is not the usual index-access risk the
 *  rest of this codebase avoids — `noUncheckedIndexedAccess` just cannot see
 *  that `SETTINGS_NAV_GROUPS` is non-empty. */
export function findSettingsSection(id: string | undefined): SettingsSectionMeta {
  return SETTINGS_SECTIONS.find((s) => s.id === id) ?? SETTINGS_SECTIONS[0]!;
}
