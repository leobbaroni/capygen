/**
 * "capygen" set in CheGuevaraBarry-Brown (SPEC §Design Reference; the
 * `@font-face` lives in `./brand.css`, not `index.css`, so this folder stays
 * self-contained per Task B3's file ownership).
 */
import { cn } from "../lib/utils";
import "./brand.css";

export interface WordmarkProps {
  className?: string;
}

export function Wordmark({ className }: WordmarkProps) {
  return (
    <span className={cn("capygen-wordmark", className)} data-testid="wordmark">
      capygen
    </span>
  );
}
