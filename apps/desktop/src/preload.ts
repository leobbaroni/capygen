/**
 * The only bridge between the renderer and the main process.
 *
 * Nothing but the typed IPC client is exposed: no `require`, no `ipcRenderer`,
 * no Node globals. Channel names are checked against the shared contract before
 * anything is sent, and `defineIpc` validates both directions with the same zod
 * schemas the main process uses, so a renderer cannot reach a channel this build
 * does not declare and cannot receive a payload that does not match.
 */
import { contextBridge, ipcRenderer } from "electron";
import {
  EVENT_CHANNEL_NAMES,
  IPC_BRIDGE_KEY,
  INVOKE_CHANNEL_NAMES,
  defineIpc,
  isEventChannel,
  isInvokeChannel,
} from "@capygen/shared";

const client = defineIpc({
  invoke: (channel, payload) => {
    if (!isInvokeChannel(channel)) {
      return Promise.reject(new Error(`capygen: unknown invoke channel "${channel}"`));
    }
    return ipcRenderer.invoke(channel, payload);
  },
  subscribe: (channel, listener) => {
    if (!isEventChannel(channel)) {
      throw new Error(`capygen: unknown event channel "${channel}"`);
    }
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown): void =>
      listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.off(channel, wrapped);
  },
});

/**
 * The renderer wraps this again with `defineIpc` (see apps/renderer/src/lib/ipc.ts)
 * so React code gets full inference from the contract rather than from whatever
 * survived the structured clone across the bridge.
 */
contextBridge.exposeInMainWorld(IPC_BRIDGE_KEY, {
  invoke: (channel: string, payload: unknown) =>
    client.invoke(channel as never, payload as never),
  subscribe: (channel: string, listener: (payload: unknown) => void) =>
    client.on(channel as never, listener as never),
  channels: {
    invoke: [...INVOKE_CHANNEL_NAMES],
    events: [...EVENT_CHANNEL_NAMES],
  },
});
