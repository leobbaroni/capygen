/**
 * The round-table dispatcher (ADR-0002, SPEC R11) — the stateful half.
 *
 * `@capygen/engine`'s `roundtable/` decides *who speaks next* from plain
 * objects. This file is what turns those decisions into turn rows, prompts and
 * harness calls, because only the desktop has a database.
 *
 * One user message becomes:
 *
 *   user turn (hop 0, `mentions` recorded)
 *     → one agent turn per target (hop 1), sequential unless
 *       `settings.parallelAgents`
 *       → for each reply, one agent turn per agent *it* @-mentioned (hop 2)
 *         → … until a hop would exceed `settings.hopCap`, at which point the
 *           chain stops: a `system` turn says so, `chat.chainStopped` fires,
 *           and the blocked hop is remembered so `chat.continue` can run
 *           exactly it — one more hop per press, never the whole chain again.
 *
 * Three things are easy to get wrong and are therefore explicit here:
 *
 *  - **Hop indices are absolute.** A user turn is hop 0, so a new user message
 *    resets the count with no bookkeeping at all — "until the user speaks" is
 *    free rather than a flag someone can forget to clear.
 *  - **Rows are created before the round runs, in target order.** A queued
 *    agent is visible in the transcript instead of appearing from nowhere when
 *    its turn starts, and — the reason it matters for `parallelAgents` — the
 *    transcript's order stays deterministic (`created_at, rowid`) rather than
 *    depending on which backend happened to answer first. Completion order is
 *    still what drives chaining, so a fast agent's mention is queued first.
 *  - **`Session.mode` is read here, not only drawn in the UI.** A solo session
 *    routes every message to the lead and plans no agent-to-agent hop at all,
 *    however many agents its roster still carries from before the switch —
 *    which is what the mode-switch confirm promises the user. Solo is still
 *    the same code path (ADR-0002), just with the mode passed to
 *    `resolveTargets`/`nextHopTargets`.
 *  - **A stateful backend is never re-sent the transcript** (SPEC R23). The
 *    text a harness receives is `buildAgentPrompt`: the labelled delta since
 *    that agent's own last turn, then the addressed message. See
 *    `roundtable/context.ts` for why `sinceTurnId` differs for `api`.
 */
import {
  buildAgentPrompt,
  IMPORTED_REFERENCE_SPEAKER_LABEL,
  chainStoppedMessage,
  hopAllowed,
  planCrewDebate,
  nextHopTargets,
  resolveTargets,
  speakerLabel,
  type RoundTableAgent,
  type SpeakerInfo,
  type TranscriptTurn,
} from "@capygen/engine";
import { parseCustomModeDocument, type SessionMode, type Turn, type TurnStatus } from "@capygen/shared";
import { errorBlock, finishTurn, openAgentTurn, recordUserTurn, systemTurn } from "./persist.js";
import { roundTableAgents } from "./routing.js";
import type { EngineDeps } from "./types.js";

/** What a runner must do with one turn: run it, and say how it ended. */
export type TurnRunner = (args: {
  sessionId: string;
  turnId: string;
  agentId: string;
  text: string;
}) => Promise<{ status: TurnStatus }>;

export interface RoundTableDeps extends EngineDeps {
  runTurn: TurnRunner;
  /**
   * For an `api` agent: the last turn its harness already replayed from the
   * database when it started (`history.ts`). The delta must start *after* that
   * or a relaunch would send the same turns twice. `null`/absent for a backend
   * that resumes its own conversation.
   */
  historyWatermark?: (sessionId: string, agentId: string) => string | null;
}

export interface DispatchArgs {
  sessionId: string;
  text: string;
  /** The composer's explicit agent pick; overrides mention parsing. */
  agentId?: string | null;
}

