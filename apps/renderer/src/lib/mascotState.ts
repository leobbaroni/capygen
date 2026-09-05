/**
 * Pure mapping from "what is happening" to a `MascotState` (CONTEXT.md
 * §Mascot). Split from `hooks/useMascotState.ts` so the decision table is
 * testable without mounting a component, subscribing to the store, or
 * mocking timers.
 */
import type { MascotState, SessionStatus } from "@capygen/shared";

/** How long a session may go without any event before the mascot naps. */
export const SLEEP_AFTER_MS = 5 * 60_000;
/** How long the mascot stays pleased with itself after a turn finishes. */
export const SUCCESS_WINDOW_MS = 4_000;

export interface MascotStateInputs {
  /** Undefined on the landing page: no session is open yet. */
  sessionStatus: SessionStatus | undefined;
  /** A permission or question block in the open session has no answer yet. */
  hasPendingInteraction: boolean;
  /**
   * Set while the session is `running`: whether the streaming turn has
   * produced anything renderable yet (`"working"`) or is still silent
   * (`"thinking"`). Ignored otherwise.
   */
  turnPhase: "thinking" | "working";
  /** The mic button is pressed — takes priority over everything else. */
  listening: boolean;
  /** Milliseconds since the most recent turn on the open session finished. */
  msSinceLastDone: number | null;
  /** Milliseconds since the last IPC event or user action, anywhere. */
  msSinceLastActivity: number;
}

/**
 * Precedence, most to least specific:
 *   listening > pending interaction > error > waiting > running > just
 *   succeeded > asleep > idle.
 * A pending permission/question always reads as "waiting" even when the
 * session-level status hasn't caught up yet, because that is the one state
 * that is unambiguously true the instant the block exists.
 */
export function deriveMascotState(inputs: MascotStateInputs): MascotState {
  if (inputs.listening) return "listening";
  if (inputs.hasPendingInteraction) return "waiting";
  if (inputs.sessionStatus === "error") return "error";
  if (inputs.sessionStatus === "waiting") return "waiting";
  if (inputs.sessionStatus === "running") {
    return inputs.turnPhase === "thinking" ? "thinking" : "working";
  }
  if (inputs.msSinceLastDone !== null && inputs.msSinceLastDone < SUCCESS_WINDOW_MS) {
    return "success";
  }
  if (inputs.msSinceLastActivity >= SLEEP_AFTER_MS) return "sleeping";
  return "idle";
}
