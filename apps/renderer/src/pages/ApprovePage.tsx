/**
 * Approve (P17) — every permission request still waiting, across sessions.
 *
 * The page exists because a request blocks a turn wherever it was raised, and
 * an operator who has several sessions running should not have to open each one
 * to find what is stuck. It is an *index*, not a second decision surface:
 *
 *  - it lists what main says is persisted and pending, bounded and paged;
 *  - it answers through the ordinary `permission.answer` path, so a decision
 *    made here goes through the same authority checks, the same staleness
 *    handling and the same grant rules as the card in the conversation;
 *  - it never invents a grant. "Allow for session" is sent exactly as the card
 *    sends it — `allow` with an explicit session scope for a card capygen's own
 *    policy raised, and the ordinary native value otherwise.
 *
 * Authority is main's answer, re-read on every load: a profile demoted to
 * viewer in another window stops being able to approve here too. A request that
 * cannot be answered is still listed — hiding it would misrepresent what is
 * waiting — with the reason, and its buttons disabled.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ShieldIcon } from "lucide-react";
import type { ApprovePendingRequest } from "@capygen/shared";
import { policiesRuleHref } from "@/components/blocks/PermissionCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { hasBridge, ipc } from "@/lib/ipc";
import { useAppStore } from "@/store/appStore";

const PAGE = 25;

const REFUSAL_TEXT: Record<NonNullable<ApprovePendingRequest["refusal"]>, string> = {
  viewer: "This session runs as a viewer profile, which cannot approve tool calls.",
  "missing-member": "The profile assigned to this session no longer exists.",
  "read-only-artifact": "This is a read-only artifact and cannot run tools.",
};

export function ApprovePage() {
  const answerPermission = useAppStore((s) => s.answerPermission);
  const [requests, setRequests] = useState<ApprovePendingRequest[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const request = useRef(0);

  const load = useCallback(async (at: number) => {
    const mine = (request.current += 1);
    setLoading(true);
    if (!hasBridge()) {
      setError("The local policy service is unavailable.");
      setLoading(false);
      return;
    }
    try {
      let page = await ipc().invoke("approve.pending", { offset: at, limit: PAGE });
      let landed = at;
      // The list shrinks under us: answering the last row on a page, or an
      // event that settled other rows, can leave `offset` past the end. The
      // page then comes back empty *and* `total <= PAGE` hides Previous, so
      // there is nothing on screen and no way back. Normalize to the last page
      // that still exists and re-read, rather than showing a dead end.
      if (page.requests.length === 0 && page.total > 0 && at > 0) {
        landed = Math.max(0, Math.floor((page.total - 1) / PAGE) * PAGE);
        if (landed !== at) {
          page = await ipc().invoke("approve.pending", { offset: landed, limit: PAGE });
        }
      }
      // A page for an offset we have since moved off must not land here.
      if (request.current !== mine) return;
      setRequests(page.requests);
      setTotal(page.total);
      setOffset(landed);
      setError(null);
    } catch (cause) {
      if (request.current !== mine) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request.current === mine) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(0);
  }, [load]);

  // Another window answered something, or a policy change settled a waiter.
  // Re-read rather than patch: what is pending is main's to say.
  useEffect(() => {
    if (!hasBridge()) return;
    const offPolicy = ipc().on("policy.changed", () => void load(offset));
    const offBlock = ipc().on("chat.block", (block) => {
      if (block.kind === "permission") void load(offset);
    });
    return () => {
      offPolicy();
      offBlock();
    };
  }, [load, offset]);

  async function answer(
    row: ApprovePendingRequest,
    decision: "allow" | "allow_always" | "deny",
  ): Promise<void> {
    setBusyId(row.blockId);
    setError(null);
    try {
      // The same shape the card sends. A local-policy card's "for session" is
      // `allow` with an explicit session scope; the historical `allow_always`
      // is collapsed to a single use by the broker and would misstate this
      // button's effect.
      if (decision === "allow_always" && row.localPolicy) {
        await answerPermission(row.requestId, "allow", { scope: "session" });
      } else {
        await answerPermission(row.requestId, decision);
      }
      await load(offset);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // Re-read first: the answer may have been refused as stale, and the list
      // must show what is really left. `load` clears the error on success, so
      // the refusal is set *after* it — otherwise the reload wipes the only
      // explanation the operator gets.
      await load(offset);
      setError(message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="titlebar-clearance min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-8" data-testid="approve-page">
      <h1 className="mb-1 text-3xl font-normal tracking-[-0.03em]">Approve</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Tool calls waiting for an answer, across every session. Answering here is the same as
        answering in the conversation.
      </p>

      {error ? (
        <p role="alert" data-testid="approve-error" className="mb-4 rounded-lg border border-destructive/40 bg-card px-3.5 py-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {loading && requests.length === 0 ? (
        <p role="status" data-testid="approve-loading" className="text-sm text-muted-foreground">
          Loading…
        </p>
      ) : total === 0 ? (
        <p data-testid="approve-empty" className="text-sm text-muted-foreground">
          Nothing is waiting for an answer.
        </p>
      ) : (
        <ul className="flex max-w-3xl flex-col gap-3" data-testid="approve-list">
          {requests.map((row) => (
            <li
              key={row.blockId}
              data-testid={`approve-row-${row.blockId}`}
              className="flex flex-col gap-2 rounded-lg border border-border-weak bg-card px-4 py-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm text-foreground">{row.toolName}</span>
                <Link
                  to={`/c/${row.sessionId}`}
                  data-testid={`approve-open-${row.blockId}`}
                  className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                >
                  {row.sessionTitle || "Untitled session"}
                </Link>
                {row.agentLabel ? <Badge variant="outline">{row.agentLabel}</Badge> : null}
              </div>

              {row.inputSummary ? (
                <p className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  {row.inputSummary}
                </p>
              ) : null}

              {row.localPolicy ? (
                <p
                  data-testid={`approve-policy-${row.blockId}`}
                  className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
                >
                  <ShieldIcon className="size-3 shrink-0" aria-hidden />
                  <span>
                    capygen&apos;s own restriction raised this
                    {row.localPolicy.executionSite === "widget-host"
                      ? ", for a widget running in this app"
                      : ""}
                    .
                  </span>
                  <Link
                    to={policiesRuleHref(row.localPolicy.ruleId)}
                    data-testid={`approve-rule-link-${row.blockId}`}
                    className="underline underline-offset-2 hover:text-foreground"
                  >
                    {row.localPolicy.ruleId === null ? "Open Policies" : "Edit the restriction"}
                  </Link>
                </p>
              ) : null}

              {row.answerable ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={busyId === row.blockId}
                    data-testid={`approve-allow-${row.blockId}`}
                    onClick={() => void answer(row, "allow")}
                  >
                    Allow once
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyId === row.blockId}
                    data-testid={`approve-allow-session-${row.blockId}`}
                    onClick={() => void answer(row, "allow_always")}
                  >
                    Allow for session
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyId === row.blockId}
                    data-testid={`approve-deny-${row.blockId}`}
                    onClick={() => void answer(row, "deny")}
                  >
                    Deny
                  </Button>
                </div>
              ) : (
                <p
                  role="note"
                  data-testid={`approve-refused-${row.blockId}`}
                  className="text-xs text-destructive"
                >
                  {row.refusal ? REFUSAL_TEXT[row.refusal] : "This request cannot be answered here."}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {total > PAGE ? (
        <nav aria-label="Pending pages" className="mt-4 flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={loading || offset === 0}
            data-testid="approve-prev"
            onClick={() => void load(Math.max(0, offset - PAGE))}
          >
            Previous
          </Button>
          <span className="text-xs text-muted-foreground" data-testid="approve-range">
            {`${offset + 1}–${Math.min(offset + PAGE, total)} of ${total}`}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={loading || offset + PAGE >= total}
            data-testid="approve-next"
            onClick={() => void load(offset + PAGE)}
          >
            Next
          </Button>
        </nav>
      ) : null}
    </div>
  );
}