export interface DispatchResult {
  userTurnId: string;
  /** The first agent turn — what `chat.send`'s contract returns. */
  agentTurnId: string;
  /** Every agent turn this message opened, in target order. */
  agentTurnIds: string[];
  /**
   * `@names` in the message that answer to no agent in this session. A typo
   * (`@claud`) silently becomes a message to the lead otherwise, and nothing
   * in the transcript distinguishes it from a message that was addressed
   * correctly — so it is returned rather than only logged.
   */
  unknownMentions: string[];
}

/** One turn queued to run: which agent, and what it is being told. */
interface Entry {
  turn: Turn;
  agent: RoundTableAgent;
  /** The message body, before the labelled delta is prepended. */
  message: string;
  /** Who wrote `message`; null when the user did. */
  messageFrom: string | null;
  /** The turn `message` came from — kept out of the delta so it is not doubled. */
  sourceTurnId: string;
  debate?: { targets: RoundTableAgent[]; topic: string };
}

interface DesktopTranscriptTurn extends TranscriptTurn {
  /** Frozen persisted label; imported references use a reserved inert marker. */
  speakerLabel?: string;
}

/** A hop the cap refused, kept so `chat.continue` can run exactly it. */
interface PendingChain {
  fromTurnId: string;
  fromAgentId: string;
  /**
   * The turn whose @-mention started this whole chain — `Turn.triggeredByTurnId`'s
   * documented contract (`packages/shared/src/domain.ts`): "`chat.continue`
   * resuming a hop-capped chain sets `parentTurnId` to the chain's *last* turn
   * while `triggeredByTurnId` keeps pointing at the mention that actually
   * started it". Captured when the hop is blocked, because `fromTurnId` alone
   * is the *last* turn and using it made every resumed chain claim a new root.
   */
  rootTriggeredByTurnId: string;
  text: string;
  hopIndex: number;
  targets: RoundTableAgent[];
}

export interface DebateRequest {
  sessionId: string;
  turnId: string;
  agentId: string;
  trigger: unknown;
  topic: string;
}
export type DebateResult = { ok: true } | { ok: false; reason: string };

export interface RoundTable {
  requestDebate(args: DebateRequest): DebateResult;
  dispatch(args: DispatchArgs): DispatchResult;
  continueChain(sessionId: string): { ok: boolean; agentTurnId: string | null };
  /**
   * Is there a hop this session's cap refused that `chat.continue` would run?
   *
   * The Continue bar used to exist only as a one-shot `chat.chainStopped`
   * event, which the renderer drops for a session that is not in the
   * foreground and clears on every `openSession` — so a chain stopped while
   * the user was reading another session came back with its transcript line
   * ("press Continue") and no button. This is the durable answer that
   * `sessions.get` reports instead.
   */
  hasPending(sessionId: string): boolean;
  isRunning(sessionId: string): boolean;
  /** Drop any queued hop for this session (interrupt, or the user speaking). */
  cancel(sessionId: string): void;
  /** Wait for every chain this session has in flight — shutdown only. */
  settled(): Promise<void>;
}

