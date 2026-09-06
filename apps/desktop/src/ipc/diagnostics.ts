/**
 * Settings ▸ Diagnostics — two channels (SPEC R19, R21).
 *
 * The setup panel's `prereqs.status` / `prereqs.run` are **not** here: they
 * live in `./prereqs.ts` with the confirm dialog and visible console that
 * SPEC R3 requires. Diagnostics only reads.
 */
import type { InvokeArgs, InvokeChannel, InvokeResult } from "@capygen/shared";
import type { DiagnosticsService } from "../integrations/DiagnosticsService.js";

export const DIAGNOSTICS_CHANNELS = [
  "diagnostics.get",
  "diagnostics.copy",
] as const satisfies readonly InvokeChannel[];

export type DiagnosticsChannel = (typeof DIAGNOSTICS_CHANNELS)[number];

export type DiagnosticsHandlers = {
  [C in DiagnosticsChannel]: (args: InvokeArgs<C>) => Promise<InvokeResult<C>> | InvokeResult<C>;
};

export function createDiagnosticsHandlers(
  diagnostics: DiagnosticsService,
): DiagnosticsHandlers {
  return {
    "diagnostics.get": () => diagnostics.get(),
    "diagnostics.copy": () => diagnostics.copy(),
  };
}
