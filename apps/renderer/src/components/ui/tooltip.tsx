/**
 * A minimal Tooltip with the same `Tooltip`/`TooltipTrigger`/`TooltipContent`
 * shape as Radix's (and the reference's port of it), written without the
 * Radix dependency — the same call `ui/collapsible.tsx` made, for the same
 * reason: nothing else in capygen needs it yet.
 *
 * Shown on hover/focus (mouse and keyboard both reach it) *or* a click —
 * click only ever opens, never toggles, because a real click is preceded by
 * its own `mouseenter` (so does `userEvent.click`): a toggling click handler
 * would open on that hover and immediately flip back closed on the click
 * that follows it in the same interaction. This also means tests can
 * exercise it with a plain `click` instead of simulating `:hover` (jsdom
 * does not run CSS, and RTL's `hover()` only fires the DOM events — this
 * listens for those events directly rather than relying on CSS `:hover`).
 *
 * Used by `UsageLine`'s per-model breakdown (SPEC R23).
 */
import {
  cloneElement,
  createContext,
  useContext,
  useId,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

interface TooltipCtx {
  open: boolean;
  show: () => void;
  hide: () => void;
  contentId: string;
}

const TooltipContext = createContext<TooltipCtx | null>(null);

function useTooltipContext(): TooltipCtx {
  const ctx = useContext(TooltipContext);
  if (!ctx) throw new Error("Tooltip.* must be rendered inside <Tooltip>");
  return ctx;
}

export function Tooltip({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  return (
    <TooltipContext.Provider
      value={{
        open,
        show: () => setOpen(true),
        hide: () => setOpen(false),
        contentId,
      }}
    >
      <span className="relative inline-flex" data-slot="tooltip">
        {children}
      </span>
    </TooltipContext.Provider>
  );
}

/** Wraps a single child element (a button, an icon, …) and attaches the
 *  hover/focus/click handlers — it does not render an element of its own, so
 *  the trigger keeps whatever semantics its child already has. */
export function TooltipTrigger({ children }: { children: ReactElement }) {
  const { show, hide, open, contentId } = useTooltipContext();
  return (
    <span
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      // Only opens, never toggles: `userEvent.click` (and a real mouse
      // click) fires `mouseenter` before `click`, so a toggling handler here
      // would open on the hover and immediately flip back closed on the
      // click that follows it in the same interaction.
      onClick={show}
      className="inline-flex"
    >
      {/* Cloning rather than a wrapping <button> keeps a real <button> child
       *  from becoming an invalid nested-button DOM. */}
      {cloneElement(children, { "aria-describedby": open ? contentId : undefined })}
    </span>
  );
}

export function TooltipContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  const { open, contentId } = useTooltipContext();
  const ref = useRef<HTMLDivElement>(null);
  if (!open) return null;
  return (
    <div
      ref={ref}
      id={contentId}
      role="tooltip"
      data-slot="tooltip-content"
      className={cn(
        "absolute bottom-full left-1/2 z-30 mb-1.5 w-max max-w-64 -translate-x-1/2 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-menu",
        className,
      )}
      {...props}
    />
  );
}
