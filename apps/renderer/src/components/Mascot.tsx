/**
 * The reactive capybara (CONTEXT.md §Mascot). One 256px transparent PNG per
 * state, served from public/mascot; the state mirrors the active session's
 * status. The sprite-strip + CSS `steps()` animation the SPEC describes lands
 * with the animation pass — this renders the still frame for the state.
 */
import type { MascotState } from "@capygen/shared";
import { cn } from "@/lib/utils";

const LABELS: Record<MascotState, string> = {
  idle: "capygen mascot, idle",
  thinking: "capygen mascot, thinking",
  working: "capygen mascot, working",
  waiting: "capygen mascot, waiting for you",
  success: "capygen mascot, done",
  error: "capygen mascot, something went wrong",
  sleeping: "capygen mascot, asleep",
  listening: "capygen mascot, listening",
};

export interface MascotProps {
  state?: MascotState;
  className?: string;
}

export function Mascot({ state = "idle", className }: MascotProps) {
  return (
    <img
      src={`./mascot/${state}.png`}
      alt={LABELS[state]}
      data-testid="mascot"
      data-state={state}
      className={cn("mascot-img h-16 w-16 shrink-0 select-none", className)}
      draggable={false}
    />
  );
}

/** Session status → mascot state. One mapping, used by every surface. */
export function mascotStateForSession(
  status: "idle" | "running" | "waiting" | "error" | undefined,
): MascotState {
  switch (status) {
    case "running":
      return "working";
    case "waiting":
      return "waiting";
    case "error":
      return "error";
    default:
      return "idle";
  }
}
