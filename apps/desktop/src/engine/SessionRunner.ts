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
  createHarnessForBackend,
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
import { loadApiHistory } from "./history.js";
import { emitBlock, errorBlock, finishTurn } from "./persist.js";
import type { Engine, EngineDeps, EnginePermissionAnswer, EngineSendArgs } from "./types.js";

/** Key under which an agent's backend session id is remembered for `resume`. */
export function backendSessionKey(agentId: string): string {
  return `engine.backendSession.${agentId}`;
}

export interface SessionRunnerDeps extends EngineDeps {
  /**
   * Overridden in tests; the default asks `@capygen/engine`'s registry for the
   * harness that matches `agent.backend`, so the composer's backend choice is
   * what decides which backend actually runs (SPEC R7/R8/R9).
   */
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

/** The key both `harnesses` and `active` are stored under. */
function agentKey(sessionId: string, agentId: string): string {
  return `${sessionId}:${agentId}`;
}

/** How long shutdown waits for a backend to settle before giving up on it. */
const DISPOSE_DEADLINE_MS = 2_000;

function withDeadline(work: Promise<unknown>, ms: number): Promise<unknown> {
  return Promise.race([
    work,
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    }),
  ]);
}

export function createSessionRunner(deps: SessionRunnerDeps): Engine {
  const { store, broadcast, log } = deps;

  /**
   * The harness registry, wired once (SPEC R7/R8/R9).
   *
   * Everything backend-specific that needs the *desktop* is injected here and
   * nowhere else: the API key provider (the engine never reads a key from
   * disk, R21) and the transcript replay an `api` agent needs because it has
   * no backend session to resume. Claude and Codex take only the logger — they
   * resume from their own session id, which `harnessFor` reads out of settings.
   */
  const makeHarness =
    deps.makeHarness ??
    ((agent: HarnessAgent): Harness =>
      createHarnessForBackend(agent.backend, {
        claude: { log },
        codex: { log },
        api: {
          log,
          ...(deps.keys ? { keys: deps.keys } : {}),
          loadHistory: (session, forAgent) => loadApiHistory(store, session, forAgent),
        },
      }));

  /** `sessionId:agentId` → harness. */
  const harnesses = new Map<string, Harness>();
  /**
   * `sessionId:agentId` → the turn that agent is running. Keyed the same way
   * as `harnesses`, not by session: a second `send` on another agent of the
   * same session (round-table, Phase 4) must not evict the first agent's turn
   * and take `interrupt` with it.
   */
  const active = new Map<string, ActiveTurn>();
  /** requestId → the harness waiting for that answer. */
  const awaiting = new Map<string, Harness>();
  /** Every `consume()` still running, so `dispose()` can wait for their writes. */
  const consuming = new Set<Promise<void>>();

  function harnessFor(session: Session, agent: Agent): Harness {
    const key = agentKey(session.id, agent.id);
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

  /**
   * [B3] MCP Apps (SPEC R31): a finished MCP tool call may have a widget.
   *
   * The Claude Agent SDK strips a tool's `_meta` from the stream, so there is
   * nothing on the wire that says "this one has a UI" (docs/spikes/mcp-apps.md
   * §b2) — the host has to ask the server itself, which is one cached
   * `tools/list` per server. That is why this runs *after* the result lands
   * (a widget with no result has nothing to render) and why it is fire and
   * forget: the turn must never wait on an MCP server to keep streaming.
   *
   * The widget block is written twice: `pending` as soon as we know there is
   * one — so the transcript shows a placeholder in the right position rather
   * than the card appearing late — and then `ready`/`unavailable` once the
   * document has been read.
   */
  function maybeOpenWidget(turn: ActiveTurn, patch: BlockPatch): void {
    const widgets = deps.widgets;
    if (!widgets || patch.kind !== "tool_call") return;
    if (patch.status !== "success" && patch.status !== "error") return;
    if (!patch.name.startsWith("mcp__") || patch.toolUseId === undefined) return;
    const toolCallId = patch.toolUseId;
    // One widget per tool call, however many times its row is rewritten.
    const widgetKey = `widget:${toolCallId}`;
    if (turn.blocks.has(widgetKey)) return;
    turn.blocks.set(widgetKey, {
      id: newId("block"),
      index: store.blocks.nextIndex(turn.turnId),
      createdAt: Date.now(),
    });

    const agentId = store.turns.get(turn.turnId)?.agentId ?? "";
    const toolResult = asToolResult(patch.output);
    const call = {
      sessionId: turn.sessionId,
      agentId,
      toolCallId,
      toolName: patch.name,
      toolInput: patch.input,
      toolResult,
    };
    void (async (): Promise<void> => {
      const target = await widgets.detect(call);
      if (!target?.resourceUri) {
        // No widget after all — drop the slot again so the index it reserved
        // is not left as a hole in the transcript.
        turn.blocks.delete(widgetKey);
        return;
      }
      const blockId = turn.blocks.get(widgetKey)?.id;
      if (!blockId) return;
      writeBlock(turn, widgetKey, {
        kind: "widget",
        toolCallId,
        serverName: target.serverName,
        toolName: target.toolName,
        resourceUri: target.resourceUri,
        html: null,
        htmlStatus: "pending",
        toolInput: patch.input,
        toolResult,
        meta: null,
      });
      const { patch: resolved } = await widgets.open({
        ...call,
        ...target,
        resourceUri: target.resourceUri,
        blockId,
        toolResult,
      });
      writeBlock(turn, widgetKey, resolved);
      log.info(`[engine] widget ${target.serverName}/${target.toolName} for block ${blockId}`);
    })().catch((err: unknown) => {
      turn.blocks.delete(widgetKey);
      log.warn(`[engine] widget resolution failed for ${patch.name}`, err);
    });
  }

  async function consume(turn: ActiveTurn, events: AsyncIterable<EngineEvent>): Promise<void> {
    for await (const event of events) {
      switch (event.type) {
        case "block": {
          writeBlock(turn, event.key, event.patch);
          maybeOpenWidget(turn, event.patch);
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
        case "elicitation": {
          awaiting.set(event.requestId, turn.harness);
          const slot = turn.blocks.get(event.key);
          if (slot) {
            broadcast("elicitation.request", {
              sessionId: turn.sessionId,
              turnId: turn.turnId,
              blockId: slot.id,
              requestId: event.requestId,
              ...(event.title !== undefined ? { title: event.title } : {}),
              ...(event.description !== undefined ? { description: event.description } : {}),
              schema: event.schema,
            });
          }
          break;
        }
        case "usage": {
          const agentId = store.turns.get(turn.turnId)?.agentId ?? null;
          // `byModel` is the split the harness went to the trouble of
          // computing (a Task sub-agent may run on a different model than the
          // agent that spawned it). Recording only `event.usage` under
          // `event.model` would file the sub-agent's tokens under the lead's
          // model and break R23's per-model aggregation. The single-row path
          // is the fallback for harnesses that report no split.
          const perModel = Object.entries(event.byModel).filter(
            ([, u]) => u.inputTokens + u.outputTokens + u.cacheReadTokens +
              u.cacheCreationTokens + u.costUsd > 0,
          );
          const rows =
            perModel.length > 0
              ? perModel.map(([model, usage]) => ({ model, usage }))
              : [{ model: event.model, usage: event.usage }];
          for (const { model, usage } of rows) {
            store.usage.record({
              sessionId: turn.sessionId,
              agentId,
              turnId: turn.turnId,
              backend: event.backend,
              model,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cacheReadTokens: usage.cacheReadTokens,
              cacheCreationTokens: usage.cacheCreationTokens,
              costUsd: usage.costUsd,
            });
          }
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

    // One turn per agent. Letting a second send through would hand the harness
    // a prompt it is bound to refuse and — worse — replace the entry
    // `interrupt()` needs for the turn that is genuinely still streaming.
    const key = agentKey(session.id, agent.id);
    if (active.has(key)) {
      const message = "this agent is already running a turn";
      log.warn(`[engine] refused a second turn ${args.turnId} for ${key}`);
      errorBlock(deps, session.id, args.turnId, message);
      finishTurn(deps, session.id, args.turnId, "error", message);
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
      active.set(key, turn);
      events = harness.send({ turnId: args.turnId, text: args.text });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[engine] could not start turn ${args.turnId}`, err);
      active.delete(key);
      errorBlock(deps, session.id, args.turnId, message);
      finishTurn(deps, session.id, args.turnId, "error", message);
      return;
    }

    const running = consume(turn, events)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`[engine] turn ${args.turnId} failed`, err);
        // Nothing is reading this harness's stream any more, so a permission
        // or question it asks next can never be answered and the backend would
        // wait on it forever — taking every later turn on this agent with it.
        void turn.harness.interrupt().catch(() => undefined);
        errorBlock(deps, session.id, args.turnId, message);
        finishTurn(deps, session.id, args.turnId, "error", message);
      })
      .finally(() => {
        if (active.get(key) === turn) active.delete(key);
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
    consuming.add(running);
    void running.finally(() => consuming.delete(running));
  }

  return {
    send,

    async interrupt(sessionId) {
      // Every agent of this session, not just one: in round-table mode more
      // than one can be mid-turn and the user asked the *session* to stop.
      const prefix = `${sessionId}:`;
      const turns = [...active].filter(([key]) => key.startsWith(prefix)).map(([, t]) => t);
      if (turns.length === 0) return false;
      const results = await Promise.all(turns.map((t) => t.harness.interrupt()));
      return results.some(Boolean);
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

    answerElicitation(requestId: string, answers: Record<string, unknown> | null): boolean {
      const harness = awaiting.get(requestId);
      // `answerElicitation` is optional on `Harness` — a backend that never
      // emits the event has nothing to answer, which reads the same to the
      // caller as a request whose turn has already ended.
      if (!harness?.answerElicitation) return false;
      awaiting.delete(requestId);
      return harness.answerElicitation(requestId, answers);
    },

    /**
     * The commands of the agent that will actually receive the message — the
     * lead unless the caller names another (R14). Falling back to "the first
     * harness whose key starts with this session" would, in a round-table
     * session, offer the user Codex's `/review` while their message goes to a
     * Claude agent that has never heard of it.
     */
    listCommands(sessionId?: string, agentId?: string | null): SlashCommand[] {
      if (!sessionId) return [];
      const wanted = agentId ?? store.sessions.get(sessionId)?.leadAgentId ?? null;
      if (wanted) {
        const harness = harnesses.get(agentKey(sessionId, wanted));
        if (harness) return harness.listCommands();
      }
      const prefix = `${sessionId}:`;
      for (const [key, harness] of harnesses) {
        if (key.startsWith(prefix)) return harness.listCommands();
      }
      return [];
    },

    /**
     * Shutdown is a two-step wait, and both steps matter. Disposing a harness
     * only *enqueues* the turn's final `interrupted` event; the `consume()`
     * loop writes it a microtask later. Returning before those writes land is
     * how a turn ends up frozen at `streaming` in SQLite, so `will-quit` can
     * await this before closing the database.
     */
    async dispose() {
      await withDeadline(
        Promise.allSettled([...harnesses.values()].map((h) => h.dispose())),
        DISPOSE_DEADLINE_MS,
      );
      // Bounded on purpose: a backend that never settles its turn must not be
      // able to hang the app's shutdown (the same rule ClaudeHarness.dispose
      // follows when it refuses to await the SDK's own teardown).
      await withDeadline(Promise.allSettled([...consuming]), DISPOSE_DEADLINE_MS);
      harnesses.clear();
      active.clear();
      awaiting.clear();
      consuming.clear();
    },
  };
}

/**
 * A tool_call block's `output` back into the MCP `CallToolResult` shape the
 * widget bridge delivers to a view. Claude's stream gives the *settled*
 * `tool_use_result` here, which already carries `content`/`structuredContent`
 * for an MCP tool; anything else is wrapped as one text block so a widget
 * always receives a well-formed result.
 */
function asToolResult(
  output: unknown,
): { content: unknown[]; structuredContent?: unknown; isError?: boolean } | null {
  if (output === undefined || output === null) return null;
  if (typeof output === "object" && !Array.isArray(output)) {
    const record = output as Record<string, unknown>;
    if (Array.isArray(record.content) || record.structuredContent !== undefined) {
      return {
        content: Array.isArray(record.content) ? record.content : [],
        ...(record.structuredContent !== undefined
          ? { structuredContent: record.structuredContent }
          : {}),
        ...(typeof record.isError === "boolean" ? { isError: record.isError } : {}),
      };
    }
  }
  return {
    content: [{ type: "text", text: typeof output === "string" ? output : JSON.stringify(output) }],
  };
}
