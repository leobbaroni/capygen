/**
 * The two Electron-shaped pieces of the run gate: a native confirm dialog and
 * a visible, detached PowerShell window (SPEC R3/R27).
 *
 * `electron` is loaded with a runtime `import()` **inside** the functions
 * below, never as a top-level import — the same rule `ClaudeHarness` follows
 * for its ESM-only SDK (COMPAT.md: "loaded with a runtime `import()`") and
 * the reason `tray.ts`/`windowState.ts` type-import Electron and take the
 * real objects as injected deps instead: a static `import` of "electron"
 * would be evaluated at module load time, which breaks under vitest (no
 * Electron runtime in the test process) even though nothing here is ever
 * called from a test — every test injects a fake `confirm`/`openConsole`
 * instead of reaching this file at all.
 *
 * `openConsole` needs no such deferral: `spawn` is `node:child_process`, not
 * Electron, and it is `electron` that is external to the esbuild bundle
 * (`apps/desktop/scripts/build.ts`) — so it resolves at runtime in the
 * packaged app exactly the way it does here.
 */
import { spawn } from "node:child_process";
import { cleanEnv } from "@capygen/engine";
import type { ConfirmOptions, ConsoleArgv } from "./runGate.js";

/**
 * Shows `dialog.showMessageBox` and resolves `true` only for the "Run"
 * button (`options.defaultId`) — Cancel, the window's close box, and Escape
 * all resolve `false`, matching Electron's own `cancelId` semantics.
 */
export async function defaultConfirm(options: ConfirmOptions): Promise<boolean> {
  const { dialog } = await import("electron");
  const result = await dialog.showMessageBox({
    type: "question",
    title: options.title,
    message: options.message,
    detail: options.detail,
    buttons: options.buttons,
    defaultId: options.defaultId,
    cancelId: options.cancelId,
    noLink: true,
  });
  return result.response === options.defaultId;
}

/**
 * Detached so the console outlives this process and is never a child capygen
 * would tear down at quit (ported from Omnigent-windows'
 * `app/src/win/bootstrap.js` `runInConsole`); `windowsHide: false` is the
 * whole point — CLAUDE.md requires the console be visible.
 */
export function defaultOpenConsole(argv: ConsoleArgv): Promise<{ pid?: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv.file, argv.args, { detached: true, stdio: "ignore", windowsHide: false, env: cleanEnv() });
    child.once("error", () => reject(new Error("Could not open the setup console. Check that Windows PowerShell is available.")));
    child.once("spawn", () => {
      child.unref();
      resolve({ pid: child.pid });
    });
  });
}
