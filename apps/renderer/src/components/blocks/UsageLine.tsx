/** Token/cost meter rendered at the end of a turn (R23). */
import { CoinsIcon } from "lucide-react";
import type { UsageBlock } from "@capygen/shared";
import { formatCostUsd, formatCount } from "./blockFormat";

export function UsageLine({ block }: { block: UsageBlock }) {
  const { usage } = block;
  return (
    <div
      data-testid="block-usage"
      className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground"
    >
      <CoinsIcon className="size-3 shrink-0" />
      <span>{formatCount(usage.inputTokens)} in</span>
      <span aria-hidden>·</span>
      <span>{formatCount(usage.outputTokens)} out</span>
      {usage.cacheReadTokens > 0 ? (
        <>
          <span aria-hidden>·</span>
          <span>{formatCount(usage.cacheReadTokens)} cached</span>
        </>
      ) : null}
      <span aria-hidden>·</span>
      <span>{formatCostUsd(usage.costUsd)}</span>
      {block.model ? <span className="text-muted-foreground/70">({block.model})</span> : null}
    </div>
  );
}
