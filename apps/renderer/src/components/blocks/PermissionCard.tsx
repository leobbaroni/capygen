/**
 * Permission block. Look ported from
 * reference/omnigent/web/src/components/blocks/ApprovalCard.tsx's binary
 * approve/reject shape (pending vs. responded `Alert`), simplified to
 * capygen's own `PermissionRequest`/`PermissionDecision` — there is no
 * ExitPlanMode / AskUserQuestion special-casing here because those already
 * arrive as their own block kinds (`question`) in our contract.
 */
import { CheckIcon, CircleSlashIcon, ShieldQuestionIcon, XIcon } from "lucide-react";
import type { PermissionBlock } from "@capygen/shared";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/store/appStore";
import { toPrettyJson } from "./blockFormat";

export function PermissionCard({ block }: { block: PermissionBlock }) {
  const answerPermission = useAppStore((s) => s.answerPermission);
  const { request, decision } = block;
  const stale = useAppStore((s) => s.staleRequests.includes(request.requestId));
  const inputPreview = toPrettyJson(request.input);

  if (decision) {
    const allowed = decision.behavior === "allow";
    return (
      <Alert
        data-testid="block-permission"
        data-state="responded"
        variant={allowed ? "success" : "default"}
      >
        {allowed ? (
          <CheckIcon className="size-4 text-success" />
        ) : (
          <XIcon className="size-4 text-muted-foreground" />
        )}
        <AlertTitle>
          {allowed ? "Allowed" : "Denied"}
          <span className="font-mono text-xs text-muted-foreground">{request.toolName}</span>
        </AlertTitle>
        {decision.message ? <AlertDescription>{decision.message}</AlertDescription> : null}
      </Alert>
    );
  }

  // The answer went nowhere: no agent is waiting on this request any more (its
  // turn ended, or it belongs to a previous launch of the app). Saying so beats
  // showing "Allowed" for a decision nothing acted on.
  if (stale) {
    return (
      <Alert data-testid="block-permission" data-state="stale" variant="default">
        <CircleSlashIcon className="size-4 text-muted-foreground" />
        <AlertTitle>
          No longer waiting
          <span className="font-mono text-xs text-muted-foreground">{request.toolName}</span>
        </AlertTitle>
        <AlertDescription>
          This request is not live any more, so the answer was not delivered. Send a new
          message to ask the agent again.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert data-testid="block-permission" data-state="pending" variant="warning">
      <ShieldQuestionIcon className="size-4 text-warning" />
      <AlertTitle>
        Permission requested
        <span className="font-mono text-xs text-muted-foreground">{request.toolName}</span>
      </AlertTitle>
      <AlertDescription>
        {request.reason ? <span>{request.reason}</span> : null}
        {inputPreview ? (
          <pre className="max-h-48 overflow-auto rounded-md bg-code-bg px-2 py-1 font-mono text-xs whitespace-pre-wrap break-words text-foreground">
            {inputPreview}
          </pre>
        ) : null}
        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            size="sm"
            data-testid="block-permission-allow"
            onClick={() => void answerPermission(request.requestId, "allow")}
          >
            <CheckIcon className="size-3.5" />
            Allow
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="block-permission-deny"
            onClick={() => void answerPermission(request.requestId, "deny")}
          >
            <XIcon className="size-3.5" />
            Deny
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
