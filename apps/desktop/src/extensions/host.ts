import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { MessageChannelMain, WebContentsView, protocol, session, type BaseWindow, type Rectangle, type CustomScheme } from "electron";
import type { ExtensionRegistry } from "./registry.js";
import type { ExtensionCapabilityService } from "./service.js";

export const EXTENSION_SCHEME = "capygen-extension";
export const EXTENSION_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
/** Must run before Electron ready; privileges are limited to origin-aware bundled assets. */
export function registerExtensionScheme(additional: CustomScheme[] = []): void {
  protocol.registerSchemesAsPrivileged([...additional, { scheme: EXTENSION_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false, bypassCSP: false, allowServiceWorkers: false } }]);
}
export interface ExtensionViewHandle {
  instanceId: string;
  webContentsId: number;
  setBounds(bounds: Rectangle): void;
  dispose(): void;
}
export function extensionAssetPath(urlText: string, origin: string): string | null {
  try {
    const url = new URL(urlText);
    if (`${url.protocol}//${url.host}` !== origin || url.username || url.password || url.search || url.hash) return null;
    const path = decodeURIComponent(url.pathname.slice(1));
    if (!path || path.includes("\\") || path.includes("\0") || path.split("/").some((part) => !part || part === "." || part === "..")) return null;
    return path;
  } catch { return null; }
}
export function createExtensionHost(deps: { registry: ExtensionRegistry; service: ExtensionCapabilityService; preloadPath?: string }) {
  const handles = new Set<ExtensionViewHandle>();
  let stopped = false;
  return {
    async open(input: { window: BaseWindow; extensionId: string; pageId: string; bounds: Rectangle }): Promise<ExtensionViewHandle> {
      if (stopped || handles.size >= 64) throw new Error("Extension views are unavailable");
      const record = deps.registry.get(input.extensionId);
      const page = record?.manifest?.pages.find((entry) => entry.id === input.pageId);
      if (!record || !page) throw new Error("Extension page is unavailable");
      const origin = `${EXTENSION_SCHEME}://${randomUUID()}`;
      const isolated = session.fromPartition(`capygen-extension-${randomUUID()}`, { cache: false });
      isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      isolated.setPermissionCheckHandler(() => false);
      isolated.setDevicePermissionHandler(() => false);
      isolated.on("will-download", (event) => event.preventDefault());
      isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: extensionAssetPath(details.url, origin) === null }));
      let disposed = false;
      await isolated.protocol.handle(EXTENSION_SCHEME, async (request) => {
        const asset = extensionAssetPath(request.url, origin);
        if (disposed || request.method !== "GET" || !asset) return new Response(null, { status: 403 });
        try {
          const result = await deps.registry.readAsset(input.extensionId, asset);
          if (disposed || result.revision !== record.revision) return new Response(null, { status: 410 });
          return new Response(new Uint8Array(result.bytes), { headers: {
            "Content-Type": result.contentType, "Content-Security-Policy": EXTENSION_CSP,
            "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer", "Permissions-Policy": "camera=(), microphone=(), geolocation=(), display-capture=()",
          } });
        } catch { return new Response(null, { status: 404 }); }
      });
      const view = new WebContentsView({ webPreferences: {
        session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false,
        nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, webSecurity: true,
        allowRunningInsecureContent: false, webviewTag: false, navigateOnDragDrop: false,
        preload: deps.preloadPath ?? join(__dirname, "extension-preload.cjs"),
        additionalArguments: [`--capygen-extension-origin=${origin}`],
      } });
      const contents = view.webContents;
      const { port1, port2 } = new MessageChannelMain();
      let delivered = false;
      const safePost = (message: unknown) => { if (!disposed && delivered && !contents.isDestroyed()) { try { port1.postMessage(message); } catch { handle.dispose(); } } };
      let authority: ReturnType<ExtensionCapabilityService["openInstance"]>;
      try { authority = deps.service.openInstance(input.extensionId, record.registration.grants, safePost); }
      catch (error) {
        disposed = true; port1.close(); port2.close(); contents.close();
        isolated.protocol.unhandle(EXTENSION_SCHEME);
        void isolated.clearStorageData().catch(() => {});
        throw error;
      }
      const url = `${origin}/${page.entry.split("/").map(encodeURIComponent).join("/")}`;
      const stopRegistry = deps.registry.subscribe(() => {
        const current = deps.registry.get(input.extensionId);
        if (!current || current.revision !== record.revision || authority.grants.some((grant) => !current.registration.grants.includes(grant))) handle.dispose();
      });
      const handle: ExtensionViewHandle = {
        instanceId: authority.instanceId, webContentsId: contents.id,
        setBounds(bounds) { if (!disposed) view.setBounds(bounds); },
        dispose() {
          if (disposed) return;
          disposed = true; handles.delete(handle); stopRegistry(); deps.service.closeInstance(authority.instanceId);
          port1.close(); port2.close(); input.window.removeListener("closed", handle.dispose);
          if (!input.window.isDestroyed()) input.window.contentView.removeChildView(view);
          if (!contents.isDestroyed()) contents.close();
          isolated.protocol.unhandle(EXTENSION_SCHEME);
          void isolated.clearStorageData().catch(() => {});
        },
      };
      handles.add(handle);
      port1.on("message", (event) => {
        if (disposed || !delivered) return;
        void deps.service.dispatch(authority.instanceId, event.data).then(safePost).catch(() => handle.dispose());
      });
      port1.on("close", () => handle.dispose()); port1.start();
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
      contents.on("will-navigate", (event) => event.preventDefault());
      contents.on("will-frame-navigate", (event) => event.preventDefault());
      contents.on("will-redirect", (event) => event.preventDefault());
      contents.on("will-attach-webview", (event) => event.preventDefault());
      contents.on("render-process-gone", handle.dispose);
      contents.on("destroyed", handle.dispose);
      contents.on("did-start-navigation", (_event, navigationUrl, isInPlace, isMainFrame) => {
        if (delivered && isMainFrame && !isInPlace) handle.dispose();
        else if (isMainFrame && navigationUrl !== url) handle.dispose();
      });
      contents.once("did-finish-load", () => {
        if (disposed || contents.getURL() !== url || contents.mainFrame.url !== url) { handle.dispose(); return; }
        delivered = true;
        contents.mainFrame.postMessage("capygen-extension-bootstrap", { ...authority, origin }, [port2]);
      });
      input.window.once("closed", handle.dispose);
      input.window.contentView.addChildView(view); view.setBounds(input.bounds);
      try { await contents.loadURL(url); if (disposed) throw new Error("Extension view was disposed while loading"); }
      catch (error) { handle.dispose(); throw error; }
      return handle;
    },
    dispose() { stopped = true; for (const handle of [...handles]) handle.dispose(); },
  };
}
