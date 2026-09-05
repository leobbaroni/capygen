import { OctagonXIcon } from "lucide-react";
import type { ErrorBlock } from "@capygen/shared";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export function ErrorCard({ block }: { block: ErrorBlock }) {
  return (
    <Alert data-testid="block-error" variant="destructive">
      <OctagonXIcon className="size-4" />
      <AlertTitle>{block.message}</AlertTitle>
      {block.detail ? (
        <AlertDescription>
          <pre className="max-h-48 overflow-auto rounded-md bg-code-bg px-2 py-1 font-mono text-xs whitespace-pre-wrap break-words text-destructive">
            {block.detail}
          </pre>
        </AlertDescription>
      ) : null}
    </Alert>
  );
}
