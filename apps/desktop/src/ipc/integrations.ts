/**
 * Settings ▸ Integrations' fifteen channels (SPEC R20, R28-R30).
 *
 * A thin map from channel to `IntegrationsService`; the service owns the
 * stores, the cache and the watchers. Errors are deliberately **not** caught
 * here — a store throws with the CLI's or the file's own message, and
 * `main.ts`'s `ipcMain.handle` logs and re-throws it so the settings page shows
 * the real reason rather than a silent no-op (SPEC §Edge Cases).
 */
import type { InvokeArgs, InvokeChannel, InvokeResult } from "@capygen/shared";
import type { IntegrationsService } from "../integrations/IntegrationsService.js";

export const INTEGRATIONS_CHANNELS = [
  "integrations.list",
  "integrations.openFolder",
  "integrations.mcp.add",
  "integrations.mcp.update",
  "integrations.mcp.remove",
  "integrations.mcp.test",
  "integrations.plugin.install",
  "integrations.plugin.uninstall",
  "integrations.plugin.setEnabled",
  "integrations.plugin.marketplaces",
  "integrations.skill.setEnabled",
  "integrations.skill.create",
  "integrations.skill.open",
  "integrations.tools.setPolicy",
  "integrations.tools.removePolicy",
  "integrations.refresh",
] as const satisfies readonly InvokeChannel[];

export type IntegrationsChannel = (typeof INTEGRATIONS_CHANNELS)[number];

export type IntegrationsHandlers = {
  [C in IntegrationsChannel]: (args: InvokeArgs<C>) => Promise<InvokeResult<C>> | InvokeResult<C>;
};

export function createIntegrationsHandlers(
  integrations: IntegrationsService,
): IntegrationsHandlers {
  return {
    "integrations.list": (args) => integrations.list(args),
    "integrations.openFolder": (args) => integrations.openFolder(args),
    "integrations.mcp.add": (args) => integrations.mcpAdd(args),
    "integrations.mcp.update": (args) => integrations.mcpUpdate(args),
    "integrations.mcp.remove": (args) => integrations.mcpRemove(args),
    "integrations.mcp.test": (args) => integrations.mcpTest(args),
    "integrations.plugin.install": (args) => integrations.pluginInstall(args),
    "integrations.plugin.uninstall": (args) => integrations.pluginUninstall(args),
    "integrations.plugin.setEnabled": (args) => integrations.pluginSetEnabled(args),
    "integrations.plugin.marketplaces": (args) => integrations.marketplaces(args),
    "integrations.skill.setEnabled": (args) => integrations.skillSetEnabled(args),
    "integrations.skill.create": (args) => integrations.skillCreate(args),
    "integrations.skill.open": (args) => integrations.skillOpen(args),
    "integrations.tools.setPolicy": (args) => integrations.setToolPolicy(args),
    "integrations.tools.removePolicy": (args) => integrations.removeToolPolicy(args),
    "integrations.refresh": (args) => integrations.refresh(args),
  };
}
