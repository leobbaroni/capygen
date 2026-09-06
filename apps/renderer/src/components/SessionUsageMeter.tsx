/**
 * Session header meter (SPEC R23): tokens in/out/cached and cost for the
 * whole open session, summed from the same `usage_events` rows each turn's
 * `UsageLine` slices for its own breakdown. Renders nothing until at least
 * one usage event exists — an empty meter before the first turn finishes is
 * noise, not information.
 */
import { CoinsIcon } from "lucide-react";
import { formatCostUsd, formatCount, sumUsage } from "@/components/blocks/blockFormat";
import { useAppStore } from "@/store/appStore";

export function SessionUsageMeter() {
  const events = useAppStore((s) => s.usageEvents);
  if (events.length === 0) return null;
  const totals = sumUsage(events);

  return (
    <div
      data-testid="session-usage-meter"
      className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
      title="Total for this session"
    >
      <CoinsIcon className="size-3 shrink-0" />
      <span>{formatCount(totals.inputTokens)} in</span>
      <span aria-hidden>·</span>
      <span>{formatCount(totals.outputTokens)} out</span>
      {totals.cacheReadTokens > 0 ? (
        <>
          <span aria-hidden>·</span>
          <span>{formatCount(totals.cacheReadTokens)} cached</span>
        </>
      ) : null}
      <span aria-hidden>·</span>
      <span className="font-medium text-foreground">{formatCostUsd(totals.costUsd)}</span>
    </div>
  );
}
