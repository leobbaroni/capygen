/**
 * "global → backend default → agent override" (SPEC R30), as three pure
 * functions so the rule has exactly one home.
 *
 * The three layers, lowest first:
 *
 *   1. **the harness's own hardcoded default** — what a `ClaudeHarness` does
 *      when nobody said anything (`permissionMode: "default"`);
 *   2. **the global backend default** — `GlobalSettings.backends.<backend>`,
 *      the floor every agent on that backend starts from;
 *   3. **the per-agent override** — `Agent.config.<backend>`, shipped in
 *      Phase 3 and already the highest priority a harness knows
 *      (`HarnessAgent.permissionMode`; COMPAT.md §Internal seams).
 *
 * Merging is **field by field**, never whole-object: an agent that sets only
 * `effort` must keep the global `permissionMode`, exactly the hazard
 * `mergeGlobalSettingsPatch` documents one level up. An `undefined` field at
 * any layer means "no opinion" and falls through; it never overwrites with
 * `undefined`.
 */
import { resolveBackendModel } from "@capygen/shared";
import type {
  Agent,
  AgentConfig,
  Backend,
  ModelCatalogue,
  ModelResolution,
  PermissionMode,
  GlobalApiDefaults,
  GlobalClaudeDefaults,
  GlobalCodexDefaults,
  GlobalSettings,
} from "@capygen/shared";

/** One backend's effective config for one agent. */
export type EffectiveClaudeConfig = GlobalClaudeDefaults & Record<string, unknown>;
export type EffectiveCodexConfig = GlobalCodexDefaults & Record<string, unknown>;
export type EffectiveApiConfig = GlobalApiDefaults & Record<string, unknown>;

/** Drop keys whose value is `undefined` so a spread cannot un-set a lower layer. */
function defined<T extends Record<string, unknown>>(value: T | undefined | null): Partial<T> {
  if (!value) return {};
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item;
  }
  return out as Partial<T>;
}

/**
 * The config a harness should be built with: the global default for its
 * backend, with the agent's own override laid on top.
 *
 * Returned as the *agent config* shape (`AgentConfig["claude"]` &c.) because
 * that is what `SessionRunner` already hands the harness — the global layer
 * disappears into it rather than becoming a second thing every harness has to
 * learn about.
 */
export function effectiveBackendConfig(
  global: GlobalSettings,
  agentConfig: AgentConfig | null | undefined,
  backend: Backend,
): Record<string, unknown> {
  switch (backend) {
    case "claude":
      return { ...defined(global.backends.claude), ...defined(agentConfig?.claude) };
    case "codex":
      return { ...defined(global.backends.codex), ...defined(agentConfig?.codex) };
    case "api":
      return { ...defined(global.backends.api), ...defined(agentConfig?.api) };
    default:
      return { ...defined(agentConfig?.[backend as "claude"]) };
  }
}

/** The same thing for a whole `Agent` row. */
export function effectiveAgentConfig(
  global: GlobalSettings,
  agent: Pick<Agent, "backend" | "config">,
): Record<string, unknown> {
  return effectiveBackendConfig(global, agent.config, agent.backend);
}

/**
 * [7-P1] Model resolution lives in `@capygen/shared`
 * (`resolveBackendModel`): `@capygen/db` derives the same alias for its flat
 * compatibility view and must not disagree with the runtime by a step. This is
 * the engine-side name for it, plus the `Agent`-shaped overload every caller
 * here actually wants.
 */
export type { ModelCatalogue, ModelResolution, ModelResolutionError } from "@capygen/shared";

export function resolveModel(
  global: GlobalSettings,
  agent: Pick<Agent, "backend" | "model">,
  catalogue?: ModelCatalogue,
): ModelResolution {
  return resolveBackendModel(global, agent.backend, agent.model, catalogue);
}

/** One backend's canonical global defaults, as a plain bag. */
function backendDefaults(global: GlobalSettings, backend: Backend): Record<string, unknown> {
  switch (backend) {
    case "claude":
      return global.backends.claude as Record<string, unknown>;
    case "codex":
      return global.backends.codex as Record<string, unknown>;
    case "api":
      return global.backends.api as Record<string, unknown>;
    default:
      return {};
  }
}

/**
 * The permission mode one agent actually runs under: its own override for its
 * own backend, else the canonical global default for that backend, else the
 * safe `"default"`.
 *
 * [7-P1] The flat `Settings.permissionMode` row is **not** consulted. It was
 * the app-wide fallback for every backend, so a global `bypassPermissions`
 * meant for Claude also loosened an `api` agent — and it is now a derived
 * compatibility view of `backends.claude.permissionMode` anyway, so reading it
 * here would be reading the Claude default under another backend's name.
 * `codex` has no `permissionMode` of its own (`approvalPolicy` is its
 * equivalent, read straight off `config.codex`) and so always answers
 * `"default"` unless something set one explicitly.
 */
export function resolvePermissionMode(
  global: GlobalSettings,
  agentConfig: AgentConfig | null | undefined,
  backend: Backend,
): PermissionMode {
  const effective = effectiveBackendConfig(global, agentConfig, backend);
  const mode = effective.permissionMode;
  return isPermissionMode(mode) ? mode : "default";
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return (
    value === "default" ||
    value === "acceptEdits" ||
    value === "bypassPermissions" ||
    value === "plan"
  );
}

/**
 * The efficiency numbers a harness needs, converted out of the settings hub's
 * units. `compactionThresholdPct` is a percentage because that is what a
 * settings page shows; every consumer wants the fraction (SPEC R25), and
 * `toolOutputCapKb` is bytes by the time a harness truncates with it (R25's
 * 64 KB stub).
 */
export function effectiveEfficiency(global: GlobalSettings): {
  compactionThreshold: number;
  maxToolOutputBytes: number;
  lazyMcpSchemas: boolean;
} {
  return {
    compactionThreshold: global.efficiency.compactionThresholdPct / 100,
    maxToolOutputBytes: global.efficiency.toolOutputCapKb * 1024,
    lazyMcpSchemas: global.efficiency.lazyMcpSchemas,
  };
}
