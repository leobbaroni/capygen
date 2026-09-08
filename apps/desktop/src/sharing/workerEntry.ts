/**
 * The share worker process.
 *
 * One job table, one message loop, nothing else. Every expensive part of
 * sharing — reading a file, decoding a carrier, projection, redaction, schema
 * validation, JSON and HTML encoding — happens here so it cannot block the
 * window. The child discovers nothing: it is told the exact file to read and
 * the exact bounds to read it under, and it never touches the database.
 */
import { createShareWorkerHost } from "./workerHost.js";
import type { ShareWorkerRequest } from "./workerHostTypes.js";

const host = createShareWorkerHost();

const send = (message: unknown): void => {
  const target = process as unknown as { parentPort?: { postMessage(value: unknown): void } };
  if (target.parentPort) target.parentPort.postMessage(message);
  else process.send?.(message);
};

const receive = (listener: (message: unknown) => void): void => {
  const target = process as unknown as {
    parentPort?: { on(event: "message", handler: (event: { data: unknown }) => void): void };
  };
  // Electron's utilityProcess delivers `{ data }`; a plain Node child does not.
  if (target.parentPort) target.parentPort.on("message", (event) => listener(event.data));
  else process.on("message", listener);
};

receive((message) => {
  void (async () => {
    try {
      send(await host.handle(message as ShareWorkerRequest));
    } catch {
      // A reply that cannot be produced is not worth crashing the child over;
      // main's per-request deadline turns silence into a refusal.
    }
  })();
});
