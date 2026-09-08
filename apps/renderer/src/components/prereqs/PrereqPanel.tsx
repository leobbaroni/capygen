/**
 * The setup panel (SPEC R3): `prereqs.status`'s step list, ported in feel
 * from Omnigent-windows' `app/setup/win-bootstrap.js` (step cards — title,
 * note, command, a Run button) and this app's own Servers pane (list rows
 * with a status marker and per-row actions) for the visual language.
 *
 * Every Run first goes through the **main process**'s own confirm dialog —
 * `prereqs.run`'s gate (`apps/desktop/src/ipc/prereqs.ts`) shows it, not this
 * component. This panel only asks and reports what happened: `started:false`
 * reads as "nothing ran" whether that was Cancel, an unmet dependency, or a
 * launch failure — there is no way to tell those apart from the IPC result,
 * and none of them is scary enough to show as an error banner (a rejected
 * `prereqs.run` promise still is: that means the *request* failed, not that
 * the user said no).
 *
 * `started:true` begins a bounded poll of `prereqs.status` every three
 * seconds — task B3 item 3, "live re-detect after a run finishes" — so a
 * step that was Run flips to detected on its own once the visible console's
 * command finishes, without the user having to remember to click Re-detect.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2Icon, CircleIcon, RefreshCwIcon } from "lucide-react";
import type { PrereqStep } from "@capygen/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";
import { cn } from "@/lib/utils";

/** How often to re-check while a step's console might still be running, and
 *  how long to keep doing that before giving up and waiting for a manual
 *  Re-detect (roughly two minutes — long enough for a winget install). */
const POLL_MS = 3_000;
const MAX_POLLS = 40;

export interface PrereqPanelProps {
  className?: string;
}

