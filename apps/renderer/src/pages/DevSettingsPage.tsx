/**
 * `/dev/settings/:section` — fixture data for the Settings hub's visual QA
 * and Task B2's screenshot evidence (`e2e-out/settings-mcp.png`,
 * `settings-plugins.png`, `settings-dark.png`). Same idea as `DevAgentsPage`/
 * `DevWorkspacePage`, adapted one level further: those seed `appStore`
 * directly, but every settings section talks to `ipc()` on its own
 * (`ProvidersSection.tsx`'s established pattern — see `useGlobalSettings.ts`'s
 * doc comment for why), so there is no store state to seed here. Instead this
 * page installs a **fixture bridge** at `window[IPC_BRIDGE_KEY]` — the exact
 * shape `apps/desktop/src/preload.ts` exposes — before anything below it
 * mounts, so `hasBridge()` is true and every `ipc().invoke(...)` call in the
 * real section components resolves against fixture data instead of throwing
 * "the preload bridge is missing".
 *
 * Installed synchronously in a lazy `useState` initializer, not a
 * `useEffect`: React finishes the whole render pass (this component's body,
 * `SettingsPage`, every section it mounts) before any effect runs, so a
 * child's own `useEffect(() => { ipc().invoke(...) }, [])` — which is how
 * every section fetches its data — never races the bridge being ready.
 *
 * `App.tsx` only mounts this route when `import.meta.env.DEV` — it never
 * ships in a production build.
 */
import { useState } from "react";
import { useParams } from "react-router-dom";
import {
  DEFAULT_GLOBAL_SETTINGS,
  DEFAULT_SETTINGS,
  IPC_BRIDGE_KEY,
  type DiagnosticsInfo,
  type GlobalSettings,
  type HarnessInfo,
  type McpServerEntry,
  type PluginEntry,
  type PluginMarketplaceEntry,
  type PrereqStep,
  type SkillEntry,
  type ToolPolicyEntry,
} from "@capygen/shared";
import { SettingsPage } from "./SettingsPage";

const FIXTURE_APPEARANCE: GlobalSettings = {
  ...DEFAULT_GLOBAL_SETTINGS,
  appearance: { ...DEFAULT_GLOBAL_SETTINGS.appearance, theme: "dark" },
};

const FIXTURE_HARNESSES: HarnessInfo[] = [
  {
    backend: "claude",
    label: "Claude Code",
    available: true,
    models: [
      { id: "claude-opus-4-5", label: "Opus 4.5" },
      { id: "claude-sonnet-5", label: "Sonnet 5" },
    ],
    defaultModel: "claude-opus-4-5",
  },
  {
    backend: "codex",
    label: "Codex",
    available: false,
    reason: "Codex is not signed in",
    models: [{ id: "gpt-5.5", label: "GPT-5.5" }],
    defaultModel: "gpt-5.5",
  },
  {
    backend: "api",
    label: "API model",
    available: false,
    reason: "No API key configured",
    models: [],
    defaultModel: "",
  },
];

const FIXTURE_MCP: Record<string, McpServerEntry[]> = {
  claude: [
    {
      backend: "claude",
      name: "filesystem",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem"],
      scope: "user",
      source: "~/.claude/settings.json",
      enabled: true,
      status: "connected",
      tools: ["read_file", "write_file", "list_directory"],
    },
    {
      backend: "claude",
      name: "higgsfield",
      transport: "claudeai-proxy",
      scope: "user",
      source: "live",
      enabled: true,
      status: "connected",
    },
    {
      backend: "claude",
      name: "flaky-server",
      transport: "http",
      url: "https://example.com/mcp",
      scope: "project",
      source: ".mcp.json",
      enabled: true,
      status: "failed",
    },
  ],
  codex: [
    {
      backend: "codex",
      name: "ripgrep",
      transport: "stdio",
      command: "codex-mcp-ripgrep",
      scope: "user",
      source: "~/.codex/config.toml",
      enabled: true,
      status: "connected",
    },
  ],
  api: [],
};

const FIXTURE_PLUGINS: Record<string, PluginEntry[]> = {
  claude: [
    {
      backend: "claude",
      name: "cockpit",
      version: "1.4.0",
      marketplace: "anthropic-experimental",
      enabled: true,
      installed: true,
      commands: ["pilot", "grilling", "orchestrate"],
      skills: ["domain-modeling", "handoff"],
      source: "installed_plugins.json",
    },
    {
      backend: "claude",
      name: "hyperframes",
      version: "0.9.2",
      marketplace: "anthropic-experimental",
      enabled: false,
      installed: true,
      commands: ["hyperframes"],
      skills: ["hyperframes-core", "hyperframes-animation"],
      source: "installed_plugins.json",
    },
  ],
  codex: [
    {
      backend: "codex",
      name: "codex-review",
      enabled: true,
      installed: true,
      commands: [],
      skills: [],
      source: "plugin/list",
    },
  ],
  api: [],
};

