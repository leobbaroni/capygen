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
import { AsyncLocalStorage } from "node:async_hooks";
import {
  BrowserWindow,
  Menu,
  clipboard,
  Tray,
  WebContentsView,
  app,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  webContents,
} from "electron";
import { openStore, type CapygenStore } from "@capygen/db";
import {
  DEV_URL_ENV,
  ENGINE_ENV,
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
import { isAppUrl } from "./win/navigation.js";
import { attach as attachChrome, windowOptions } from "./win/chrome.js";
import { createTrayIntegration, type TrayIntegration } from "./win/tray.js";
import {
  WINDOW_STATE_KEY,
  captureWindowState,
  clampToDisplays,
  parseWindowState,
} from "./win/windowState.js";
import { longPath, resolveInitialProjectDir } from "./win/projectArg.js";
import { createIpcContext, type IpcContext } from "./ipc/handlers.js";
import { createMcpPoolRegistry, type McpPoolRegistry } from "./ipc/mcpPools.js";
import { createSafeStorageSecretsStore } from "./ipc/secrets.js";
import { createHarnessLister } from "./ipc/harnessList.js";
import { createMcpPoolProbe } from "./integrations/probeMcpServer.js";
import {
  WIDGET_SCHEME,
  WIDGET_SCHEME_PRIVILEGES,
  createWidgetHost,
  type WidgetHostHandlers,
} from "./ipc/widgets.js";
import { createBrowserViewService } from "./workspace/BrowserViewService.js";
import { ECHO_DELAY_MS, createStubEngine } from "./engine/stub.js";
import type { EngineDeps } from "./engine/types.js";

/**
 * dist/ after bundling. esbuild emits CommonJS here (Electron's main entry is
 * `dist/main.cjs`), so `__dirname` is the portable way to reach the sibling
 * preload, the copied migrations and the tray icon.
 */
const HERE: string = __dirname;

const RENDERER_INDEX = path.join(HERE, "..", "..", "renderer", "dist", "index.html");
const PRELOAD = path.join(HERE, "preload.cjs");
const TRAY_ICON = path.join(HERE, "assets", "tray.png");
/** Window + taskbar icon. Only meaningful for `pnpm start` / e2e runs against
 *  the dev directory — a packaged build takes its icon from the executable
 *  resources electron-builder writes (Phase 12). */
const APP_ICON = path.join(HERE, "assets", "icon.png");

let store: CapygenStore | null = null;
let log: Logger;
let ipc: IpcContext | null = null;
let widgets: WidgetHostHandlers | null = null;
let mcpPools: McpPoolRegistry | null = null;
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

/**
 * MCP App widgets (SPEC R31) are served from their own privileged scheme so
 * each document carries the CSP its `ui://` resource declared. This must run
 * before `app.whenReady()`; `protocol.handle` is installed once the store is
 * open (`registerIpc`).
 */
protocol.registerSchemesAsPrivileged([WIDGET_SCHEME_PRIVILEGES]);

// ---------------------------------------------------------------------------
// windows
// ---------------------------------------------------------------------------

const shellWindows = new Set<BrowserWindow>();

/** The `webContents.id` of the renderer whose IPC call is currently running.
 *  Read only by the Browser pane's window resolution — see the
 *  `createBrowserViewService` call and the `ipcMain.handle` loop. */
const ipcSender = new AsyncLocalStorage<number>();

function isDark(): boolean {
  // Never let a theme read decide the app's fate: this runs from timers that
  // can outlive the database by a tick during shutdown, and `node:sqlite`
  // throws "database is not open" rather than returning nothing.
  let theme: string = "system";
  try {
    theme = store?.settings.all().theme ?? "system";
  } catch {
    /* store closed or mid-migration — fall back to the OS preference */
  }
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return nativeTheme.shouldUseDarkColors;
}

function rendererUrl(): { kind: "url" | "file"; value: string } {
  const devUrl = process.env[DEV_URL_ENV];
  if (devUrl) return { kind: "url", value: devUrl };
  return { kind: "file", value: RENDERER_INDEX };
}

/** Is this URL our own SPA? (`win/navigation.ts` holds the rule and its test.) */
function isRendererUrl(raw: string): boolean {
  return isAppUrl(raw, rendererUrl());
}

/**
 * Refuse any top-level navigation away from the SPA; open real links outside.
 *
 * Without this a plain link inside model or tool output — clicked in the main
 * frame — replaces the SPA with somebody else's page, and Electron re-runs the
 * preload against it, handing that page the whole typed IPC client outside the
 * renderer's own CSP.
 */
function guardNavigation(win: BrowserWindow): void {
  const deny = (event: { preventDefault: () => void }, url: string): void => {
    if (isRendererUrl(url)) return;
    event.preventDefault();
    log.warn(`[main] blocked in-window navigation to ${url}`);
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
  };
  win.webContents.on("will-navigate", (event, url) => deny(event, url));
  win.webContents.on("will-redirect", (event, url) => deny(event, url));
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
    ...(fs.existsSync(APP_ICON) ? { icon: APP_ICON } : {}),
    ...windowOptions(isDark()),
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      // The preload only uses `contextBridge`/`ipcRenderer`, both available in
      // a sandboxed preload, so there is no reason to give the renderer process
      // Node's full API surface.
      sandbox: true,
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
  guardNavigation(win);

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
  // The default engine is the real session runner (one Claude harness per
  // agent). `CAPYGEN_ENGINE=stub` swaps in the offline echo double so the e2e
  // walking-skeleton run is deterministic and spends no tokens.
  // `stub-roundtable` is the same echo double with `peerMentions` on: every
  // reply @mentions the next agent, so the *real* dispatcher's hop cap (SPEC
  // R11) can be proved end to end without spending a token
  // (`tests/e2e/roundtable.spec.ts`).
  const engineMode = process.env[ENGINE_ENV];
  const useStub = engineMode === "stub" || engineMode === "stub-roundtable";
  if (useStub) log.warn(`[engine] ${ENGINE_ENV}=${engineMode} — running the offline echo engine`);

  // One MCP client pool per distinct server list, shared between the widget
  // host and the `api` harness and closed when the last of them lets go
  // (SPEC R26 — they used to spawn every stdio server twice per session).
  mcpPools = createMcpPoolRegistry({
    log: {
      info: (...a) => log.info(...(a as [string])),
      warn: (...a) => log.warn(...(a as [string])),
      error: (...a) => log.error(...(a as [string])),
    },
  });

  // The widget host owns one bridge per project directory; it never
  // reads a resource for a session whose project we cannot name.
  widgets = createWidgetHost({
    pools: mcpPools,
    log: { info: (...a) => log.info(...(a as [string])), warn: (...a) => log.warn(...(a as [string])) },
    projectPathFor: (sessionId) => {
      const session = activeStore.sessions.get(sessionId);
      if (!session) return null;
      return activeStore.projects.get(session.projectId)?.path ?? null;
    },
    openExternal: (url) => shell.openExternal(url),
    saveFile: async (file) => {
      const owner = [...shellWindows][0];
      const result = await dialog.showSaveDialog(
        ...((owner ? [owner, { defaultPath: file.fileName }] : [{ defaultPath: file.fileName }]) as [
          Electron.BrowserWindow,
          Electron.SaveDialogOptions,
        ]),
      );
      if (result.canceled || !result.filePath) return false;
      const data =
        file.base64 !== undefined
          ? Buffer.from(file.base64, "base64")
          : Buffer.from(file.text ?? "", "utf8");
      fs.writeFileSync(result.filePath, data);
      log.info(`[widget] saved ${result.filePath} (${data.length} bytes)`);
      return true;
    },
  });

  protocol.handle(WIDGET_SCHEME, (request) => {
    const served = widgets?.serve(request.url) ?? null;
    if (!served) return new Response("widget not found", { status: 404 });
    return new Response(served.body, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": served.csp,
        // A widget document is per-block state, never a cacheable asset.
        "cache-control": "no-store",
      },
    });
  });

  // R21: keys live in their own small ciphertext file next to the database,
  // never in settings or logs — `secrets.ts` refuses to write plaintext if
  // OS-level encryption is unavailable rather than falling back to it. The
  // same store answers `harness.list`'s "is there a key?" question and, via
  // `handlers.ts`, feeds the api harness's `KeyProvider`.
  const secretsStore = createSafeStorageSecretsStore({
    safeStorage,
    filePath: path.join(app.getPath("userData"), "secrets.json"),
    log: { warn: (m) => log.warn(m) },
  });

  // [B1] The Browser pane (SPEC R16). A native `WebContentsView` positioned
  // over the renderer's placeholder — Omnigent's pattern, never a deprecated
  // `<webview>`. It is built here rather than in `workspace/` because it is
  // the one workspace service that needs Electron, and `handlers.ts` keeps
  // its no-Electron-import rule by taking it as an injected dependency.
  const browserViews = createBrowserViewService({
    // [C] The *calling* window, not "the first one still alive". Both windows
    // (the tray's "New Window", R2) share this one service, and React's
    // `useId` gives two identical component trees the same `viewId`, so a
    // window-agnostic lookup put window 2's Browser pane inside window 1.
    // `ipcSender` carries the in-flight event's sender id (see the
    // `ipcMain.handle` loop below); the fallback only matters for the calls
    // that do not originate from a renderer at all.
    window: () => {
      const senderId = ipcSender.getStore();
      const sender = senderId === undefined ? null : webContents.fromId(senderId);
      const owner = sender ? BrowserWindow.fromWebContents(sender) : null;
      if (owner && !owner.isDestroyed()) return owner;
      return [...shellWindows].find((win) => !win.isDestroyed()) ?? null;
    },
    WebContentsView,
    // Adapted, not passed through: `PartitionSessionLike` is the two calls the
    // service makes, without Electron's 40-member permission union.
    sessionFromPartition: (partition) => {
      const partitionSession = session.fromPartition(partition);
      return {
        setPermissionRequestHandler: (handler) =>
          partitionSession.setPermissionRequestHandler((contents, permission, callback) =>
            handler(contents, permission, callback),
          ),
        setPermissionCheckHandler: (handler) =>
          partitionSession.setPermissionCheckHandler(() => handler()),
      };
    },
    openExternal: (url) => void shell.openExternal(url),
    broadcast,
    log,
  });

  const context = createIpcContext({
    store: activeStore,
    broadcast,
    log,
    widgets,
    pools: mcpPools,
    browser: browserViews,
    ...(useStub
      ? {
          makeEngine: (engineDeps: EngineDeps) =>
            createStubEngine(engineDeps, ECHO_DELAY_MS, {
              peerMentions: engineMode === "stub-roundtable",
            }),
        }
      : {}),
    secrets: secretsStore,
    listHarnesses: createHarnessLister({
      defaultModel: () => activeStore.settings.all().defaultModel,
      // `has` only: whether a key exists decides availability, and the value
      // itself never leaves `secrets.get` for anything but the api harness.
      secrets: secretsStore,
    }),

    // [Phase 6] The Settings hub's OS-facing half (SPEC R19, R30). Each one is
    // a function rather than an Electron object so `SettingsService` — and its
    // tests — stay Electron-free.
    settingsPlatform: {
      applyTheme: (theme) => {
        // `nativeTheme.themeSource` is what makes Chromium's own widgets (the
        // scrollbars, a <select> popup, the caption buttons' hover) follow the
        // choice; `isDark()` then reads the stored value back for the window
        // background, which is why the projection onto the flat row matters.
        nativeTheme.themeSource = theme;
        for (const win of shellWindows) {
          if (!win.isDestroyed()) win.setBackgroundColor(isDark() ? "#0e1013" : "#ffffff");
        }
      },
      setStartWithWindows: (enabled) => {
        // Windows' Run key, via Electron. `openAsHidden` is deliberately off:
        // a window that appears is what a person expects from "start with
        // Windows", and the tray (R2) is where it goes when they close it.
        app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath });
        log.info(`[settings] start with Windows: ${enabled ? "on" : "off"}`);
      },
      applyCloseToTray: (enabled) => log.info(`[settings] close to tray: ${enabled ? "on" : "off"}`),
      applyNotifications: (notifications) =>
        log.info(`[settings] notifications: ${notifications.enabled ? "on" : "off"}`),
    },

    // [Phase 6] The config-sync engine (SPEC R28-R30). Only the two pieces it
    // cannot build itself: the shared MCP pool for `integrations.mcp.test`
    // (R26 — a Test button must not spawn a second copy of a server a session
    // already has open) and the OS "reveal this file" for a skill.
    integrations: {
      probeMcpServer: createMcpPoolProbe(mcpPools),
      openPath: async (target) => {
        const error = await shell.openPath(target);
        if (error) throw new Error(`could not open ${target}: ${error}`);
      },
    },

    // [Phase 6] Diagnostics (SPEC R19, R21). `writeClipboard` is the only
    // reason this page needs Electron at all, and everything that reaches it
    // has been through `redact` first.
    diagnostics: {
      writeClipboard: (text) => clipboard.writeText(text),
      fileSize: (file) => {
        try {
          return fs.statSync(file).size;
        } catch {
          return 0;
        }
      },
    },
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
      const picked = result.filePaths[0];
      // The dialog returns long paths, but a shortcut target or a junction can
      // still hand back an 8.3 name, and Codex's Windows sandbox refuses those
      // (see `longPath`). Normalising here means every project row is long.
      return picked ? longPath(picked) : null;
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
    ipcMain.handle(channel, async (event, raw: unknown) => {
      try {
        // Defence in depth behind `guardNavigation`: only a frame showing our
        // own SPA may drive these channels.
        const sender = event.senderFrame;
        if (sender && !isRendererUrl(sender.url)) {
          throw new Error(`capygen: ${channel} refused for ${sender.url}`);
        }
        const args = parseInvokeArgs(channel, raw);
        const handler = context.handlers[channel] as (a: unknown) => unknown;
        // [C] The handler map is deliberately Electron-free and takes only
        // `args` — but the Browser pane's five channels have to know *which
        // window* asked, or a second window drives the first one's native
        // view. `AsyncLocalStorage` carries the sender for the duration of
        // the call (awaits included) without putting Electron's event into
        // the contract; `BrowserViewDeps.window` above is its only reader.
        const result = await ipcSender.run(event.sender.id, () => handler(args));
        return parseInvokeResult(channel as InvokeChannel, result);
      } catch (err) {
        // Fail loudly with the real text (SPEC §Edge Cases: never swallow).
        log.error(`[ipc] ${channel} failed`, err);
        throw err;
      }
    });
  }
  log.info(`[ipc] ${INVOKE_CHANNEL_NAMES.length} channels registered`);

  // [Phase 6] Push the stored settings at the OS before the first window
  // paints (theme, run-at-login), then start the config watchers (SPEC R29:
  // a change made outside the app is reflected on next open). Both are
  // deliberately *after* the channels are registered and neither is awaited:
  // chokidar's first scan must not sit between launch and the landing page
  // (G1's 3 s budget).
  context.settings.applyOnStart();
  void context.integrations.start().catch((err: unknown) => {
    log.warn("[integrations] could not start the config watchers", err);
  });

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
  if (store.reconciled.turns > 0 || store.reconciled.sessions > 0) {
    log.warn(
      `[db] closed ${store.reconciled.turns} turn(s) and ${store.reconciled.sessions} session(s)` +
        " left in flight by the previous run",
    );
  }

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

