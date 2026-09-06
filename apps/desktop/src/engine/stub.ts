/**
 * The echo double.
 *
 * It answers `echo: <text>` after 300 ms, exercising the whole path a real
 * harness uses — block row, `chat.block`, turn status, session status — without
 * a model, a process or a network call. The handler tests run against it; the
 * app runs `createSessionRunner` instead (see `ipc/handlers.ts`).
 *
 * [C] `peerMentions` turns it into a *round-table* double: `dispatch` and
 * `continueChain` are handed to the real `createRoundTable`, and every echoed
 * reply ends with an `@mention` of another agent in the session. That is what
 * `CAPYGEN_ENGINE=stub-roundtable` selects, and what `tests/e2e/roundtable.spec.ts`
 * uses to prove the hop cap (SPEC R11) offline: a ping-pong that would run
 * forever, stopped at the cap, with the Continue bar granting exactly one more
 * hop. The dispatcher under test is the shipping one — only the *models* are
 * fake, which is the whole point of testing a loop bound with a loop.
 *
 * Off by default: the handler tests want the single-target echo, and a stub
 * that started chaining would change every one of their turn counts.
 */
import { describeAgent as describeAgentInfo } from "../ipc/agentsDescribe.js";
import { createRoundTable, type RoundTable } from "./RoundTable.js";
import { emitBlock, finishTurn, openAgentTurn, recordUserTurn, textBlock } from "./persist.js";
import type { Engine, EngineDeps } from "./types.js";
import { newId, type Block } from "@capygen/shared";

export const ECHO_DELAY_MS = 300;

/**
 * [C] `todo: a, b, c` makes the echo double write a real Claude-shaped
 * `TodoWrite` tool call before its text reply.
 *
 * The Tasks pane is fed *only* by the broadcast tap in `ipc/handlers.ts`
 * (`TasksService.observeBlock`) — capygen never asks a model for its plan
 * (R26). Proving that end to end therefore needs a block of that exact
 * shape in the transcript, and the offline engine is the only place one can
 * come from without spending a token. The first item is `in_progress` and
 * the rest `pending`, which is what a real agent's first `TodoWrite` looks
 * like.
 */
const TODO_PREFIX = /^todo:\s*/i;

