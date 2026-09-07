/**
 * The one authority for user preferences, and the things the app does when they
 * change (SPEC R19, R21, R30).
 *
 * [7-P1] There used to be two mutable authorities. `GlobalSettings` was the hub
 * the user edited, Phase 2's flat `Settings` row was what `SessionRunner`, the
 * renderer and the workspace pane actually read, and `settings.patch`
 * *projected* the overlapping fields from one onto the other. `settings.set`
 * wrote the flat row directly — bypassing the hub, the platform effects and the
 * `settings.changed` broadcast — and the next `settings.patch` silently reverted
 * it. Now:
 *
 *  - **`GlobalSettings` is the only storage** for every overlapping preference
 *    (`SETTINGS_COMPAT_FIELDS`). The flat row keeps only the three that have no
 *    canonical home (`SETTINGS_FLAT_ONLY_FIELDS`: `hopCap`, `showThinking`,
 *    `uiFontSize`), and arbitrary internal `getRaw`/`setRaw` bookkeeping.
 *  - **`settings.get`/`.set` are compatibility views.** A read derives the
 *    overlapping fields from the canonical object; a write translates them onto
 *    it and applies the same platform effects and broadcast the hub does, so
 *    both IPC surfaces behave identically.
 *  - **`general.defaultModel` is derived, never stored** — it is the model of
 *    whichever backend is `general.defaultBackend`, resolved through that
 *    backend's own chain (canonical override → its own catalogue default). A
 *    write of it lands on `backends[defaultBackend].model`. It is never a
 *    cross-backend fallback; `resolveModel` in `@capygen/engine` owns that rule
 *    and this file only presents its answer for the selected backend.
 *  - **`permissionMode` is derived** from `backends.claude.permissionMode`, or
 *    the safe `"default"`. `SessionRunner` no longer reads the flat row at all.
 *  - **A row this build must not rewrite** (written by a newer version, or
 *    corrupt) makes the whole preference surface **read-only**: `settings.patch`,
 *    `settings.reset` and every `settings.set` are refused with the reason —
 *    flat-only fields included — the bytes are preserved, and no value is
 *    recovered from a stale flat row. The flat-only preferences stay
 *    *readable*; internal `getRaw`/`setRaw` bookkeeping is unaffected, because
 *    none of it is a user preference.
 *
 * One-time normalisation (`normalizedVersion`) moves a legacy profile's flat
 * `defaultModel`/`permissionMode` onto the canonical rows, and only where the
 * canonical row has no opinion of its own — an existing canonical value always
 * wins. The marker makes it happen once, so a later `reset("backends")` cannot
 * make the legacy alias look unconverted and resurrect it.
 *
 * `apply` is where the OS-facing effects live (theme, close-to-tray, run at
 * login). Every one of them is injected, so this file has no Electron import
 * and the unit tests can watch what it *asked* for.
 */
import type { CapygenStore, GlobalSettingsRead } from "@capygen/db";
import { z } from "zod";
import {
  BackendSchema,
  GlobalEfficiencySchema,
  SettingsSchema,
  deriveDefaultModel,
  SETTINGS_COMPAT_FIELDS,
  SETTINGS_NORMALISED,
  ThemeSchema,
  PermissionModeSchema,
  type ModelCatalogue,
  type GlobalSettings,
  type GlobalSettingsPatch,
  type GlobalSettingsSection,
  type PermissionMode,
  type Settings,
  type SettingsPatch,
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
  /**
   * Each backend's **own** catalogue default, when one is known — Claude's
   * curated first entry, Codex's probed `isDefault`, the first model of the
   * first API provider with a key (`ipc/harnessList.ts`). Read only to fill in
   * the derived `general.defaultModel` view; a backend that cannot answer
   * simply has no derived model, which is the honest answer rather than
   * another backend's id.
   */
  catalogue?: ModelCatalogue;
}

export class SettingsService {
  constructor(private readonly deps: SettingsServiceDeps) {}

  /** The canonical row plus whether it may be written; see `GlobalSettingsRead`. */
  read(): GlobalSettingsRead {
    const read = this.deps.store.globalSettings.read();
    return { ...read, settings: this.derive(read.settings) };
  }

  /** `settings.getAll`. */
  all(): GlobalSettings {
    return this.read().settings;
  }

