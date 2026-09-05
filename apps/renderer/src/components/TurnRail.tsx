/**
 * Turn rail: a slim strip of dots, one per turn, so a long session can be
 * scanned and jumped through at a glance. Colour follows the turn's status;
 * clicking scrolls that turn into view (`Transcript` gives each turn the
 * matching `#turn-<id>` anchor).
 */
import type { Turn } from "@capygen/shared";
import { cn } from "@/lib/utils";

const STATUS_CLASS: Record<Turn["status"], string> = {
  pending: "bg-muted-foreground/40",
  streaming: "bg-info animate-pulse",
  done: "bg-success/70",
  error: "bg-destructive",
  interrupted: "bg-warning",
};

export function TurnRail({ turns }: { turns: Turn[] }) {
  if (turns.length === 0) return null;
  return (
    <nav
      aria-label="Turns"
      data-testid="turn-rail"
      className="pointer-events-auto fixed top-1/2 right-1.5 z-10 hidden -translate-y-1/2 flex-col items-center gap-1 lg:flex"
    >
      {turns.map((turn) => (
        <a
          key={turn.id}
          href={`#turn-${turn.id}`}
          data-testid="turn-rail-dot"
          title={`${turn.role} turn — ${turn.status}`}
          className={cn(
            "size-1.5 shrink-0 rounded-full transition-transform hover:scale-150",
            STATUS_CLASS[turn.status],
            turn.role === "user" && "opacity-50",
          )}
        />
      ))}
    </nav>
  );
}
