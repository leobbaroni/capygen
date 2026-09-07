/**
 * [7-P1] Settings and model **authority**, as regressions.
 *
 * The contract these hold the code to:
 *
 *  - `GlobalSettings` is the only storage for every overlapping preference; the
 *    flat `Settings` row is a compatibility *view*, and `SettingsRepo` — which
 *    shipping code calls directly — is where that view lives.
 *  - `general.defaultModel` is a derived alias of
 *    `backends[general.defaultBackend].model`. It is never persisted, a patch
 *    naming it lands on the canonical field, and a reset cannot resurrect it.
 *  - Migration runs **once**, and only in the direction that cannot lose data:
 *    an absent canonical row takes the flat keys that are actually present; a
 *    valid canonical row wins whole and ignores every flat opinion.
 *  - A canonical row this build must not rewrite refuses every settings write,
 *    through either surface, while flat-only and internal state keep working.
 *  - Model resolution is per backend, with each backend's own fallback, and
 *    never borrows another backend's model.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openStore, type CapygenStore } from "@capygen/db";
import {
  BUILTIN_BACKEND_DEFAULT_MODEL,
  DEFAULT_GLOBAL_SETTINGS,
  DEFAULT_SETTINGS,
  SETTINGS_NORMALISED,
  type HarnessInfo,
} from "@capygen/shared";
import { SettingsService } from "../src/integrations/SettingsService.js";
import { checkModelSelection } from "../src/ipc/modelSelection.js";
import { CLAUDE_MODELS } from "../src/ipc/harnessList.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));

let dir: string;
let store: CapygenStore;
let events: { channel: string; payload: unknown }[];
let applied: string[];

function service(catalogue?: (backend: string) => string | null): SettingsService {
  return new SettingsService({
    store,
    broadcast: (channel, payload) => void events.push({ channel, payload }),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...(catalogue ? { catalogue: catalogue as never } : {}),
    platform: {
      applyTheme: (theme) => applied.push(`theme:${theme}`),
      setStartWithWindows: (on) => applied.push(`login:${on}`),
      applyCloseToTray: (on) => applied.push(`tray:${on}`),
    },
  });
}

/** Write a raw flat key the way a pre-hub build did. */
function legacyFlat(values: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(values)) store.settings.setRaw(key, value);
}

function rawCanonical(): Record<string, unknown> | undefined {
  const row = store.db.get<{ value_json: string }>(
    "SELECT value_json FROM settings WHERE key = ?",
    "global_settings",
  );
  return row ? (JSON.parse(row.value_json) as Record<string, unknown>) : undefined;
}

function flatKeyExists(key: string): boolean {
  const row = store.db.get<{ key: string }>("SELECT key FROM settings WHERE key = ?", key);
  return row !== undefined && row !== null;
}

beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "capygen-settings-")));
  store = openStore(path.join(dir, "capygen.db"), { migrationsDir: MIGRATIONS_DIR });
  events = [];
  applied = [];
});

afterEach(() => {
  store.close();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows may still hold a handle; the OS cleans temp eventually */
  }
});

// ---------------------------------------------------------------------------

describe("the flat row is a view, not a second authority", () => {
  it("derives every overlapping field from the canonical object", () => {
    const settings = service();
    settings.patch({
      appearance: { theme: "dark" },
      closeToTray: false,
      efficiency: { compactionThresholdPct: 50 },
      backends: { claude: { permissionMode: "plan", model: "claude-sonnet-4-5" } },
    });

    // Read straight off the repo, the way shipping consumers do.
    const flat = store.settings.all();
    expect(flat.theme).toBe("dark");
    expect(flat.closeToTray).toBe(false);
    expect(flat.compactionThreshold).toBeCloseTo(0.5);
    expect(flat.permissionMode).toBe("plan");
    expect(flat.defaultModel).toBe("claude-sonnet-4-5");
    // …and none of them is stored as a flat row any more.
    for (const key of ["theme", "closeToTray", "permissionMode", "defaultModel"]) {
      expect(flatKeyExists(key)).toBe(false);
    }
  });

  it("translates a flat write onto the canonical row, through the repo itself", () => {
    store.settings.patch({ theme: "dark", permissionMode: "acceptEdits", defaultModel: "claude-haiku-4-5" });
    const canonical = store.globalSettings.all();
    expect(canonical.appearance.theme).toBe("dark");
    expect(canonical.backends.claude.permissionMode).toBe("acceptEdits");
    expect(canonical.backends.claude.model).toBe("claude-haiku-4-5");
    // The alias itself is still not storage.
    expect("defaultModel" in ((rawCanonical()?.general ?? {}) as object)).toBe(false);
  });

  it("keeps the three flat-only preferences and internal state exactly where they are", () => {
    store.settings.patch({ hopCap: 7, showThinking: false, uiFontSize: 16 });
    store.settings.setRaw("engine.backendSession.a1", "sess_123");
    const flat = store.settings.all();
    expect(flat.hopCap).toBe(7);
    expect(flat.showThinking).toBe(false);
    expect(flat.uiFontSize).toBe(16);
    expect(flatKeyExists("hopCap")).toBe(true);
    expect(store.settings.getRaw("engine.backendSession.a1", null)).toBe("sess_123");
  });

  it("a flat write that moves the default backend puts the model on that backend", () => {
    store.settings.patch({ defaultBackend: "codex", defaultModel: "gpt-5-codex" });
    const canonical = store.globalSettings.all();
    expect(canonical.general.defaultBackend).toBe("codex");
    expect(canonical.backends.codex.model).toBe("gpt-5-codex");
    expect(canonical.backends.claude.model).toBeUndefined();
  });
});

