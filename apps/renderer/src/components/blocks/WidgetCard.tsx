/**
 * Placeholder for the MCP Apps widget host (R31). The real thing — a
 * sandboxed iframe running the ext-apps bridge (tool input/result delivery,
 * `ui/*` messages, `ui/callTool`, size negotiation, theme passthrough) — is
 * Phase 3 work (PLAN.md, A13: how a `ui://` resource's HTML is fetched for a
 * CLI-hosted server is still a spike away). This card only proves the block
 * reached the transcript and shows which tool/server it is for and whether
 * its HTML has arrived (`htmlStatus`), so a widget-carrying turn is visible
 * and legible instead of silently dropped.
 */
import { PuzzleIcon } from "lucide-react";
import type { WidgetBlock } from "@capygen/shared";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

const STATUS_COPY: Record<WidgetBlock["htmlStatus"], string> = {
  pending: "Loading this tool's widget…",
  ready: "This tool has a widget UI — rendering it is not built yet.",
  unavailable: "This tool's widget UI could not be loaded.",
};

export function WidgetCard({ block }: { block: WidgetBlock }) {
  return (
    <Alert data-testid="block-widget" data-state={block.htmlStatus} variant="default">
      <PuzzleIcon className="size-4 text-muted-foreground" />
      <AlertTitle>
        {block.toolName}
        <span className="font-mono text-xs text-muted-foreground">{block.serverName}</span>
      </AlertTitle>
      <AlertDescription>{STATUS_COPY[block.htmlStatus]}</AlertDescription>
    </Alert>
  );
}
