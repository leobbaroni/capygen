/**
 * Permission block. Modelled on Claude Code's own permission prompt and
 * reference/omnigent/web/src/components/PermissionsModal.tsx's structure
 * (title/description above the action row) — simplified to capygen's own
 * `PermissionRequest`/`PermissionDecision`; there is no ExitPlanMode /
 * AskUserQuestion special-casing here because those already arrive as their
 * own block kinds (`question`) in our contract.
 *
 * Three buttons per SPEC R32/R28: Allow once (`decision: "allow"`), Allow
 * for session, Deny,
 * with an optional free-text reason carried on the deny. Enter/Escape are
 * the CLI's own shortcuts for this exact prompt; scoped to `window` rather
 * than the card's own DOM, since the composer usually still has focus while an
 * agent runs, and skipped whenever an input/textarea has focus so they never
 * steal a keystroke from something the user is typing.
 *
 * The shortcut is armed on **one** card at a time — the oldest pending request
 * in the session (`pendingInteractionBlock`). Every pending card used to arm
 * its own window listener, and Claude routinely emits several tool_use blocks
 * in one message, so a single Enter approved every open request at once. That
 * is precisely the auto-approval R27 forbids.
 *
 * The body is per tool, not a JSON dump. The reference's own ApprovalCard
 * hides the transport JSON deliberately ("it would expose unrelated ids and
 * duplicate details"): a shell approval shows the command and its cwd, a patch
 * approval shows the files it touches, and only an unrecognised tool falls back
 * to pretty-printed input.
 */
import {
  CheckIcon,
  CheckCheckIcon,
  CircleSlashIcon,
  FilePenIcon,
  ShieldQuestionIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ShieldIcon } from "lucide-react";
import type {
  LocalPolicyAttribution as LocalPolicyAttributionType,
  PermissionBlock,
  PermissionRequest,
  PolicyBoundary,
} from "@capygen/shared";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { pendingInteractionBlock, useAppStore } from "@/store/appStore";
import { summarizeToolInput, toPrettyJson } from "./blockFormat";

/** A field of the request's `input`, when it is an object. */
function field(input: unknown, key: string): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  return (input as Record<string, unknown>)[key];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The card body for the tools capygen actually sees asked about, so a real
 * approval reads like Claude Code's / the reference's prompt rather than the
 * raw transport frame. `body === null` means "no dedicated view" and the
 * generic summary + JSON preview is used instead.
 */
export function permissionDetail(request: PermissionRequest): {
  title: string | null;
  icon: ReactNode | null;
  body: ReactNode | null;
} {
  const name = request.toolName;
  const command = text(field(request.input, "command"));
  const cwd = text(field(request.input, "cwd"));
  if (command && (name === "shell" || name === "Bash" || name === "bash")) {
    return {
      title: "Command approval",
      icon: <TerminalIcon className="size-4 text-warning" />,
      body: (
        <>
          <pre
            data-testid="block-permission-command"
            className="max-h-40 overflow-auto rounded-md bg-code-bg px-2 py-1 font-mono text-xs whitespace-pre-wrap break-words text-foreground"
          >
            {command}
          </pre>
          {cwd ? (
            <span className="font-mono text-xs text-muted-foreground" data-testid="block-permission-cwd">
              in {cwd}
            </span>
          ) : null}
        </>
      ),
    };
  }

  const changes = field(request.input, "changes");
  if (Array.isArray(changes) && (name === "apply_patch" || name === "Edit" || name === "Write")) {
    return {
      title: "File change approval",
      icon: <FilePenIcon className="size-4 text-warning" />,
      body: (
        <ul className="flex flex-col gap-0.5" data-testid="block-permission-changes">
          {changes.map((change, i) => (
            <li key={i} className="flex items-baseline gap-2 font-mono text-xs">
              <span className="text-muted-foreground">
                {text(field(change, "kind")) ?? "update"}
              </span>
              <span className="break-all text-foreground">
                {text(field(change, "path")) ?? "(unnamed file)"}
              </span>
            </li>
          ))}
        </ul>
      ),
    };
  }

  const path = text(field(request.input, "path")) ?? text(field(request.input, "file_path"));
  if (path && (name === "Read" || name === "read_file" || name === "write_file" || name === "edit_file")) {
    return {
      title: null,
      icon: null,
      body: (
        <span className="font-mono text-xs break-all text-foreground" data-testid="block-permission-path">
          {path}
        </span>
      ),
    };
  }

  return { title: null, icon: null, body: null };
}

const DECISION_COPY: Record<"allow" | "allow_always" | "deny", string> = {
  allow: "Allowed",
  allow_always: "Allowed for the session",
  deny: "Denied",
};

/**
 * Where "edit the owning restriction" actually goes.
 *
 * A rule id travels as a query parameter that Policies resolves against its own
 * list. Attribution without a rule (a boundary refusal, say) has nothing to
 * open, so it links to the page rather than to a rule that does not exist.
 */
