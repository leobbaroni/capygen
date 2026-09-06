/**
 * Permission block. Modelled on Claude Code's own permission prompt and
 * reference/omnigent/web/src/components/PermissionsModal.tsx's structure
 * (title/description above the action row) — simplified to capygen's own
 * `PermissionRequest`/`PermissionDecision`; there is no ExitPlanMode /
 * AskUserQuestion special-casing here because those already arrive as their
 * own block kinds (`question`) in our contract.
 *
 * Three buttons per SPEC R32/R28: Allow once (`decision: "allow"`), Allow
 * for session (`decision: "allow_always"` — the handler persists it as
 * `scope: "always"`; `ipc.ts`'s own comment explains the collapse), Deny,
 * with an optional free-text reason carried on the deny. Enter/Escape are
 * the CLI's own shortcuts for this exact prompt; scoped to *this* pending
 * card (`window`, not the card's own DOM, since the composer usually still
 * has focus while an agent runs) and skipped whenever an input/textarea has
 * focus so they never steal a keystroke from something the user is typing.
 */
import { CheckIcon, CheckCheckIcon, CircleSlashIcon, ShieldQuestionIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PermissionBlock } from "@capygen/shared";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/store/appStore";
import { summarizeToolInput, toPrettyJson } from "./blockFormat";

const DECISION_COPY: Record<"allow" | "allow_always" | "deny", string> = {
  allow: "Allowed",
  allow_always: "Allowed for the session",
  deny: "Denied",
};

export function PermissionCard({ block }: { block: PermissionBlock }) {
  const answerPermission = useAppStore((s) => s.answerPermission);
  const { request, decision } = block;
  const stale = useAppStore((s) => s.staleRequests.includes(request.requestId));
  const [reason, setReason] = useState("");
  const pending = decision === null && !stale;

  const title = block.title ?? block.displayName ?? "Permission requested";
  const inputSummary = summarizeToolInput(request.input) || null;
  const inputPreview = toPrettyJson(request.input);

  // Arity matters here: `toHaveBeenCalledWith(id, "allow")` in the existing
  // test suite does not match a call that passes an explicit trailing
  // `undefined` third argument, so the reason is only ever passed when there
  // actually is one rather than always spreading `reason || undefined`.
  function allowOnce(): void {
    void answerPermission(request.requestId, "allow");
  }
  function allowForSession(): void {
    void answerPermission(request.requestId, "allow_always");
  }
  function deny(): void {
    const trimmed = reason.trim();
    if (trimmed) void answerPermission(request.requestId, "deny", { message: trimmed });
    else void answerPermission(request.requestId, "deny");
  }

  // A ref, not a `reason` dependency on the effect below: rebinding a
  // window listener on every keystroke of the reason field is wasteful, and
  // the effect only needs *some* way to read the field's current value when
  // Escape is actually pressed, not to react to it changing.
  const denyRef = useRef(deny);
  denyRef.current = deny;

  // R32's keyboard shortcuts. Window-scoped (not the card's own element)
  // because the composer, not this card, usually holds focus while an agent
  // is running — but never when a text field has focus, so Enter can still
  // send a chat message and Escape can still close something else.
  useEffect(() => {
    if (!pending) return;
    function onKeyDown(e: KeyboardEvent): void {
      const target = e.target;
      if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) return;
      if (e.key === "Enter") {
        e.preventDefault();
        allowOnce();
      } else if (e.key === "Escape") {
        e.preventDefault();
        denyRef.current();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // `allowOnce` closes only over `request.requestId`/`answerPermission`,
    // which the outer deps already cover via `pending` changing whenever the
    // block (and so `request`) changes; `deny` is read through the ref above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  if (decision) {
    const allowed = decision.behavior !== "deny";
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
          {DECISION_COPY[decision.behavior]}
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
        {title}
        <span className="font-mono text-xs text-muted-foreground">{request.toolName}</span>
      </AlertTitle>
      <AlertDescription>
        {block.description ? <span>{block.description}</span> : null}
        {request.reason ? <span>{request.reason}</span> : null}
        {inputSummary ? (
          <span className="font-mono text-xs text-muted-foreground">{inputSummary}</span>
        ) : null}
        {inputPreview ? (
          <pre className="max-h-48 overflow-auto rounded-md bg-code-bg px-2 py-1 font-mono text-xs whitespace-pre-wrap break-words text-foreground">
            {inputPreview}
          </pre>
        ) : null}
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason for denying (optional)"
          aria-label="Reason for denying (optional)"
          data-testid="block-permission-reason"
          className="w-full rounded-md border border-border bg-card px-2 py-1 text-sm text-foreground outline-none focus:border-ring"
        />
        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            size="sm"
            data-testid="block-permission-allow"
            onClick={allowOnce}
          >
            <CheckIcon className="size-3.5" />
            Allow once
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="block-permission-allow-always"
            onClick={allowForSession}
          >
            <CheckCheckIcon className="size-3.5" />
            Allow for session
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="block-permission-deny"
            onClick={deny}
          >
            <XIcon className="size-3.5" />
            Deny
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
