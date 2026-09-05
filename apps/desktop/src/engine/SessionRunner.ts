/**
 * The session runner — one harness per (session, agent), and the only place that
 * turns `EngineEvent`s into rows and renderer events.
 *
 * Responsibilities:
 *   - own the harness lifecycle (create lazily, reuse across turns, dispose on
 *     shutdown). Reuse is not an optimisation: the Claude harness keeps one
 *     streaming session alive so the prompt cache stays warm (SPEC R24);
 *   - persist every block *as it arrives* rather than at the end of the turn
 *     (SPEC R23), always upserting the same row for the same harness block key;
 *   - resolve permission / AskUserQuestion answers coming back over IPC;
 *   - record one `usage_events` row per model call (SPEC R23);
 *   - restore lazily after a relaunch: the backend session id is stored per
 *     agent, so the first send in a restored session resumes it instead of
 *     starting a fresh conversation.
 */
import {
  ClaudeHarness,
  type BlockPatch,
  type EngineEvent,
  type Harness,
  type HarnessAgent,
  type HarnessSession,
} from "@capygen/engine";
import {
  newId,
  type Agent,
  type Block,
  type Session,
  type SlashCommand,
} from "@capygen/shared";
import { emitBlock, errorBlock, finishTurn } from "./persist.js";
import type { Engine, EngineDeps, EnginePermissionAnswer, EngineSendArgs } from "./types.js";

/** Key under which an agent's backend session id is remembered for `resume`. */
export function backendSessionKey(agentId: string): string {
  return `engine.backendSession.${agentId}`;
}

export interface SessionRunnerDeps extends EngineDeps {
  /** Overridden in tests; the default builds a real Claude harness. */
  makeHarness?: (agent: HarnessAgent) => Harness;
}

/** Where a harness block key landed the first time it was written. */
interface BlockSlot {
  id: string;
  index: number;
  createdAt: number;
}

interface ActiveTurn {
  sessionId: string;
  turnId: string;
  harness: Harness;
  blocks: Map<string, BlockSlot>;
}

