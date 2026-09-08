/**
 * Session mode picker (SPEC R10): **Solo orchestrator** (one lead agent) vs.
 * **Round-table** (several top-level agents share the transcript, ADR-0002)
 * — a segmented two-button control. Used both on the New Session landing
 * (choosing the mode before the session exists, next to the harness picker)
 * and in the chat header (`sessions.setMode` on an existing session, ADR-0002:
 * "can be switched later without losing history"). The caller owns what
 * happens on a change — `ChatPage` shows a confirm before switching an
 * existing round-table session with more than one agent back to solo.
 */
import { UserIcon, UsersIcon, SettingsIcon, type LucideIcon } from "lucide-react";
import type { SessionMode } from "@capygen/shared";
import { cn } from "@/lib/utils";

const OPTIONS: { mode: SessionMode; label: string; icon: LucideIcon }[] = [
  { mode: "solo", label: "Solo orchestrator", icon: UserIcon },
  { mode: "round-table", label: "Round-table", icon: UsersIcon },
];

export interface ModePickerProps {
  mode: SessionMode;
  onChange: (mode: SessionMode) => void;
  disabled?: boolean;
  testId?: string;
  allowCustom?: boolean;
}

export function ModePicker({
  mode,
  onChange,
  disabled = false,
  testId = "mode-picker",
  allowCustom = false,
}: ModePickerProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Session mode"
      data-testid={testId}
      className="flex shrink-0 items-center gap-0.5 rounded-full border border-border-weak bg-muted/40 p-0.5"
    >
      {[...OPTIONS, ...(allowCustom || mode === "custom" ? [{ mode: "custom" as const, label: "Custom", icon: SettingsIcon }] : [])].map(({ mode: option, label, icon: Icon }) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={mode === option}
          disabled={disabled}
          data-testid={`${testId}-${option}`}
          onClick={() => option !== mode && onChange(option)}
          className={cn(
            "flex h-6 items-center gap-1 rounded-full px-2.5 text-sm font-normal whitespace-nowrap transition-colors",
            mode === option
              ? "bg-card text-foreground shadow-xs"
              : "text-muted-foreground hover:text-foreground",
            disabled && "cursor-not-allowed opacity-60",
          )}
        >
          <Icon className="size-3.5 shrink-0" />
          {label}
        </button>
      ))}
    </div>
  );
}
