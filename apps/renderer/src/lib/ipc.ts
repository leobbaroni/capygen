/**
 * The renderer's handle on the main process.
 *
 * `window.capygen` is the raw bridge the preload exposed (allow-listed channel
 * names, structured-cloneable values only). Wrapping it with the shared
 * `defineIpc` gives React code the contract's own types and validates every
 * payload again on this side, so a store never sees a half-shaped block.
 */
import { IPC_BRIDGE_KEY, defineIpc, type IpcClient } from "@capygen/shared";

interface RawBridge {
  invoke(channel: string, payload: unknown): Promise<unknown>;
  subscribe(channel: string, listener: (payload: unknown) => void): () => void;
  channels: { invoke: string[]; events: string[] };
}

declare global {
  interface Window {
    [IPC_BRIDGE_KEY]?: RawBridge;
  }
}

/** True in the Electron shell, false when the SPA is opened in a plain browser. */
export function hasBridge(): boolean {
  return typeof window !== "undefined" && Boolean(window[IPC_BRIDGE_KEY]);
}

let cached: IpcClient | null = null;

export function ipc(): IpcClient {
  if (cached) return cached;
  const bridge = typeof window === "undefined" ? undefined : window[IPC_BRIDGE_KEY];
  if (!bridge) {
    throw new Error(
      "capygen: the preload bridge is missing. The renderer must run inside the Electron shell.",
    );
  }
  cached = defineIpc({
    invoke: (channel, payload) => bridge.invoke(channel, payload),
    subscribe: (channel, listener) => bridge.subscribe(channel, listener),
  });
  return cached;
}
