/**
 * shadcn/ui Alert, ported from
 * reference/omnigent/web/src/components/ui/alert.tsx. Used by the permission,
 * question and error block cards — the family of "something needs your
 * attention" surfaces in the transcript.
 */
import { type ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const alertVariants = cva(
  "relative grid w-full gap-1 rounded-lg border px-3 py-2.5 text-left text-sm has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2 *:[svg]:row-span-2 *:[svg]:translate-y-0.5",
  {
    variants: {
      variant: {
        default: "bg-card text-card-foreground",
        destructive: "border-destructive/40 bg-card text-destructive",
        warning: "border-warning/40 bg-card text-foreground",
        info: "border-info/40 bg-card text-foreground",
        success: "border-success/40 bg-card text-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export function Alert({
  className,
  variant,
  ...props
}: ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

export function AlertTitle({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn("flex items-center gap-2 font-medium", className)}
      {...props}
    />
  );
}

export function AlertDescription({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn("flex flex-col gap-2 text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}
