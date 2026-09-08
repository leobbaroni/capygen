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
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  BrowserWindow,
  Menu,
  Notification,
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
  utilityProcess,
  webContents,
} from "electron";
import { cleanEnv } from "@capygen/engine";
import { openStore, type CapygenStore } from "@capygen/db";
import {
  newId,
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
import { applyConfigHomes } from "./win/configHomes.js";
import { createNotifier, type Notifier } from "./win/notify.js";
import { createIpcContext, type IpcContext } from "./ipc/handlers.js";
import { createMcpPoolRegistry, type McpPoolRegistry } from "./ipc/mcpPools.js";
import { createSafeStorageSecretsStore } from "./ipc/secrets.js";
import { cachedCliProbe, createHarnessLister } from "./ipc/harnessList.js";
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
import { createElectronImportWorkerClient } from "./imports/electronUtilityWorker.js";
import type { ImportWorkerClient } from "./imports/utilityWorker.js";
import { ImportStagingService } from "./imports/staging.js";
import {
  createPolicyRuntime,
  createPermissionCardPublisher,
  type PolicyRuntime,
} from "./policies/runtime.js";
import { ShareWorkerClient } from "./sharing/workerClient.js";
import { ShareStagingService } from "./sharing/staging.js";
import type { ShareStagingMeta } from "./ipc/sharing.js";

/**
 * dist/ after bundling. esbuild emits CommonJS here (Electron's main entry is
 * `dist/main.cjs`), so `__dirname` is the portable way to reach the sibling
 * preload, the copied migrations and the tray icon.
 */
import { createExtensionIntegration } from "./extensions/integration.js";
import { registerExtensionScheme } from "./extensions/host.js";
import { UpdateService } from "./updates/UpdateService.js";
import { createPrivateUpdateDriver } from "./updates/driver.js";
import { createUpdateHandlers } from "./ipc/updates.js";
import { consoleArgv } from "./prereqs/runGate.js";
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
let extensions: ReturnType<typeof createExtensionIntegration> | null = null;
let updates: UpdateService | null = null;
let updateTimer: ReturnType<typeof setInterval> | null = null;
let launchUpdateTimer: ReturnType<typeof setTimeout> | null = null;
let widgets: WidgetHostHandlers | null = null;
let mcpPools: McpPoolRegistry | null = null;
let tray: TrayIntegration | null = null;
let notifier: Notifier | null = null;
let importWorker: ImportWorkerClient | null = null;
let importStaging: ImportStagingService | null = null;
let policyRuntime: PolicyRuntime | null = null;
let shareWorker: ShareWorkerClient | null = null;
let shareStaging: ShareStagingService<ShareStagingMeta> | null = null;
let shareSweep: ReturnType<typeof setInterval> | null = null;

function disposePolicy(): void {
  policyRuntime?.dispose();
  policyRuntime = null;
}

async function disposeSharing(): Promise<void> {
  if (shareSweep) clearInterval(shareSweep);
  shareSweep = null;
  // Stop the process before waiting on release acknowledgements during quit.
  shareWorker?.dispose();
  await shareStaging?.dispose();
}

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
// Windows shows a toast under the *AppUserModelID*, not the process name; an
// unset one makes `new Notification(...)` silently do nothing on Windows 10.
app.setAppUserModelId("com.capygen.app");

/**
 * [Phase 6/C] Point every backend at an isolated config home when asked to
 * (`CAPYGEN_CLAUDE_CONFIG_DIR` → `CLAUDE_CONFIG_DIR`, `CAPYGEN_CODEX_HOME` →
 * `CODEX_HOME`). This must happen **before** anything reads `process.env`:
 * `resolveBackendHomes()` and `cleanEnv()` both copy it, and the second is
 * what every harness child, `claude` CLI spawn and MCP stdio server inherits.
 * See `win/configHomes.ts` for why the seam is capygen-namespaced rather than
 * the backends' own variable names.
 */
const configHomes = applyConfigHomes(process.env);

/**
 * MCP App widgets (SPEC R31) are served from their own privileged scheme so
 * each document carries the CSP its `ui://` resource declared. This must run
 * before `app.whenReady()`; `protocol.handle` is installed once the store is
 * open (`registerIpc`).
 */
registerExtensionScheme([WIDGET_SCHEME_PRIVILEGES]);

// ---------------------------------------------------------------------------
// windows
// ---------------------------------------------------------------------------

const shellWindows = new Set<BrowserWindow>();

/** What the notifier reads when the settings hub cannot be asked (shutdown,
 *  a store that threw): silence, never a guessed "on". */
const DEFAULT_NOTIFICATIONS_OFF = {
  enabled: false,
  onFinish: false,
  onNeedsInput: false,
  onRunnerDisconnect: false,
} as const;

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
  const importOwnerId = win.webContents.id;
  win.on("closed", () => {
    shellWindows.delete(win);
    void importStaging?.releaseWindow(importOwnerId);
    void shareStaging?.releaseWindow(importOwnerId).catch(() => {
      log.warn("[sharing] window cleanup failed");
    });
  });

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
  // [Phase 6/C] The desktop-notification tap (SPEC R19's `notifications`).
  // After the sends, and inside its own try: a toast must never be able to
  // stop an event reaching the UI.
  try {
    if (event !== "chat.turnStatus" || store?.turns.get((parsed as { turnId: string }).turnId)?.role === "agent") {
      notifier?.handle(event, parsed);
    }
  } catch (err) {
    log?.warn(`[notify] handler threw for ${event}`, err);
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
    // Fails closed: the widget host outlives no policy runtime in practice,
    // but a call that cannot be evaluated is a call that must not run.
    authorizeWidgetCall: async (request) =>
      policyRuntime
        ? policyRuntime.widgets.authorizeWidgetCall(request)
        : { allowed: false, message: "capygen's local policy is not available." },
    onConnectionEnded: (token) => policyRuntime?.widgets.onConnectionEnded(token),
    // The block row carries its turn; nothing here parses an id to find one.
    turnOfBlock: (blockId) => store?.blocks.get(blockId)?.turnId ?? null,
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

  // One CLI-version probe for every page that asks (see its doc comment).
  const sharedCliProbe = cachedCliProbe();

  // One lister for the whole process: `harness.list` awaits it, and the
  // model-resolution paths read its `snapshot()` synchronously.
  const harnessLister = createHarnessLister({
    defaultModel: () => activeStore.settings.all().defaultModel,
    // The `api` default model comes from the provider the settings select.
    apiProvider: () => activeStore.globalSettings.all().backends.api.provider ?? null,
    // `has` only: whether a key exists decides availability, and the value
    // itself never leaves `secrets.get` for anything but the api harness.
    secrets: secretsStore,
    // [review] One shared, TTL-cached CLI probe for the whole process. The
    // Harnesses page and Settings ▸ Diagnostics ask the same CLIs the same
    // `--version` question; before this they spawned a child process each,
    // and diagnostics re-spawned on every `diagnostics.get`.
    probe: sharedCliProbe,
  });

  extensions = createExtensionIntegration({ store: activeStore, profileDirectory: app.getPath("userData"), window: () => {
    const senderId = ipcSender.getStore();
    const sender = senderId === undefined ? null : webContents.fromId(senderId);
    return sender ? BrowserWindow.fromWebContents(sender) : null;
  } });
  const updateRoot = path.join(app.getPath("userData"), "updates");
  const updateOwner = () => { const id = ipcSender.getStore(); const contents = id === undefined ? null : webContents.fromId(id); return contents ? BrowserWindow.fromWebContents(contents) : null; };
  updates = new UpdateService({ root: updateRoot, currentVersion: app.getVersion(), packaged: app.isPackaged,
    portable: !!process.env.PORTABLE_EXECUTABLE_FILE, secrets: secretsStore, processId: process.pid,
    driver: (token, progress) => createPrivateUpdateDriver({ root: updateRoot, token, portable: !!process.env.PORTABLE_EXECUTABLE_FILE, progress }),
    changed: (status) => broadcast("updates.changed", status),
    idle: () => activeStore.sessions.list().every((row) => row.status !== "running" && row.status !== "waiting" && context.engine.isSessionQuiescent?.(row.id) !== false),
    confirmInstall: async (command) => {
      const owner = updateOwner(); if (!owner) return false;
      const result = await dialog.showMessageBox(owner, { type: "question", title: "Install verified update?", message: "capygen will close, then run this command in a visible PowerShell window.",
        detail: `${command}\n\nThis is an unsigned build. Its checksum was verified, but no publisher signature is claimed. Nothing runs if you cancel.`, buttons: ["Cancel", "Install update"], defaultId: 0, cancelId: 0 });
      return result.response === 1 && !owner.isDestroyed();
    },
    launchInstall: (command) => new Promise<void>((resolve, reject) => {
      const launch = consoleArgv(command);
      const env: Record<string, string> = {};
      const allowed = new Set(["systemroot", "systemdrive", "windir", "comspec", "path", "pathext", "userprofile", "appdata", "localappdata", "temp", "tmp", "username"]);
      for (const [key, value] of Object.entries(process.env)) if (value && allowed.has(key.toLowerCase())) env[key] = value;
      // The confirmed command must not also execute a user's PowerShell profile.
      const child = spawn(launch.file, ["-NoProfile", ...launch.args], { detached: true, windowsHide: false, stdio: "ignore", env: cleanEnv(env) });
      child.once("error", () => reject(new Error("Visible installer console could not start")));
      child.once("spawn", () => { child.unref(); resolve(); });
    }), quit: () => app.quit(),
    savePortable: async (source, name, expected) => {
      const owner = updateOwner(); if (!owner) return false;
      const selected = await dialog.showSaveDialog(owner, { title: "Save portable replacement", defaultPath: path.join(app.getPath("downloads"), name), filters: [{ name: "Windows application", extensions: ["exe"] }] });
      if (selected.canceled || !selected.filePath || owner.isDestroyed()) return false;
      const temporary = path.join(path.dirname(selected.filePath), `.capygen-${randomUUID()}.tmp`);
      try {
        await fs.promises.copyFile(source, temporary, fs.constants.COPYFILE_EXCL);
        let size = 0; const hash = createHash("sha512");
        for await (const chunk of fs.createReadStream(temporary)) { size += chunk.length; if (size > expected.size) throw new Error("Portable copy size changed"); hash.update(chunk); }
        if (size !== expected.size || hash.digest("base64") !== expected.sha512) throw new Error("Portable copy checksum failed");
        await fs.promises.rename(temporary, selected.filePath); return true;
      } finally { await fs.promises.unlink(temporary).catch(() => {}); }
    },
  });
  const context = createIpcContext({
    extensions: extensions.handlers,
    updates: createUpdateHandlers(updates),
    store: activeStore,
    workspace: {
      worktrees: {
        pickDestination: async ({ sourceProjectId, branch }) => {
          const sender = ipcSender.getStore();
          const owner = [...shellWindows].find((win) => !win.isDestroyed() && win.webContents.id === sender);
          if (!owner) throw new Error("the worktree window was closed");
          const source = activeStore.projects.get(sourceProjectId);
          if (!source) throw new Error("unknown source project");
          const result = await dialog.showSaveDialog(owner, {
            title: `Create worktree for ${branch.name}`,
            buttonLabel: "Create worktree here",
            defaultPath: path.join(path.dirname(source.path), path.basename(branch.name)),
            properties: ["createDirectory", "showOverwriteConfirmation"],
          });
          if (owner.isDestroyed()) throw new Error("the worktree window was closed");
          return result.canceled ? null : result.filePath ?? null;
        },
        confirmRemoval: async (risk) => {
          const sender = ipcSender.getStore();
          const owner = [...shellWindows].find((win) => !win.isDestroyed() && win.webContents.id === sender);
          if (!owner) return false;
          const result = await dialog.showMessageBox(owner, {
            type: "warning",
            title: "Remove worktree and its files?",
            message: `Remove ${risk.path}?`,
            detail: "This directory contains modified, untracked, or ignored files. Removing it permanently deletes those files. The branch and committed history are kept.",
            buttons: ["Cancel", "Remove worktree and files"],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          });
          return !owner.isDestroyed() && result.response === 1;
        },
      },
    },
    imports: {
      staging: importStaging!,
      ownerId: () => {
        const owner = ipcSender.getStore();
        if (owner === undefined) throw new Error("missing import window");
        return owner;
      },
      isOwnerAlive: (owner) => [...shellWindows].some((win) =>
        !win.isDestroyed() && win.webContents.id === owner),
      pickFile: async (owner) => {
        const win = [...shellWindows].find((candidate) =>
          !candidate.isDestroyed() && candidate.webContents.id === owner);
        if (!win) throw new Error("the import window was closed");
        const picked = await dialog.showOpenDialog(win, {
          title: "Import a transcript",
          properties: ["openFile"],
          filters: [{ name: "Transcripts", extensions: ["jsonl", "json"] }],
        });
        return picked.canceled ? null : picked.filePaths[0] ?? null;
      },
    },
    sharing: {
      staging: shareStaging!,
      worker: shareWorker!,
      appVersion: app.getVersion(),
      ownerId: () => {
        const owner = ipcSender.getStore();
        if (owner === undefined) throw new Error("missing sharing window");
        return owner;
      },
      isOwnerAlive: (owner) => [...shellWindows].some((win) =>
        !win.isDestroyed() && win.webContents.id === owner),
      pickFile: async (owner) => {
        const win = [...shellWindows].find((candidate) =>
          !candidate.isDestroyed() && candidate.webContents.id === owner);
        if (!win) throw new Error("the sharing window was closed");
        const picked = await dialog.showOpenDialog(win, {
          title: "Import a shared session",
          properties: ["openFile"],
          filters: [{ name: "Shared sessions", extensions: ["json", "html"] }],
        });
        return picked.canceled ? null : picked.filePaths[0] ?? null;
      },
      chooseSaveTarget: async (owner, suggestedName) => {
        const win = [...shellWindows].find((candidate) =>
          !candidate.isDestroyed() && candidate.webContents.id === owner);
        if (!win) throw new Error("the sharing window was closed");
        const extension = path.extname(suggestedName).slice(1);
        const selected = await dialog.showSaveDialog(win, {
          title: "Export the reviewed session",
          defaultPath: suggestedName,
          properties: ["showOverwriteConfirmation"],
          filters: [{ name: "Shared session", extensions: [extension] }],
        });
        return selected.canceled ? null : selected.filePath ?? null;
      },
      writeFile: (filePath, text) => fs.promises.writeFile(longPath(filePath), text, "utf8"),
    },
    broadcast,
    log,
    widgets,
    pools: mcpPools,
    browser: browserViews,
    localPolicies: policyRuntime!.ipcDeps,
    policyHooks: policyRuntime!.hooks,
    policyAnswer: policyRuntime!.broker,
    policySubject: policyRuntime!.subject,
    policyApprovability: (sessionId) => policyRuntime!.approvability(sessionId),
    ...(useStub
      ? {
          makeEngine: (engineDeps: EngineDeps) =>
            createStubEngine(engineDeps, ECHO_DELAY_MS, {
              peerMentions: engineMode === "stub-roundtable",
            }),
        }
      : {}),
    secrets: secretsStore,
    listHarnesses: harnessLister,
    // [7-P1] The **same** lister, read synchronously. Every path that has to
    // resolve or validate a model — `sessions.create`, `agents.*`,
    // `SessionRunner` — needs the catalogue without spawning a probe, so it
    // reads the last answer a probe actually produced. Left unwired, these
    // consumers saw an empty catalogue: a Codex agent with no explicit model
    // was refused instead of taking Codex's own default, and the cross-backend
    // mismatch guard had no evidence and never fired.
    catalogue: () => [...harnessLister.snapshot()],

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
        //
        // Read-then-write, not write-unconditionally: `applyOnStart` runs this
        // on **every** launch, so an unconditional call would have every e2e
        // run (and every ordinary start) touch the machine's real Run key to
        // rewrite the value it already had. Comparing first makes the common
        // case a registry read and nothing else.
        let current = false;
        try {
          current = app.getLoginItemSettings().openAtLogin;
        } catch (err) {
          log.warn("[settings] could not read the login-item state", err);
        }
        if (current === enabled) return;
        app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath });
        log.info(`[settings] start with Windows: ${enabled ? "on" : "off"}`);
      },
      // The tray's own `closeToTray` callback reads the hub directly (see the
      // `createTrayIntegration` call), so there is nothing to push here — this
      // is the audit line that says which value is live.
      applyCloseToTray: (enabled) => log.info(`[settings] close to tray: ${enabled ? "on" : "off"}`),
      applyNotifications: (notifications) =>
        log.info(
          `[settings] notifications: ${notifications.enabled ? "on" : "off"}` +
            ` (finish=${notifications.onFinish} needsInput=${notifications.onNeedsInput}` +
            ` disconnect=${notifications.onRunnerDisconnect})`,
        ),
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
      // The very same cached probe `harness.list` uses (see above).
      probe: sharedCliProbe,
      writeClipboard: (text) => clipboard.writeText(text),
      fileSize: (file) => {
        try {
          return fs.statSync(file).size;
        } catch {
          return 0;
        }
      },
    },
    // [Phase 6/C] The one seam the prerequisites gate needs for e2e (SPEC R3,
    // R27). `CAPYGEN_PREREQ_CONFIRM=cancel` replaces the *confirm dialog* —
    // and only the confirm dialog — with one that answers "Cancel" without
    // drawing anything, so `tests/e2e/settings.spec.ts` can click Run… and
    // prove that (a) the gate really asked and (b) nothing was spawned. The
    // console launcher is untouched: it is never reached, which is the
    // assertion. Any other value (including unset) leaves the real
    // `dialog.showMessageBox` in place, so the shipping build has no way in.
    ...(process.env.CAPYGEN_PREREQ_CONFIRM === "cancel"
      ? {
          prereqs: {
            confirm: async (options) => {
              // `detail` is where `confirmOptionsFor` puts the exact command,
              // so logging its first line proves the gate built a real dialog
              // for this step rather than short-circuiting before it.
              log.warn(
                "[prereqs] CAPYGEN_PREREQ_CONFIRM=cancel — auto-cancelling the confirm for" +
                  ` \`${options.detail.split("\n")[0] ?? ""}\``,
              );
              return false;
            },
          },
        }
      : {}),
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
  if (app.isPackaged) {
    launchUpdateTimer = setTimeout(() => { const mode = activeStore.globalSettings.all().updates.mode; if (mode === "automatic" || mode === "at-launch") void updates?.check().catch(() => {}); }, 10_000);
    updateTimer = setInterval(() => { if (activeStore.globalSettings.all().updates.mode === "automatic") void updates?.check().catch(() => {}); }, 15 * 60_000);
    updateTimer.unref(); launchUpdateTimer.unref();
  }
  void context.integrations.start().catch((err: unknown) => {
    log.warn("[integrations] could not start the config watchers", err);
  });

  return context;
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