describe("the derived defaultModel alias", () => {
  it("is never persisted, and a patch naming only it reaches the canonical field", () => {
    const settings = service();
    settings.patch({ general: { defaultModel: "claude-sonnet-4-5", providers: [] } });
    expect(store.globalSettings.all().backends.claude.model).toBe("claude-sonnet-4-5");
    expect("defaultModel" in ((rawCanonical()?.general ?? {}) as object)).toBe(false);
    expect(settings.all().general.defaultModel).toBe("claude-sonnet-4-5");
  });

  it("falls through to the backend's own built-in default with no catalogue at all", () => {
    // No probe, no callback, no stored model: Claude still has an answer.
    expect(service().all().general.defaultModel).toBe(BUILTIN_BACKEND_DEFAULT_MODEL.claude);
    expect(store.settings.all().defaultModel).toBe(BUILTIN_BACKEND_DEFAULT_MODEL.claude);
  });

  /** The repo-level view and the service must not disagree by a step. */
  it("agrees with the flat repo view once the store is given the same catalogue", () => {
    store.setModelCatalogue((backend) => (backend === "codex" ? "gpt-5-codex" : null));
    const settings = service((backend) => (backend === "codex" ? "gpt-5-codex" : null));
    settings.patch({ general: { defaultBackend: "codex" } });
    expect(settings.all().general.defaultModel).toBe("gpt-5-codex");
    expect(store.settings.all().defaultModel).toBe("gpt-5-codex");
  });

  it("uses the selected backend's own catalogue, never another backend's model", () => {
    const settings = service((backend) => (backend === "codex" ? "gpt-5-codex" : null));
    settings.patch({
      general: { defaultBackend: "codex" },
      backends: { claude: { model: "claude-sonnet-4-5" } },
    });
    expect(settings.all().general.defaultModel).toBe("gpt-5-codex");
  });

  it("is empty rather than borrowed when the selected backend can name nothing", () => {
    const settings = service();
    settings.patch({ general: { defaultBackend: "api" }, backends: { claude: { model: "claude-sonnet-4-5" } } });
    expect(settings.all().general.defaultModel).toBe("");
  });

  it("survives reset('backends') without resurrecting anything", () => {
    const settings = service();
    settings.patch({ general: { defaultModel: "claude-sonnet-4-5", providers: [] } });
    settings.reset("backends");
    expect(store.globalSettings.all().backends.claude.model).toBeUndefined();
    expect("defaultModel" in ((rawCanonical()?.general ?? {}) as object)).toBe(false);
    // Back to the built-in, not to the model that was just cleared.
    expect(settings.all().general.defaultModel).toBe(BUILTIN_BACKEND_DEFAULT_MODEL.claude);
  });
});

