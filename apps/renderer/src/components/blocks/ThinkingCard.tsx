/** Thinking block: collapsed by default, matching Omnigent's reasoning treatment. */
import { BrainIcon, ChevronRightIcon } from "lucide-react";
import type { ThinkingBlock } from "@capygen/shared";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

export function ThinkingCard({ block }: { block: ThinkingBlock }) {
  return (
    <Collapsible defaultOpen={false} className="group w-full" data-testid="block-thinking">
      <CollapsibleTrigger className="flex items-center gap-1.5 py-0.5 text-left text-sm text-muted-foreground transition-colors hover:text-foreground">
        <BrainIcon className="size-3.5 shrink-0" />
        <span>Thinking</span>
        <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 ml-2 border-l border-border-weak py-1 pl-3 text-sm whitespace-pre-wrap text-muted-foreground">
        {block.text}
      </CollapsibleContent>
    </Collapsible>
  );
}
