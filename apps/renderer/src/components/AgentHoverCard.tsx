/**
 * Hover flyout for a speaker label / agents-pane row (SPEC item B2.3's
 * "Hover card on speaker labels"): the agent's `@mentionName`, backend/model,
 * and description if it has one — ported in spirit from
 * reference/omnigent/web/src/components/AgentHoverCard.tsx onto capygen's
 * `Agent` shape, reusing the `Tooltip` primitive already in `ui/` (open on
 * hover/focus/click) rather than pulling in Radix's separate HoverCard for
 * one caller.
 */
import type { Agent } from "@capygen/shared";
import type { ReactElement } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { BACKEND_LABEL } from "@/lib/agentDisplay";

export function AgentHoverCard({ agent, children }: { agent: Agent; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger>{children}</TooltipTrigger>
      <TooltipContent
        data-testid={`agent-hover-card-${agent.id}`}
        className="w-64 max-w-64 flex-col items-start gap-1 text-left whitespace-normal"
      >
        <p className="font-semibold text-foreground">{agent.displayName}</p>
        <p className="text-muted-foreground">
          @{agent.mentionName} · {BACKEND_LABEL[agent.backend]} · {agent.model}
        </p>
        {agent.description ? <p className="text-foreground">{agent.description}</p> : null}
      </TooltipContent>
    </Tooltip>
  );
}
