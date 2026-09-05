/**
 * Chat page (P2): a scrolling transcript with the composer pinned at the
 * bottom, both inside Omnigent's centred content column, plus the turn rail
 * (`TurnRail`) and a queued-messages strip for text typed while a turn is
 * still streaming.
 */
import { useEffect, useRef } from "react";
import { useParams } from "react-router-dom";
import { XIcon } from "lucide-react";
import { Mascot } from "@/components/Mascot";
import { Composer } from "@/components/Composer";
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
  const queuedMessages = useAppStore((s) => s.queuedMessages);
  // Subscribing to the map (not a derived array) keeps the component re-rendering
  // as blocks stream in; ordering is done by the selector below.
  const blocks = useAppStore((s) => s.blocks);
  const bottom = useRef<HTMLDivElement>(null);
  const mascotState = useMascotState();

  useEffect(() => {
    if (sessionId) void openSession(sessionId);
  }, [sessionId, openSession]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [turns.length, blocks]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="chat-page">
      <header className="titlebar-clearance flex h-9 shrink-0 items-center gap-2 px-4">
        <Mascot state={mascotState} className="h-5 w-5" />
        <span className="truncate text-sm text-muted-foreground">
          {session?.title || "Untitled session"}
        </span>
        {session?.status === "running" ? (
          <span
            data-testid="session-running-dot"
            aria-label="Running"
            className="size-1.5 shrink-0 animate-pulse rounded-full bg-info"
          />
        ) : null}
      </header>

      <TurnRail turns={turns} />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[840px] px-10 py-6">
          <Transcript
            turns={turns}
            blocksOfTurn={(turnId) => blocksOfTurn(useAppStore.getState(), turnId)}
          />
          <div ref={bottom} />
        </div>
      </div>

      <div className="shrink-0 px-10 pb-6">
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
          />
        </div>
      </div>
    </div>
  );
}
