/**
 * Turn rail: a slim strip of dots, one per turn, so a long session can be
 * scanned and jumped through at a glance. Colour follows the turn's status;
 * clicking scrolls that turn into view (`Transcript` gives each turn the
 * matching `#turn-<id>` anchor).
 *
 * [C] `absolute`, not `fixed`. Fixed positioning anchors to the *window*, and
 * `WorkspaceHost`'s aside is a normal-flow element with no z-index — so with
 * the workspace open the rail floated on top of whichever pane was docked at
 * the right edge (visible in all three committed e2e screenshots: dots inside
 * the Tasks and Browser panes), and each `pointer-events-auto` dot ate the
 * clicks meant for the pane underneath. `ChatPage` marks the chat column
 * `relative`, which is what this now measures against.
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
      className="pointer-events-auto absolute top-1/2 right-1.5 z-10 hidden max-h-[70%] -translate-y-1/2 flex-col items-center gap-1 overflow-y-auto lg:flex"
    >
      {turns.map((turn) => (
        <button
          key={turn.id}
          type="button"
          // Not an `<a href="#turn-…">`: the shell runs under a HashRouter,
          // where that hash is a *route* — clicking one navigated out of the
          // session to the landing page instead of scrolling.
          onClick={() =>
            document
              .getElementById(`turn-${turn.id}`)
              ?.scrollIntoView({ block: "start", behavior: "smooth" })
          }
          data-testid="turn-rail-dot"
          title={`${turn.role} turn — ${turn.status}`}
          aria-label={`Scroll to the ${turn.role} turn (${turn.status})`}
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
