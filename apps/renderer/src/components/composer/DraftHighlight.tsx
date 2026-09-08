import { forwardRef } from "react";
export const DraftHighlight = forwardRef<HTMLDivElement, { text: string; recognized: ReadonlySet<string> }>(function DraftHighlight({ text, recognized }, ref) {
  const parts = text.split(/((?:^|\s)[@/][\w:.-]+(?![\w/:-]))/g);
  return <div ref={ref} aria-hidden="true" data-testid="composer-draft-highlight" className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words text-ui text-foreground">{parts.map((part, index) => recognized.has(part.trim().toLowerCase()) ? <span key={index}>{part.match(/^\s*/)?.[0]}<span className="rounded bg-primary/10 text-primary">{part.trim()}</span></span> : part)}{text.endsWith("\n") ? "\u200b" : ""}</div>;
});
