/**
 * The Settings hub (SPEC R19, R30) as `main.ts` calls it: args parsed in,
 * result parsed out through the shared contract.
 *
 * Two claims beyond "it stores things":
 *
 *  - the **projection** onto Phase 2's flat `Settings` row really happens, so
 *    `SessionRunner`, `appStore` and the workspace panes — none of which know
 *    the hub exists — pick up a hub change without a second source of truth
 *    (see `SettingsService`'s header table);
 *  - the **OS switches** are asked for exactly once per change, and a switch
 *    that throws does not take the others (or the write) down with it.
 */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GLOBAL_SETTINGS,
  parseInvokeArgs,
  parseInvokeResult,
  type GlobalSettings,
  type InvokeChannel,
} from "@capygen/shared";
import { createIpcContext, type IpcContext } from "../src/ipc/handlers.js";
import { SETTINGS_HUB_CHANNELS } from "../src/ipc/settings.js";
import { SettingsService, type SettingsPlatform } from "../src/integrations/SettingsService.js";
import { createStubEngine } from "../src/engine/stub.js";
import { makeHarness, type Harness } from "./workspaceHarness.js";

let h: Harness;
let ipc: IpcContext;
let platform: {
  themes: string[];
  startWithWindows: boolean[];
  closeToTray: boolean[];
  notifications: unknown[];
  impl: SettingsPlatform;
};

function makePlatform(): typeof platform {
  const themes: string[] = [];
  const startWithWindows: boolean[] = [];
  const closeToTray: boolean[] = [];
  const notifications: unknown[] = [];
  return {
    themes,
    startWithWindows,
    closeToTray,
    notifications,
    impl: {
      applyTheme: (theme) => void themes.push(theme),
      setStartWithWindows: (enabled) => void startWithWindows.push(enabled),
      applyCloseToTray: (enabled) => void closeToTray.push(enabled),
      applyNotifications: (value) => void notifications.push(value),
    },
  };
}

async function call<C extends InvokeChannel>(channel: C, raw: unknown): Promise<unknown> {
  const args = parseInvokeArgs(channel, raw);
  const handler = ipc.handlers[channel] as (a: unknown) => unknown;
  return parseInvokeResult(channel, await handler(args));
}

beforeEach(() => {
  h = makeHarness({ prefix: "capygen-settings-" });
  platform = makePlatform();
  ipc = createIpcContext({
    store: h.store,
    broadcast: h.broadcast,
    log: h.log,
    makeEngine: createStubEngine,
    pickDirectory: async () => null,
    appInfo: () => appInfo(h),
    settingsPlatform: platform.impl,
    // A temp home for both backends: nothing in this file may reach the real
    // `~/.claude` or `~/.codex`.
    integrations: {
      env: { CLAUDE_CONFIG_DIR: path.join(h.dir, "claude"), CODEX_HOME: path.join(h.dir, "codex") },
      home: h.dir,
      createWatcher: () => ({ on: () => undefined, close: () => undefined }),
    },
  });
});

afterEach(async () => {
  await ipc.dispose();
  h.close();
});

function appInfo(harness: Harness): {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  userDataDir: string;
  logFile: string;
  dbFile: string;
} {
  return {
    name: "capygen",
    version: "0.1.0",
    electron: "44.2.0",
    chrome: "1",
    node: "24.20.0",
    platform: "win32",
    userDataDir: harness.dir,
    logFile: path.join(harness.dir, "logs", "capygen.log"),
    dbFile: harness.store.db.file,
  };
}

describe("contract coverage", () => {
  it("answers exactly the three settings-hub channels", () => {
    expect([...SETTINGS_HUB_CHANNELS]).toEqual([
      "settings.getAll",
      "settings.patch",
      "settings.reset",
    ]);
    for (const channel of SETTINGS_HUB_CHANNELS) {
      expect(typeof ipc.handlers[channel]).toBe("function");
    }
  });
});

