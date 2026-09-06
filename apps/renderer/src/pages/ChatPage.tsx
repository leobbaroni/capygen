/**
 * Chat page (P2): a scrolling transcript with the composer pinned at the
 * bottom, both inside Omnigent's centred content column, plus the turn rail
 * (`TurnRail`) and a queued-messages strip for text typed while a turn is
 * still streaming.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { ArrowDownIcon, XIcon } from "lucide-react";
import { Mascot } from "@/brand/Mascot";
import { Composer } from "@/components/Composer";
import { SessionUsageMeter } from "@/components/SessionUsageMeter";
import { Transcript } from "@/components/Transcript";
import { TurnRail } from "@/components/TurnRail";
import { useMascotState } from "@/hooks/useMascotState";
import { blocksOfTurn, isBusy, useAppStore } from "@/store/appStore";
import { cn } from "@/lib/utils";

export function ChatPage() {
  const { sessionId = "" } = useParams();
  const openSession = useAppStore((s) => s.openSession);
  const send = useAppStore((s) => s.send);
  const interrupt = useAppStore((s) => s.interrupt);
  const turns = useAppStore((s) => s.turns);
  const busy = useAppStore(isBusy);
  const session = useAppStore((s) => s.sessions.find((x) => x.id === sessionId));
  const commands = useAppStore((s) => s.commands);
  const harnesses = useAppStore((s) => s.harnesses);
  // The picker for an ongoing session only ever shows/edits the lead agent —
  // round-table's per-agent @-mention target picker is Phase 4 (R10/R11).
  const leadAgent = useAppStore((s) =>
    s.agents.find((a) => a.id === s.sessions.find((x) => x.id === sessionId)?.leadAgentId),
  );
  const queuedMessages = useAppStore((s) => s.queuedMessages);
  const error = useAppStore((s) => s.error);
  // Subscribing to the map (not a derived array) keeps the component re-rendering
  // as blocks stream in; ordering is done by the selector below.
  const blocks = useAppStore((s) => s.blocks);
  const bottom = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  /** False once the user scrolls up: streaming must not yank them back down. */
  const [pinned, setPinned] = useState(true);
  const mascotState = useMascotState();

  useEffect(() => {
    if (sessionId) void openSession(sessionId);
  }, [sessionId, openSession]);

  const nearBottom = useCallback((el: HTMLDivElement): boolean => {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }, []);

  // A token arrives many times a second while an agent replies. Following it
  // is right only while the reader is already at the bottom; otherwise they
  // are re-reading something and being scrolled away from it is the bug.
  useEffect(() => {
    if (!pinned) return;
    bottom.current?.scrollIntoView({ block: "end" });
  }, [turns.length, blocks, pinned]);

  // A new session (or a switch) starts pinned again.
  useEffect(() => {
    setPinned(true);
  }, [sessionId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="chat-page">
      <header className="titlebar-clearance flex h-9 shrink-0 items-center gap-2 px-4">
        <Mascot state={mascotState} size={20} />
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
          {session?.title || "Untitled session"}
        </span>
        {session?.status === "running" ? (
          <span
            data-testid="session-running-dot"
            aria-label="Running"
            className="size-1.5 shrink-0 animate-pulse rounded-full bg-info"
          />
        ) : null}
        <SessionUsageMeter />
      </header>

      <TurnRail turns={turns} />

      <div
        ref={scroller}
        onScroll={(e) => setPinned(nearBottom(e.currentTarget))}
        className="min-h-0 flex-1 overflow-y-auto"
        data-testid="transcript-scroller"
        data-pinned={pinned || undefined}
      >
        <div className="mx-auto w-full max-w-[840px] px-10 py-6">
          <Transcript
            turns={turns}
            blocksOfTurn={(turnId) => blocksOfTurn(useAppStore.getState(), turnId)}
          />
          <div ref={bottom} />
        </div>
      </div>

      <div className="relative shrink-0 px-10 pb-6">
        {error ? (
          <div className="mx-auto mb-2 w-full max-w-[840px]">
            <p
              role="alert"
              data-testid="chat-error"
              className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-sm text-destructive"
            >
              {error}
            </p>
          </div>
        ) : null}
        {!pinned && turns.length > 0 ? (
          <button
            type="button"
            data-testid="scroll-to-bottom"
            aria-label="Scroll to the newest message"
            onClick={() => {
              setPinned(true);
              bottom.current?.scrollIntoView({ block: "end", behavior: "smooth" });
            }}
            className="absolute -top-5 left-1/2 z-20 flex size-8 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-popover text-muted-foreground shadow-menu transition-colors hover:text-foreground"
          >
            <ArrowDownIcon className="size-4" />
          </button>
        ) : null}
        <div className="mx-auto flex w-full max-w-[840px] flex-col gap-2">
          {queuedMessages.length > 0 ? (
            <ul data-testid="queued-messages" className="flex flex-col gap-1">
              {queuedMessages.map((text, i) => (
                <li
                  key={i}
                  className="flex items-center gap-2 rounded-lg border border-border-weak bg-muted/40 px-3 py-1.5 text-sm text-muted-foreground"
                >
                  <span className={cn("min-w-0 flex-1 truncate")}>{text}</span>
                  <span className="shrink-0 text-xs">queued</span>
                  <button
                    type="button"
                    aria-label="Remove queued message"
                    onClick={() =>
                      useAppStore.setState((s) => ({
                        queuedMessages: s.queuedMessages.filter((_, idx) => idx !== i),
                      }))
                    }
                    className="shrink-0 rounded-full hover:text-foreground"
                  >
                    <XIcon className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <Composer
            onSubmit={(text) => send(text)}
            onInterrupt={() => void interrupt()}
            busy={busy}
            testId="chat-composer"
            placeholder="Reply…"
            commands={commands}
            harnesses={harnesses}
            agent={leadAgent ? { backend: leadAgent.backend, model: leadAgent.model } : null}
            // An agent's backend is fixed once it exists (CONTEXT.md); the
            // picker only ever offers that same backend's other models here
            // (Composer filters to `agent.backend`), so "picking" one is
            // exactly what the `/model` built-in is for (R14) — there is no
            // separate "switch model" IPC to call.
            onPickAgent={({ model }) => void send(`/model ${model}`)}
          />
        </div>
      </div>
    </div>
  );
}