function todoBlock(sessionId: string, turnId: string, index: number, text: string): Block | null {
  if (!TODO_PREFIX.test(text)) return null;
  const items = text
    .replace(TODO_PREFIX, "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (items.length === 0) return null;
  const ts = Date.now();
  return {
    id: newId("block"),
    turnId,
    sessionId,
    kind: "tool_call",
    index,
    name: "TodoWrite",
    input: {
      todos: items.map((content, i) => ({
        content,
        activeForm: content,
        status: i === 0 ? "in_progress" : "pending",
      })),
    },
    status: "success",
    createdAt: ts,
    updatedAt: ts,
  };
}

export interface StubEngineOptions {
  /** Answer every turn with an `@mention` of another agent, and dispatch
   *  through the real round table so the mention actually chains. */
  peerMentions?: boolean;
}

export function createStubEngine(
  deps: EngineDeps,
  delayMs = ECHO_DELAY_MS,
  options: StubEngineOptions = {},
): Engine {
  const inFlight = new Map<string, { timer: ReturnType<typeof setTimeout>; turnId: string }>();

  /**
   * Whom this agent hands the floor to: the next agent in roster order,
   * wrapping round. With one agent there is nobody, so a solo session under
   * this option still answers exactly once and stops — a chain needs two.
   */
  function peerOf(sessionId: string, agentId: string | null | undefined): string | null {
    if (!options.peerMentions || !agentId) return null;
    const agents = deps.store.sessions.agents(sessionId);
    if (agents.length < 2) return null;
    const index = agents.findIndex((a) => a.id === agentId);
    if (index < 0) return null;
    return agents[(index + 1) % agents.length]!.mentionName;
  }

  const engine: Engine = {
    send({ sessionId, turnId, agentId, text }) {
      // One turn at a time per session: a second send supersedes the first.
      const existing = inFlight.get(sessionId);
      if (existing) clearTimeout(existing.timer);

      const timer = setTimeout(() => {
        inFlight.delete(sessionId);
        try {
          const peer = peerOf(sessionId, agentId ?? deps.store.turns.get(turnId)?.agentId);
          const todos = todoBlock(sessionId, turnId, deps.store.blocks.nextIndex(turnId), text);
          if (todos) emitBlock(deps, todos);
          emitBlock(
            deps,
            textBlock(
              sessionId,
              turnId,
              deps.store.blocks.nextIndex(turnId),
              peer ? `echo: ${text} — over to @${peer}` : `echo: ${text}`,
            ),
          );
          finishTurn(deps, sessionId, turnId, "done");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          finishTurn(deps, sessionId, turnId, "error", message);
        }
      }, delayMs);
      timer.unref?.();
      inFlight.set(sessionId, { timer, turnId });
    },

    /**
     * [B1] The echo double's round table: the lead (or the named agent), one
     * hop, no mention chaining. It reproduces exactly what the real dispatcher
     * writes for the single-target case — user turn, one agent turn opened
     * `streaming` — so the handler tests still exercise the real row and
     * broadcast sequence without a backend.
     */
    dispatch({ sessionId, text, agentId }) {
      if (roundTable) return roundTable.dispatch({ sessionId, text, agentId });
      const session = deps.store.sessions.get(sessionId);
      if (!session) throw new Error(`unknown session: ${sessionId}`);
      const userTurn = recordUserTurn(deps, sessionId, text);
      const target = agentId ?? session.leadAgentId;
      const agentTurn = openAgentTurn(deps, {
        sessionId,
        agentId: target,
        parentTurnId: userTurn.id,
        hopIndex: userTurn.hopIndex + 1,
        triggeredByTurnId: userTurn.id,
      });
      engine.send({ sessionId, turnId: agentTurn.id, agentId: target, text });
      return {
        userTurnId: userTurn.id,
        agentTurnId: agentTurn.id,
        agentTurnIds: [agentTurn.id],
        // The echo double resolves no mentions at all, so none can be unknown.
        unknownMentions: [],
      };
    },

    hasPendingChain(sessionId) {
      return roundTable?.hasPending(sessionId) ?? false;
    },

    continueChain(sessionId) {
      if (roundTable) return roundTable.continueChain(sessionId);
      const session = deps.store.sessions.get(sessionId);
      if (!session) throw new Error(`unknown session: ${sessionId}`);
      if (deps.store.turns.hasStreaming(sessionId)) return { ok: false, agentTurnId: null };
      const turns = deps.store.turns.list(sessionId);
      const last = turns[turns.length - 1];
      const agentId = last?.agentId ?? session.leadAgentId;
      if (!last || !agentId) return { ok: false, agentTurnId: null };
      const agentTurn = openAgentTurn(deps, {
        sessionId,
        agentId,
        parentTurnId: last.id,
        hopIndex: last.hopIndex + 1,
        triggeredByTurnId: last.triggeredByTurnId ?? last.id,
      });
      engine.send({ sessionId, turnId: agentTurn.id, agentId, text: "Continue." });
      return { ok: true, agentTurnId: agentTurn.id };
    },

    interrupt(sessionId) {
      roundTable?.cancel(sessionId);
      const existing = inFlight.get(sessionId);
      if (!existing) return false;
      clearTimeout(existing.timer);
      inFlight.delete(sessionId);
      return true;
    },

    /**
     * [C] The echo double's `agents.describe` (SPEC R13): config only. There
     * is no harness to ask, which is exactly the "agent that has not run a
     * turn yet" case `agentsDescribe.ts` documents — the same honest empty
     * capabilities/tools the placeholder handler used to return, now through
     * the one composition path.
     */
    describeAgent(agentId) {
      return Promise.resolve(
        describeAgentInfo(
          {
            getAgent: (id) => deps.store.sessions.agent(id) ?? undefined,
            listOtherAgents: (sessionId, selfId) =>
              deps.store.sessions
                .agents(sessionId)
                .filter((a) => a.id !== selfId)
                .map((a) => ({
                  agentId: a.id,
                  mentionName: a.mentionName,
                  backend: a.backend,
                  model: a.model,
                })),
            usageFor: (id) => deps.store.usage.totalsByAgent(id),
          },
          agentId,
        ),
      );
    },

    answerPermission: () => false,
    answerQuestion: () => false,
    answerElicitation: () => false,
    listCommands: () => [],

    async dispose() {
      for (const { timer } of inFlight.values()) clearTimeout(timer);
      inFlight.clear();
      // A chain still in flight would otherwise leave its rows `streaming`
      // after the database closes — the same reason `SessionRunner.dispose`
      // waits for `roundTable.settled()`.
      await roundTable?.settled();
    },
  };

  /**
   * The real dispatcher, driven by the echo. `runTurn` resolves when the turn
   * row settles, which is what the round table chains on — the same contract
   * `SessionRunner.runTurn` fulfils with a live harness.
   */
  const roundTable: RoundTable | null = options.peerMentions
    ? createRoundTable({
        ...deps,
        runTurn: ({ sessionId, turnId, agentId, text }) =>
          new Promise((resolve) => {
            engine.send({ sessionId, turnId, agentId, text });
            const settle = setInterval(() => {
              const status = deps.store.turns.get(turnId)?.status;
              if (status && status !== "streaming" && status !== "pending") {
                clearInterval(settle);
                resolve({ status });
              }
            }, Math.max(5, Math.floor(delayMs / 4)));
            settle.unref?.();
          }),
      })
    : null;

  return engine;
}
