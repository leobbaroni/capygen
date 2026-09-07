import { utilityProcess } from "electron";
import {
  ImportWorkerClient,
  type ImportWorkerClientOptions,
  type UtilityProcessLike,
} from "./utilityWorker.js";

/** Production Electron adapter. Kept separate so Node-only unit tests never
 * import Electron's executable shim. Call only after `app.whenReady()`. */
export function createElectronImportWorkerClient(
  options: Omit<ImportWorkerClientOptions, "fork">,
): ImportWorkerClient {
  return new ImportWorkerClient({
    ...options,
    fork: (modulePath, args, forkOptions) =>
      utilityProcess.fork(modulePath, args, forkOptions) as UtilityProcessLike,
  });
}