export function policiesRuleHref(ruleId: string | null): string {
  return ruleId === null
    ? "/settings/policies"
    : `/settings/policies?rule=${encodeURIComponent(ruleId)}`;
}

/** Each enforcement point, named as a place rather than as an enum value. */
const BOUNDARY_TEXT: Record<PolicyBoundary, string> = {
  "api-tool": "an API tool call",
  "claude-pre-tool": "Claude's pre-tool hook",
  "codex-dynamic-tool": "a Codex dynamic tool",
  "codex-command-approval": "a Codex command approval",
  "codex-file-approval": "a Codex file approval",
  "codex-permissions-approval": "a Codex permissions approval",
};

/**
 * Why capygen is asking, and which restriction to edit to stop it asking.
 *
 * ADR-0007: a refusal or a prompt names its owning rule and links to that
 * rule's editor, because the way to make an exception is to edit the
 * restriction rather than to route around it. Attribution is display-only —
 * main minted it, and nothing here is authority.
 */
function LocalPolicyAttribution({ attribution }: { attribution: LocalPolicyAttributionType }) {
  const scope = attribution.scope;
  const scopeText =
    scope === null ? "a local restriction"
      : scope.kind === "global" ? "a global restriction"
      : scope.kind === "project" ? "a project restriction"
      : "a restriction on this session";
  return (
    <span
      data-testid="block-permission-local-policy"
      className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
    >
      <ShieldIcon className="size-3 shrink-0" aria-hidden />
      <span>
        capygen is asking because {scopeText} covers{" "}
        {BOUNDARY_TEXT[attribution.boundary]}
        {attribution.executionSite === "widget-host"
          // Where a call *runs* is not the same question as which boundary
          // covers it: a widget's tool executes in the app's own host, not in
          // the backend, and an approval that did not say so would read as if
          // the backend were about to run it.
          ? ", requested by a widget running in this app"
          : ""}
        .
      </span>
      <Link
        // The id, not a selector: Policies looks it up among the rules it
        // already read, so this can only ever open a real restriction — and
        // says so plainly when that restriction has since been deleted.
        to={policiesRuleHref(attribution.ruleId)}
        data-testid="block-permission-rule-link"
        className="underline underline-offset-2 hover:text-foreground"
      >
        {attribution.ruleId === null ? "Open Policies" : "Edit this restriction"}
      </Link>
    </span>
  );
}

/**
 * How "Allow for session" is sent.
 *
 * A card raised by capygen's *own* local policy sends `allow` with an explicit
 * `scope: "session"`, which is what mints a session grant. The historical
 * `allow_always` value means something else entirely: the local broker collapses
 * it to a single-use allow, so a card sending it could never create the grant
 * its own button promised — the button said "for the session" and delivered
 * once. Ordinary native cards keep their existing behaviour untouched.
 */
function sessionAnswer(
  request: PermissionBlock["request"],
): { decision: "allow"; scope: "session" } | null {
  return request.localPolicy ? { decision: "allow", scope: "session" } : null;
}

export function PermissionCard({ block }: { block: PermissionBlock }) {
  const answerPermission = useAppStore((s) => s.answerPermission);
  const { request, decision } = block;
  const stale = useAppStore((s) => s.staleRequests.includes(request.requestId));
  // Exactly one card owns the Enter/Escape shortcut — see the file header.
  const armed = useAppStore((s) => pendingInteractionBlock(s)?.id === block.id);
  const [reason, setReason] = useState("");
  const pending = decision === null && !stale;

  const detail = permissionDetail(request);
  const title = block.title ?? block.displayName ?? detail.title ?? "Permission requested";
  const inputSummary = detail.body ? null : summarizeToolInput(request.input) || null;
  const inputPreview = detail.body ? null : toPrettyJson(request.input);

  // Arity matters here: `toHaveBeenCalledWith(id, "allow")` in the existing
  // test suite does not match a call that passes an explicit trailing
  // `undefined` third argument, so the reason is only ever passed when there
  // actually is one rather than always spreading `reason || undefined`.
  function allowOnce(): void {
    void answerPermission(request.requestId, "allow");
  }
  function allowForSession(): void {
    const answer = sessionAnswer(request);
    // Arity matters (see the note above `allowOnce`): the ordinary native call
    // stays two-argument, and only a local-policy card carries a scope.
    if (answer === null) void answerPermission(request.requestId, "allow_always");
    else void answerPermission(request.requestId, "allow", { scope: "session" });
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
    if (!pending || !armed) return;
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
  }, [pending, armed]);

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
      {detail.icon ?? <ShieldQuestionIcon className="size-4 text-warning" />}
      <AlertTitle>
        {title}
        <span className="font-mono text-xs text-muted-foreground">{request.toolName}</span>
      </AlertTitle>
      <AlertDescription>
        {block.description ? <span>{block.description}</span> : null}
        {request.reason ? <span>{request.reason}</span> : null}
        {request.localPolicy ? <LocalPolicyAttribution attribution={request.localPolicy} /> : null}
        {detail.body}
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
