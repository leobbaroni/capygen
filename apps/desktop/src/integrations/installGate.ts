/**
 * The confirm gate for installing and uninstalling a Claude plugin
 * (SPEC R27, CLAUDE.md "never install anything silently").
 *
 * [review] `Settings ▸ Plugins` used to call `integrations.plugin.install`
 * straight from a button: `ClaudeConfigStore.installPlugin` then ran
 * `claude plugin install <id> --yes` with `windowsHide: true`, so third-party
 * code arrived on the machine with nothing ever shown to the user. The engine's
 * own comment claimed "the renderer's own dialog" satisfied R27; there was no
 * such dialog.
 *
 * It is gated here, in main, rather than in the renderer, for the same reason
 * `prereqs.run` is: a gate a compromised or merely buggy renderer can skip is
 * not a gate. These are pure functions deciding *what the dialog says*; the
 * dialog itself is `prereqs/electronDefaults.ts`'s `defaultConfirm`, the same
 * one the setup panel uses, so the two screens cannot drift apart.
 */
import type { ConfirmOptions } from "../prereqs/runGate.js";

export type PluginGateAction = "install" | "uninstall";

/** The exact `claude` command capygen is about to run, as the user will see it. */
export function pluginCommand(action: PluginGateAction, id: string): string {
  return action === "install" ? `claude plugin install ${id} --yes` : `claude plugin uninstall ${id}`;
}

/**
 * What the native confirm shows before a plugin is installed or removed.
 * Quotes the command verbatim (CLAUDE.md) and never claims anything has run.
 */
export function pluginConfirmOptions(action: PluginGateAction, id: string): ConfirmOptions {
  const verb = action === "install" ? "install" : "uninstall";
  return {
    title: action === "install" ? `Install the plugin "${id}"?` : `Uninstall the plugin "${id}"?`,
    message:
      action === "install"
        ? "capygen will run this command, which downloads and installs code written by " +
          "the plugin's author:"
        : "capygen will run this command:",
    detail:
      `${pluginCommand(action, id)}\n\n` +
      `Nothing is ${verb}ed until you click ${action === "install" ? "Install" : "Uninstall"}. ` +
      "Closing this dialog runs nothing.",
    buttons: [action === "install" ? "Install" : "Uninstall", "Cancel"],
    defaultId: 0,
    cancelId: 1,
  };
}

/** The message a refusal carries back to the settings page. */
export function pluginCancelled(action: PluginGateAction, id: string): string {
  return `\`${pluginCommand(action, id)}\` was not run — you cancelled the confirmation.`;
}