/**
 * Shutdown has to wait for the engine.
 *
 * Disposing a harness only *queues* the turn's final `interrupted` event; the
 * runner writes it a microtask later. Closing SQLite in the same tick — which
 * a synchronous `will-quit` handler does — makes that write throw, and the
 * turn stays `streaming` in the database forever. So the first `will-quit`
 * defers the quit, drains the engine, and only then closes the store and quits
 * for real.
 */
let shuttingDown = false;

app.on("will-quit", (event) => {
  if (shuttingDown) return;
  shuttingDown = true;
  event.preventDefault();
  void (async () => {
    try {
      await widgets?.dispose();
    } catch (err) {
      log?.error("[main] widget host shutdown error", err);
    }
    try {
      await ipc?.dispose();
    } catch (err) {
      log?.error("[main] engine shutdown error", err);
    }
    try {
      // After both holders have let go; anything still open is closed here.
      await mcpPools?.closeAll();
    } catch (err) {
      log?.error("[main] MCP pool shutdown error", err);
    }
    try {
      tray?.destroy();
      store?.close();
      // Nulled, not just closed: anything still holding a timer (the caption
      // blend, geometry persistence) reads `store?.` and must find nothing
      // rather than a closed handle that throws.
      store = null;
      log?.info("[main] shut down cleanly");
    } catch (err) {
      log?.error("[main] shutdown error", err);
    }
    // `exit`, not `quit`: the quit we deferred above was cancelled, and asking
    // for another one only re-runs this sequence. Everything a clean quit does
    // — engine drained, tray gone, database closed — has already happened.
    app.exit(0);
  })();
});