describe("one-time normalisation", () => {
  it("migrates only the flat keys actually present, when there is no canonical row", () => {
    legacyFlat({ theme: "dark", defaultModel: "claude-sonnet-4-5", permissionMode: "acceptEdits" });
    // `defaultBackend`, `closeToTray` and `compactionThreshold` were never set.
    const settings = service();
    expect(settings.normalize().converted).toBe(true);

    const canonical = store.globalSettings.all();
    expect(canonical.appearance.theme).toBe("dark");
    expect(canonical.backends.claude.model).toBe("claude-sonnet-4-5");
    expect(canonical.backends.claude.permissionMode).toBe("acceptEdits");
    // Absent keys stayed absent — no fabricated opinion.
    expect(canonical.general.defaultBackend).toBe(DEFAULT_GLOBAL_SETTINGS.general.defaultBackend);
    expect(canonical.closeToTray).toBe(DEFAULT_GLOBAL_SETTINGS.closeToTray);
    expect(canonical.efficiency.compactionThresholdPct).toBe(
      DEFAULT_GLOBAL_SETTINGS.efficiency.compactionThresholdPct,
    );
    expect(canonical.normalizedVersion).toBe(SETTINGS_NORMALISED);
  });

  it("deletes the overlapping flat keys rather than resetting them", () => {
    legacyFlat({ theme: "dark", defaultModel: "claude-sonnet-4-5", hopCap: 9 });
    service().normalize();
    // Gone, not rewritten as defaults — a reset through `patch` would have
    // re-created all six rows and left the second authority in place.
    for (const key of ["theme", "defaultModel", "permissionMode", "defaultBackend", "closeToTray", "compactionThreshold"]) {
      expect(flatKeyExists(key)).toBe(false);
    }
    expect(store.settings.all().hopCap).toBe(9);
  });

  it("lets an existing canonical row win whole, ignoring every flat opinion", () => {
    // A canonical row this build wrote, plus stale flat rows from before it.
    store.globalSettings.patch({
      appearance: { theme: "light" },
      backends: { claude: { model: "claude-opus-4-5", permissionMode: "default" } },
    });
    legacyFlat({ theme: "dark", defaultModel: "stale-model", permissionMode: "bypassPermissions" });

    expect(service().normalize().converted).toBe(true);
    const canonical = store.globalSettings.all();
    expect(canonical.appearance.theme).toBe("light");
    expect(canonical.backends.claude.model).toBe("claude-opus-4-5");
    expect(canonical.backends.claude.permissionMode).toBe("default");
  });

  it("normalises an older canonical row's own stored alias, once, only where the backend is silent", () => {
    // What an older build persisted: the alias inside the canonical row.
    store.settings.setRaw("global_settings", {
      version: 1,
      general: { defaultBackend: "claude", defaultModel: "claude-sonnet-4-5", providers: [] },
    });
    expect(service().normalize().converted).toBe(true);
    expect(store.globalSettings.all().backends.claude.model).toBe("claude-sonnet-4-5");
  });

  it("leaves an older canonical row's alias alone when that backend already has a model", () => {
    store.settings.setRaw("global_settings", {
      version: 1,
      general: { defaultBackend: "claude", defaultModel: "stale-alias", providers: [] },
      backends: { claude: { model: "claude-haiku-4-5" } },
    });
    service().normalize();
    expect(store.globalSettings.all().backends.claude.model).toBe("claude-haiku-4-5");
  });

  it("runs once: a later reset cannot make it migrate a stale value again", () => {
    legacyFlat({ defaultModel: "claude-sonnet-4-5", providers: [] });
    const settings = service();
    settings.normalize();
    expect(store.globalSettings.all().backends.claude.model).toBe("claude-sonnet-4-5");

    settings.reset("all");
    expect(store.globalSettings.all().normalizedVersion).toBe(SETTINGS_NORMALISED);
    expect(settings.normalize().converted).toBe(false);
    expect(store.globalSettings.all().backends.claude.model).toBeUndefined();
  });

  it("skips a row this build must not rewrite, recovering nothing from the flat row", () => {
    store.settings.setRaw("global_settings", { version: 99, appearance: { theme: "dark" } });
    legacyFlat({ defaultModel: "stale-model", permissionMode: "bypassPermissions" });
    const result = service().normalize();
    expect(result.converted).toBe(false);
    expect(result.reason).toMatch(/newer version/i);
    expect(rawCanonical()).toMatchObject({ version: 99 });
    // Safe defaults, and no permission mode recovered from the stale row.
    expect(store.settings.all().permissionMode).toBe("default");
  });
});

