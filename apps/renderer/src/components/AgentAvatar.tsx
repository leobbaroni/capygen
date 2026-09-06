/**
 * The small colour-swatch-plus-initial avatar every round-table surface
 * reuses: speaker labels, the `@mention` menu, the agents pane tree, and the
 * agent info drawer's header.
 */
import type { Agent } from "@capygen/shared";
import { agentColor, agentInitial } from "@/lib/agentDisplay";

export function AgentAvatar({
  agent,
  size = 20,
}: {
  agent: Pick<Agent, "color" | "order" | "displayName">;
  size?: number;
}) {
  return (
    <span
      aria-hidden
      data-testid="agent-avatar"
      className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{
        backgroundColor: agentColor(agent),
        width: size,
        height: size,
        fontSize: Math.max(9, Math.round(size * 0.45)),
      }}
    >
      {agentInitial(agent.displayName)}
    </span>
  );
}
