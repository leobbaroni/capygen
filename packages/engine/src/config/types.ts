/**
 * The shapes the three config stores share (SPEC R28-R30).
 *
 * `IntegrationsSnapshot` is deliberately *not* `integrations.list`'s response:
 * that channel adds `lastSync`, which is the sync coordinator's fact rather
 * than the store's, and it drops `marketplaces`, which Settings ▸ Plugins asks
 * for on its own channel. Keeping the store's own shape means a store can be
 * unit-tested without an IPC contract in the way.
 */
import type {
  McpServerEntry,
  PluginEntry,
  PluginMarketplaceEntry,
  SkillEntry,
  ToolPolicyEntry,
} from "@capygen/shared";

export interface ConfigStoreLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
}

export interface IntegrationsSnapshot {
  mcpServers: McpServerEntry[];
  plugins: PluginEntry[];
  skills: SkillEntry[];
  tools: ToolPolicyEntry[];
  marketplaces: PluginMarketplaceEntry[];
}

export function emptySnapshot(): IntegrationsSnapshot {
  return { mcpServers: [], plugins: [], skills: [], tools: [], marketplaces: [] };
}

/** Which kinds a refresh actually changed — `integrations.changed.kinds`. */
export const INTEGRATION_KINDS = ["mcpServers", "plugins", "skills", "tools"] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

/** The kinds whose lists differ between two snapshots. */
export function changedKinds(
  before: IntegrationsSnapshot,
  after: IntegrationsSnapshot,
): IntegrationKind[] {
  const out: IntegrationKind[] = [];
  for (const kind of INTEGRATION_KINDS) {
    if (JSON.stringify(before[kind]) !== JSON.stringify(after[kind])) out.push(kind);
  }
  return out;
}