export function createSessionRunner(deps: SessionRunnerDeps): Engine {
  const { store, broadcast, log } = deps;
  const makeHarness =
    deps.makeHarness ?? ((): Harness => new ClaudeHarness({ log }));

  /** `sessionId:agentId` → harness. */
  const harnesses = new Map<string, Harness>();
  /** One in-flight turn per session (round-table queuing lands in Phase 4). */
  const active = new Map<string, ActiveTurn>();
  /** requestId → the harness waiting for that answer. */
  const awaiting = new Map<string, Harness>();

  function harnessFor(session: Session, agent: Agent): Harness {
    const key = `${session.id}:${agent.id}`;
    const existing = harnesses.get(key);
    if (existing) return existing;

    const project = store.projects.get(session.projectId);
    if (!project) throw new Error(`session ${session.id} has no project row`);

    const resumeSessionId = store.settings.getRaw<string | null>(
      backendSessionKey(agent.id),
      null,
    );
    const harnessSession: HarnessSession = {
      sessionId: session.id,
      projectPath: project.path,
    };
    const harnessAgent: HarnessAgent = {
      agentId: agent.id,
      name: agent.name,
      backend: agent.backend,
      model: agent.model,
      permissionMode: store.settings.all().permissionMode,
      resumeSessionId,
      config: agent.config,
    };
    const harness = makeHarness(harnessAgent);
    harnesses.set(key, harness);
    void harness.start(harnessSession, harnessAgent).catch((err: unknown) => {
      log.error(`[engine] harness.start failed for ${key}`, err);
    });
    log.info(
      `[engine] harness ${agent.backend}/${agent.model} for ${key}` +
        `${resumeSessionId ? ` resuming ${resumeSessionId}` : ""}`,
    );
    return harness;
  }

  /**
   * Materialise one harness block key into a row and upsert it. The slot (id,
   * position, birth time) is remembered per key, so the twentieth text delta
   * rewrites the same row at the same position instead of appending a new one.
   */
  function writeBlock(turn: ActiveTurn, key: string, patch: BlockPatch): Block {
    let slot = turn.blocks.get(key);
    if (!slot) {
      slot = {
        id: newId("block"),
        index: store.blocks.nextIndex(turn.turnId),
        createdAt: Date.now(),
      };
      turn.blocks.set(key, slot);
    }
    const block = {
      ...patch,
      id: slot.id,
      turnId: turn.turnId,
      sessionId: turn.sessionId,
      index: slot.index,
      createdAt: slot.createdAt,
      updatedAt: Date.now(),
      // The spread of a union of patches cannot be narrowed back to the union
      // by the compiler; `blocks.upsert` re-parses with zod, so a mismatch is a
      // loud error at the boundary rather than a bad row.
    } as Block;
    return emitBlock(deps, block);
  }

  async function consume(turn: ActiveTurn, events: AsyncIterable<EngineEvent>): Promise<void> {
    for await (const event of events) {
      switch (event.type) {
        case "block": {
          writeBlock(turn, event.key, event.patch);
          break;
        }
        case "permission": {
          awaiting.set(event.requestId, turn.harness);
          const slot = turn.blocks.get(event.key);
          if (slot) {
            broadcast("permission.request", {
              sessionId: turn.sessionId,
              turnId: turn.turnId,
              blockId: slot.id,
              request: event.request,
            });
          }
          break;
        }
        case "question": {
          awaiting.set(event.requestId, turn.harness);
          const slot = turn.blocks.get(event.key);
          if (slot) {
            broadcast("question.request", {
              sessionId: turn.sessionId,
              turnId: turn.turnId,
              blockId: slot.id,
              requestId: event.requestId,
              questions: event.questions,
            });
          }
          break;
        }
        case "usage": {
          const agentId = store.turns.get(turn.turnId)?.agentId ?? null;
          store.usage.record({
            sessionId: turn.sessionId,
            agentId,
            turnId: turn.turnId,
            backend: event.backend,
            model: event.model,
            inputTokens: event.usage.inputTokens,
            outputTokens: event.usage.outputTokens,
            cacheReadTokens: event.usage.cacheReadTokens,
            cacheCreationTokens: event.usage.cacheCreationTokens,
            costUsd: event.usage.costUsd,
          });
          break;
        }
        case "session": {
          const agentId = store.turns.get(turn.turnId)?.agentId;
          if (agentId && event.backendSessionId) {
            store.settings.setRaw(backendSessionKey(agentId), event.backendSessionId);
          }
          break;
        }
        case "turn": {
          finishTurn(deps, turn.sessionId, turn.turnId, event.status, event.error);
          break;
        }
      }
    }
  }

  function send(args: EngineSendArgs): void {
    const session = store.sessions.get(args.sessionId);
    if (!session) throw new Error(`unknown session: ${args.sessionId}`);
    const agentId = args.agentId ?? session.leadAgentId;
    const agent = agentId ? store.sessions.agent(agentId) : null;
    if (!agent) {
      errorBlock(deps, session.id, args.turnId, "This session has no agent to answer with.");
      finishTurn(deps, session.id, args.turnId, "error", "no agent");
      return;
    }

    // Anything that goes wrong before the stream exists must still close the
    // turn: a row left `streaming` is a composer that never unlocks.
    let harness: Harness;
    let events: AsyncIterable<EngineEvent>;
    let turn: ActiveTurn;
    try {
      harness = harnessFor(session, agent);
      turn = {
        sessionId: session.id,
        turnId: args.turnId,
        harness,
        blocks: new Map(),
      };
      active.set(session.id, turn);
      events = harness.send({ turnId: args.turnId, text: args.text });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[engine] could not start turn ${args.turnId}`, err);
      active.delete(session.id);
      errorBlock(deps, session.id, args.turnId, message);
      finishTurn(deps, session.id, args.turnId, "error", message);
      return;
    }

    void consume(turn, events)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`[engine] turn ${args.turnId} failed`, err);
        errorBlock(deps, session.id, args.turnId, message);
        finishTurn(deps, session.id, args.turnId, "error", message);
      })
      .finally(() => {
        if (active.get(session.id) === turn) active.delete(session.id);
        // A stream that ended without a final status would leave the row
        // `streaming` and the composer locked; close it loudly instead.
        if (store.turns.get(turn.turnId)?.status === "streaming") {
          const message = "the backend ended the turn without a result";
          errorBlock(deps, session.id, turn.turnId, message);
          finishTurn(deps, session.id, turn.turnId, "error", message);
        }
        // Whatever the outcome, nothing is still waiting on this turn.
        for (const [requestId, waiting] of [...awaiting]) {
          if (waiting === turn.harness) awaiting.delete(requestId);
        }
      });
  }

  return {
    send,

    async interrupt(sessionId) {
      const turn = active.get(sessionId);
      if (!turn) return false;
      return turn.harness.interrupt();
    },

    answerPermission(requestId: string, answer: EnginePermissionAnswer): boolean {
      const harness = awaiting.get(requestId);
      if (!harness) return false;
      awaiting.delete(requestId);
      return harness.answerPermission(requestId, answer);
    },

    answerQuestion(requestId: string, answers: Record<string, string>): boolean {
      const harness = awaiting.get(requestId);
      if (!harness) return false;
      awaiting.delete(requestId);
      return harness.answerQuestion(requestId, answers);
    },

    listCommands(sessionId?: string): SlashCommand[] {
      if (!sessionId) return [];
      const prefix = `${sessionId}:`;
      for (const [key, harness] of harnesses) {
        if (key.startsWith(prefix)) return harness.listCommands();
      }
      return [];
    },

    dispose() {
      for (const harness of harnesses.values()) {
        void harness.dispose().catch(() => undefined);
      }
      harnesses.clear();
      active.clear();
      awaiting.clear();
    },
  };
}
