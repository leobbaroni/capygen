/**
 * Chat page (P2): a scrolling transcript with the composer pinned at the
 * bottom, both inside Omnigent's centred content column, plus the turn rail
 * (`TurnRail`) and a queued-messages strip for text typed while a turn is
 * still streaming.
 *
 * Phase 4 round-table additions (SPEC R10-R13, ADR-0002, item B2.2-B2.4):
 *   - `ModePicker` in the header (`sessions.setMode`) — switching an
 *     existing round-table session with more than one agent back to solo
 *     shows a confirm first (history is kept either way per ADR-0002; this
 *     is only about surprising the user by silently sidelining agents).
 *   - The composer gets the session's `agents` for its `@mention` menu, and
 *     `Transcript` gets them for speaker labels.
 *   - `ChainStoppedBar` above the composer, wired to `chat.continue`, when
 *     the dispatcher has stopped an agent-to-agent chain at the hop cap.
 *   - A gear button opens `SessionSettingsSheet` (hop cap, parallel agents,
 *     sub-agent routing default), and a users button toggles `AgentsPane`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { ArrowDownIcon, SettingsIcon, UsersIcon, XIcon } from "lucide-react";
import type { SessionMode } from "@capygen/shared";
import { Mascot } from "@/brand/Mascot";
import { AgentsPane } from "@/components/AgentsPane";
import { ChainStoppedBar } from "@/components/ChainStoppedBar";
import { Composer } from "@/components/Composer";
import { ModePicker } from "@/components/ModePicker";
import { SessionSettingsSheet } from "@/components/SessionSettingsSheet";
import { SessionUsageMeter } from "@/components/SessionUsageMeter";
import { Transcript } from "@/components/Transcript";
import { TurnRail } from "@/components/TurnRail";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useMascotState } from "@/hooks/useMascotState";
import { blocksOfTurn, isBusy, useAppStore } from "@/store/appStore";
import { cn } from "@/lib/utils";

export function ChatPage() {
  const { sessionId = "" } = useParams();
  const openSession = useAppStore((s) => s.openSession);
  const send = useAppStore((s) => s.send);
  const interrupt = useAppStore((s) => s.interrupt);
  const continueChat = useAppStore((s) => s.continueChat);
  const setMode = useAppStore((s) => s.setMode);
  const updateSessionSettings = useAppStore((s) => s.updateSessionSettings);
  const turns = useAppStore((s) => s.turns);
  const busy = useAppStore(isBusy);
  const session = useAppStore((s) => s.sessions.find((x) => x.id === sessionId));
  const commands = useAppStore((s) => s.commands);
  const harnesses = useAppStore((s) => s.harnesses);
  const agents = useAppStore((s) => s.agents);
  const chainStopped = useAppStore((s) => s.chainStopped);
  const unknownMentions = useAppStore((s) => s.unknownMentions);
  // The harness/model picker in the composer only ever shows/edits the lead
  // agent — round-table's own per-message @-mention routing is separate
  // (the composer's `@mention` menu below), not a second backend picker.
  const leadAgent = agents.find((a) => a.id === session?.leadAgentId);
  const queuedMessages = useAppStore((s) => s.queuedMessages);
  const error = useAppStore((s) => s.error);
  // Subscribing to the map (not a derived array) keeps the component re-rendering
  // as blocks stream in; ordering is done by the selector below.
  const blocks = useAppStore((s) => s.blocks);
  const bottom = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  /** False once the user scrolls up: streaming must not yank them back down. */
  const [pinned, setPinned] = useState(true);
  const [agentsPaneOpen, setAgentsPaneOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** The mode a round-table→solo switch is asking the user to confirm, or
   *  `null` when no confirm is pending (every other switch applies at once). */
  const [modeConfirmTarget, setModeConfirmTarget] = useState<SessionMode | null>(null);
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

  /** ADR-0002: switching a round-table session with more than one agent
   *  back to solo keeps history either way — the confirm is only so the
   *  switch itself is never a surprise, not a data-loss warning. */
  function requestModeChange(next: SessionMode): void {
    if (next === "solo" && session?.mode === "round-table" && agents.length > 1) {
      setModeConfirmTarget(next);
      return;
    }
    void setMode(sessionId, next);
  }

  function confirmModeChange(): void {
    const next = modeConfirmTarget;
    setModeConfirmTarget(null);
    if (next) void setMode(sessionId, next);
  }

  const stoppedTurn = chainStopped ? turns.find((t) => t.id === chainStopped.turnId) : undefined;
  /** Which backends can actually run `/model` (SPEC R14). */
  const canSwitchModel = leadAgent ? leadAgent.backend !== "api" : false;

  return (
    // `min-w-0` on both: a flex item's default minimum width is its content,
    // so with the Agents pane open the chat column refused to shrink and the
    // whole shell scrolled sideways — clipping the pane's own footer button
    // and the sessions sidebar on a 1280px window.
    <div className="flex min-h-0 min-w-0 flex-1" data-testid="chat-page-row">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="chat-page">
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
          <ModePicker mode={session?.mode ?? "solo"} onChange={requestModeChange} testId="chat-mode-picker" />
          <div className="relative">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setSettingsOpen((v) => !v)}
              aria-label="Round-table settings"
              aria-expanded={settingsOpen}
              data-testid="session-settings-button"
            >
              <SettingsIcon className="size-4" />
            </Button>
            {session ? (
              <SessionSettingsSheet
                open={settingsOpen}
                onOpenChange={setSettingsOpen}
                settings={session.settings}
                onChange={(patch) => void updateSessionSettings(sessionId, patch)}
              />
            ) : null}
          </div>
          <Button
            variant={agentsPaneOpen ? "secondary" : "ghost"}
            size="icon-sm"
            onClick={() => setAgentsPaneOpen((v) => !v)}
            aria-label="Agents"
            aria-pressed={agentsPaneOpen}
            data-testid="agents-pane-toggle"
          >
            <UsersIcon className="size-4" />
          </Button>
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
              agents={agents}
              unknownMentions={unknownMentions}
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
          {chainStopped ? (
            <div className="mx-auto mb-2 w-full max-w-[840px]">
              <ChainStoppedBar
                hopCount={stoppedTurn?.hopIndex ?? session?.settings.hopCap ?? 3}
                reason={chainStopped.reason}
                busy={busy}
                onContinue={() => void continueChat()}
              />
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
              placeholder={session?.mode === "round-table" ? "Reply, or @mention an agent…" : "Reply…"}
              commands={commands}
              harnesses={harnesses}
              agent={leadAgent ? { backend: leadAgent.backend, model: leadAgent.model } : null}
              // This agent exists, so its backend is fixed for its lifetime.
              lockBackend
              // An agent's backend is fixed once it exists (CONTEXT.md); the
              // picker only ever offers that same backend's other models here
              // (Composer filters to `agent.backend`), so "picking" one is
              // exactly what the `/model` built-in is for (R14) — there is no
              // separate "switch model" IPC to call. The agent row is updated
              // from the backend's own `session` event once the switch lands
              // (`SessionRunner`), so the label here follows the real model.
              //
              onPickAgent={({ model }) => void send(`/model ${model}`)}
              // Disabled for a backend with no command layer at all
              // (`ApiHarness.capabilities().slashCommands === false`,
              // `BACKEND_BUILTIN_SLASH_COMMANDS.api === []`): picking a model
              // there used to send the literal text "/model <id>" to the
              // provider, which answered it as prose while the agent kept its
              // old model.
              canPickModel={canSwitchModel}
              agents={session?.mode === "round-table" ? agents : []}
            />
          </div>
        </div>
      </div>

      {agentsPaneOpen && sessionId ? (
        <AgentsPane sessionId={sessionId} onClose={() => setAgentsPaneOpen(false)} />
      ) : null}

      <Dialog
        open={modeConfirmTarget !== null}
        onOpenChange={(o) => {
          if (!o) setModeConfirmTarget(null);
        }}
      >
        <DialogContent data-testid="mode-switch-confirm" className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Switch to solo orchestrator?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            History is kept (ADR-0002). The lead keeps answering; the other{" "}
            {Math.max(agents.length - 1, 0)} agent{agents.length - 1 === 1 ? "" : "s"} stay in the
            roster but stop receiving messages until you switch back to round-table.
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setModeConfirmTarget(null)}>
              Cancel
            </Button>
            <Button onClick={confirmModeChange} data-testid="mode-switch-confirm-submit">
              Switch
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
