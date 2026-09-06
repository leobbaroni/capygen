/**
 * Token/cost meter rendered at the end of a turn (R23). When the session has
 * more than one `usage_events` row for this turn (a sub-agent call, a
 * compaction summary on a different model, …), the total grows a small
 * breakdown affordance — a tooltip listing each model's own totals, so the
 * headline number stays one line but the detail is one hover/click away.
 */
import { CoinsIcon } from "lucide-react";
import { useMemo } from "react";
import type { UsageBlock } from "@capygen/shared";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppStore } from "@/store/appStore";
import { formatCostUsd, formatCount, groupUsageByModel } from "./blockFormat";

export function UsageLine({ block }: { block: UsageBlock }) {
  const { usage } = block;
  // Selects the store's own stable array reference, then filters in a
  // `useMemo` — filtering *inside* the selector would hand zustand's
  // `useSyncExternalStore` a new array every render, which it reads as "the
  // store changed" and re-renders forever (confirmed: this exact shape
  // produced "Maximum update depth exceeded" before the fix).
  const usageEvents = useAppStore((s) => s.usageEvents);
  const events = useMemo(
    () => usageEvents.filter((e) => e.turnId === block.turnId),
    [usageEvents, block.turnId],
  );
  const byModel = groupUsageByModel(events);
  const hasBreakdown = byModel.length > 1;

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
      {hasBreakdown ? (
        <Tooltip>
          <TooltipTrigger>
            <button
              type="button"
              data-testid="usage-breakdown-trigger"
              className="rounded-full border border-border-weak px-1.5 py-0 text-[0.65rem] leading-4 text-muted-foreground hover:text-foreground"
            >
              {byModel.length} models
            </button>
          </TooltipTrigger>
          <TooltipContent data-testid="usage-breakdown">
            <ul className="flex flex-col gap-1">
              {byModel.map(({ model, totals }) => (
                <li key={model} className="flex items-center justify-between gap-3">
                  <span className="font-mono">{model}</span>
                  <span>
                    {formatCount(totals.inputTokens)} in · {formatCount(totals.outputTokens)} out ·{" "}
                    {formatCostUsd(totals.costUsd)}
                  </span>
                </li>
              ))}
            </ul>
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}