describe("a read-only canonical row", () => {
  beforeEach(() => {
    store.db.run(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
      "global_settings",
      "{not json",
      Date.now(),
    );
  });

  it("refuses both settings surfaces, and preserves its bytes", () => {
    const settings = service();
    expect(() => settings.patch({ appearance: { theme: "dark" } })).toThrow(/could not read/i);
    expect(() => settings.setFlat({ theme: "dark" })).toThrow(/could not read/i);
    expect(() => settings.reset("all")).toThrow(/could not read/i);
    const row = store.db.get<{ value_json: string }>(
      "SELECT value_json FROM settings WHERE key = ?",
      "global_settings",
    );
    expect(row?.value_json).toBe("{not json");
    expect(events).toEqual([]);
  });

  it("refuses flat-only preference writes too, through both layers", () => {
    // The read-only posture is about the preferences, not about which of the
    // six overlapping fields a call happens to name.
    const settings = service();
    expect(() => settings.setFlat({ hopCap: 11 })).toThrow(/could not read/i);
    expect(() => store.settings.patch({ hopCap: 11 })).toThrow(/could not read/i);
    expect(flatKeyExists("hopCap")).toBe(false);
  });

  it("still reports readable flat-only values, and internal state stays writable", () => {
    // Written while the canonical row was still fine.
    store.db.run("DELETE FROM settings WHERE key = ?", "global_settings");
    store.settings.patch({ hopCap: 9, uiFontSize: 17 });
    store.db.run(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
      "global_settings",
      "{not json",
      Date.now(),
    );
    expect(store.settings.all().hopCap).toBe(9);
    expect(store.settings.all().uiFontSize).toBe(17);
    // Not a preference: backend session ids and window geometry keep working.
    store.settings.setRaw("engine.backendSession.a1", "sess_9");
    expect(store.settings.getRaw("engine.backendSession.a1", null)).toBe("sess_9");
  });
});

describe("setFlat commits before it announces", () => {
  it("applies OS effects and broadcasts only after a successful write", () => {
    const settings = service();
    settings.setFlat({ theme: "dark", hopCap: 5 });
    expect(store.globalSettings.all().appearance.theme).toBe("dark");
    expect(store.settings.all().hopCap).toBe(5);
    expect(applied).toContain("theme:dark");
    expect(events.map((e) => e.channel)).toEqual(["settings.changed"]);
  });

  /**
   * The half that fails second is the one that proves atomicity. Doing the
   * canonical write first and the flat one after leaves the canonical write
   * already committed when the second throws — "canonical-first" is an order,
   * not a transaction.
   */
  it("rolls the canonical write back when the flat-only half fails", () => {
    const settings = service();
    settings.patch({ appearance: { theme: "light" } });
    const realRun = store.db.run.bind(store.db);
    const run = vi
      .spyOn(store.db, "run")
      .mockImplementation((sql: string, ...params: unknown[]) => {
        if (params[0] === "hopCap") throw new Error("disk full");
        return realRun(sql, ...(params as never[]));
      });
    try {
      expect(() => store.settings.patch({ theme: "dark", hopCap: 5 })).toThrow(/disk full/);
    } finally {
      run.mockRestore();
    }
    // Neither half landed.
    expect(store.globalSettings.all().appearance.theme).toBe("light");
    expect(flatKeyExists("hopCap")).toBe(false);
  });

  /**
   * The same failure through the service, which is the layer that also has OS
   * effects and a broadcast to get wrong: a partially applied write that has
   * already told the tray and both windows about itself is worse than one that
   * simply failed.
   */
  it("through the service: no effects, no broadcast, original rows intact", () => {
    const settings = service();
    settings.patch({ appearance: { theme: "light" } });
    store.settings.patch({ hopCap: 4 });
    const bytesBefore = rawCanonical();
    applied.length = 0;
    events.length = 0;

    const realRun = store.db.run.bind(store.db);
    const run = vi
      .spyOn(store.db, "run")
      .mockImplementation((sql: string, ...params: unknown[]) => {
        if (params[0] === "hopCap") throw new Error("disk full");
        return realRun(sql, ...(params as never[]));
      });
    try {
      expect(() => settings.setFlat({ theme: "dark", hopCap: 5 })).toThrow(/disk full/);
    } finally {
      run.mockRestore();
    }

    expect(store.globalSettings.all().appearance.theme).toBe("light");
    expect(store.settings.all().hopCap).toBe(4);
    expect(rawCanonical()).toEqual(bytesBefore);
    expect(applied).toEqual([]);
    expect(events).toEqual([]);
  });

  it("writes neither half when the canonical half is refused", () => {
    store.settings.setRaw("global_settings", { version: 99 });
    const settings = service();
    expect(() => settings.setFlat({ theme: "dark", hopCap: 5 })).toThrow(/newer version/i);
    // The flat-only half of the same call is not written either: a refusal is
    // all-or-nothing, not "the part that happened to be allowed".
    expect(store.settings.all().hopCap).toBe(DEFAULT_SETTINGS.hopCap);
    expect(flatKeyExists("hopCap")).toBe(false);
    expect(applied).toEqual([]);
    expect(events).toEqual([]);
  });
});

