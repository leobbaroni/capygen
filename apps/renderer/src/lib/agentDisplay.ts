/**
 * Small display helpers shared by every round-table surface (speaker labels,
 * the composer's `@mention` menu, the agents pane, hover cards, the Add
 * agent dialog): the backend's human label and a per-agent colour/initial —
 * kept in one place so the same agent renders identically everywhere instead
 * of each component re-deriving it.
 *
 * `BACKEND_LABEL` moved here from `Composer.tsx`, which still re-exports
 * nothing — every caller (including Composer itself) imports it from here.
 */
import { AgentConfigSchema, type Agent, type Backend, type HarnessInfo } from "@capygen/shared";

export const BACKEND_LABEL: Record<Backend, string> = {
  claude: "Claude Code",
  codex: "Codex",
  api: "API model",
};

/**
 * Five theme-aware hues — `index.css`'s chart palette, already tuned for
 * both light and dark — cycled by an agent's `order` when it has no explicit
 * `color` (`AgentSchema.color` is a free-form CSS colour string). Enough to
 * tell apart the small number of agents one round-table session realistically
 * carries; a session with more just repeats the cycle.
 */
export const AGENT_COLOR_PALETTE = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
] as const;

export function agentColor(agent: Pick<Agent, "color" | "order">): string {
  if (agent.color) return agent.color;
  return AGENT_COLOR_PALETTE[agent.order % AGENT_COLOR_PALETTE.length] ?? AGENT_COLOR_PALETTE[0];
}

/** First letter of a display name, upper-cased — the avatar glyph. Falls
 *  back to "?" for a blank name, which should not happen in practice
 *  (`displayName` is `min(1)`) but keeps the avatar from rendering empty. */
export function agentInitial(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed[0]!.toUpperCase() : "?";
}

/** Catalogue labels are authoritative; an unknown model keeps its exact identifier. */
export function modelDisplayName(harnesses: readonly HarnessInfo[], backend: Backend, model: string): string {
  return harnesses.find((harness) => harness.backend === backend)?.models.find((entry) => entry.id === model)?.label ?? model;
}
export function supportedEfforts(harnesses: readonly HarnessInfo[], backend: Backend, model: string): string[] {
  return harnesses.find((harness) => harness.backend === backend && harness.available)?.models.find((entry) => entry.id === model)?.efforts ?? [];
}
export function agentEffort(agent: Pick<Agent, "backend" | "config">): string {
  const config = AgentConfigSchema.safeParse(agent.config ?? {});
  if (!config.success) return "";
  const section = config.data[agent.backend];
  const value = section?.[agent.backend === "claude" ? "effort" : "reasoningEffort"];
  return typeof value === "string" ? value : "";
}
export function withAgentEffort(config: Agent["config"], backend: Backend, effort: string): Agent["config"] {
  const existing = AgentConfigSchema.parse(config ?? {});
  const section: Record<string, unknown> = { ...existing[backend] };
  const key = backend === "claude" ? "effort" : "reasoningEffort";
  if (effort) section[key] = effort; else delete section[key];
  return { ...existing, [backend]: section };
}
