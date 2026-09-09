import path from "node:path";
import { app } from "electron";
import { NsisUpdater, type ProgressInfo } from "electron-updater";
import type { DownloadUpdateOptions } from "electron-updater/out/AppUpdater.js";
import type { AppAdapter } from "electron-updater/out/AppAdapter.js";
import type { UpdateDriver } from "./UpdateService.js";

/** Pinned 6.8.9 hook: retain its authenticated transport and checksum validation for both EXEs. */
class CapygenUpdater extends NsisUpdater {
  protected override readonly app: AppAdapter;
  constructor(adapter: AppAdapter) {
    // Passing an adapter to super is electron-updater's test seam: it disables
    // the HTTP executor. Initialize the real Electron transport first, then
    // retain our contained cache and explicit-install app adapter.
    super(null);
    this.app = adapter;
  }
  portable = false;
  protected override doDownloadUpdate(options: DownloadUpdateOptions): Promise<string[]> {
    const info = options.updateInfoAndProvider.info;
    const name = `capygen-${info.version}-${this.portable ? "portable" : "setup"}.exe`;
    const files = info.files.filter((file) => path.posix.basename(file.url) === name);
    if (files.length !== 1) return Promise.reject(new Error("Required update artifact missing"));
    return super.doDownloadUpdate({ ...options, disableWebInstaller: true, disableDifferentialDownload: true,
      updateInfoAndProvider: { ...options.updateInfoAndProvider, info: { ...info, files } } });
  }
}
export function createPrivateUpdateDriver(input: { root: string; token: string; portable: boolean; progress(transferred: number, percent: number): void }): UpdateDriver {
  const updater = new CapygenUpdater({
    version: app.getVersion(), name: "capygen", isPackaged: app.isPackaged,
    appUpdateConfigPath: path.join(process.resourcesPath, "app-update.yml"),
    userDataPath: app.getPath("userData"), baseCachePath: path.join(input.root, "cache"),
    whenReady: async () => { await app.whenReady(); }, relaunch: () => {}, quit: () => {}, onQuit: () => {},
  });
  updater.portable = input.portable;
  updater.autoDownload = false; updater.autoInstallOnAppQuit = false; updater.autoRunAppAfterInstall = false;
  updater.allowDowngrade = false; updater.allowPrerelease = false;
  updater.disableDifferentialDownload = true; updater.disableWebInstaller = true;
  updater.logger = { info() {}, warn() {}, error() {}, debug() {} };
  updater.on("error", () => {}); // Errors are sanitized by UpdateService, never logged with HTTP headers.
  updater.on("download-progress", (event: ProgressInfo) => input.progress(event.transferred, event.percent));
  // In 6.8.9 private:true prefers inherited GH_TOKEN over options.token. An explicit
  // token with the flag omitted selects the same PrivateGitHubProvider without that fallback.
  updater.setFeedURL({ provider: "github", owner: "leobbaroni", repo: "capygen", token: input.token });
  return { checkForUpdates: () => updater.checkForUpdates(), downloadUpdate: (cancel) => updater.downloadUpdate(cancel),
    dispose: () => { updater.removeAllListeners(); updater.on("error", () => {}); } };
}