describe("model selection is checked before anything is written", () => {
  const harnesses: HarnessInfo[] = [
    {
      backend: "claude",
      label: "Claude Code",
      available: true,
      models: [
        { id: "claude-opus-4-5", label: "Claude Opus 4.5" },
        { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
      ],
      defaultModel: "claude-opus-4-5",
      providers: [],
    },
    {
      backend: "codex",
      label: "Codex",
      available: true,
      models: [{ id: "gpt-5-codex", label: "GPT-5 Codex" }],
      defaultModel: "gpt-5-codex",
      providers: [],
    },
    { backend: "api", label: "API model", available: false, models: [], defaultModel: "", providers: [] },
  ];

  function deps(mutate?: (s: SettingsService) => void) {
    const settings = service();
    mutate?.(settings);
    return { settings: () => settings.all(), harnesses: () => harnesses };
  }

  it("accepts an unknown id: a custom or new model is not a typo", () => {
    const check = checkModelSelection(
      { settings: () => DEFAULT_GLOBAL_SETTINGS, harnesses: () => harnesses },
      { backend: "codex", model: "my-org/custom-tuned-v3" },
    );
    expect(check).toEqual({ ok: true, model: "my-org/custom-tuned-v3" });
  });

  it("refuses a model another backend certainly owns", () => {
    const check = checkModelSelection(deps(), { backend: "codex", model: "claude-opus-4-5" });
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/claude offers/i);
  });

  it("refuses a resolved canonical default that is wrong for its own backend", () => {
    // Nothing explicit on the agent — the mistake is in the stored default.
    const check = checkModelSelection(
      deps((s) => s.patch({ backends: { codex: { model: "claude-opus-4-5" } } })),
      { backend: "codex", model: "" },
    );
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/would run "claude-opus-4-5"/);
  });

  it("says nothing about a backend whose catalogue is empty right now", () => {
    const check = checkModelSelection(deps(), { backend: "api", model: "claude-opus-4-5" });
    // `provider` is the one an `api` dispatch would really use; see the
    // effective-provider block below.
    expect(check).toEqual({ ok: true, model: "claude-opus-4-5", provider: "anthropic" });
  });

  it("resolves through the backend's own built-in default with no catalogue", () => {
    const check = checkModelSelection(
      { settings: () => DEFAULT_GLOBAL_SETTINGS, harnesses: () => [] },
      { backend: "claude", model: "" },
    );
    expect(check).toEqual({ ok: true, model: BUILTIN_BACKEND_DEFAULT_MODEL.claude });
  });

  it("refuses when a backend can name no model at all", () => {
    const check = checkModelSelection(
      { settings: () => DEFAULT_GLOBAL_SETTINGS, harnesses: () => [] },
      { backend: "codex", model: "", name: "reviewer" },
    );
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/"reviewer".*no model is selected for the codex backend/s);
  });
});

/** The built-in fallback must name a model the curated catalogue actually offers. */
describe("the built-in Claude default matches the shipped catalogue", () => {
  it("is the curated list's first entry", () => {
    expect(BUILTIN_BACKEND_DEFAULT_MODEL.claude).toBe(CLAUDE_MODELS[0]?.id);
  });
});

/**
 * [7-P1 review] Ambiguous input has a documented rule rather than an accident.
 */
describe("a patch naming both the alias and the canonical field", () => {
  it("lets the explicit backends[selected].model win", () => {
    const settings = service();
    settings.patch({
      general: { defaultModel: "claude-haiku-4-5", providers: [] },
      backends: { claude: { model: "claude-sonnet-4-5" } },
    });
    // The explicit canonical field names the storage; the alias is a view of it.
    expect(store.globalSettings.all().backends.claude.model).toBe("claude-sonnet-4-5");
    expect(settings.all().general.defaultModel).toBe("claude-sonnet-4-5");
  });

  it("still applies the alias when the same patch names no explicit model", () => {
    const settings = service();
    settings.patch({
      general: { defaultModel: "claude-haiku-4-5", providers: [] },
      backends: { claude: { permissionMode: "plan" } },
    });
    expect(store.globalSettings.all().backends.claude.model).toBe("claude-haiku-4-5");
    expect(store.globalSettings.all().backends.claude.permissionMode).toBe("plan");
  });

  it("targets the backend the same patch selects", () => {
    const settings = service();
    settings.patch({
      general: { defaultBackend: "codex", defaultModel: "gpt-5-codex", providers: [] },
      backends: { codex: { model: "gpt-5.5-codex" } },
    });
    expect(store.globalSettings.all().backends.codex.model).toBe("gpt-5.5-codex");
    expect(store.globalSettings.all().backends.claude.model).toBeUndefined();
  });
});