describe("settings.getAll / .patch / .reset", () => {
  it("starts at the shipping defaults", async () => {
    expect(await call("settings.getAll", {})).toEqual(DEFAULT_GLOBAL_SETTINGS);
  });

  it("deep-merges a section without resetting its siblings", async () => {
    await call("settings.patch", { patch: { general: { defaultModel: "claude-haiku-4-5" } } });
    const after = (await call("settings.patch", {
      patch: { general: { alwaysSteer: true } },
    })) as GlobalSettings;
    expect(after.general.defaultModel).toBe("claude-haiku-4-5");
    expect(after.general.alwaysSteer).toBe(true);
    expect(after.general.defaultBackend).toBe("claude");
  });

  it("survives a reopen of the same profile", async () => {
    await call("settings.patch", { patch: { appearance: { theme: "dark" } } });
    // A second service on the same database is the reopen: the row, not the
    // in-memory object, is what a relaunch reads.
    const second = new SettingsService({ store: h.store, broadcast: h.broadcast, log: h.log });
    expect(second.all().appearance.theme).toBe("dark");
  });

  it("resets one section and leaves the others alone", async () => {
    await call("settings.patch", {
      patch: { appearance: { theme: "dark" }, general: { autoTitleSessions: false } },
    });
    const after = (await call("settings.reset", { section: "appearance" })) as GlobalSettings;
    expect(after.appearance).toEqual(DEFAULT_GLOBAL_SETTINGS.appearance);
    expect(after.general.autoTitleSessions).toBe(false);
    const all = (await call("settings.reset", { section: "all" })) as GlobalSettings;
    expect(all).toEqual(DEFAULT_GLOBAL_SETTINGS);
  });

  it("broadcasts settings.changed after every write, never after a read", async () => {
    await call("settings.getAll", {});
    expect(h.eventsOn("settings.changed")).toHaveLength(0);
    await call("settings.patch", { patch: { closeToTray: false } });
    await call("settings.reset", { section: "all" });
    const events = h.eventsOn("settings.changed") as { settings: GlobalSettings }[];
    expect(events).toHaveLength(2);
    expect(events[0]?.settings.closeToTray).toBe(false);
    expect(events[1]?.settings).toEqual(DEFAULT_GLOBAL_SETTINGS);
  });

  it("refuses to let telemetry be turned on, loudly", async () => {
    // `GlobalSettingsPatchSchema` names no `telemetry` key, but it is
    // `.passthrough()`, so a caller *can* smuggle one as far as
    // `mergeGlobalSettingsPatch` — where `z.literal(false)` rejects it. The
    // patch fails whole rather than being partly applied, which is the right
    // end of "never swallow" (SPEC §Edge Cases) for a flag that is meant to be
    // unreachable. Recorded here because "the schema rejects it earlier" would
    // have been the easy assumption.
    await expect(call("settings.patch", { patch: { telemetry: true } })).rejects.toThrow(
      /telemetry/,
    );
    expect(((await call("settings.getAll", {})) as GlobalSettings).telemetry).toBe(false);
  });
});

describe("projection onto the flat Settings row (R30 layering)", () => {
  it("moves the overlapping fields so SessionRunner and appStore see them", async () => {
    await call("settings.patch", {
      patch: {
        appearance: { theme: "dark" },
        general: { defaultBackend: "codex", defaultModel: "gpt-6" },
        efficiency: { compactionThresholdPct: 50 },
        closeToTray: false,
        backends: { claude: { permissionMode: "acceptEdits" } },
      },
    });
    const flat = h.store.settings.all();
    expect(flat.theme).toBe("dark");
    expect(flat.defaultBackend).toBe("codex");
    expect(flat.defaultModel).toBe("gpt-6");
    expect(flat.compactionThreshold).toBeCloseTo(0.5, 5);
    expect(flat.closeToTray).toBe(false);
    // The global backend default becomes the *fallback* the runner uses; an
    // agent's own `config.claude.permissionMode` still outranks it (Phase 4).
    expect(flat.permissionMode).toBe("acceptEdits");
  });

  it("leaves permissionMode alone when the hub has no opinion", async () => {
    h.store.settings.patch({ permissionMode: "plan" });
    await call("settings.patch", { patch: { general: { alwaysSteer: true } } });
    expect(h.store.settings.all().permissionMode).toBe("plan");
  });

  it("keeps the flat row's own fields it does not own", async () => {
    h.store.settings.patch({ hopCap: 7, showThinking: false });
    await call("settings.patch", { patch: { appearance: { theme: "light" } } });
    const flat = h.store.settings.all();
    expect(flat.hopCap).toBe(7);
    expect(flat.showThinking).toBe(false);
  });
});

describe("OS switches", () => {
  it("asks for each one on every write, and once on start-up", async () => {
    ipc.settings.applyOnStart();
    expect(platform.themes).toEqual(["dark"]);
    expect(platform.startWithWindows).toEqual([false]);

    await call("settings.patch", { patch: { appearance: { theme: "dark" }, startWithWindows: true } });
    expect(platform.themes).toEqual(["dark", "dark"]);
    expect(platform.startWithWindows).toEqual([false, true]);
    expect(platform.closeToTray).toEqual([true, true]);
    expect(platform.notifications).toHaveLength(2);
  });

  it("keeps the write when one switch throws", async () => {
    const boom = vi.fn(() => {
      throw new Error("the Run key is locked by policy");
    });
    const service = new SettingsService({
      store: h.store,
      broadcast: h.broadcast,
      log: h.log,
      platform: { setStartWithWindows: boom, applyTheme: platform.impl.applyTheme },
    });
    const next = service.patch({ startWithWindows: true, appearance: { theme: "dark" } });
    expect(next.startWithWindows).toBe(true);
    expect(boom).toHaveBeenCalledTimes(1);
    // the other switch still ran, and the failure was reported not swallowed
    expect(platform.themes).toContain("dark");
    expect(h.log.warn).toHaveBeenCalled();
    expect(service.all().startWithWindows).toBe(true);
  });
});
