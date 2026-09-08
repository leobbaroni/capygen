/**
 * Sub-agent spawn block (CONTEXT.md §Sub-agent). Collapsed by default —
 * expands to the spawn's description.
 *
 * The card shows the routed **model** and, when capygen re-homed the spawn
 * itself, a "routed" marker and the spawn's own cost. Those three fields are
 * on `SubagentBlock` precisely so R12's routing has a visible effect: without
 * them a Claude agent whose rule sends sub-agents to `claude-haiku-4-5`
 * produced a card byte-identical to an unrouted spawn, and the only surface
 * that showed the difference was the Agents pane — which `ChatPage` opens
 * closed.
 */
import { ChevronRightIcon, UsersIcon } from "lucide-react";
import type { SubagentBlock } from "@capygen/shared";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

const STATUS_VARIANT = {
  spawned: "outline",
  running: "info",
  done: "success",
  error: "destructive",
} as const;

export function SubagentCard({ block }: { block: SubagentBlock }) {
  return (
    <Collapsible
      defaultOpen={false}
      className="group w-full"
      data-testid="block-subagent"
      data-status={block.status}
      data-delegated={block.delegated ? "true" : undefined}
    >
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-1.5 rounded-lg border border-border-weak bg-card px-3 py-2 text-left text-sm transition-colors hover:bg-accent/40">
        <UsersIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">
          Sub-agent <span className="font-medium text-foreground">{block.name}</span>
          {block.backend ? (
            <span className="text-muted-foreground"> · {block.backend}</span>
          ) : null}
          {block.model ? (
            <span className="text-muted-foreground" data-testid="block-subagent-model">
              {" "}
              · {block.model}
            </span>
          ) : null}
        </span>
        {block.delegated ? (
          <Badge variant="info" data-testid="block-subagent-routed" title="capygen routed this spawn to another backend (SPEC R12)">
            routed
          </Badge>
        ) : null}
        {block.costUsd !== undefined && block.costUsd > 0 ? (
          <span
            className="shrink-0 text-xs text-muted-foreground"
            data-testid="block-subagent-cost"
          >
            ${block.costUsd.toFixed(4)}
          </span>
        ) : null}
        <Badge variant={STATUS_VARIANT[block.status]}>{block.status}</Badge>
        <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
      </CollapsibleTrigger>
      {block.description || block.crewRoute ? (
        <CollapsibleContent className="mt-1 ml-2 border-l border-border-weak py-1 pl-3 text-sm text-muted-foreground">
          {block.description ? <div>{block.description}</div> : null}
          {block.crewRoute ? (
            <div data-testid="block-subagent-crew-route" className="mt-1 space-y-0.5">
              <div>Rule: {block.crewRoute.ruleId ?? "default"}</div>
              <div>Roster: {block.crewRoute.rosterId}</div>
              <div>Classified: {block.crewRoute.taskKind} · {block.crewRoute.difficulty}</div>
              <div>Target: {block.crewRoute.target.backend} · {block.crewRoute.target.model} · {block.crewRoute.target.effort}{block.crewRoute.target.provider ? ` · ${block.crewRoute.target.provider}` : ""}</div>
            </div>
          ) : null}
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  );
}
