/**
 * Diff block: a simple unified-diff view (SPEC R6 calls only for "a simple
 * unified view" — no side-by-side / syntax highlighting yet, that is a Files
 * & Editor pane concern in Phase 5). Header names the file and the
 * +add/−del counts; the body colours each patch line by its leading marker.
 */
import { FileDiffIcon } from "lucide-react";
import type { DiffBlock } from "@capygen/shared";
import { cn } from "@/lib/utils";

export function DiffCard({ block }: { block: DiffBlock }) {
  const lines = block.patch.split("\n");
  return (
    <div
      data-testid="block-diff"
      className="flex flex-col gap-1 rounded-lg border border-border-weak bg-card px-3 py-2 text-sm"
    >
      <div className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
        <FileDiffIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate text-foreground">{block.path}</span>
        <span className="ml-auto shrink-0 tabular-nums">
          <span className="text-success">+{block.additions}</span>{" "}
          <span className="text-destructive">−{block.deletions}</span>
        </span>
      </div>
      {block.patch ? (
        <pre className="max-h-96 overflow-auto rounded-md bg-code-bg px-2 py-1.5 font-mono text-xs leading-5">
          {lines.map((line, i) => (
            <div
              key={i}
              className={cn(
                "whitespace-pre-wrap break-words",
                line.startsWith("+") && !line.startsWith("+++") && "bg-success/10 text-success",
                line.startsWith("-") && !line.startsWith("---") && "bg-destructive/10 text-destructive",
                line.startsWith("@@") && "text-info",
              )}
            >
              {line.length === 0 ? " " : line}
            </div>
          ))}
        </pre>
      ) : null}
    </div>
  );
}
