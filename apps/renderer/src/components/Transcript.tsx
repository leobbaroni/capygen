/**
 * The transcript: one row per turn (user right-aligned bubble, agent/system
 * full-width prose), each rendering its blocks through `BlockRenderer`
 * (SPEC R6). A streaming agent turn with no blocks yet shows the dot
 * indicator instead of an empty gap.
 *
 * Round-table speaker labels (SPEC item B2.2): `agents` is the session's
 * roster; an agent turn gets a `SpeakerLabel` header above its blocks only
 * when there is more than one agent — a solo session's single agent needs no
 * label (the mode invariant from ADR-0002: "Solo mode is round-table with
 * one agent", so `agents.length > 1` is the real "is this actually a
 * round-table conversation?" signal, not `Session.mode` itself).
 */
import type { Agent, Block, Turn } from "@capygen/shared";
import { BlockRenderer } from "@/components/blocks/BlockRenderer";
import { SpeakerLabel } from "@/components/SpeakerLabel";
import { cn } from "@/lib/utils";

export interface TranscriptProps {
  turns: Turn[];
  blocksOfTurn: (turnId: string) => Block[];
  /** Session's top-level agents, for speaker labels. Defaults to `[]`, which
   *  keeps every turn label-free (the pre-Phase-4 solo look). */
  agents?: Agent[];
}

export function Transcript({ turns, blocksOfTurn, agents = [] }: TranscriptProps) {
  return (
    <div className="flex flex-col gap-5" data-testid="transcript">
      {turns.map((turn) => (
        <TurnView key={turn.id} turn={turn} blocks={blocksOfTurn(turn.id)} agents={agents} />
      ))}
    </div>
  );
}

function TurnView({ turn, blocks, agents }: { turn: Turn; blocks: Block[]; agents: Agent[] }) {
  const isUser = turn.role === "user";
  const speaker =
    !isUser && agents.length > 1 ? agents.find((a) => a.id === turn.agentId) : undefined;
  return (
    <div
      id={`turn-${turn.id}`}
      data-testid="turn"
      data-role={turn.role}
      data-status={turn.status}
      className={cn("flex w-full scroll-mt-4", isUser ? "justify-end" : "justify-start")}
    >
      <div className={cn("flex min-w-0 flex-col gap-2", isUser ? "max-w-[80%]" : "w-full")}>
        {speaker ? <SpeakerLabel agent={speaker} /> : null}
        {/* Hop 1 is just "the agent answering the user" — every solo turn is
            one, so badging it is noise. The chip only means something once an
            agent answers another agent (CONTEXT.md §Turn; the dispatcher and
            its hop cap arrive in Phase 4). */}
        {turn.hopIndex > 1 && !isUser ? (
          <span className="text-xs text-muted-foreground" data-testid="turn-hop">
            hop {turn.hopIndex}
          </span>
        ) : null}
        {blocks.map((block) => (
          // `id` is a scroll anchor: a `task`-family `ToolCallCard` links to
          // the sub-agent block it spawned (`toolFamily.ts`'s
          // `subagentBlockId`), and `TurnRail`-style deep links reuse the
          // same `block-<id>` convention as `turn-<id>`.
          <div key={block.id} id={`block-${block.id}`}>
            <BlockRenderer block={block} isUser={isUser} />
          </div>
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