  /** `settings.patch` — deep merge, apply, broadcast. */
  patch(patch: GlobalSettingsPatch): GlobalSettings {
    const next = this.deps.store.globalSettings.patch(patch);
    return this.afterWrite(next, Object.keys(patch));
  }

  /**
   * `settings.reset`.
   *
   * `reset("backends")` clears every canonical backend override, models
   * included. Because `general.defaultModel` is derived rather than stored,
   * nothing is left behind for the next read to resurrect: the derived value
   * simply falls through to the selected backend's own catalogue default.
   * `reset("general")` restores the general section's own fields and creates no
   * backend override — a section reset must not write a model onto a backend
   * the user never edited.
   */
  reset(section: GlobalSettingsSection): GlobalSettings {
    const next = this.deps.store.globalSettings.reset(section);
    return this.afterWrite(next, [section]);
  }

  // -------------------------------------------------------------------------
  // compatibility view: the flat `Settings` shape
  // -------------------------------------------------------------------------

  /**
   * `settings.get` — the flat shape Phase 2 shipped. The repo is the view (see
   * `SettingsRepo`'s header); this exists so both IPC surfaces read through one
   * object, not because there are two implementations.
   */
  flat(): Settings {
    return this.deps.store.settings.all();
  }

  /**
   * `settings.set` — the same write, expressed in the old shape.
   *
   * The repo puts the canonical half and the flat-only half in **one**
   * transaction, so a failure on either side leaves neither applied.
   * Doing the canonical write first and the flat one after would not have been
   * atomic: the first would already have committed. The OS effects and the
   * broadcast therefore run only once that commit has actually returned.
   */
  setFlat(patch: SettingsPatch): Settings {
    // Every preference write, overlapping or flat-only, needs a writable
    // canonical row — the read-only posture is about the preferences, not
    // about which of the six fields a given call happens to name.
    this.assertWritable();
    const next = this.deps.store.settings.patch(patch);
    // Committed: only now is anything told about it.
    const settings = this.all();
    this.applyPlatform(settings);
    this.deps.broadcast("settings.changed", { settings });
    return next;
  }

  /**
   * A canonical row this build must not rewrite makes the whole settings
   * surface read-only: `settings.patch`, `settings.reset` and every
   * `settings.set`, flat-only fields included.
   *
   * The flat-only preferences are still **readable** — they were never in that
   * row, so they are reported as stored — and internal `getRaw`/`setRaw` state
   * (window geometry, backend session ids) is untouched, because none of it is
   * a user preference. What is refused is changing preferences while the
   * authority that owns them cannot be read.
   */
  private assertWritable(): void {
    const read = this.deps.store.globalSettings.read();
    if (!read.writable) throw new Error(read.reason ?? "the stored settings are read-only");
  }

  // -------------------------------------------------------------------------
  // derivation and one-time normalisation
  // -------------------------------------------------------------------------

  /** Fill in the fields that are views rather than storage. */
  private derive(settings: GlobalSettings): GlobalSettings {
    return {
      ...settings,
      general: {
        ...settings.general,
        defaultModel: deriveDefaultModel(settings, this.deps.catalogue),
      },
    };
  }

