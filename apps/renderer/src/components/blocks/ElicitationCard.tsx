/**
 * Placeholder for a backend elicitation request — MCP `elicitation/create`,
 * or a Codex user-input request (R32). The real form renders from
 * `block.schema` (a JSON Schema object or Codex's own field list) and answers
 * through `elicitation.answer`; both are Phase 3 work (the handler is wired
 * as a stub in `apps/desktop/src/ipc/handlers.ts` today). This card is
 * read-only so it never claims to have collected an answer it cannot send.
 */
import { CheckIcon, CircleSlashIcon, MessageCircleQuestionIcon } from "lucide-react";
import type { ElicitationBlock } from "@capygen/shared";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export function ElicitationCard({ block }: { block: ElicitationBlock }) {
  if (block.status === "accepted") {
    return (
      <Alert data-testid="block-elicitation" data-state="accepted" variant="success">
        <CheckIcon className="size-4 text-success" />
        <AlertTitle>{block.title ?? "Answered"}</AlertTitle>
      </Alert>
    );
  }
  if (block.status === "declined" || block.status === "cancelled") {
    return (
      <Alert data-testid="block-elicitation" data-state={block.status} variant="default">
        <CircleSlashIcon className="size-4 text-muted-foreground" />
        <AlertTitle>{block.title ?? "Request dismissed"}</AlertTitle>
      </Alert>
    );
  }
  return (
    <Alert data-testid="block-elicitation" data-state="pending" variant="info">
      <MessageCircleQuestionIcon className="size-4 text-info" />
      <AlertTitle>{block.title ?? "The agent needs more information"}</AlertTitle>
      <AlertDescription>
        {block.description ? <span>{block.description}</span> : null}
        <p className="text-xs text-muted-foreground">
          A form for this request is not built yet.
        </p>
      </AlertDescription>
    </Alert>
  );
}
