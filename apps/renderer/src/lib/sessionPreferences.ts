import { AgentDraftSchema, type AgentDraft } from "@capygen/shared";

const ROSTER_KEY = "capygen.roundTableRoster.v1";
const SETTINGS_KEY = "capygen.roundTableSettings.v1";

/** UI defaults only: never persist arbitrary agent config, environment or credentials. */
export function saveRoundTableRoster(agents: AgentDraft[]): void {
  const safe = agents.map((agent) => ({
    name: agent.name, displayName: agent.displayName, mentionName: agent.mentionName,
    backend: agent.backend, model: agent.model, role: agent.role,
    description: agent.description, color: agent.color,
    config: agent.backend === "claude" ? { claude: { effort: agent.config?.claude?.effort } }
      : agent.backend === "codex" ? { codex: { reasoningEffort: agent.config?.codex?.reasoningEffort } }
      : { api: { provider: agent.config?.api?.provider, reasoningEffort: agent.config?.api?.reasoningEffort } },
  }));
  try { localStorage.setItem(ROSTER_KEY, JSON.stringify(safe)); } catch { /* storage unavailable */ }
}
export function loadRoundTableRoster(): AgentDraft[] {
  try { const result = AgentDraftSchema.array().max(16).safeParse(JSON.parse(localStorage.getItem(ROSTER_KEY) ?? "[]")); return result.success ? result.data : []; }
  catch { return []; }
}
export function saveRoundTableSettings(settings: { hopCap: number; parallelAgents: boolean }): void {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ hopCap: settings.hopCap, parallelAgents: settings.parallelAgents })); } catch { /* storage unavailable */ }
}
export function loadRoundTableSettings(): { hopCap: number; parallelAgents: boolean } | null {
  try {
    const value = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null");
    return value && Number.isInteger(value.hopCap) && value.hopCap >= 1 && value.hopCap <= 20 && typeof value.parallelAgents === "boolean" ? { hopCap: value.hopCap, parallelAgents: value.parallelAgents } : null;
  } catch { return null; }
}
