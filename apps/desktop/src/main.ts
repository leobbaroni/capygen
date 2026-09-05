/**
 * capygen — Electron main process.
 *
 * Responsibilities, in start-up order:
 *   1. single-instance lock (a second launch focuses the running window),
 *   2. rotating redacting logger in %APPDATA%\capygen\logs,
 *   3. SQLite open + migrations at %APPDATA%\capygen\capygen.db,
 *   4. seamless window (hidden title bar + blended caption buttons), restored
 *      to its last geometry,
 *   5. tray with Open / New Window / Quit, and close-to-tray,
 *   6. the typed IPC handlers.
 *
 * The renderer is loaded from CAPYGEN_DEV_URL when set (pnpm dev), otherwise
 * from the built apps/renderer/dist/index.html next to this bundle.
 */
import path from "node:path";
import fs from "node:fs";
import {
  BrowserWindow,
  Menu,
  Tray,
  app,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  screen,
  shell,
} from "electron";
import { openStore, type CapygenStore } from "@capygen/db";
import {
  DEV_URL_ENV,
  INVOKE_CHANNEL_NAMES,
  LOG_DIR_NAME,
  LOG_FILE_NAME,
  DB_FILE_NAME,
  USER_DATA_ENV,
  parseInvokeArgs,
  parseInvokeResult,
  parseEventPayload,
  type EventChannel,
  type EventInput,
  type InvokeChannel,
} from "@capygen/shared";
import { createLogger, type Logger } from "./win/logger.js";
import { attach as attachChrome, windowOptions } from "./win/chrome.js";
import { createTrayIntegration, type TrayIntegration } from "./win/tray.js";
import {
  WINDOW_STATE_KEY,
  captureWindowState,
  clampToDisplays,
  parseWindowState,
} from "./win/windowState.js";
import { resolveInitialProjectDir } from "./win/projectArg.js";
import { createIpcContext, type IpcContext } from "./ipc/handlers.js";

/**
 * dist/ after bundling. esbuild emits CommonJS here (Electron's main entry is
 * `dist/main.cjs`), so `__dirname` is the portable way to reach the sibling
 * preload, the copied migrations and the tray icon.
 */
const HERE: string = __dirname;

const RENDERER_INDEX = path.join(HERE, "..", "..", "renderer", "dist", "index.html");
const PRELOAD = path.join(HERE, "preload.cjs");
const TRAY_ICON = path.join(HERE, "assets", "tray.png");

let store: CapygenStore | null = null;
let log: Logger;
let ipc: IpcContext | null = null;
let tray: TrayIntegration | null = null;

// ---------------------------------------------------------------------------
// single instance
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// An isolated user-data dir keeps e2e runs from touching the real profile.
const userDataOverride = process.env[USER_DATA_ENV];
if (userDataOverride) {
  fs.mkdirSync(userDataOverride, { recursive: true });
  app.setPath("userData", userDataOverride);
}
app.setName("capygen");

// ---------------------------------------------------------------------------
// windows
// ---------------------------------------------------------------------------

const shellWindows = new Set<BrowserWindow>();

function isDark(): boolean {
  const theme = store?.settings.all().theme ?? "system";
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return nativeTheme.shouldUseDarkColors;
}

function rendererUrl(): { kind: "url" | "file"; value: string } {
  const devUrl = process.env[DEV_URL_ENV];
  if (devUrl) return { kind: "url", value: devUrl };
  return { kind: "file", value: RENDERER_INDEX };
}

function createWindow(): BrowserWindow {
  const saved = clampToDisplays(
    parseWindowState(store?.settings.getRaw(WINDOW_STATE_KEY, null) ?? null),
    screen.getAllDisplays().map((d) => d.workArea),
  );

  const win = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    ...(saved.x !== undefined && saved.y !== undefined ? { x: saved.x, y: saved.y } : {}),
    minWidth: 860,
    minHeight: 560,
    show: false,
    backgroundColor: isDark() ? "#0e1013" : "#ffffff",
    ...windowOptions(isDark()),
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  if (saved.maximized) win.maximize();
  shellWindows.add(win);
  attachChrome(win, { isDark, log: (m) => log.info(m) });
  tray?.onWindowCreated(win);

  win.once("ready-to-show", () => win.show());

  const persistGeometry = (): void => {
    const state = captureWindowState(win);
    if (state) store?.settings.setRaw(WINDOW_STATE_KEY, state);
  };
  win.on("resize", persistGeometry);
  win.on("move", persistGeometry);
  win.on("close", persistGeometry);
  win.on("closed", () => shellWindows.delete(win));

  // External links open in the user's browser, never inside the shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  const target = rendererUrl();
  log.info(`[main] loading renderer from ${target.kind}: ${target.value}`);
  if (target.kind === "url") void win.loadURL(target.value);
  else void win.loadFile(target.value);

  return win;
}

