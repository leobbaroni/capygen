/**
 * Settings layering (SPEC R30).
 *
 * The layering claim under test is the one the settings hub is built on:
 * "global → backend default → agent override", merged **field by field**, so a
 * per-agent override of one key never silently discards the global value of
 * another. That is the same hazard `mergeGlobalSettingsPatch` documents one
 * level up, and it was a real bug in `SettingsRepo.patch` once already.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_GLOBAL_SETTINGS,
  GlobalSettingsSchema,
  type Agent,
} from "@capygen/shared";
import {
  effectiveAgentConfig,
  effectiveBackendConfig,
  effectiveEfficiency,
  resolveModel,
  resolvePermissionMode,
} from "../src/config/index.js";

function globalWith(patch: Record<string, unknown>): ReturnType<typeof GlobalSettingsSchema.parse> {
  return GlobalSettingsSchema.parse({ ...DEFAULT_GLOBAL_SETTINGS, ...patch });
}

describe("global → backend default → agent override", () => {
  const global = globalWith({
    backends: {
      claude: { permissionMode: "acceptEdits", effort: "high" },
      codex: { approvalPolicy: "on-request", sandbox: "workspace-write" },
      api: { provider: "anthropic", model: "claude-sonnet-4-5" },
    },
  });

  it("uses the global default when the agent says nothing", () => {
    expect(effectiveBackendConfig(global, null, "claude")).toEqual({
      permissionMode: "acceptEdits",
      effort: "high",
    });
  });

  it("lets one agent field win without dropping the others", () => {
    expect(
      effectiveBackendConfig(global, { claude: { permissionMode: "plan" } }, "claude"),
    ).toEqual({ permissionMode: "plan", effort: "high" });
  });

  it("never lets an undefined agent field un-set the global one", () => {
    expect(
      effectiveBackendConfig(
        global,
        { claude: { permissionMode: undefined, effort: "low" } },
        "claude",
      ),
    ).toEqual({ permissionMode: "acceptEdits", effort: "low" });
  });

  it("keeps the three backends apart", () => {
    expect(effectiveBackendConfig(global, { claude: { effort: "x" } }, "codex")).toEqual({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    expect(effectiveBackendConfig(global, null, "api")).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    });
  });

  it("falls back to nothing when there is no global opinion", () => {
    expect(effectiveBackendConfig(DEFAULT_GLOBAL_SETTINGS, null, "claude")).toEqual({});
  });

  it("reads a whole agent row", () => {
    const agent = {
      backend: "codex",
      config: { codex: { sandbox: "read-only" } },
    } as Pick<Agent, "backend" | "config">;
    expect(effectiveAgentConfig(global, agent)).toEqual({
      approvalPolicy: "on-request",
      sandbox: "read-only",
    });
  });
});

/**
 * [7-P1] Resolution is **per backend**: an agent's own choice, then the
 * canonical default for its *own* backend, then that backend's own catalogue
 * default — and a refusal if none of those exists. `general.defaultModel` is a
 * derived alias of the selected default backend and is never a fallback for
 * another one; sending a Claude id to Codex is a spawn that fails from a picker
 * that promised something else.
 */
describe("model resolution", () => {
  const global = globalWith({
    general: { ...DEFAULT_GLOBAL_SETTINGS.general, defaultModel: "claude-opus-4-5" },
    backends: {
      ...DEFAULT_GLOBAL_SETTINGS.backends,
      api: { model: "gpt-5" },
      claude: { model: "claude-opus-4-5" },
    },
  });

  it("prefers the agent's own explicit model", () => {
    expect(resolveModel(global, { backend: "claude", model: "claude-haiku-4-5" })).toEqual({
      ok: true,
      model: "claude-haiku-4-5",
    });
  });

  it("falls back to the canonical default for that same backend", () => {
    expect(resolveModel(global, { backend: "api", model: "" })).toEqual({
      ok: true,
      model: "gpt-5",
    });
    expect(resolveModel(global, { backend: "claude", model: "" })).toEqual({
      ok: true,
      model: "claude-opus-4-5",
    });
  });

  it("never borrows another backend's model, and uses the backend's own catalogue", () => {
    // Codex has no canonical model here; the general alias says a Claude id.
    expect(resolveModel(global, { backend: "codex", model: "" })).toEqual({
      ok: false,
      backend: "codex",
      reason: expect.stringContaining("no model is selected for the codex backend"),
    });
    expect(
      resolveModel(global, { backend: "codex", model: "" }, (b) =>
        b === "codex" ? "gpt-5-codex" : "claude-opus-4-5",
      ),
    ).toEqual({ ok: true, model: "gpt-5-codex" });
  });

  it("refuses rather than sending an empty model", () => {
    const bare = resolveModel(DEFAULT_GLOBAL_SETTINGS, { backend: "codex", model: "  " }, () => "");
    expect(bare.ok).toBe(false);
  });
});

/**
 * [7-P1] The flat `Settings.permissionMode` is no longer consulted: it was one
 * app-wide value applied to every backend, so a `bypassPermissions` meant for
 * Claude also loosened an `api` agent.
 */
describe("permission mode resolution", () => {
  it("takes the agent's own override, then the canonical backend default", () => {
    const global = globalWith({
      backends: {
        ...DEFAULT_GLOBAL_SETTINGS.backends,
        claude: { permissionMode: "bypassPermissions" },
      },
    });
    expect(resolvePermissionMode(global, null, "claude")).toBe("bypassPermissions");
    expect(resolvePermissionMode(global, { claude: { permissionMode: "plan" } }, "claude")).toBe(
      "plan",
    );
  });

  it("does not carry one backend's mode to another, and is safe by default", () => {
    const global = globalWith({
      backends: {
        ...DEFAULT_GLOBAL_SETTINGS.backends,
        claude: { permissionMode: "bypassPermissions" },
      },
    });
    expect(resolvePermissionMode(global, null, "api")).toBe("default");
    expect(resolvePermissionMode(global, null, "codex")).toBe("default");
    expect(resolvePermissionMode(DEFAULT_GLOBAL_SETTINGS, null, "claude")).toBe("default");
  });
});

describe("efficiency numbers", () => {
  it("converts the settings-page units into the ones a harness uses", () => {
    expect(effectiveEfficiency(DEFAULT_GLOBAL_SETTINGS)).toEqual({
      compactionThreshold: 0.7,
      maxToolOutputBytes: 64 * 1024,
      lazyMcpSchemas: true,
    });
    const strict = globalWith({
      efficiency: { compactionThresholdPct: 50, toolOutputCapKb: 16, lazyMcpSchemas: false },
    });
    expect(effectiveEfficiency(strict)).toEqual({
      compactionThreshold: 0.5,
      maxToolOutputBytes: 16 * 1024,
      lazyMcpSchemas: false,
    });
  });
});