/**
 * [7-P1 review] A legacy row is raw JSON an older build wrote, or a person
 * edited. One bad value must cost only itself.
 */
describe("legacy fields are validated one at a time", () => {
  it("drops an out-of-range value and keeps its valid siblings", () => {
    legacyFlat({
      theme: "dark",
      compactionThreshold: 999,
      defaultModel: "claude-sonnet-4-5",
      permissionMode: "acceptEdits",
    });
    expect(service().normalize().converted).toBe(true);

    const canonical = store.globalSettings.all();
    // The bad one is ignored…
    expect(canonical.efficiency.compactionThresholdPct).toBe(
      DEFAULT_GLOBAL_SETTINGS.efficiency.compactionThresholdPct,
    );
    // …and everything beside it still made the trip.
    expect(canonical.appearance.theme).toBe("dark");
    expect(canonical.backends.claude.model).toBe("claude-sonnet-4-5");
    expect(canonical.backends.claude.permissionMode).toBe("acceptEdits");
    expect(canonical.normalizedVersion).toBe(SETTINGS_NORMALISED);
  });

  it("leaves the canonical row readable afterwards", () => {
    // The failure this guards: an unvalidated value reached the row, the next
    // read could not parse it, and the flat rows it came from were already gone.
    legacyFlat({ compactionThreshold: 999, theme: "dark", hopCap: 8 });
    service().normalize();
    expect(store.globalSettings.read().state).toBe("valid");
    expect(store.globalSettings.read().writable).toBe(true);
    expect(store.settings.all().theme).toBe("dark");
    expect(store.settings.all().hopCap).toBe(8);
  });

  it("ignores a legacy value of the wrong type entirely", () => {
    legacyFlat({ theme: 42, permissionMode: "not-a-mode", defaultBackend: "nope", closeToTray: false });
    service().normalize();
    const canonical = store.globalSettings.all();
    expect(canonical.appearance.theme).toBe(DEFAULT_GLOBAL_SETTINGS.appearance.theme);
    expect(canonical.backends.claude.permissionMode).toBeUndefined();
    expect(canonical.general.defaultBackend).toBe(DEFAULT_GLOBAL_SETTINGS.general.defaultBackend);
    // The one good value still crossed.
    expect(canonical.closeToTray).toBe(false);
  });

  it("never migrates a schema-filled default as though it were a choice", () => {
    // Nothing was ever set: `settings.all()` would report six defaults, but no
    // row exists for any of them, so nothing is an expressed preference.
    expect(service().normalize().converted).toBe(true);
    const raw = rawCanonical();
    expect((raw?.backends as Record<string, { model?: string }>).claude?.model).toBeUndefined();
    expect((raw?.backends as Record<string, { permissionMode?: string }>).claude?.permissionMode)
      .toBeUndefined();
  });
});

/**
 * [7-P1 review] The three flat-only preferences are stored per key, so they
 * must be read and written per key.
 */
describe("flat-only preferences stand alone", () => {
  it("a corrupt row costs only itself", () => {
    store.settings.patch({ hopCap: 9, showThinking: false, uiFontSize: 17 });
    // As if an older build (or a hand edit) left one bad value behind.
    store.settings.setRaw("hopCap", 900);
    const flat = store.settings.all();
    expect(flat.hopCap).toBe(DEFAULT_SETTINGS.hopCap);
    expect(flat.showThinking).toBe(false);
    expect(flat.uiFontSize).toBe(17);
  });

  it("refuses an invalid write instead of storing it behind a default", () => {
    expect(() => store.settings.patch({ hopCap: 900 })).toThrow(/hopCap/);
    // Nothing was written, so nothing is hidden: the row and the read agree.
    expect(flatKeyExists("hopCap")).toBe(false);
    expect(store.settings.all().hopCap).toBe(DEFAULT_SETTINGS.hopCap);
  });

  it("does not write the valid half of a mixed invalid call", () => {
    expect(() => store.settings.patch({ showThinking: false, uiFontSize: 99 })).toThrow(
      /uiFontSize/,
    );
    expect(flatKeyExists("showThinking")).toBe(false);
  });
});

/**
 * [7-P1 review] `version`, `normalizedVersion` and `telemetry` are owned by the
 * schema, the migration and the app's local-only promise — not by a settings
 * page. The patch schema leaves them out, but it is `.passthrough()`.
 */
