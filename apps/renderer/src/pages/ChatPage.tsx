/**
 * Chat page (P2, skeleton): a scrolling transcript with the composer pinned at
 * the bottom, both inside Omnigent's centred content column. The turn rail,
 * queued-messages strip and scrollbar map arrive with P2 proper.
 */
import { useEffect, useRef } from "react";
import { useParams } from "react-router-dom";
import { Mascot, mascotStateForSession } from "@/components/Mascot";
import { Composer } from "@/components/Composer";
import { Transcript } from "@/components/Transcript";
import { blocksOfTurn, isBusy, useAppStore } from "@/store/appStore";

export function ChatPage() {
  const { sessionId = "" } = useParams();
  const openSession = useAppStore((s) => s.openSession);
  const send = useAppStore((s) => s.send);
  const interrupt = useAppStore((s) => s.interrupt);
  const turns = useAppStore((s) => s.turns);
  const busy = useAppStore(isBusy);
  const session = useAppStore((s) => s.sessions.find((x) => x.id === sessionId));
  // Subscribing to the map (not a derived array) keeps the component re-rendering
  // as blocks stream in; ordering is done by the selector below.
  const blocks = useAppStore((s) => s.blocks);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (sessionId) void openSession(sessionId);
  }, [sessionId, openSession]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [turns.length, blocks]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="chat-page">
      <header className="titlebar-clearance flex h-9 shrink-0 items-center gap-2 px-4">
        <Mascot
          state={mascotStateForSession(session?.status)}
          className="h-5 w-5"
        />
        <span className="truncate text-sm text-muted-foreground">
          {session?.title || "Untitled session"}
        </span>
      </header>

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
        <div className="mx-auto w-full max-w-[840px]">
          <Composer
            onSubmit={(text) => send(text)}
            onInterrupt={() => void interrupt()}
            busy={busy}
            testId="chat-composer"
            placeholder="Reply…"
          />
        </div>
      </div>
    </div>
  );
}