export function createRoundTable(deps: RoundTableDeps): RoundTable {
  const { store, log } = deps;
  const pending = new Map<string, PendingChain[]>();
  /** Sessions whose chain was cancelled; the driver checks between rounds. */
  const cancelled = new Set<string>();
  const running = new Set<Promise<void>>();
  const runningSessions = new Map<string, number>();
  const executing = new Map<string, Entry>();
  const debateIntents = new Map<string, { targets: RoundTableAgent[]; topic: string }>();

  function sessionSettings(sessionId: string): {
    hopCap: number;
    parallel: boolean;
    mode: SessionMode;
  } {
    const session = store.sessions.get(sessionId);
    return {
      hopCap: session?.settings.hopCap ?? 3,
      parallel: session?.settings.parallelAgents ?? false,
      // ADR-0002: in solo the lead is the only agent that speaks, so no hop
      // is ever planned — whatever the roster still holds from before the
      // switch, and whoever a reply @-mentions.
      mode: session?.mode ?? "round-table",
    };
  }

  function speakerMap(sessionId: string): Map<string, SpeakerInfo> {
    const map = new Map<string, SpeakerInfo>();
    for (const agent of store.sessions.historicalAgents(sessionId)) {
      map.set(agent.id, { mentionName: agent.mentionName, backend: agent.backend });
    }
    return map;
  }

  /**
   * The settled transcript as text. Streaming turns are skipped: a turn that is
   * still being written has nothing to quote, and the turn being dispatched
   * right now is one of them.
   */
  function transcriptOf(sessionId: string): DesktopTranscriptTurn[] {
    const blocks = store.blocks.listBySession(sessionId);
    const texts = new Map<string, string[]>();
    for (const block of blocks) {
      if (block.kind !== "text") continue;
      if (block.delegatedFrom) continue; // see `textOfTurn`
      const list = texts.get(block.turnId);
      if (list) list.push(block.text);
      else texts.set(block.turnId, [block.text]);
    }
    return store.turns
      .list(sessionId)
      .filter((turn) => turn.status !== "streaming" && turn.status !== "pending")
      .map((turn) => ({
        id: turn.id,
        agentId: turn.agentId,
        role: turn.role,
        ...(turn.speakerLabel !== undefined ? { speakerLabel: turn.speakerLabel } : {}),
        text: (texts.get(turn.id) ?? []).join("\n").trim(),
      }));
  }

  /**
   * The text an agent turn produced, for chaining and for the next delta.
   *
   * A *delegated* sub-agent (SPEC R12) streams its own text blocks into the
   * parent's turn, and those are not the parent's words: folding them in here
   * would deliver a sub-agent's entire raw answer, unbounded, to whichever
   * agent the parent then @-mentions — and re-include it in every later
   * context delta on top of that (SPEC R23's "minimal delta"). `delegatedFrom`
   * is exactly the marker that says which blocks those are.
   */
  function textOfTurn(turnId: string): string {
    return store.blocks
      .listByTurn(turnId)
      .filter((b): b is Extract<typeof b, { kind: "text" }> => b.kind === "text")
      .filter((b) => !b.delegatedFrom)
      .map((b) => b.text)
      .join("\n")
      .trim();
  }

  /**
   * Where this agent's context delta starts. For `claude`/`codex` that is its
   * own last turn — everything before it is already inside the backend session
   * being resumed. For `api` it is the later of that and the point the stored
   * history was replayed from, because `history.ts` already gave it everything
   * up to there, labelled.
   */
  function deltaStart(
    sessionId: string,
    agent: RoundTableAgent,
    transcript: readonly TranscriptTurn[],
  ): string | null {
    let own: string | null = null;
    for (const turn of transcript) {
      if (turn.agentId === agent.id) own = turn.id;
    }
    if (agent.backend !== "api") return own;
    const watermark = deps.historyWatermark?.(sessionId, agent.id) ?? null;
    if (!watermark) return own;
    if (!own) return watermark;
    const at = (id: string): number => transcript.findIndex((t) => t.id === id);
    return at(watermark) > at(own) ? watermark : own;
  }

  function promptFor(entry: Entry): string {
    const transcript = transcriptOf(entry.turn.sessionId);
    const sinceTurnId = deltaStart(entry.turn.sessionId, entry.agent, transcript);
    const excluded = new Set([entry.sourceTurnId, entry.turn.id]);
    let start = 0;
    if (sinceTurnId) {
      const at = transcript.findIndex((turn) => turn.id === sinceTurnId);
      if (at >= 0) start = at + 1;
    }
    const importedReference =
      entry.agent.backend === "api"
        ? null
        : transcript
            .slice(start)
            .findLast(
              (turn) =>
                turn.speakerLabel === IMPORTED_REFERENCE_SPEAKER_LABEL &&
                !excluded.has(turn.id),
            )?.text ?? null;
    // The ordinary delta path clamps every quoted turn to 1,500 characters.
    // Remove the marked row and prepend it unchanged as part of this user
    // message instead, preserving the formatter's separate 6,000-byte bound.
    const ordinary = transcript.filter(
      (turn) => turn.speakerLabel !== IMPORTED_REFERENCE_SPEAKER_LABEL,
    );
    const prompt = buildAgentPrompt({
      backend: entry.agent.backend,
      agentId: entry.agent.id,
      transcript: ordinary,
      speakers: speakerMap(entry.turn.sessionId),
      sinceTurnId,
      exclude: [...excluded],
      message: entry.message,
      messageFrom: entry.messageFrom,
    });
    return importedReference ? `${importedReference}\n\n${prompt}` : prompt;
  }

  function openEntries(
    sessionId: string,
    targets: readonly RoundTableAgent[],
    args: {
      hopIndex: number;
      parentTurnId: string;
      triggeredByTurnId: string;
      message: string;
      messageFrom: string | null;
      sourceTurnId: string;
    },
  ): Entry[] {
    return targets.map((agent) => ({
      agent,
      turn: openAgentTurn(deps, {
        sessionId,
        agentId: agent.id,
        parentTurnId: args.parentTurnId,
        hopIndex: args.hopIndex,
        triggeredByTurnId: args.triggeredByTurnId,
        speakerLabel: speakerLabel(agent),
      }),
      message: args.message,
      messageFrom: args.messageFrom,
      sourceTurnId: args.sourceTurnId,
    }));
  }

  /** Close a queued turn nobody will run (interrupt between rounds). */
  function abandon(entry: Entry, reason: string): void {
    if (store.turns.get(entry.turn.id)?.status !== "streaming") return;
    finishTurn(deps, entry.turn.sessionId, entry.turn.id, "interrupted", reason);
  }

  async function runOne(entry: Entry): Promise<{ entry: Entry; status: TurnStatus }> {
    const text = promptFor(entry);
    executing.set(entry.turn.id, entry);
    try {
      const result = await deps.runTurn({
        sessionId: entry.turn.sessionId, turnId: entry.turn.id,
        agentId: entry.agent.id, text,
      });
      return { entry, status: result.status };
    } finally {
      executing.delete(entry.turn.id);
    }
  }

  /**
   * Run a round, then plan the next one from what was said.
   *
   * The cap is applied to every hop this loop *plans*, `chat.continue`
   * included: Continue's one permitted hop is the round `continueChain` has
   * already opened before calling this, so a second hop needs a second press.
   */
  async function drive(sessionId: string, first: Entry[]): Promise<void> {
    let round = first;

    while (round.length > 0) {
      if (cancelled.has(sessionId)) {
        for (const entry of round) abandon(entry, "the session was interrupted");
        return;
      }

      const { hopCap, parallel, mode } = sessionSettings(sessionId);
      const settled: { entry: Entry; status: TurnStatus }[] = [];
      if (parallel && mode !== "custom") {
        // One lane per agent, lanes run concurrently. Two hops addressed to
        // the *same* agent in one round (two speakers both mentioning it) must
        // not run at once: a harness takes one turn at a time and the runner
        // refuses the second outright. Within a lane the order is the order
        // the rows were opened in; across lanes it is completion order, which
        // is what `settled` records — `Promise.all` would let the slowest
        // agent decide when the fastest one's mention gets followed.
        const lanes = new Map<string, Entry[]>();
        for (const entry of round) {
          const lane = lanes.get(entry.agent.id);
          if (lane) lane.push(entry);
          else lanes.set(entry.agent.id, [entry]);
        }
        await Promise.allSettled(
          [...lanes.values()].map(async (lane) => {
            for (const entry of lane) {
              if (cancelled.has(sessionId)) {
                abandon(entry, "the session was interrupted");
                continue;
              }
              settled.push(await runOne(entry));
            }
          }),
        );
      } else {
        for (const entry of round) {
          if (cancelled.has(sessionId)) {
            abandon(entry, "the session was interrupted");
            continue;
          }
          settled.push(await runOne(entry));
        }
      }

      if (cancelled.has(sessionId)) return;

      const next: Entry[] = [];
      // Every hop this round refused. A round can block more than once — two
      // agents answering in parallel can both mention someone at the cap — and
      // remembering only the last would make Continue resume one chain and
      // silently drop the other, while writing the transcript a "chain
      // stopped" line per blocked agent.
      const blocked: PendingChain[] = [];
      const agents = roundTableAgents(store, sessionId);
      for (const { entry, status } of settled) {
        const intent = debateIntents.get(entry.turn.id);
        debateIntents.delete(entry.turn.id);
        if (status !== "done") {
          // A failed hop stops its own chain and says so; a failed *first*
          // answer is just a failed turn, and the error block already says it.
          if (entry.turn.hopIndex > 1) {
            deps.broadcast("chat.chainStopped", {
              sessionId,
              turnId: entry.turn.id,
              reason: "error",
            });
          }
          continue;
        }
        if (mode === "custom") {
          const debate = intent ?? entry.debate;
          if (debate && debate.targets.length > 0 && hopAllowed(entry.turn.hopIndex + debate.targets.length, hopCap)) {
            const [target, ...remaining] = debate.targets;
            // Open one row at a time: every debater and the explicit lead return
            // receives a successive hop and the preceding turn as its parent.
            const [queued] = openEntries(sessionId, [target!], {
              hopIndex: entry.turn.hopIndex + 1, parentTurnId: entry.turn.id,
              triggeredByTurnId: entry.turn.triggeredByTurnId ?? entry.turn.id,
              message: remaining.length === 0
                ? `Decide the outcome of this debate: ${debate.topic}`
                : `Contribute your assessment to this debate: ${debate.topic}`,
              messageFrom: entry.agent.id, sourceTurnId: "",
            });
            queued!.debate = { targets: remaining, topic: debate.topic };
            next.push(queued!);
          }
          continue;
        }
        const reply = textOfTurn(entry.turn.id);
        if (!reply) continue;
        const targets = nextHopTargets({
          text: reply,
          speakerAgentId: entry.agent.id,
          agents,
          mode,
        });
        if (targets.length === 0) continue;

        const hopIndex = entry.turn.hopIndex + 1;
        if (!hopAllowed(hopIndex, hopCap)) {
          blocked.push({
            fromTurnId: entry.turn.id,
            fromAgentId: entry.agent.id,
            // Exactly what the un-blocked hop below would have inherited.
            rootTriggeredByTurnId: entry.turn.triggeredByTurnId ?? entry.turn.id,
            text: reply,
            hopIndex,
            targets,
          });
          deps.broadcast("chat.chainStopped", {
            sessionId,
            turnId: entry.turn.id,
            reason: "hop_cap",
          });
          log.info(
            `[roundtable] ${sessionId}: chain stopped at hop ${hopIndex} (cap ${hopCap})`,
          );
          continue;
        }

        next.push(
          ...openEntries(sessionId, targets, {
            hopIndex,
            parentTurnId: entry.turn.id,
            triggeredByTurnId: entry.turn.triggeredByTurnId ?? entry.turn.id,
            message: reply,
            messageFrom: entry.agent.id,
            sourceTurnId: entry.turn.id,
          }),
        );
      }

      // One notice per round, however many chains it stopped: the transcript is
      // saying "the agents have stopped talking to each other", which is one
      // fact, and the per-turn detail is already in the `chainStopped` events.
      if (blocked.length > 0) {
        pending.set(sessionId, blocked);
        systemTurn(deps, sessionId, chainStoppedMessage(hopCap));
      }
      round = next;
    }
  }

  function start(sessionId: string, entries: Entry[]): void {
    runningSessions.set(sessionId, (runningSessions.get(sessionId) ?? 0) + 1);
    const task = drive(sessionId, entries)
      .catch((err: unknown) => {
        log.error(`[roundtable] chain for ${sessionId} failed`, err);
      })
      .finally(() => {
        running.delete(task);
        for (const turnId of debateIntents.keys()) {
          if (store.turns.get(turnId)?.sessionId === sessionId) debateIntents.delete(turnId);
        }
        const remaining = (runningSessions.get(sessionId) ?? 1) - 1;
        if (remaining > 0) runningSessions.set(sessionId, remaining);
        else runningSessions.delete(sessionId);
      });
    running.add(task);
  }

  return {
    requestDebate(args: DebateRequest): DebateResult {
      const session = store.sessions.get(args.sessionId);
      const entry = executing.get(args.turnId);
      if (!session || session.mode !== "custom" || !entry
        || entry.turn.sessionId !== args.sessionId || entry.agent.id !== args.agentId
        || session.leadAgentId !== args.agentId || cancelled.has(args.sessionId)) {
        return { ok: false, reason: "Only the currently executing custom lead turn may request a debate." };
      }
      if (debateIntents.has(args.turnId)) return { ok: false, reason: "This turn already requested a debate." };
      if (typeof args.topic !== "string" || !args.topic.trim() || args.topic.length > 4000) {
        return { ok: false, reason: "A debate topic must contain 1–4000 characters." };
      }
      const parsed = parseCustomModeDocument(session.settings.crew);
      if (!parsed.ok) return { ok: false, reason: "The custom crew policy is invalid." };
      const plan = planCrewDebate(parsed.document, args.trigger, entry.turn.hopIndex, session.settings.hopCap);
      if (!plan.ok) return plan;
      const agents = roundTableAgents(store, args.sessionId);
      const targets = plan.rosterIds.map((id) => agents.find((agent) => agent.id === session.settings.crewBindings?.[id]));
      if (targets.some((agent) => !agent) || new Set(targets.map((agent) => agent!.id)).size !== targets.length
        || targets.at(-1)?.id !== session.leadAgentId) {
        return { ok: false, reason: "The debate roster bindings are unavailable or invalid. Apply the crew again." };
      }
      debateIntents.set(args.turnId, { targets: targets as RoundTableAgent[], topic: args.topic.trim() });
      return { ok: true };
    },
    dispatch(args: DispatchArgs): DispatchResult {
      const session = store.sessions.get(args.sessionId);
      if (!session) throw new Error(`unknown session: ${args.sessionId}`);

      // A new user message ends whatever the agents were doing among
      // themselves: R11's "until the user speaks".
      pending.delete(args.sessionId);
      cancelled.delete(args.sessionId);

      const agents = roundTableAgents(store, args.sessionId);
      const targets = resolveTargets({
        text: args.text,
        agents,
        leadAgentId: session.leadAgentId,
        ...(args.agentId && session.mode !== "custom" ? { explicitAgentId: args.agentId } : {}),
        mode: session.mode === "custom" ? "solo" : session.mode,
      });
      if (targets.unknown.length > 0) {
        log.info(
          `[roundtable] ${args.sessionId}: no agent answers to ` +
            targets.unknown.map((n) => `@${n}`).join(", "),
        );
      }

      const userTurn = recordUserTurn(
        deps,
        args.sessionId,
        args.text,
        targets.source === "mentions" ? targets.agents.map((a) => a.id) : [],
      );

      // No agents at all: the turn still has to exist and has to close, or the
      // composer stays locked forever waiting for a reply nobody can give.
      if (targets.agents.length === 0) {
        const turn = openAgentTurn(deps, {
          sessionId: args.sessionId,
          agentId: null,
          parentTurnId: userTurn.id,
          hopIndex: userTurn.hopIndex + 1,
          triggeredByTurnId: userTurn.id,
        });
        errorBlock(deps, args.sessionId, turn.id, "This session has no agent to answer with.");
        finishTurn(deps, args.sessionId, turn.id, "error", "no agent");
        return {
          userTurnId: userTurn.id,
          agentTurnId: turn.id,
          agentTurnIds: [turn.id],
          unknownMentions: targets.unknown,
        };
      }

      const entries = openEntries(args.sessionId, targets.agents, {
        hopIndex: userTurn.hopIndex + 1,
        parentTurnId: userTurn.id,
        triggeredByTurnId: userTurn.id,
        message: args.text,
        messageFrom: null,
        sourceTurnId: userTurn.id,
      });
      log.info(
        `[roundtable] ${args.sessionId}: ${targets.source} → ` +
          entries.map((e) => `@${e.agent.mentionName}`).join(", "),
      );
      start(args.sessionId, entries);

      return {
        userTurnId: userTurn.id,
        agentTurnId: entries[0]!.turn.id,
        agentTurnIds: entries.map((e) => e.turn.id),
        unknownMentions: targets.unknown,
      };
    },

    /**
     * Resume the hop the cap refused — **one** hop, then the cap applies again.
     *
     * With no remembered chain (a relaunch, or a session that simply stopped)
     * this falls back to nudging whoever spoke last with "Continue.", which is
     * what the button meant before the dispatcher existed and is still the only
     * sensible reading of Continue in a solo session.
     */
    continueChain(sessionId: string): { ok: boolean; agentTurnId: string | null } {
      const session = store.sessions.get(sessionId);
      if (!session) throw new Error(`unknown session: ${sessionId}`);
      if (store.turns.hasStreaming(sessionId)) return { ok: false, agentTurnId: null };
      cancelled.delete(sessionId);

      // Every chain the round blocked resumes together — one press, one more
      // hop each, in the order they were blocked in.
      const chains = pending.get(sessionId);
      if (chains && chains.length > 0) {
        pending.delete(sessionId);
        const entries = chains.flatMap((chain) =>
          openEntries(sessionId, chain.targets, {
            hopIndex: chain.hopIndex,
            // `parentTurnId` is the chain's last turn, `triggeredByTurnId` the
            // mention that started it — the split `Turn` documents.
            parentTurnId: chain.fromTurnId,
            triggeredByTurnId: chain.rootTriggeredByTurnId,
            message: chain.text,
            messageFrom: chain.fromAgentId,
            sourceTurnId: chain.fromTurnId,
          }),
        );
        start(sessionId, entries);
        return { ok: true, agentTurnId: entries[0]!.turn.id };
      }

      const turns = store.turns.list(sessionId);
      const last = [...turns].reverse().find((t) => t.role === "agent" && t.agentId) ?? null;
      const agentId = session.mode === "custom" ? session.leadAgentId : last?.agentId ?? session.leadAgentId;
      if (!last || !agentId) return { ok: false, agentTurnId: null };
      if (session.mode === "custom" && !hopAllowed(last.hopIndex + 1, session.settings.hopCap)) {
        return { ok: false, agentTurnId: null };
      }
      const agents = roundTableAgents(store, sessionId);
      const agent = agents.find((a) => a.id === agentId);
      if (!agent) return { ok: false, agentTurnId: null };

      const entries = openEntries(sessionId, [agent], {
        hopIndex: last.hopIndex + 1,
        parentTurnId: last.id,
        triggeredByTurnId: last.triggeredByTurnId ?? last.id,
        message: "Continue.",
        messageFrom: null,
        sourceTurnId: last.id,
      });
      start(sessionId, entries);
      return { ok: true, agentTurnId: entries[0]!.turn.id };
    },

    hasPending(sessionId: string): boolean {
      return (pending.get(sessionId)?.length ?? 0) > 0;
    },
    isRunning: (sessionId) => runningSessions.has(sessionId),

    cancel(sessionId: string): void {
      pending.delete(sessionId);
      for (const [turnId, entry] of executing) {
        if (entry.turn.sessionId === sessionId) debateIntents.delete(turnId);
      }
      cancelled.add(sessionId);
    },

    async settled(): Promise<void> {
      await Promise.allSettled([...running]);
    },
  };
}
