/**
 * The Settings hub's three channels (SPEC R19, R30).
 *
 * Its own module for the same reason `workspace.ts` and `widgets.ts` are:
 * `handlers.ts` stays a thin, Electron-free map from channel to behaviour and
 * gains one registration line rather than a service.
 */
import type { InvokeArgs, InvokeChannel, InvokeResult } from "@capygen/shared";
import type { SettingsService } from "../integrations/SettingsService.js";

/** Listed rather than inferred, so a new settings channel fails here loudly. */
export const SETTINGS_HUB_CHANNELS = [
  "settings.getAll",
  "settings.patch",
  "settings.reset",
] as const satisfies readonly InvokeChannel[];

export type SettingsHubChannel = (typeof SETTINGS_HUB_CHANNELS)[number];

export type SettingsHubHandlers = {
  [C in SettingsHubChannel]: (args: InvokeArgs<C>) => Promise<InvokeResult<C>> | InvokeResult<C>;
};

export function createSettingsHubHandlers(settings: SettingsService): SettingsHubHandlers {
  return {
    "settings.getAll": () => settings.all(),
    "settings.patch": (args) => settings.patch(args.patch),
    "settings.reset": (args) => settings.reset(args.section),
  };
}
