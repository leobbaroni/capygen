/**
 * The minimal transcript for task A1: user turns as a right-aligned bubble,
 * agent turns as plain prose, and one renderer per block kind so nothing is
 * silently dropped while the harness layer is still a stub.
 *
 * Phase 3 replaces the per-kind bodies with Omnigent's real cards (tool call
 * headers, diffs, permission and AskUserQuestion cards). The `switch` here is
 * exhaustive on purpose — adding a kind to the union makes this a type error.
 */
import type { Block, Turn } from "@capygen/shared";
import { cn } from "@/lib/utils";

export interface TranscriptProps {
  turns: Turn[];
  blocksOfTurn: (turnId: string) => Block[];
}

export function Transcript({ turns, blocksOfTurn }: TranscriptProps) {
  return (
    <div className="flex flex-col gap-5" data-testid="transcript">
      {turns.map((turn) => (
        <TurnView key={turn.id} turn={turn} blocks={blocksOfTurn(turn.id)} />
      ))}
    </div>
  );
}

function TurnView({ turn, blocks }: { turn: Turn; blocks: Block[] }) {
  const isUser = turn.role === "user";
  return (
    <div
      data-testid="turn"
      data-role={turn.role}
      data-status={turn.status}
      className={cn("flex w-full", isUser ? "justify-end" : "justify-start")}
    >
      <div className={cn("flex min-w-0 flex-col gap-2", isUser ? "max-w-[80%]" : "w-full")}>
        {blocks.map((block) => (
          <BlockView key={block.id} block={block} isUser={isUser} />
        ))}
        {blocks.length === 0 && turn.status === "streaming" ? (
          <span className="text-sm text-muted-foreground" data-testid="turn-thinking">
            Thinking…
          </span>
        ) : null}
      </div>
    </div>
  );
}

function BlockView({ block, isUser }: { block: Block; isUser: boolean }) {
  switch (block.kind) {
    case "text":
      return (
        <div
          data-testid="block-text"
          className={cn(
            "text-ui whitespace-pre-wrap break-words",
            isUser
              ? "rounded-2xl bg-secondary px-3.5 py-2 text-secondary-foreground"
              : "text-foreground",
          )}
        >
          {block.text}
        </div>
      );

    case "thinking":
      return (
        <details data-testid="block-thinking" className="text-sm text-muted-foreground">
          <summary className="cursor-pointer select-none">Thinking</summary>
          <div className="mt-1 whitespace-pre-wrap">{block.text}</div>
        </details>
      );

    case "tool_call":
      return (
        <div
          data-testid="block-tool-call"
          data-status={block.status}
          className="rounded-lg border border-border-weak bg-card px-3 py-2 text-sm"
        >
          <div className="flex items-center gap-2">
            <span className="font-mono">{block.name}</span>
            <span className="text-muted-foreground">{block.status}</span>
          </div>
        </div>
      );

    case "diff":
      return (
        <div
          data-testid="block-diff"
          className="rounded-lg border border-border-weak bg-card px-3 py-2 text-sm"
        >
          <div className="font-mono">{block.path}</div>
          <div className="text-muted-foreground">
            +{block.additions} −{block.deletions}
          </div>
        </div>
      );

    case "permission":
      return (
        <div
          data-testid="block-permission"
          className="rounded-lg border border-warning/40 bg-card px-3 py-2 text-sm"
        >
          Permission requested for <span className="font-mono">{block.request.toolName}</span>
          {block.decision ? ` — ${block.decision.behavior}` : ""}
        </div>
      );

    case "question":
      return (
        <div
          data-testid="block-question"
          className="rounded-lg border border-info/40 bg-card px-3 py-2 text-sm"
        >
          {block.questions.map((q) => (
            <div key={q.question}>{q.question}</div>
          ))}
        </div>
      );

    case "subagent":
      return (
        <div
          data-testid="block-subagent"
          className="rounded-lg border border-session-active/40 bg-card px-3 py-2 text-sm"
        >
          Sub-agent <span className="font-medium">{block.name}</span> — {block.status}
        </div>
      );

    case "error":
      return (
        <div
          data-testid="block-error"
          className="rounded-lg border border-destructive/50 bg-card px-3 py-2 text-sm text-destructive"
        >
          {block.message}
        </div>
      );

    case "usage":
      return (
        <div data-testid="block-usage" className="text-sm text-muted-foreground">
          {block.usage.inputTokens} in · {block.usage.outputTokens} out ·{" "}
          {block.usage.costUsd.toFixed(4)} USD
        </div>
      );
  }
}