const FIXTURE_SKILLS: Record<string, SkillEntry[]> = {
  claude: [
    {
      backend: "claude",
      name: "graphify",
      scope: "user",
      path: "C:/Users/tuga/.claude/skills/graphify/SKILL.md",
      enabled: true,
      description: "Build or query a persistent knowledge graph of a folder/repo.",
    },
    {
      backend: "claude",
      name: "pilot",
      scope: "plugin",
      path: "C:/plugins/cockpit/skills/pilot/SKILL.md",
      pluginName: "cockpit",
      enabled: true,
    },
  ],
  codex: [],
  api: [],
};

const FIXTURE_TOOLS: Record<string, ToolPolicyEntry[]> = {
  claude: [
    { backend: "claude", pattern: "Bash(rm *)", decision: "deny", scope: "global" },
    { backend: "claude", pattern: "WebFetch(*)", decision: "ask", scope: "global" },
  ],
  codex: [],
  api: [],
};

const FIXTURE_MARKETPLACES: PluginMarketplaceEntry[] = [
  { name: "anthropic-experimental", source: "claude plugin marketplace list" },
];

const FIXTURE_PREREQS: PrereqStep[] = [
  { id: "claude-cli", title: "Claude Code CLI", detected: true, version: "2.1.261", command: "winget install Anthropic.ClaudeCode", description: "", kind: "cli" },
  { id: "codex-cli", title: "Codex CLI", detected: false, command: "npm install -g @openai/codex", description: "Needed for the Codex backend.", kind: "cli" },
];

const FIXTURE_DIAGNOSTICS: DiagnosticsInfo = {
  versions: { app: "0.12.1", electron: "44.2.0", node: "24.20.0", claude: "2.1.261", codex: "0.153.4" },
  paths: { userData: "C:/Users/tuga/AppData/Roaming/capygen", dbFile: "capygen.db", logDir: "C:/Users/tuga/AppData/Roaming/capygen/logs" },
  harnessAvailability: FIXTURE_HARNESSES.map((h) => ({ backend: h.backend, available: h.available, reason: h.reason })),
  dbSizeBytes: 2_500_000,
  logDir: "C:/Users/tuga/AppData/Roaming/capygen/logs",
};

function fixtureInvoke(channel: string, payload: unknown): Promise<unknown> {
  const args = (payload ?? {}) as { backend?: keyof typeof FIXTURE_MCP };
  switch (channel) {
    case "settings.get":
      return Promise.resolve(DEFAULT_SETTINGS);
    case "settings.getAll":
      return Promise.resolve(FIXTURE_APPEARANCE);
    case "settings.patch":
    case "settings.reset":
      return Promise.resolve(FIXTURE_APPEARANCE);
    case "harness.list":
      return Promise.resolve(FIXTURE_HARNESSES);
    case "projects.list":
    case "sessions.list":
    case "chat.listCommands":
      return Promise.resolve([]);
    case "secrets.has":
      return Promise.resolve({ has: false, source: "none" });
    case "integrations.list":
      return Promise.resolve({
        mcpServers: FIXTURE_MCP[args.backend ?? "claude"] ?? [],
        plugins: FIXTURE_PLUGINS[args.backend ?? "claude"] ?? [],
        skills: FIXTURE_SKILLS[args.backend ?? "claude"] ?? [],
        tools: FIXTURE_TOOLS[args.backend ?? "claude"] ?? [],
        lastSync: Date.now(),
      });
    case "integrations.plugin.marketplaces":
      return Promise.resolve(FIXTURE_MARKETPLACES);
    case "integrations.mcp.test":
      return Promise.resolve({ ok: true, status: "connected", tools: ["read_file", "write_file"] });
    case "prereqs.status":
      return Promise.resolve({ steps: FIXTURE_PREREQS, recommendation: "Install the Codex CLI next." });
    case "diagnostics.get":
      return Promise.resolve(FIXTURE_DIAGNOSTICS);
    default:
      return Promise.resolve({ ok: true });
  }
}

declare global {
  interface Window {
    [IPC_BRIDGE_KEY]?: {
      invoke(channel: string, payload: unknown): Promise<unknown>;
      subscribe(channel: string, listener: (payload: unknown) => void): () => void;
      channels: { invoke: string[]; events: string[] };
    };
  }
}

function installFixtureBridge(): void {
  window[IPC_BRIDGE_KEY] = {
    invoke: fixtureInvoke,
    subscribe: () => () => undefined,
    channels: { invoke: [], events: [] },
  };
}

export function DevSettingsPage() {
  useState(() => {
    installFixtureBridge();
    return null;
  });
  // Reuse the real SettingsPage under a route that still supplies `:section`
  // — this page is mounted at `/dev/settings/:section` in App.tsx.
  const { section } = useParams();
  return (
    <div data-testid="dev-settings-page" className="flex min-h-0 flex-1 flex-col">
      <p className="border-b border-border-weak bg-card/50 px-3 py-1.5 text-xs text-muted-foreground">
        Fixture settings hub — dev-only route, not part of a production build. Section: {section ?? "general"}
      </p>
      <SettingsPage />
    </div>
  );
}
