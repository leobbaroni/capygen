import type { UpdateService } from "../updates/UpdateService.js";
import type { IpcHandlers } from "./handlers.js";
export type UpdateHandlers = Pick<IpcHandlers, Extract<keyof IpcHandlers, `updates.${string}`>>;
export function createUpdateHandlers(service?: UpdateService): UpdateHandlers {
  const required = () => { if (!service) throw new Error("Updates are unavailable in this host."); return service; };
  return {
    "updates.status": () => service?.status() ?? { phase: "unavailable", currentVersion: "0.0.0", version: null, progress: 0, message: "Updates are unavailable in this host.", hasCredential: false, portable: false },
    "updates.check": () => required().check(), "updates.download": () => required().download(),
    "updates.cancel": () => required().cancel(), "updates.clear": () => required().clear(),
    "updates.install": () => required().install(), "updates.savePortable": () => required().savePortable(),
    "updates.setCredential": ({ value }) => required().setCredential(value), "updates.deleteCredential": () => required().deleteCredential(),
  };
}