describe("reserved fields survive an arbitrary passthrough patch", () => {
  it("refuses a patch that tries to change one, and writes nothing", () => {
    const settings = service();
    legacyFlat({ defaultModel: "claude-sonnet-4-5", providers: [] });
    settings.normalize();

    for (const patch of [
      { normalizedVersion: 0 },
      { version: 99 },
      { telemetry: true },
    ] as never[]) {
      expect(() => settings.patch({ appearance: { theme: "dark" }, ...(patch as object) })).toThrow(
        /not something a settings page sets/,
      );
    }
    // The whole patch failed, so the field beside the reserved one is untouched.
    expect(store.globalSettings.all().appearance.theme).toBe(
      DEFAULT_GLOBAL_SETTINGS.appearance.theme,
    );
    expect(store.globalSettings.all().normalizedVersion).toBe(SETTINGS_NORMALISED);
  });

  it("accepts a patch that echoes the values it read", () => {
    // A settings page sending the whole object back is not asking for a change
    // and must not be made to fail.
    const settings = service();
    legacyFlat({ defaultModel: "claude-sonnet-4-5", providers: [] });
    settings.normalize();
    const current = settings.all();

    settings.patch({
      appearance: { theme: "dark" },
      version: current.version,
      normalizedVersion: current.normalizedVersion,
      telemetry: false,
    } as never);

    const canonical = store.globalSettings.all();
    expect(canonical.appearance.theme).toBe("dark");
    expect(canonical.normalizedVersion).toBe(SETTINGS_NORMALISED);
    expect(canonical.version).toBe(DEFAULT_GLOBAL_SETTINGS.version);
    expect(canonical.telemetry).toBe(false);
    // …and the profile is still converted, so nothing migrates again.
    expect(settings.normalize().converted).toBe(false);
    expect(store.globalSettings.all().backends.claude.model).toBe("claude-sonnet-4-5");
  });
});

/**
 * [7-P1] `api` model resolution is **per provider**, and the provider is a
 * per-agent choice.
 *
 * `harness.list` reports one flattened `api` row whose `defaultModel` comes from
 * the *global* provider, so resolving from it hands an agent — or a delegated
 * child — that selects a provider of its own the wrong catalogue's first model.
 * `checkModelSelection` takes the effective section instead; this is the seam
 * `SessionRunner` uses for an agent and `resolveTarget` uses for a delegated
 * child, so both are covered here. (An end-to-end delegated **api** child is not
 * reachable offline: an `api` parent's route to `api` is same-backend model
 * routing rather than delegation, and only `api` agents get the
 * `delegate_task` tool — a Claude parent's copy lives behind the Claude SDK's
 * in-process MCP server.)
 */
