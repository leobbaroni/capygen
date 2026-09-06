/**
 * The Settings hub's store and the things the app does when it changes
 * (SPEC R19, R21, R30).
 *
 * Two jobs, and the second one is the interesting half:
 *
 *  1. **Store.** `settings.getAll` / `.patch` / `.reset` on top of
 *     `GlobalSettingsRepo` (one versioned JSON row in the `settings` table),
 *     with `settings.changed` broadcast after every write so a second window
 *     (R2's tray "New Window") never shows stale settings.
 *
 *  2. **Projection.** Phase 2's *flat* `Settings` row is still what
 *     `SessionRunner`, the renderer's `appStore` and the workspace pane read —
 *     `store.settings.all()` appears in all three. Rather than edit those call
 *     sites (and give the app two sources of truth for "the default model"),
 *     every `settings.patch` **projects** the overlapping fields onto that row:
 *
 *     | GlobalSettings | flat `Settings` | consumed by |
 *     |---|---|---|
 *     | `appearance.theme` | `theme` | `main.isDark`, the tray, the renderer |
 *     | `general.defaultBackend` | `defaultBackend` | the landing composer |
 *     | `general.defaultModel` | `defaultModel` | `sessions.create`, `harness.list` |
 *     | `backends.claude.permissionMode` | `permissionMode` | `SessionRunner.permissionModeFor`'s fallback |
 *     | `efficiency.compactionThresholdPct` | `compactionThreshold` (÷100) | compaction (R25) |
 *     | `closeToTray` | `closeToTray` | `win/tray.ts` |
 *
 *     So the layering the SPEC asks for — global → backend default → agent
 *     override — reaches the harnesses through the field `SessionRunner`
 *     already treats as the *lowest* priority, and `agent.config.<backend>`
 *     keeps outranking it exactly as it did in Phase 4. The projection is
 *     one-way on purpose: the hub is the place a person edits, and a
 *     `settings.set` from an older surface simply loses on the next patch.
 *
 * `apply` is where the OS-facing effects live (theme, close-to-tray, run at
 * login). Every one of them is injected, so this file has no Electron import
 * and the unit tests can watch what it *asked* for.
 */
import type { CapygenStore } from "@capygen/db";
import {
  DEFAULT_GLOBAL_SETTINGS,
  type GlobalSettings,
  type GlobalSettingsPatch,
  type GlobalSettingsSection,
} from "@capygen/shared";
import type { Broadcast, EngineLogger } from "../engine/types.js";

/** The OS-level switches a settings change can flip. All injected. */
export interface SettingsPlatform {
  /** `nativeTheme.themeSource = …` plus repainting the window backgrounds. */
  applyTheme?: (theme: GlobalSettings["appearance"]["theme"]) => void;
  /** `app.setLoginItemSettings({openAtLogin})` — Windows Run key. */
  setStartWithWindows?: (enabled: boolean) => void;
  /** Reported so the tray can stop asking the flat row (it still may). */
  applyCloseToTray?: (enabled: boolean) => void;
  /** Turned off wholesale by `notifications.enabled` (R19). */
  applyNotifications?: (settings: GlobalSettings["notifications"]) => void;
}

export interface SettingsServiceDeps {
  store: CapygenStore;
  broadcast: Broadcast;
  log: EngineLogger;
  platform?: SettingsPlatform;
}

export class SettingsService {
  constructor(private readonly deps: SettingsServiceDeps) {}

  /** `settings.getAll`. */
  all(): GlobalSettings {
    return this.deps.store.globalSettings.all();
  }

  /** `settings.patch` — deep merge, project, apply, broadcast. */
  patch(patch: GlobalSettingsPatch): GlobalSettings {
    const next = this.deps.store.globalSettings.patch(patch);
    this.afterWrite(next, Object.keys(patch));
    return next;
  }

  /** `settings.reset`. */
  reset(section: GlobalSettingsSection): GlobalSettings {
    const next = this.deps.store.globalSettings.reset(section);
    this.afterWrite(next, [section]);
    return next;
  }

  /**
   * Called once at start-up: pushes the stored settings at the OS without
   * writing anything, so a profile restored from disk starts in the theme and
   * login state it was left in.
   */
  applyOnStart(): GlobalSettings {
    const settings = this.all();
    this.applyPlatform(settings);
    return settings;
  }

  private afterWrite(next: GlobalSettings, touched: string[]): void {
    this.project(next);
    this.applyPlatform(next);
    this.deps.log.info(`[settings] updated ${touched.join(",") || "(nothing)"}`);
    this.deps.broadcast("settings.changed", { settings: next });
  }

  /** See the table in this file's header. */
  private project(settings: GlobalSettings): void {
    const flat: Record<string, unknown> = {
      theme: settings.appearance.theme,
      defaultBackend: settings.general.defaultBackend,
      defaultModel: settings.general.defaultModel,
      compactionThreshold: clamp(settings.efficiency.compactionThresholdPct / 100, 0.1, 0.95),
      closeToTray: settings.closeToTray,
    };
    // Only when the hub actually has an opinion: an unset global default must
    // leave `SessionRunner`'s existing fallback alone rather than forcing it
    // back to "default" on every unrelated patch.
    if (settings.backends.claude.permissionMode) {
      flat.permissionMode = settings.backends.claude.permissionMode;
    }
    try {
      this.deps.store.settings.patch(flat as never);
    } catch (err) {
      // A projection failure must not lose the hub write that already landed.
      this.deps.log.warn(`[settings] could not project onto the flat row: ${describe(err)}`);
    }
  }

  private applyPlatform(settings: GlobalSettings): void {
    const platform = this.deps.platform;
    if (!platform) return;
    for (const [what, run] of [
      ["theme", () => platform.applyTheme?.(settings.appearance.theme)],
      ["startWithWindows", () => platform.setStartWithWindows?.(settings.startWithWindows)],
      ["closeToTray", () => platform.applyCloseToTray?.(settings.closeToTray)],
      ["notifications", () => platform.applyNotifications?.(settings.notifications)],
    ] as const) {
      try {
        run();
      } catch (err) {
        // One failing switch (a locked Run key, say) must not stop the others.
        this.deps.log.warn(`[settings] applying ${what} failed: ${describe(err)}`);
      }
    }
  }
}

/**
 * The flat row a brand-new profile should start from, derived from the hub's
 * defaults rather than restated — so the two shapes cannot drift.
 */
export const PROJECTED_DEFAULTS = {
  theme: DEFAULT_GLOBAL_SETTINGS.appearance.theme,
  defaultBackend: DEFAULT_GLOBAL_SETTINGS.general.defaultBackend,
  defaultModel: DEFAULT_GLOBAL_SETTINGS.general.defaultModel,
  compactionThreshold: DEFAULT_GLOBAL_SETTINGS.efficiency.compactionThresholdPct / 100,
  closeToTray: DEFAULT_GLOBAL_SETTINGS.closeToTray,
} as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
