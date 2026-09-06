/**
 * "Chain stopped after N hops — Continue" bar (ADR-0002, SPEC R11): shown
 * when the dispatcher stops an agent-to-agent chain at the session's hop cap
 * (or on an error mid-chain) — "until the user speaks or presses Continue".
 * `ChatPage` wires `onContinue` to `chat.continue`; sending a new message
 * clears the bar the same way speaking does (`appStore.send`).
 */
import { AlertCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface ChainStoppedBarProps {
  hopCount: number;
  reason: "hop_cap" | "error";
  busy: boolean;
  onContinue: () => void;
}

export function ChainStoppedBar({ hopCount, reason, busy, onContinue }: ChainStoppedBarProps) {
  return (
    <div
      data-testid="chain-stopped-bar"
      role="status"
      className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-foreground"
    >
      <AlertCircleIcon className="size-4 shrink-0 text-warning" />
      <span className="min-w-0 flex-1">
        {reason === "hop_cap"
          ? `Chain stopped after ${hopCount} hop${hopCount === 1 ? "" : "s"}.`
          : "The agent chain stopped after an error."}
      </span>
      <Button
        size="sm"
        variant="secondary"
        disabled={busy}
        onClick={onContinue}
        data-testid="chain-stopped-continue"
      >
        Continue
      </Button>
    </div>
  );
}
