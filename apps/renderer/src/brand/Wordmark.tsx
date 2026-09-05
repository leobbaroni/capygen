/**
 * "capygen" set in CheGuevaraBarry-Brown (SPEC §Design Reference; the
 * `@font-face` lives in `./brand.css`, not `index.css`, so this folder stays
 * self-contained per Task B3's file ownership).
 */
import { cn } from "../lib/utils";
import "./brand.css";

export interface WordmarkProps {
  className?: string;
  /** Overridable so two lockups on one screen (sidebar + landing footer)
   *  stay individually addressable. */
  testId?: string;
}

export function Wordmark({ className, testId = "wordmark" }: WordmarkProps) {
  return (
    <span className={cn("capygen-wordmark", className)} data-testid={testId}>
      capygen
    </span>
  );
}
