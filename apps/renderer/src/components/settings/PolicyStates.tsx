/**
 * The two states both policy sections need and neither should invent twice:
 * a service that could not be reached, and a refusal explained in words.
 *
 * The unavailable state is deliberately not an empty list. "No profiles yet"
 * and "could not ask" are different facts, and showing the first when the
 * second is true is the fake success this page must never produce.
 */
import { CircleAlertIcon, PlugZapIcon } from "lucide-react";

export function PolicyUnavailable({
  what,
  onRetry,
  busy,
  testId = "policy-unavailable",
}: {
  what: string;
  onRetry: () => void;
  busy?: boolean;
  testId?: string;
}) {
  return (
    <div
      role="status"
      data-testid={testId}
      className="flex flex-col gap-2.5 rounded-lg border border-dashed border-border bg-card/50 px-3.5 py-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between"
    >
      <p className="flex items-start gap-2.5">
        <PlugZapIcon className="size-4 shrink-0 translate-y-0.5" aria-hidden />
        <span>
          {what} could not be read — the local policy service is unavailable. Nothing has been
          changed, and this is not an empty list.
        </span>
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={onRetry}
        data-testid={`${testId}-retry`}
        className="shrink-0 self-start rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50 sm:self-auto"
      >
        {busy ? "Retrying…" : "Retry"}
      </button>
    </div>
  );
}

/** A refusal that belongs to the whole panel rather than to one row. */
export function PolicyRefusal({ message, testId }: { message: string; testId?: string }) {
  return (
    <p
      role="alert"
      data-testid={testId}
      className="flex items-start gap-2 rounded-md border border-destructive/40 bg-card px-3 py-2 text-sm text-destructive"
    >
      <CircleAlertIcon className="size-4 shrink-0 translate-y-0.5" aria-hidden />
      {message}
    </p>
  );
}