app.on("second-instance", () => revealWindow());

app.whenReady().then(async () => {
  const userData = app.getPath("userData");
  log = createLogger({ dir: path.join(userData, LOG_DIR_NAME), fileName: LOG_FILE_NAME });
  log.captureConsole();
  log.captureProcessErrors();
  log.info(`[main] capygen ${app.getVersion()} starting; userData=${userData}`);
  // Logged only once the logger exists — `applyConfigHomes` runs long before
  // it does. A run whose line is absent used the machine's real homes, which
  // is exactly the thing an e2e must be able to tell apart.
  for (const mapping of configHomes) {
    log.warn(`[config] ${mapping.to}=${mapping.dir} (from ${mapping.from})`);
  }

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

  importWorker = createElectronImportWorkerClient({
    workerPath: path.join(HERE, "importWorker.cjs"),
    jobsDirectory: path.join(userData, "imports", "jobs"),
  });
  await importWorker.initialize();
  importStaging = new ImportStagingService({
    directory: path.join(userData, "imports", "staging"),
    stage: importWorker.stageTranscript.bind(importWorker),
    projectExists: (projectId) => Boolean(store?.projects.get(projectId)),
    log,
  });
  await importStaging.initialize();
  shareWorker = new ShareWorkerClient({
    fork: () => utilityProcess.fork(path.join(HERE, "shareWorker.cjs"), [], {
      serviceName: "capygen sharing",
      stdio: "ignore",
      // This worker needs no backend credentials or configuration homes.
      env: cleanEnv({
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
      }),
    }),
    log: { warn: (message) => log.warn(message) },
  });
  shareStaging = new ShareStagingService<ShareStagingMeta>({
    releaseJob: (jobId) => shareWorker!.release(jobId),
    isWorkerGone: () => shareWorker!.isGone(),
    log,
  });
  shareSweep = setInterval(() => {
    void shareStaging?.sweepNow().catch(() => log.warn("[sharing] expiry cleanup failed"));
  }, 5_000);
  shareSweep.unref();
  // One local policy runtime, before the IPC context that both the management
  // channels and the session runner read it from (ADR-0007: one service).
  policyRuntime = createPolicyRuntime({
    store,
    ask: createPermissionCardPublisher({
      store,
      // Typed, not cast: the publisher's payloads are checked against the
      // event contract at compile time.
      broadcast,
      newBlockId: () => newId("block"),
    }),
    publishChanged: (change) => broadcast("policy.changed", change),
    // Read lazily: the engine is built inside `registerIpc`, after this.
    engine: () => ipc?.engine ?? null,
  });
  ipc = registerIpc(store);

  // [Phase 6/C] The notifications switch, made real (SPEC R19/R30). Built
  // *after* the IPC context because it reads the settings hub, and assigned to
  // the module-level `notifier` the `broadcast` tap above consults — so events
  // fired before this point (there are none: nothing streams before a window)
  // simply do not toast.
  const activeStore = store;
  notifier = createNotifier({
    claim: (key) => {
      const raw = activeStore.settings.getRaw<unknown>("notifications.seen", []);
      const seen = Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
      if (seen.includes(key)) return false;
      activeStore.settings.setRaw("notifications.seen", [...seen.slice(-199), key]);
      return true;
    },
    settings: () => ipc?.settings.all().notifications ?? DEFAULT_NOTIFICATIONS_OFF,
    isFocused: () => [...shellWindows].some((win) => !win.isDestroyed() && win.isFocused()),
    show: (request) => {
      if (!Notification.isSupported()) return;
      const toast = new Notification({ title: request.title, body: request.body });
      if (request.onClick) toast.on("click", request.onClick);
      toast.show();
    },
    reveal: revealWindow,
    sessionTitle: (sessionId) => {
      try {
        return activeStore.sessions.get(sessionId)?.title ?? null;
      } catch {
        return null;
      }
    },
    log,
  });

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
    // [Phase 6/C] The hub is the authority; the flat row (which the hub
    // projects onto, see `SettingsService.project`) is the fallback for a
    // profile whose hub row has not been written yet.
    closeToTray: () => {
      try {
        return ipc?.settings.all().closeToTray ?? store?.settings.all().closeToTray ?? true;
      } catch {
        return true;
      }
    },
  });
  tray.create();

  createWindow();
  ipc.automations.start();

  nativeTheme.on("updated", () => {
    for (const win of shellWindows) {
      if (!win.isDestroyed()) win.setBackgroundColor(isDark() ? "#0e1013" : "#ffffff");
    }
  });

  app.on("activate", () => {
    if (shellWindows.size === 0) createWindow();
  });
}).catch(async (error: unknown) => {
  log?.error("[main] startup failed", error);
  try { disposePolicy(); } catch { /* preserve the startup error */ }
  try { await disposeSharing(); } catch { /* preserve the startup error */ }
  try { await importStaging?.dispose(); } catch { /* preserve the startup error */ }
  try { await importWorker?.dispose(); } catch { /* preserve the startup error */ }
  try { store?.close(); store = null; } catch { /* process is terminating */ }
  dialog.showErrorBox("capygen could not start", "Startup failed. See the capygen log for details.");
  app.exit(1);
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
    if (updateTimer) clearInterval(updateTimer);
    if (launchUpdateTimer) clearTimeout(launchUpdateTimer);
    updates?.dispose();
    try { extensions?.dispose(); } catch { log?.warn("[extensions] shutdown cleanup failed"); }
    try { disposePolicy(); }
    catch { log?.warn("[policy] shutdown cleanup failed"); }
    try { await disposeSharing(); }
    catch { log?.warn("[sharing] shutdown cleanup failed"); }
    try {
      await importStaging?.dispose();
    } catch (err) {
      log?.error("[main] import staging shutdown error", err);
    }
    try { await importWorker?.dispose(); }
    catch (err) { log?.error("[main] import worker shutdown error", err); }
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
