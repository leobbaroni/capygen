/**
 * A minimal Collapsible with the same trigger/content shape as Radix's (and
 * the reference's port of it in reference/omnigent/web/src/components/ui/
 * collapsible.tsx), written without the Radix dependency — nothing else in
 * capygen needs it yet, so pulling in `@radix-ui/react-collapsible` for one
 * component would be dead weight. Used by the tool-call card's expandable
 * parameters/output panel and the thinking block.
 */
import {
  createContext,
  useContext,
  useId,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

interface CollapsibleCtx {
  open: boolean;
  toggle: () => void;
  contentId: string;
}

const CollapsibleContext = createContext<CollapsibleCtx | null>(null);

function useCollapsibleContext(): CollapsibleCtx {
  const ctx = useContext(CollapsibleContext);
  if (!ctx) throw new Error("Collapsible.* must be rendered inside <Collapsible>");
  return ctx;
}

export interface CollapsibleProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}

export function Collapsible({
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  className,
  children,
  ...props
}: CollapsibleProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const open = controlledOpen ?? uncontrolledOpen;
  const contentId = useId();

  function toggle(): void {
    const next = !open;
    if (controlledOpen === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  }

  return (
    <CollapsibleContext.Provider value={{ open, toggle, contentId }}>
      <div data-slot="collapsible" data-state={open ? "open" : "closed"} className={className} {...props}>
        {children}
      </div>
    </CollapsibleContext.Provider>
  );
}

export function CollapsibleTrigger({
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { open, toggle, contentId } = useCollapsibleContext();
  return (
    <button
      type="button"
      data-slot="collapsible-trigger"
      data-state={open ? "open" : "closed"}
      aria-expanded={open}
      aria-controls={contentId}
      onClick={toggle}
      className={cn("appearance-none bg-transparent p-0", className)}
      {...props}
    >
      {children}
    </button>
  );
}

export function CollapsibleContent({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  const { open, contentId } = useCollapsibleContext();
  if (!open) return null;
  return (
    <div id={contentId} data-slot="collapsible-content" data-state="open" className={className} {...props}>
      {children}
    </div>
  );
}
