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
import type {
  Agent,
  AgentConfig,
  Backend,
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
 * The model an agent runs on: its own, else the global default for its
 * backend, else the app-wide `general.defaultModel`. A harness is never given
 * an empty model string — COMPAT.md's Claude row is explicit that the account
 * default must never be relied on.
 */
export function effectiveModel(
  global: GlobalSettings,
  agent: Pick<Agent, "backend" | "model">,
): string {
  if (agent.model && agent.model.length > 0) return agent.model;
  if (agent.backend === "api" && global.backends.api.model) return global.backends.api.model;
  return global.general.defaultModel;
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
