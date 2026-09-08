import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import type { BaseWindow } from "electron";
import type { ExtensionRegistry } from "../src/extensions/registry.js";
import type { ExtensionCapabilityService } from "../src/extensions/service.js";

const state = vi.hoisted(() => ({ sessions: [] as any[], views: [] as any[], channels: [] as any[] }));
vi.mock("electron", () => ({
  protocol: { registerSchemesAsPrivileged: vi.fn() },
  session: { fromPartition: vi.fn(() => {
    const value = { protocol: { handle: vi.fn(), unhandle: vi.fn() }, setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), setDevicePermissionHandler: vi.fn(), on: vi.fn(), webRequest: { onBeforeRequest: vi.fn() }, clearStorageData: vi.fn(async () => {}) };
    state.sessions.push(value); return value;
  }) },
  WebContentsView: class {
    webContents = Object.assign(new EventEmitter(), { id: state.views.length + 1, mainFrame: { url: "", postMessage: vi.fn() }, isDestroyed: () => false, close: vi.fn(), setWindowOpenHandler: vi.fn(), getURL: () => this.webContents.mainFrame.url,
      loadURL: async (url: string) => { this.webContents.mainFrame.url = url; this.webContents.emit("did-finish-load"); } });
    setBounds = vi.fn();
    constructor(public options: unknown) { state.views.push(this); }
  },
  MessageChannelMain: class {
    port1 = Object.assign(new EventEmitter(), { close: vi.fn(), start: vi.fn(), postMessage: vi.fn() });
    port2 = { close: vi.fn() };
    constructor() { state.channels.push(this); }
  },
}));
import { createExtensionHost, extensionAssetPath, EXTENSION_CSP } from "../src/extensions/host.js";

it("confines assets, denies ambient authority, binds fresh ports and drops late replies after disposal", async () => {
  let resolveReply!: (reply: unknown) => void;
  let nextId = 0;
  const service = { openInstance: vi.fn(() => ({ instanceId: `instance-${++nextId}`, nonce: "secret", grants: [], extensionId: "fixture", version: 1 })), closeInstance: vi.fn(), dispatch: vi.fn(() => new Promise((resolve) => { resolveReply = resolve; })) };
  const record = { revision: "revision", registration: { grants: [] }, manifest: { pages: [{ id: "fixture.page", entry: "index.html" }] } };
  const registry = { get: vi.fn(() => record), subscribe: vi.fn(() => vi.fn()), readAsset: vi.fn(async () => ({ bytes: Buffer.from("page"), contentType: "text/html", revision: "revision" })) };
  const window = Object.assign(new EventEmitter(), { isDestroyed: () => false, contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } });
  const host = createExtensionHost({ registry: registry as unknown as ExtensionRegistry, service: service as unknown as ExtensionCapabilityService, preloadPath: "C:/fixture/preload.cjs" });
  const args = { window: window as unknown as BaseWindow, extensionId: "fixture", pageId: "fixture.page", bounds: { x: 0, y: 0, width: 300, height: 200 } };
  const first = await host.open(args);
  const isolated = state.sessions[0]; const view = state.views[0]; const channel = state.channels[0];
  expect(view.options.webPreferences).toMatchObject({ sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true });
  expect(isolated.setPermissionCheckHandler.mock.calls[0][0]()).toBe(false);
  const deny = vi.fn(); isolated.webRequest.onBeforeRequest.mock.calls[0][0]({ url: "https://example.org/image.png" }, deny); expect(deny).toHaveBeenCalledWith({ cancel: true });
  expect(view.webContents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: "deny" });
  const url = view.webContents.getURL();
  expect(extensionAssetPath(url, url.slice(0, url.lastIndexOf("/")))).toBe("index.html");
  expect(extensionAssetPath(url.replace("index.html", "%2e%2e%2fsecret"), url.slice(0, url.lastIndexOf("/")))).toBeNull();
  const response = await isolated.protocol.handle.mock.calls[0][1]({ url, method: "GET" });
  expect(response.headers.get("Content-Security-Policy")).toBe(EXTENSION_CSP);
  expect(EXTENSION_CSP).toContain("connect-src 'none'");
  channel.port1.emit("message", { data: { forged: true } });
  expect(service.dispatch).toHaveBeenCalledWith(first.instanceId, { forged: true });
  first.dispose(); resolveReply({ ok: true }); await Promise.resolve();
  expect(channel.port1.postMessage).not.toHaveBeenCalled();
  expect(service.closeInstance).toHaveBeenCalledWith(first.instanceId);
  expect(channel.port1.close).toHaveBeenCalled();
  const second = await host.open(args); expect(second.instanceId).not.toBe(first.instanceId);
  expect(state.views[1].webContents.getURL()).not.toBe(url);
  host.dispose(); expect(service.closeInstance).toHaveBeenCalledWith(second.instanceId);
});
