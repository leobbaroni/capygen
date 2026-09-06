/** Static, hand-drawn pixel mascot states. Source: scripts/mascot-pixels.py. */
import type { CSSProperties } from "react";
import { type MascotState } from "@capygen/shared";
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

export interface MascotProps {
  state?: MascotState;
  /** 144px is a sharp 2x rendering of the 72px logical drawing. */
  size?: number;
  className?: string;
  /** Sidebar and page mascot use different test ids. */
  testId?: string;
}

export function Mascot({ state = "idle", size = 144, className, testId = "mascot" }: MascotProps) {
  const style = {
    width: size,
    height: size,
    // Relative URL also works in the packaged file:// renderer.
    backgroundImage: `url("./mascot/${state}.png")`,
    backgroundSize: "100% 100%",
  } as CSSProperties;

  return (
    <span
      key={state}
      role="img"
      aria-label={LABELS[state]}
      className={cn("capygen-mascot", `capygen-mascot--${state}`, className)}
      style={style}
      data-testid={testId}
      data-state={state}
    />
  );
}
