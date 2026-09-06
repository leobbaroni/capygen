/**
 * A minimal Dialog with the same Dialog/DialogContent/DialogHeader/
 * DialogTitle/DialogFooter shape as Radix's (and the reference's port of it
 * in reference/omnigent/web/src/components/ui/dialog.tsx), written without
 * the Radix dependency — same rationale as `ui/collapsible.tsx` and
 * `ui/tooltip.tsx`: nothing else in capygen needs it yet.
 *
 * Renders a fixed, centred overlay while `open`; Escape and a mousedown on
 * the overlay itself (not its content — stopped via `stopPropagation` in
 * `DialogContent`) both call `onOpenChange(false)`.
 */
import { useEffect, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

export function Dialog({ open, onOpenChange, children }: DialogProps) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onOpenChange(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  if (!open) return null;
  return (
    <div
      role="presentation"
      data-slot="dialog-overlay"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onOpenChange(false);
      }}
    >
      {children}
    </div>
  );
}

export function DialogContent({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      data-slot="dialog-content"
      onMouseDown={(e) => e.stopPropagation()}
      className={cn(
        "flex max-h-[85vh] w-full max-w-lg flex-col gap-4 rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-dialog",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div data-slot="dialog-header" className={cn("flex flex-col gap-1", className)} {...props} />
  );
}

export function DialogTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      data-slot="dialog-title"
      className={cn("text-base font-semibold text-foreground", className)}
      {...props}
    />
  );
}

export function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn("flex items-center justify-end gap-2 pt-1", className)}
      {...props}
    />
  );
}