function revealWindow(): void {
  const win = [...shellWindows][0];
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (!win.isVisible()) win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function broadcast<E extends EventChannel>(event: E, payload: EventInput<E>): void {
  const parsed = parseEventPayload(event, payload);
  for (const win of shellWindows) {
    if (win.isDestroyed()) continue;
    win.webContents.send(event, parsed);
  }
}

function registerIpc(activeStore: CapygenStore): IpcContext {
  const context = createIpcContext({
    store: activeStore,
    broadcast,
    log,
    pickDirectory: async () => {
      const owner = [...shellWindows][0];
      const result = await (owner
        ? dialog.showOpenDialog(owner, {
            title: "Choose a project folder",
            properties: ["openDirectory", "createDirectory"],
          })
        : dialog.showOpenDialog({
            title: "Choose a project folder",
            properties: ["openDirectory", "createDirectory"],
          }));
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0] ?? null;
    },
    appInfo: () => ({
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron ?? "",
      chrome: process.versions.chrome ?? "",
      node: process.versions.node,
      platform: process.platform,
      userDataDir: app.getPath("userData"),
      logFile: log.file,
      dbFile: activeStore.db.file,
    }),
  });

  for (const channel of INVOKE_CHANNEL_NAMES) {
    ipcMain.handle(channel, async (_event, raw: unknown) => {
      try {
        const args = parseInvokeArgs(channel, raw);
        const handler = context.handlers[channel] as (a: unknown) => unknown;
        const result = await handler(args);
        return parseInvokeResult(channel as InvokeChannel, result);
      } catch (err) {
        // Fail loudly with the real text (SPEC §Edge Cases: never swallow).
        log.error(`[ipc] ${channel} failed`, err);
        throw err;
      }
    });
  }
  log.info(`[ipc] ${INVOKE_CHANNEL_NAMES.length} channels registered`);
  return context;
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

app.on("second-instance", () => revealWindow());

app.whenReady().then(() => {
  const userData = app.getPath("userData");
  log = createLogger({ dir: path.join(userData, LOG_DIR_NAME), fileName: LOG_FILE_NAME });
  log.captureConsole();
  log.captureProcessErrors();
  log.info(`[main] capygen ${app.getVersion()} starting; userData=${userData}`);

  const dbFile = path.join(userData, DB_FILE_NAME);
  store = openStore(dbFile, {
    migrationsDir: path.join(HERE, "migrations"),
    onBackup: (file) => log.info(`[db] pre-migration backup written: ${file}`),
    onMigrate: (applied) => log.info(`[db] migrations applied: ${applied.join(", ")}`),
  });
  log.info(`[db] open at ${dbFile}`);

  // `--project=<dir>` / CAPYGEN_PROJECT_DIR pre-selects a folder so the landing
  // page can start a session without opening the picker. Never implicit: with
  // neither set the user chooses a folder before the first turn runs.
  const initialProject = resolveInitialProjectDir();
  if (initialProject) {
    const project = store.projects.upsertByPath({ path: initialProject });
    store.projects.touch(project.id);
    log.info(`[main] initial project ${project.path}`);
  }

  ipc = registerIpc(store);

  tray = createTrayIntegration({
    Tray,
    Menu,
    nativeImage,
    shell,
    iconPath: TRAY_ICON,
    logDir: path.join(userData, LOG_DIR_NAME),
    reveal: revealWindow,
    createWindow: () => createWindow(),
    quit: () => app.quit(),
    log,
    closeToTray: () => store?.settings.all().closeToTray ?? true,
  });
  tray.create();

  createWindow();

  nativeTheme.on("updated", () => {
    for (const win of shellWindows) {
      if (!win.isDestroyed()) win.setBackgroundColor(isDark() ? "#0e1013" : "#ffffff");
    }
  });

  app.on("activate", () => {
    if (shellWindows.size === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // R2: keep running in the tray so agents keep running.
  if (tray?.shouldQuitOnAllClosed() ?? true) app.quit();
});

app.on("before-quit", () => {
  tray?.markQuitting();
});

app.on("will-quit", () => {
  try {
    ipc?.dispose();
    tray?.destroy();
    store?.close();
    log?.info("[main] shut down cleanly");
  } catch (err) {
    log?.error("[main] shutdown error", err);
  }
});
