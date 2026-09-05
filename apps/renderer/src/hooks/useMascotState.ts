/**
 * The reactive mascot's state (CONTEXT.md §Mascot), derived from the store on
 * a 1s tick. The decision table itself lives in `lib/mascotState.ts` — this
 * hook is only the glue: which store fields feed it, and the clock that
 * makes the time-based states (`sleeping`, `success`) advance without a new
 * store event.
 */
import { useEffect, useState } from "react";
import type { MascotState } from "@capygen/shared";
import { deriveMascotState } from "@/lib/mascotState";
import { activeTurnPhase, pendingInteractionBlock, useAppStore } from "@/store/appStore";

export function useMascotState(): MascotState {
  const sessionStatus = useAppStore(
    (s) => s.sessions.find((x) => x.id === s.activeSessionId)?.status,
  );
  const hasPendingInteraction = useAppStore((s) => pendingInteractionBlock(s) !== null);
  const turnPhase = useAppStore(activeTurnPhase);
  const listening = useAppStore((s) => s.listening);
  const lastActivityAt = useAppStore((s) => s.lastActivityAt);
  const lastDoneAt = useAppStore((s) => s.lastDoneAt);

  // Re-render once a second so "5 minutes idle" and "just finished" advance
  // on their own, without needing a store write to trigger them.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  return deriveMascotState({
    sessionStatus,
    hasPendingInteraction,
    turnPhase,
    listening,
    msSinceLastDone: lastDoneAt === null ? null : now - lastDoneAt,
    msSinceLastActivity: now - lastActivityAt,
  });
}
