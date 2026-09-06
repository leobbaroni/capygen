/**
 * Speaker header for a round-table agent turn (SPEC item B2.2): avatar,
 * `@mentionName` and a backend badge, wrapped in `AgentHoverCard` (item
 * B2.3's "Hover card on speaker labels") — modelled on the reference's
 * `AgentCard` header row. `Transcript` renders this above a turn's blocks
 * only when the session has more than one agent (see its own doc comment).
 */
import type { Agent } from "@capygen/shared";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AgentHoverCard } from "@/components/AgentHoverCard";
import { Badge } from "@/components/ui/badge";
import { BACKEND_LABEL } from "@/lib/agentDisplay";

export function SpeakerLabel({ agent }: { agent: Agent }) {
  return (
    <AgentHoverCard agent={agent}>
      <div
        data-testid="speaker-label"
        data-agent-id={agent.id}
        className="flex w-fit cursor-default items-center gap-1.5 text-sm"
      >
        <AgentAvatar agent={agent} size={18} />
        <span className="font-medium text-foreground">@{agent.mentionName}</span>
        <Badge variant="outline">{BACKEND_LABEL[agent.backend]}</Badge>
      </div>
    </AgentHoverCard>
  );
}