export function PrereqPanel({ className }: PrereqPanelProps) {
  const [steps, setSteps] = useState<PrereqStep[]>([]);
  const [recommendation, setRecommendation] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [quickSetup, setQuickSetup] = useState(false);
  const sequence = useRef(0);
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const poll = useRef<{ timer: ReturnType<typeof setInterval> | null; count: number }>({
    timer: null,
    count: 0,
  });

  const stopPolling = useCallback((): void => {
    if (poll.current.timer) clearInterval(poll.current.timer);
    poll.current = { timer: null, count: 0 };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const result = await ipc().invoke("prereqs.status", {});
      setSteps(result.steps);
      setRecommendation(result.recommendation);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const startPolling = useCallback((): void => {
    stopPolling();
    const timer = setInterval(() => {
      poll.current.count += 1;
      if (poll.current.count > MAX_POLLS) {
        stopPolling();
        return;
      }
      void refresh();
    }, POLL_MS);
    poll.current = { timer, count: 0 };
  }, [refresh, stopPolling]);

  useEffect(() => {
    void refresh();
    return () => { sequence.current += 1; stopPolling(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(step: PrereqStep): Promise<void> {
    setBusyId(step.id);
    setRowErrors((prev) => ({ ...prev, [step.id]: "" }));
    try {
      const result = await ipc().invoke("prereqs.run", { stepId: step.id });
      if (result.started) startPolling();
      else setNotice("Nothing started. If you confirmed the command, re-detect the required tools and try again.");
    } catch (err) {
      setRowErrors((prev) => ({
        ...prev,
        [step.id]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setBusyId(null);
    }
  }

  async function setupMissing(): Promise<void> {
    const runId = ++sequence.current;
    stopPolling();
    setQuickSetup(true);
    setNotice("");
    try {
      for (;;) {
        const result = await ipc().invoke("prereqs.status", {});
        if (sequence.current !== runId) return;
        setSteps(result.steps); setRecommendation(result.recommendation);
        const missing = result.steps.filter((step) => !step.detected);
        if (!missing.length) { setNotice("Setup is complete."); return; }
        const next = missing.find((step) => (step.blockedBy ?? []).every((id) => result.steps.find((candidate) => candidate.id === id)?.detected));
        if (!next) { setNotice("Finish the required dependencies, then try setup again."); return; }
        setBusyId(next.id);
        setNotice(`Waiting for ${next.title.toLowerCase()}. Each step needs your confirmation.`);
        const launched = await ipc().invoke("prereqs.run", { stepId: next.id });
        if (sequence.current !== runId) return;
        if (!launched.started) { setNotice("Setup stopped. No further commands will run."); return; }
        let detected = false;
        for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
          if (sequence.current !== runId) return;
          const current = await ipc().invoke("prereqs.status", {});
          if (sequence.current !== runId) return;
          setSteps(current.steps); setRecommendation(current.recommendation);
          if (current.steps.find((step) => step.id === next.id)?.detected) { detected = true; break; }
        }
        if (!detected) { setNotice("Setup paused while the current step finishes. Check its console, then run setup again."); return; }
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      if (sequence.current === runId) { setQuickSetup(false); setBusyId(null); }
    }
  }

  return (
    <div data-testid="prereq-panel" className={cn("flex flex-col gap-3", className)}>
      <div className="flex items-start justify-between gap-3">
        {recommendation ? (
          <p data-testid="prereq-recommendation" className="text-sm text-muted-foreground">
            {recommendation}
          </p>
        ) : (
          <span />
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void refresh()}
          disabled={loading}
          data-testid="prereq-redetect"
          className="shrink-0"
        >
          <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
          Re-detect
        </Button>
      </div>

      <div className="flex items-center gap-2">
        {quickSetup ? <Button variant="outline" size="sm" onClick={() => {
          sequence.current += 1; setQuickSetup(false); setBusyId(null);
          setNotice("Setup stopped. Any command already running remains in its console.");
        }}>Stop setup</Button> : <Button size="sm" disabled={loading || busyId !== null || !steps.some((step) => !step.detected)} onClick={() => void setupMissing()}>Set up missing steps</Button>}
        <span className="text-xs text-muted-foreground">Review each command before it runs.</span>
      </div>
      {notice ? <p role="status" className="text-xs text-muted-foreground">{notice}</p> : null}
      {error ? (
        <p role="alert" data-testid="prereq-error" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <ul className="flex flex-col gap-2">
        {steps.map((step) => {
          const blockedId = (step.blockedBy ?? []).find(
            (id) => !steps.find((s) => s.id === id)?.detected,
          );
          const blockedTitle = blockedId ? steps.find((s) => s.id === blockedId)?.title : undefined;
          const rowError = rowErrors[step.id];
          return (
            <li
              key={step.id}
              data-testid="prereq-step-row"
              data-step-id={step.id}
              data-detected={step.detected}
              className="rounded-lg border border-border-weak bg-card p-2.5"
            >
              <div className="flex items-start gap-2">
                {step.detected ? (
                  <CheckCircle2Icon
                    data-testid="prereq-step-detected"
                    className="mt-0.5 size-4 shrink-0 text-success"
                  />
                ) : (
                  <CircleIcon
                    data-testid="prereq-step-missing"
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-medium text-foreground">{step.title}</span>
                    {step.version ? <Badge variant="outline">{step.version}</Badge> : null}
                  </div>
                  <details className="mt-1 text-xs text-muted-foreground">
                    <summary className="cursor-pointer">Details and command</summary>
                  {step.description ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">{step.description}</p>
                  ) : null}
                  <code
                    className="mt-1 block whitespace-pre-wrap break-all rounded bg-code-bg px-1.5 py-0.5 font-mono text-xs text-foreground"
                    title={step.command}
                  >
                    {step.command}
                  </code>
                  </details>
                  {rowError ? (
                    <p role="alert" data-testid="prereq-step-error" className="mt-1 text-xs text-destructive">
                      {rowError}
                    </p>
                  ) : null}
                </div>
                {!step.detected ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busyId !== null || quickSetup || Boolean(blockedId)}
                    title={blockedId ? `Finish "${blockedTitle}" first` : undefined}
                    onClick={() => void run(step)}
                    data-testid="prereq-step-run"
                    className="shrink-0"
                  >
                    Run…
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>

      {!loading && steps.length === 0 ? (
        <p data-testid="prereq-empty" className="text-sm text-muted-foreground">
          Nothing to detect.
        </p>
      ) : null}
    </div>
  );
}
