import type { IpcHandlers } from "./handlers.js";
export type ExtensionHandlers = Pick<IpcHandlers, Extract<keyof IpcHandlers, `extensions.${string}`>>;
export function unavailableExtensionHandlers(): ExtensionHandlers {
  const unavailable = () => { throw new Error("Extensions are unavailable in this host."); };
  return { "extensions.list": () => ({ items: [], nextOffset: null }), "extensions.pick": unavailable,
    "extensions.register": unavailable, "extensions.unregister": unavailable, "extensions.refresh": unavailable,
    "extensions.open": unavailable, "extensions.bounds": unavailable, "extensions.close": unavailable, "extensions.theme": () => ({ ok: false }) };
}
