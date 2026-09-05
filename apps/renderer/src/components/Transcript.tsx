/**
 * The transcript: one row per turn (user right-aligned bubble, agent/system
 * full-width prose), each rendering its blocks through `BlockRenderer`
 * (SPEC R6). A streaming agent turn with no blocks yet shows the dot
 * indicator instead of an empty gap.
 */
import type { Block, Turn } from "@capygen/shared";
import { BlockRenderer } from "@/components/blocks/BlockRenderer";
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
      id={`turn-${turn.id}`}
      data-testid="turn"
      data-role={turn.role}
      data-status={turn.status}
      className={cn("flex w-full scroll-mt-4", isUser ? "justify-end" : "justify-start")}
    >
      <div className={cn("flex min-w-0 flex-col gap-2", isUser ? "max-w-[80%]" : "w-full")}>
        {turn.hopIndex > 0 && !isUser ? (
          <span className="text-xs text-muted-foreground" data-testid="turn-hop">
            hop {turn.hopIndex}
          </span>
        ) : null}
        {blocks.map((block) => (
          <BlockRenderer key={block.id} block={block} isUser={isUser} />
        ))}
        {blocks.length === 0 && turn.status === "streaming" ? <StreamingDots /> : null}
        {turn.status === "interrupted" ? (
          <span className="text-sm text-muted-foreground" data-testid="turn-interrupted">
            Interrupted
          </span>
        ) : null}
      </div>
    </div>
  );
}

function StreamingDots() {
  return (
    <span
      className="flex items-center gap-1 py-1 text-muted-foreground"
      data-testid="turn-thinking"
      aria-label="Thinking"
    >
      <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.3s]" />
      <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.15s]" />
      <span className="size-1.5 animate-bounce rounded-full bg-current" />
    </span>
  );
}
