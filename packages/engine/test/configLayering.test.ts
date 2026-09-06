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
  effectiveModel,
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

describe("effective model", () => {
  it("prefers the agent's own, then the api default, then the app default", () => {
    const global = globalWith({
      general: { ...DEFAULT_GLOBAL_SETTINGS.general, defaultModel: "claude-opus-4-5" },
      backends: { ...DEFAULT_GLOBAL_SETTINGS.backends, api: { model: "gpt-5" } },
    });
    expect(effectiveModel(global, { backend: "claude", model: "claude-haiku-4-5" })).toBe(
      "claude-haiku-4-5",
    );
    expect(effectiveModel(global, { backend: "api", model: "" })).toBe("gpt-5");
    expect(effectiveModel(global, { backend: "claude", model: "" })).toBe("claude-opus-4-5");
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