  /**
   * Move a legacy profile onto the canonical rows, once.
   *
   * Two cases, and they are opposites — getting them the wrong way round is how
   * a stale flat value overwrites a canonical one:
   *
   *  - **No canonical row at all** (`missing`): this profile predates the
   *    settings hub, so its flat rows *are* its preferences. Only keys that are
   *    **actually present** as rows are migrated — an absent key means the user
   *    never set it, which is a different thing from the schema default
   *    `settings.all()` would report, and migrating that default would fabricate
   *    an opinion nobody expressed.
   *  - **A canonical row this build understands** (`valid`): it wins, whole. No
   *    flat value is consulted at all. The only thing normalised is the row's
   *    *own* stored `general.defaultModel` — the alias an older build persisted
   *    — and only when the selected backend has no explicit model of its own.
   *
   * A row this build must not rewrite (`future`/`corrupt`) is skipped entirely:
   * nothing is recovered from a stale flat row on its behalf.
   *
   * The canonical write and the removal of the overlapping flat keys share one
   * transaction. The keys are **deleted**, not reset through `patch`: this table
   * is key/value and `patch` writes every field of the merged object, so a reset
   * would re-create all six rows and leave the second authority in place.
   */
  normalize(): { converted: boolean; reason?: string } {
    const read = this.deps.store.globalSettings.read();
    if (!read.writable) return { converted: false, reason: read.reason ?? "read-only settings" };
    if (read.settings.normalizedVersion >= SETTINGS_NORMALISED) return { converted: false };

    const next: GlobalSettings = {
      ...read.settings,
      normalizedVersion: SETTINGS_NORMALISED,
      backends: {
        ...read.settings.backends,
        claude: { ...read.settings.backends.claude },
        codex: { ...read.settings.backends.codex },
        api: { ...read.settings.backends.api },
      },
    };

    if (read.state === "missing") {
      // [7-P1] Every legacy value is checked against **its own** schema before
      // it is carried across, and an invalid one is dropped on its own. These
      // are raw JSON rows written by an older build (or edited by hand): a
      // single out-of-range value used to be copied in verbatim, which then
      // failed the whole-object parse — and the migration had already deleted
      // the flat rows it came from, so a profile lost every preference it had
      // because one of them was bad.
      const present = this.deps.store.settings.presentCompatKeys();
      const backend = valid(BackendSchema, present.get("defaultBackend"));
      if (backend) next.general = { ...next.general, defaultBackend: backend };
      const target = next.general.defaultBackend;

      const theme = valid(ThemeSchema, present.get("theme"));
      if (theme) next.appearance = { ...next.appearance, theme };

      const tray = valid(z.boolean(), present.get("closeToTray"));
      if (tray !== null) next.closeToTray = tray;

      const threshold = valid(
        SettingsSchema.shape.compactionThreshold,
        present.get("compactionThreshold"),
      );
      if (threshold !== null) {
        const pct = Math.round(threshold * 100);
        const asPct = valid(GlobalEfficiencySchema.shape.compactionThresholdPct, pct);
        if (asPct !== null) {
          next.efficiency = { ...next.efficiency, compactionThresholdPct: asPct };
        }
      }

      // A model is free-form, so "valid" only means a non-empty string. It is
      // migrated as an explicit choice **only** because the row exists — the
      // schema's own default is never migrated, since an absent key never
      // reaches `presentCompatKeys`.
      const model = present.get("defaultModel");
      if (typeof model === "string" && model.trim()) {
        (next.backends[target] as Record<string, unknown>).model = model.trim();
      }

      const mode = valid(PermissionModeSchema, present.get("permissionMode"));
      // Claude only. The old flat scalar was one app-wide value, and the
      // accepted contract deliberately stops it propagating to another backend.
      if (mode) next.backends.claude.permissionMode = mode;
    } else {
      // A canonical row this build understands. Its own stored alias is the
      // only legacy value in play, and only where the backend is silent.
      const storedAlias = (read.raw?.general as { defaultModel?: unknown } | undefined)
        ?.defaultModel;
      const backend = next.general.defaultBackend;
      const target = next.backends[backend] as Record<string, unknown>;
      if (!target.model && typeof storedAlias === "string" && storedAlias.trim()) {
        target.model = storedAlias.trim();
      }
    }

    try {
      this.deps.store.db.transaction(() => {
        this.deps.store.globalSettings.replace(next);
        this.deps.store.settings.removeCompatKeys();
      });
    } catch (err) {
      this.deps.log.warn(`[settings] normalisation failed, nothing changed: ${describe(err)}`);
      return { converted: false, reason: describe(err) };
    }
    this.deps.log.info(
      `[settings] normalised a ${read.state} profile onto the canonical settings`,
    );
    return { converted: true };
  }

  /**
   * Called once at start-up: normalises a legacy profile, then pushes the
   * stored settings at the OS without writing anything else, so a profile
   * restored from disk starts in the theme and login state it was left in.
   */
  applyOnStart(): GlobalSettings {
    this.normalize();
    const settings = this.all();
    this.applyPlatform(settings);
    return settings;
  }

  private afterWrite(next: GlobalSettings, touched: string[]): GlobalSettings {
    const derived = this.derive(next);
    this.applyPlatform(derived);
    this.deps.log.info(`[settings] updated ${touched.join(",") || "(nothing)"}`);
    this.deps.broadcast("settings.changed", { settings: derived });
    return derived;
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
 * One raw legacy value against its own schema: the parsed value, or `null` when
 * it does not belong. Per field on purpose — see `normalize`.
 */
function valid<T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }, value: unknown): T | null {
  if (value === undefined) return null;
  const parsed = schema.safeParse(value);
  return parsed.success && parsed.data !== undefined ? parsed.data : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
