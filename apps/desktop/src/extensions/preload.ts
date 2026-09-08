/** Isolated extension bootstrap. No generic IPC, filesystem or capygen preload APIs. */
import { ipcRenderer } from "electron";
declare const window: { top: unknown; postMessage(message: unknown, targetOrigin: string, transfer: unknown[]): void };
declare const location: { protocol: string; host: string };
const prefix = "--capygen-extension-origin=";
const origin = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
ipcRenderer.once("capygen-extension-bootstrap", (event, value: unknown) => {
  if (!origin || window !== window.top || `${location.protocol}//${location.host}` !== origin
    || typeof value !== "object" || value === null || !("origin" in value) || value.origin !== origin
    || event.ports.length !== 1) { for (const port of event.ports) port.close(); return; }
  // The target is the verified extension origin, and this listener is consumed once.
  window.postMessage({ type: "capygen-extension-ready", ...value }, origin, [event.ports[0]!]);
});