describe("api model resolution follows the effective provider", () => {
  const harnesses: HarnessInfo[] = [
    {
      backend: "claude",
      label: "Claude Code",
      available: true,
      models: [{ id: "claude-opus-4-5", label: "Claude Opus 4.5" }],
      defaultModel: "claude-opus-4-5",
      providers: [],
    },
    {
      backend: "codex",
      label: "Codex",
      available: true,
      models: [{ id: "gpt-5-codex", label: "GPT-5 Codex" }],
      defaultModel: "gpt-5-codex",
      providers: [],
    },
    {
      backend: "api",
      label: "API model",
      available: true,
      // Flattened, as the picker sees it: both keyed providers' lists.
      models: [
        { id: "claude-opus-4-5", label: "Claude Opus 4.5" },
        { id: "gpt-5", label: "GPT-5" },
        { id: "gpt-5-mini", label: "GPT-5 mini" },
      ],
      // Derived from the *global* provider — the value that must not be used
      // for an agent that picks its own.
      defaultModel: "claude-opus-4-5",
      providers: ["anthropic", "openai"],
    },
  ];

  function check(
    globalProvider: string | undefined,
    config: Record<string, unknown> | null,
    model = "",
    canonicalModel?: string,
  ) {
    const settings = service();
    settings.patch({
      backends: {
        api: {
          ...(globalProvider ? { provider: globalProvider } : {}),
          ...(canonicalModel ? { model: canonicalModel } : {}),
        },
      },
    } as never);
    return checkModelSelection(
      { settings: () => settings.all(), harnesses: () => harnesses },
      { backend: "api", model, config, name: "capy" },
    );
  }

  it("uses the agent's own provider default, not the global one", () => {
    // Global says OpenAI; the agent says Anthropic and names no model.
    expect(check("openai", { provider: "anthropic" })).toEqual({
      ok: true,
      model: "claude-opus-4-5",
      provider: "anthropic",
    });
  });

  it("and the inverse: an OpenAI agent under an Anthropic global", () => {
    expect(check("anthropic", { provider: "openai" })).toEqual({
      ok: true,
      model: "gpt-5",
      provider: "openai",
    });
  });

  it("keeps the canonical model ahead of the provider catalogue", () => {
    expect(check("openai", { provider: "openai" }, "", "gpt-5-mini")).toEqual({
      ok: true,
      model: "gpt-5-mini",
      provider: "openai",
    });
  });

  it("keeps an explicit model ahead of everything", () => {
    expect(check("openai", { provider: "openai" }, "gpt-5", "gpt-5-mini")).toEqual({
      ok: true,
      model: "gpt-5",
      provider: "openai",
    });
  });

  it("refuses a canonical model that belongs to the wrong effective provider", () => {
    // Chosen while the global provider was Anthropic; this agent runs on OpenAI.
    const result = check("anthropic", { provider: "openai" }, "", "claude-opus-4-5");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/anthropic model.*provider is openai/i);
  });

  it("refuses an explicit model that belongs to the wrong effective provider", () => {
    const result = check("openai", { provider: "openai" }, "claude-opus-4-5");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/anthropic model.*provider is openai/i);
  });

  it("allows a custom model on any provider", () => {
    expect(check("openai", { provider: "openai" }, "my-org/tuned-v3")).toEqual({
      ok: true,
      model: "my-org/tuned-v3",
      provider: "openai",
    });
  });

  /**
   * [7-P1] With nothing chosen the fallback is still the provider the harness
   * will really use, so it is reported and it is checked. It was treated as a
   * mere guess and skipped — which let validation pick an OpenAI model while
   * `ApiHarness.resolveConfig` sent it to Anthropic.
   */
  it("reports the provider it resolved, so the caller can materialise it", () => {
    expect(check("openai", { provider: "anthropic" })).toEqual({
      ok: true,
      model: "claude-opus-4-5",
      provider: "anthropic",
    });
  });

  it("reports the fallback provider too — it is what the harness will use", () => {
    // Nothing chosen: the first keyed provider, which is also where the model
    // came from. (Each case gets its own store; `check` only ever adds.)
    expect(check(undefined, null)).toEqual({
      ok: true,
      model: "claude-opus-4-5",
      provider: "anthropic",
    });
  });

  it("falls back to the first keyed provider, and validates against it", () => {
    // OpenAI is the only provider with a key: its first model is the default…
    const openAiOnly = [
      ...harnesses.filter((h) => h.backend !== "api"),
      {
        backend: "api" as const,
        label: "API model",
        available: true,
        models: [
          { id: "gpt-5", label: "GPT-5" },
          { id: "gpt-5-mini", label: "GPT-5 mini" },
        ],
        defaultModel: "gpt-5",
        providers: ["openai" as const],
      },
    ];
    const settings = service();
    const result = checkModelSelection(
      { settings: () => settings.all(), harnesses: () => openAiOnly },
      { backend: "api", model: "", config: null, name: "capy" },
    );
    expect(result).toEqual({ ok: true, model: "gpt-5", provider: "openai" });
  });

  it("refuses a model that the deterministic fallback provider cannot run", () => {
    // Nothing keyed and nothing chosen: the documented built-in is Anthropic,
    // and that is what the harness would really use — so an OpenAI id here is
    // not a valid selection, it is a request that fails at Anthropic.
    const noKeys = harnesses.map((h) =>
      h.backend === "api" ? { ...h, models: [], defaultModel: "", providers: [] } : h,
    );
    const settings = service();
    const result = checkModelSelection(
      { settings: () => settings.all(), harnesses: () => noKeys },
      { backend: "api", model: "gpt-5", config: null, name: "capy" },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/openai model.*provider is anthropic/i);
  });

  /**
   * [7-P1] A custom endpoint is not the public provider. A gateway at a
   * `baseUrl` of its own routinely serves ids from another vendor's catalogue,
   * so the curated lists are no evidence about it and refusing on them blocks a
   * legitimate setup.
   */
  it("makes no catalogue claim about a custom baseUrl", () => {
    expect(
      check("openai", { provider: "openai", baseUrl: "https://gateway.invalid/v1" }, "claude-opus-4-5"),
    ).toEqual({ ok: true, model: "claude-opus-4-5", provider: "openai" });
  });

  it("still checks a model against the public provider it names", () => {
    const result = check("openai", { provider: "openai" }, "claude-opus-4-5");
    expect(result.ok).toBe(false);
  });
});
