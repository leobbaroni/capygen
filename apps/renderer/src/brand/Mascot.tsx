/**
 * The reactive capybara (CONTEXT.md §Mascot; SPEC §Design Reference).
 *
 * Renders one of the eight 256px transparent PNGs staged into `public/mascot`
 * (source of truth: `assets/mascot/states/*.png`, copied by
 * `apps/renderer/scripts/sync-assets.ts`). Two behaviours, both CSS-driven so
 * they stay off the main thread and honour `prefers-reduced-motion`
 * (`brand.css`):
 *
 *  - Cross-fade: when `state` changes, the previous frame stays mounted and
 *    fades out over 150ms while the new one fades in, instead of popping.
 *  - Per-state micro-animation on the current frame: idle bobs gently,
 *    thinking pulses slowly (a stand-in "thinking" cue), working jitters in
 *    4 steps, waiting blinks, success bounces once, error shakes once,
 *    sleeping bobs slower, listening pulses faster than thinking.
 */
import { useEffect, useRef, useState } from "react";
import type { MascotState } from "@capygen/shared";
import { cn } from "../lib/utils";
import "./brand.css";

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

/** How long the outgoing frame takes to fade out — matches `brand.css`. */
const CROSSFADE_MS = 150;

export interface MascotProps {
  state?: MascotState;
  /** Rendered size in CSS pixels (square). Default 64 — matches the
   * landing page's `h-16 w-16`. */
  size?: number;
  className?: string;
}

function frameSrc(state: MascotState): string {
  // Relative, not absolute: the built app loads `dist/index.html` over
  // `file://` (vite.config.ts `base: "./"`), where a leading `/` would
  // resolve against the filesystem root instead of the app folder.
  return `./mascot/${state}.png`;
}

export function Mascot({ state = "idle", size = 64, className }: MascotProps) {
  const previousStateRef = useRef<MascotState>(state);
  const [outgoing, setOutgoing] = useState<MascotState | null>(null);

  useEffect(() => {
    const previous = previousStateRef.current;
    if (previous === state) return;
    previousStateRef.current = state;
    setOutgoing(previous);
    const timer = window.setTimeout(() => setOutgoing(null), CROSSFADE_MS);
    return () => window.clearTimeout(timer);
  }, [state]);

  return (
    <span
      className={cn("capygen-mascot", className)}
      style={{ width: size, height: size }}
      data-testid="mascot"
      data-state={state}
    >
      {outgoing ? (
        <span key={outgoing} className="capygen-mascot__layer capygen-mascot__layer--out" aria-hidden>
          <img
            src={frameSrc(outgoing)}
            alt=""
            draggable={false}
            className={cn("capygen-mascot__img", `capygen-mascot__img--${outgoing}`)}
          />
        </span>
      ) : null}
      <span key={state} className="capygen-mascot__layer capygen-mascot__layer--in">
        <img
          src={frameSrc(state)}
          alt={LABELS[state]}
          draggable={false}
          className={cn("capygen-mascot__img", `capygen-mascot__img--${state}`)}
        />
      </span>
    </span>
  );
}

/** Session status → mascot state. Mirrors `components/Mascot.tsx`'s mapping
 * (CONTEXT.md §Mascot: state mirrors the active session's status) so both can
 * agree without importing each other. */
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
