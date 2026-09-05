/**
 * Sub-agent spawn block (CONTEXT.md §Sub-agent). Collapsed by default —
 * expands to the spawn's description. The status badge is the primary
 * signal; the routing policy and agent tree proper arrive with Phase 4 (R12).
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
    >
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-1.5 rounded-lg border border-border-weak bg-card px-3 py-2 text-left text-sm transition-colors hover:bg-accent/40">
        <UsersIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">
          Sub-agent <span className="font-medium text-foreground">{block.name}</span>
          {block.backend ? (
            <span className="text-muted-foreground"> · {block.backend}</span>
          ) : null}
        </span>
        <Badge variant={STATUS_VARIANT[block.status]}>{block.status}</Badge>
        <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
      </CollapsibleTrigger>
      {block.description ? (
        <CollapsibleContent className="mt-1 ml-2 border-l border-border-weak py-1 pl-3 text-sm text-muted-foreground">
          {block.description}
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  );
}
