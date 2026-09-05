/**
 * Tool-call block. Look ported from
 * reference/omnigent/web/src/components/blocks/ToolCard.tsx: a single muted
 * trigger line (status icon + name + args summary + chevron) that expands to
 * the full input JSON and the output — the reference deliberately keeps tool
 * calls quiet so the agent's prose reads first.
 */
import {
  ChevronRightIcon,
  CircleSlashIcon,
  Loader2Icon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import type { ToolCallBlock } from "@capygen/shared";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { summarizeToolInput, toPrettyJson } from "./blockFormat";

export function ToolCallCard({ block }: { block: ToolCallBlock }) {
  const summary = summarizeToolInput(block.input);
  const inputJson = toPrettyJson(block.input);
  const outputText =
    block.output === undefined
      ? null
      : typeof block.output === "string"
        ? block.output
        : toPrettyJson(block.output);

  return (
    <Collapsible
      defaultOpen={false}
      className="group w-full"
      data-testid="block-tool-call"
      data-status={block.status}
    >
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-1.5 py-0.5 text-left text-sm text-muted-foreground transition-colors hover:text-foreground">
        <StatusIcon status={block.status} />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium text-foreground">{block.name}</span>
          {summary ? <span className="text-muted-foreground"> {summary}</span> : null}
        </span>
        <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 ml-2 flex flex-col gap-2 border-l border-border-weak py-1 pl-3">
        <CodePanel title="Parameters" text={inputJson} />
        {outputText !== null ? (
          <CodePanel title="Output" text={outputText} truncated={block.truncated} />
        ) : block.status === "running" || block.status === "pending" ? (
          <div className="flex items-center gap-2 rounded-md border border-dashed border-border-weak bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
            <Loader2Icon className="size-3.5 shrink-0 animate-spin text-info" />
            Waiting for output…
          </div>
        ) : block.status === "denied" ? (
          <div className="rounded-md border border-dashed border-border-weak bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
            Denied before it ran.
          </div>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}

function StatusIcon({ status }: { status: ToolCallBlock["status"] }) {
  switch (status) {
    case "pending":
    case "running":
      return <Loader2Icon className="size-3.5 shrink-0 animate-spin text-info" />;
    case "error":
      return <XCircleIcon className="size-3.5 shrink-0 text-destructive" />;
    case "denied":
      return <CircleSlashIcon className="size-3.5 shrink-0 text-muted-foreground" />;
    case "success":
    default:
      return <WrenchIcon className="size-3.5 shrink-0" />;
  }
}

function CodePanel({
  title,
  text,
  truncated,
}: {
  title: string;
  text: string;
  truncated?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {title}
        {truncated ? <span className="normal-case text-warning">truncated</span> : null}
      </div>
      <pre
        className={cn(
          "max-h-80 overflow-auto rounded-md bg-code-bg px-3 py-2 font-mono text-xs whitespace-pre-wrap break-words text-foreground",
        )}
      >
        {text || "(empty)"}
      </pre>
    </div>
  );
}
