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
 *
 * Two more attributions the transcript owes the reader:
 *   - a **user** turn shows who it was addressed to (`Turn.mentions`), and
 *     any `@name` that answered to nobody, so "who is this going to?" is
 *     visible before the reply arrives rather than only once the wrong
 *     agent's speaker label appears;
 *   - a block a **delegated sub-agent** wrote (`Block.delegatedFrom`, SPEC
 *     R12) is nested under its own label instead of sitting at the parent's
 *     indentation, where another model's answer read as the lead's own words.
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
  /** `@names` on one user turn that matched no agent, from `chat.send`'s
   *  `unknownMentions` (`resolveTargets` never drops them silently). */
  unknownMentions?: { turnId: string; names: string[] } | null;
}

export function Transcript({
  turns,
  blocksOfTurn,
  agents = [],
  unknownMentions = null,
}: TranscriptProps) {
  return (
    <div className="flex flex-col gap-5" data-testid="transcript">
      {turns.map((turn) => (
        <TurnView
          key={turn.id}
          turn={turn}
          blocks={blocksOfTurn(turn.id)}
          agents={agents}
          unknown={unknownMentions?.turnId === turn.id ? unknownMentions.names : []}
        />
      ))}
    </div>
  );
}

function TurnView({
  turn,
  blocks,
  agents,
  unknown,
}: {
  turn: Turn;
  blocks: Block[];
  agents: Agent[];
  unknown: string[];
}) {
  const isUser = turn.role === "user";
  const speaker =
    !isUser && agents.length > 1 ? agents.find((a) => a.id === turn.agentId) : undefined;
  const recipients = isUser
    ? turn.mentions
        .map((id) => agents.find((a) => a.id === id))
        .filter((a): a is Agent => a !== undefined)
    : [];
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
        {recipients.length > 0 || unknown.length > 0 ? (
          <div
            className="flex flex-wrap items-center justify-end gap-1"
            data-testid="turn-recipients"
          >
            {recipients.map((agent) => (
              <span
                key={agent.id}
                data-testid="turn-recipient"
                className="rounded-full border border-border-weak px-1.5 py-0.5 text-xs text-muted-foreground"
              >
                @{agent.mentionName}
              </span>
            ))}
            {unknown.map((name) => (
              <span
                key={name}
                role="status"
                data-testid="turn-unknown-mention"
                title="No agent in this session answers to that name — the lead replied instead."
                className="rounded-full border border-warning/50 bg-warning/10 px-1.5 py-0.5 text-xs text-warning"
              >
                @{name} — no such agent
              </span>
            ))}
          </div>
        ) : null}
        {blocks.map((block) => (
          // `id` is a scroll anchor: a `task`-family `ToolCallCard` links to
          // the sub-agent block it spawned (`toolFamily.ts`'s
          // `subagentBlockId`), and `TurnRail`-style deep links reuse the
          // same `block-<id>` convention as `turn-<id>`.
          <div key={block.id} id={`block-${block.id}`}>
            {block.delegatedFrom ? (
              // A delegated sub-agent streams into the *parent's* turn (SPEC
              // R12). Indented under its own label so the reader can tell the
              // lead's own output from the model it delegated to — the two
              // used to sit side by side at the same indentation, and the only
              // clue was the model id inside a usage line.
              <div
                className="ml-2 border-l-2 border-info/40 pl-3"
                data-testid="delegated-block"
                data-delegated-from={block.delegatedFrom}
              >
                <p className="pb-1 text-xs text-muted-foreground">
                  delegated · {block.delegatedFrom}
                </p>
                <BlockRenderer block={block} isUser={isUser} />
              </div>
            ) : (
              <BlockRenderer block={block} isUser={isUser} />
            )}
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
