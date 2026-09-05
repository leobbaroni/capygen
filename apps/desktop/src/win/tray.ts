/**
 * Tray + close-to-tray, ported from Omnigent-windows/app/src/win/integration.js
 * down to what R2 asks for: Open / New Window / Quit, and closing the last
 * window hides to the tray so running agents keep running.
 *
 * All Electron objects are injected so the decision logic is unit-testable with
 * fakes (and so this module has no import-time Electron dependency).
 */
import type { BrowserWindow, MenuItemConstructorOptions } from "electron";

export interface TrayDeps {
  Tray: typeof import("electron").Tray;
  Menu: typeof import("electron").Menu;
  nativeImage: typeof import("electron").nativeImage;
  shell: typeof import("electron").shell;
  iconPath: string;
  logDir: string;
  /** Show and focus an existing window, creating one when none is left. */
  reveal: () => void;
  createWindow: () => void;
  quit: () => void;
  log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
  /** User setting; false makes closing the last window quit the app. */
  closeToTray: () => boolean;
}

export interface TrayIntegration {
  create(): void;
  destroy(): void;
  /** Install the close-to-tray handler on a new window. */
  onWindowCreated(win: BrowserWindow): void;
  /** `window-all-closed` verdict. */
  shouldQuitOnAllClosed(): boolean;
  /** Called from `before-quit`, so window close handlers let the quit through. */
  markQuitting(): void;
  menuTemplate(): MenuItemConstructorOptions[];
  readonly hasTray: boolean;
}

export function createTrayIntegration(deps: TrayDeps): TrayIntegration {
  let tray: import("electron").Tray | null = null;
  let quitting = false;
  let hintShown = false;

  function menuTemplate(): MenuItemConstructorOptions[] {
    return [
      { label: "Open capygen", click: () => deps.reveal() },
      { label: "New Window", click: () => deps.createWindow() },
      { type: "separator" },
      { label: "Open Log Folder", click: () => void deps.shell.openPath(deps.logDir) },
      { type: "separator" },
      { label: "Quit capygen", click: () => integration.quitNow() },
    ];
  }

  function showHintOnce(): void {
    if (hintShown || !tray) return;
    hintShown = true;
    try {
      tray.displayBalloon({
        title: "capygen is still running",
        content: "Agents keep running in the background. Use the tray icon to open or quit.",
        iconType: "info",
      });
    } catch (err) {
      deps.log.warn("[win] tray balloon failed", err);
    }
  }

  const integration = {
    get hasTray() {
      return tray !== null;
    },
    menuTemplate,
    quitNow(): void {
      quitting = true;
      deps.quit();
    },
    markQuitting(): void {
      quitting = true;
    },
    create(): void {
      if (tray) return;
      try {
        const image = deps.nativeImage.createFromPath(deps.iconPath);
        const icon = image.isEmpty() ? deps.iconPath : image.resize({ width: 16, height: 16 });
        tray = new deps.Tray(icon);
        tray.setToolTip("capygen");
        tray.on("click", () => deps.reveal());
        tray.on("double-click", () => deps.reveal());
        tray.setContextMenu(deps.Menu.buildFromTemplate(menuTemplate()));
        deps.log.info("[win] tray created");
      } catch (err) {
        tray = null;
        deps.log.warn("[win] tray unavailable; falling back to quit-on-last-window", err);
      }
    },
    destroy(): void {
      try {
        tray?.destroy();
      } catch {
        /* already gone */
      }
      tray = null;
    },
    onWindowCreated(win: BrowserWindow): void {
      win.on("close", (event) => {
        if (quitting || !tray || !deps.closeToTray()) return;
        event.preventDefault();
        win.hide();
        showHintOnce();
      });
    },
    shouldQuitOnAllClosed(): boolean {
      return quitting || tray === null || !deps.closeToTray();
    },
  };

  return integration;
}
