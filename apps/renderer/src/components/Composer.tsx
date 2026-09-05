/**
 * The composer. Omnigent's shape: a rounded card with the textarea on top and a
 * tray of chips underneath, focus lifting a soft shadow rather than a border.
 *
 * Enter sends, Shift+Enter newlines — the desktop behaviour; the mobile/coarse
 * pointer exception in the reference does not apply to a Windows app.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export interface ComposerProps {
  onSubmit: (text: string) => void | Promise<void>;
  onInterrupt?: () => void;
  busy?: boolean;
  disabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  /** Rendered in the tray under the textarea (project chip, mode chip, …). */
  tray?: React.ReactNode;
  testId?: string;
}

export function Composer({
  onSubmit,
  onInterrupt,
  busy = false,
  disabled = false,
  placeholder = "Describe a task…",
  autoFocus = true,
  tray,
  testId = "composer",
}: ComposerProps) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  // G1: the composer is focused and usable the moment the window paints.
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  // Grow with the content up to a cap, then scroll inside.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [value]);

  async function submit(): Promise<void> {
    const text = value.trim();
    if (text === "" || disabled) return;
    setValue("");
    await onSubmit(text);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      data-testid={testId}
      className={cn(
        "relative z-10 flex w-full flex-col rounded-2xl border border-border bg-card dark:bg-card-solid",
        "transition-shadow duration-150 has-[textarea:focus]:shadow-[var(--composer-shadow-focus)]",
      )}
    >
      <div className="relative overflow-hidden px-4 pt-3">
        <Textarea
          ref={ref}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          spellCheck={false}
          data-testid={`${testId}-input`}
          aria-label="Message"
          className="max-h-[220px] min-h-[24px] overflow-y-auto"
        />
      </div>
      <div className="flex items-center justify-between gap-2 px-3 pt-2 pb-2.5">
        <div className="flex min-w-0 items-center gap-1.5">{tray}</div>
        {busy ? (
          <Button
            variant="secondary"
            size="icon-sm"
            onClick={onInterrupt}
            aria-label="Stop"
            data-testid={`${testId}-stop`}
          >
            <Square className="size-3.5" />
          </Button>
        ) : (
          <Button
            type="submit"
            size="icon-sm"
            disabled={disabled || value.trim() === ""}
            aria-label="Send"
            data-testid={`${testId}-send`}
          >
            <ArrowUp className="size-4" />
          </Button>
        )}
      </div>
    </form>
  );
}
