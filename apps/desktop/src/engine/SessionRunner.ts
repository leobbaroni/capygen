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
  DELEGATE_TASK_SCHEMA,
  DELEGATE_TASK_TOOL,
  createDelegateMcpServer,
  createDelegateRunner,
  createHarnessForBackend,
  createSubagentRouter,
  delegateTaskTool,
  effectiveBackendConfig,
  resolveModel,
  resolvePermissionMode,
  type ModelCatalogue,
  type BlockPatch,
  type EngineEvent,
  type Harness,
  type HarnessAgent,
  type HarnessSession,
  type McpServerConfig,
  type SubagentRoute,
  type SubagentRouteRequest,
} from "@capygen/engine";
import {
  newId,
  type Agent,
  type AgentDescribe,
  type AgentRuntimeInfo,
  type Backend,
  type Block,
  type GlobalSettings,
  type PermissionMode,
  type Session,
  type SlashCommand,
  type TurnStatus,
} from "@capygen/shared";
import { createHash } from "node:crypto";
import { buildImportReference } from "@capygen/engine";
import { loadApiHistory } from "./history.js";
import { emitBlock, errorBlock, finishTurn } from "./persist.js";
import { describeAgent as describeAgentInfo } from "../ipc/agentsDescribe.js";
import { createRoundTable, type RoundTable } from "./RoundTable.js";
import { harnessDescribeSnapshot } from "./describeSnapshot.js";
import { delegationTarget, promptAdditionFor, resolveSubagentRoute } from "./routing.js";
import type { Engine, EngineDeps, EnginePermissionAnswer, EngineSendArgs } from "./types.js";

/** Key under which an agent's backend session id is remembered for `resume`. */
export function backendSessionKey(agentId: string): string {
  return `engine.backendSession.${agentId}`;
}

/**
 * [7-P1] Which backend the stored resume id belongs to.
 *
 * A resume id is a *backend's* handle — a Claude SDK session, a Codex thread —
 * and means nothing to another one, so it is stored with the backend that
 * issued it and checked before use.
 *
 * No shipping path changes an agent's backend today (`AgentPatchSchema` has no
 * `backend` field), so this is a guard rather than a fix for an observed bug:
 * it makes the invariant explicit before the worktree/import work starts moving
 * agents around, and it means a handle written by an older build — which
 * carries no tag — is still trusted, because no backend change can have
 * happened to it.
 */
export function backendSessionBackendKey(agentId: string): string {
  return `engine.backendSession.backend.${agentId}`;
}

/**
 * The client-hosted tool set the stored backend session was **started** with.
 *
 * A Codex thread's `dynamicTools` are fixed at `thread/start`: the pinned
 * schema has no such field on `ThreadResumeParams`, so a resumed thread keeps
 * the set it was created with and no later edit can reach it (proven both ways
 * in `packages/engine/scripts/probe-codex-dynamic-tools.ts`).
 *
 * Resuming across a changed set is therefore a silent lie in one of two
 * directions: a tool the agent now has that the thread will never offer, or one
 * it no longer has that the thread still advertises. Recording a signature of
 * what was declared makes the difference detectable, so the runner can start a
 * fresh thread and say why instead.
 *
 * The signature is names and schemas only. A routing *target* change —
 * delegating to a different backend or model — does not alter the tool the
 * model sees, so it must not throw away a live thread.
 */
/** Rows the continuity read will look at — enough prose to fill the 6 KB
 *  reference several times over, and a hard stop well before "the session". */
const CONTINUITY_MAX_ROWS = 40;
/** Characters read from any one block, so a single huge row cannot cross the
 *  process boundary to be thrown away a moment later. */
const CONTINUITY_MAX_CHARS_PER_ROW = 2_000;

export function backendSessionToolsKey(agentId: string): string {
  return `engine.backendSession.dynamicTools.${agentId}`;
}

/** Stable across key order and across runs; empty when nothing is declared. */
export function dynamicToolSignature(
  tools: readonly { name: string; parameters: unknown }[] | undefined,
): string {
  if (!tools || tools.length === 0) return "";
  const canonical = tools
    .map((tool) => `${tool.name}:${stableJson(tool.parameters)}`)
    .sort()
    .join("|");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/** JSON with object keys sorted, so formatting cannot move the signature. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * [B1] The per-agent wiring the *routing policy* adds on top of a harness's own
 * deps (SPEC R12). Built in `harnessFor`, where the session and the agent row
 * are both in hand; a test's `makeHarness` may simply ignore the second
 * argument, which is why it is separate from `HarnessAgent`.
 */
export interface HarnessExtras {
  /** Claude's `PreToolUse` model rewrite for a same-backend route. */
  routeSubagent?: (req: SubagentRouteRequest) => SubagentRoute | null | undefined;
  /** Claude's in-process `delegate_task` MCP server for a cross-backend one. */
  mcpServers?: () =>
    | Promise<Record<string, unknown> | null>
    | Record<string, unknown>
    | null;
  /** The same tool, as an `api`-backend tool definition. */
  extraTools?: readonly ReturnType<typeof delegateTaskTool>[];
  /**
   * The same tool again, for Codex: client-hosted tools declared once on
   * `thread/start` and called back through `item/tool/call`.
   *
   * ADR-0004 recorded that a Codex lead could not be handed `delegate_task`,
   * because app-server took MCP servers only from the user's `config.toml`.
   * That is still true of MCP servers; it is not true of *tools*. The pinned
   * 0.153.4 binary carries `ThreadStartParams.dynamicTools`, and
   * `packages/engine/scripts/probe-codex-dynamic-tools.ts` proves against that
   * binary that a declared tool is routed back to the client — with no edit to
   * any file the user's own CLI reads.
   */
  dynamicTools?: readonly ReturnType<typeof delegateTaskTool>[];
  /** Persists a dynamic tool's full result and returns its `tool_outputs` id. */
  storeDynamicToolOutput?: (info: {
    callId: string;
    blockKey: string;
    toolName: string;
    output: string;
  }) => string | null;
  /** Full main-process-only MCP values captured with this harness lifecycle. */
  mcpServerConfigs?: readonly McpServerConfig[];
}

export interface SessionRunnerDeps extends EngineDeps {
  /**
   * Overridden in tests; the default asks `@capygen/engine`'s registry for the
   * harness that matches `agent.backend`, so the composer's backend choice is
   * what decides which backend actually runs (SPEC R7/R8/R9).
   */
  makeHarness?: (agent: HarnessAgent, extras: HarnessExtras) => Harness;
  /**
   * [7-P1] The canonical settings, read fresh whenever a harness is **built**.
   * A global change therefore reaches the next new or restarted harness and
   * never an active turn. Defaults to the store's own row so the existing
   * tests need no wiring.
   */
  settings?: () => GlobalSettings;
  /** Each backend's own catalogue default; never probes (see `handlers.ts`). */
  catalogue?: ModelCatalogue;
  /**
   * [7-P1] The same check `sessions.create`/`agents.*` run before they write.
   *
   * IPC validation alone only covers rows created *since* it existed: a session
   * stored before this build, or one whose backend catalogue has changed under
   * it, reaches dispatch with a model nobody has checked. The actual dispatch
   * runs the identical validator, so the two can never disagree about whether
   * an agent can run.
   */
  validateModel?: (selection: {
    backend: Backend;
    model?: string | null;
    name?: string;
    /** The effective section for that backend — `api` reads `provider`. */
    config?: Record<string, unknown> | null;
  }) => { ok: boolean; model: string; provider?: string; reason?: string };
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
  /**
   * toolCallId → who is resolving that call's widget.
   *
   * `"harness"` means the backend emitted its own `widget` block for the call
   * (Codex reads the `ui://` straight off `mcpToolCall.appContext`; the `api`
   * harness off the tool's `_meta`), so the runner must not run a second,
   * independent detection against the same MCP server — and must never delete
   * a slot the harness has already written a row into.
   * `"runner"` means nobody claimed it and the runner is asking the widget
   * host itself, which is what the Claude backend needs: its stream carries no
   * tool `_meta` at all (docs/spikes/mcp-apps.md §b2).
   */
  widgetOwner: Map<string, "harness" | "runner">;
  /** toolCallIds whose `ui://` document is already being fetched. */
  widgetOpening: Set<string>;
  /**
   * toolCallIds whose widget row has reached a settled `htmlStatus`. The two
   * resolution paths (harness-announced and host-detected) race by a microtask
   * or two, so a late `pending` patch must not reopen a card that is already
   * showing its document.
   */
  widgetResolved: Set<string>;
  /** toolCallId → the harness block key of its tool_call row. */
  toolCallKeys: Map<string, string>;
  /**
   * [7-P1] Set while the harness is still starting, so the slot is reserved
   * before the first await: a second send is refused, and a Stop that lands
   * during startup is remembered rather than lost.
   */
  starting: boolean;
  /** Stop reached this turn before its stream existed; nothing is sent. */
  cancelled: boolean;
}

/**
 * [7-P1] The one effort field each backend actually reads, surfaced as the
 * single non-secret scalar `AgentRuntimeInfo.effort`. Claude calls it `effort`,
 * Codex and the API loop call it `reasoningEffort`; nothing else from the
 * effective config leaves the main process.
 */
function readEffort(agent: HarnessAgent): string | null {
  const section = (agent.config as Record<string, Record<string, unknown>> | null | undefined)?.[
    agent.backend
  ];
  // [7-P1] The backend's **own** field, not whichever of the two happens to be
  // set: Claude's option is `effort` (`ClaudeOptions.effort`), Codex's and the
  // API loop's is `reasoningEffort`. Reading `effort ?? reasoningEffort` made
  // the answer depend on which key a config bag happened to carry, so a Codex
  // agent could report a stale Claude value that nothing sends.
  const field = agent.backend === "claude" ? "effort" : "reasoningEffort";
  const value = section?.[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The key both `harnesses` and `active` are stored under. */
function agentKey(sessionId: string, agentId: string): string {
  return `${sessionId}:${agentId}`;
}

/**
 * The permission mode one agent actually runs under (SPEC R19/R27).
 *
 * Per-agent config beats the global setting, and the per-agent field is the
 * one under the agent's *own* backend key. `codex` has no `permissionMode` of
 * its own (its equivalent is `approvalPolicy`, which `CodexHarness` reads
 * directly from `config.codex`), so it falls through to the global setting.
 */
export function permissionModeFor(agent: Agent, fallback: PermissionMode): PermissionMode {
  const config = agent.config;
  if (!config) return fallback;
  switch (agent.backend) {
    case "claude":
      return config.claude?.permissionMode ?? fallback;
    case "api":
      return config.api?.permissionMode ?? fallback;
    default:
      return fallback;
  }
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
  const makeHarness: (agent: HarnessAgent, extras: HarnessExtras) => Harness =
    deps.makeHarness ??
    ((agent: HarnessAgent, extras: HarnessExtras): Harness =>
      createHarnessForBackend(agent.backend, {
        claude: {
          log,
          ...(extras.routeSubagent ? { routeSubagent: extras.routeSubagent } : {}),
          ...(extras.mcpServers ? { mcpServers: extras.mcpServers } : {}),
        },
        codex: {
          log,
          ...(extras.dynamicTools ? { dynamicTools: extras.dynamicTools } : {}),
          ...(extras.storeDynamicToolOutput
            ? { storeDynamicToolOutput: extras.storeDynamicToolOutput }
            : {}),
        },
        api: {
          log,
          ...(deps.keys ? { keys: deps.keys } : {}),
          ...(deps.pools
            ? { acquirePool: (servers) => deps.pools!.acquire(servers) }
            : {}),
          ...(extras.extraTools ? { extraTools: extras.extraTools } : {}),
          mcpServers: extras.mcpServerConfigs ?? [],
          loadHistory: (session, forAgent) => loadApiHistory(store, session, forAgent),
        },
      }));

  const settings = deps.settings ?? ((): GlobalSettings => store.globalSettings.all());

  /** `sessionId:agentId` → harness. */
  const harnesses = new Map<string, Harness>();
  /**
   * [7-P1] `sessionId:agentId` → the configuration that harness was built with.
   * Read only by `agentRuntime` (three scalars and a flag) and used to answer
   * "what is actually running" without re-deriving it — the capture is the
   * lifecycle's, not the current settings'.
   */
  const runtime = new Map<string, HarnessAgent>();
  /** Agents whose harness must be replaced as soon as their turn ends. */
  const restartPending = new Set<string>();
  /**
   * `sessionId:agentId` → an evicted harness's teardown, while it is still
   * running. `harnessFor` awaits it before building the replacement so the two
   * never hold the same agent's resources at once.
   */
  const disposing = new Map<string, Promise<void>>();
  /**
   * `sessionId:agentId` → the in-flight `start()` (after any pending teardown).
   * A second turn on the same agent joins this rather than starting again.
   */
  const starting = new Map<string, Promise<void>>();
  /**
   * Set by `dispose()`. Anything parked on a start checks it before it acts:
   * a backend that finishes starting after shutdown must not send, and must
   * not write into a store the caller is about to close.
   */
  let shuttingDown = false;
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
  /**
   * [B1] `sessionId:agentId` → the last turn that existed when that agent's
   * harness started. Only an `api` agent has one, and only because
   * `history.ts` replayed the transcript up to that point at `start()`: the
   * round table's context delta must begin *after* it or a relaunch would send
   * the same turns a second time (`RoundTable.deltaStart`).
   */
  const historyWatermarks = new Map<string, string | null>();
  /**
   * `sessionId` → the delegated sub-agent harnesses currently in flight for
   * that session (SPEC R12).
   *
   * `active` only ever holds a *top-level* agent's own harness, so before this
   * existed nothing `interrupt()` could see held the short-lived child
   * `delegate_task` builds: pressing Stop left a cross-backend sub-agent
   * running — and billing — until `DEFAULT_DELEGATE_TIMEOUT_MS`, with its
   * output dropped on the floor because the parent's turn had already gone.
   * Entries are added before the child's first `await` and removed once it is
   * disposed (`createDelegateRunner`'s `onHarness` contract).
   */
  const delegated = new Map<string, Set<Harness>>();

  /**
   * `sessionId:agentId` → the signature of the client-hosted tool set the live
   * harness was built with, recorded alongside its backend session id so a
   * later launch can tell whether the stored thread still matches.
   */
  const declaredToolSignature = new Map<string, string>();

  /**
   * [B1] Everything the routing policy adds to one agent's harness (SPEC R12).
   *
   * The two levers are chosen once, here, and never per turn — a tool list or
   * an MCP server list that moved between turns is a cache miss on every turn
   * (R24). What stays dynamic is the *target*: `delegate_task`'s runner asks
   * `delegationTarget` again on every call, so a routing rule the user edits in
   * Settings takes effect on the next spawn without restarting the backend.
   */
  function harnessExtras(
    session: Session,
    agent: Agent,
    harnessAgent: HarnessAgent,
  ): HarnessExtras {
    const extras: HarnessExtras = {};

    if (agent.backend === "claude") {
      // Same-backend routes only: `createSubagentRouter` returns nothing for a
      // cross-backend decision, because the hook's one lever is the model and
      // a foreign model id would fail the spawn instead of redirecting it.
      const router = createSubagentRouter({
        route: (req) => resolveSubagentRoute(store, session.id, req.agentId || agent.id),
        log,
      });
      extras.routeSubagent = (req): SubagentRoute | null => {
        const routed = router(req);
        return routed ? { model: routed.model, backend: routed.backend } : null;
      };
    }

    const target = delegationTarget(store, session.id, agent.id);
    if (!target) return extras;

    const project = store.projects.get(session.projectId);
    const run = createDelegateRunner({
      session: { sessionId: session.id, projectPath: project?.path ?? process.cwd() },
      parent: harnessAgent,
      // Re-read per call, not captured: see the comment above.
      target: () => delegationTarget(store, session.id, agent.id),
      // [7-P1] The factory is handed the **same** child agent `start()` gets,
      // so the two cannot describe different runs. It used to build a second
      // one from the parent here, carrying the parent's whole config and its
      // permission mode into another backend.
      makeHarness: (_routed: { backend: Backend; model: string }, child: HarnessAgent) =>
        makeHarness(
          child,
          // No delegation inside a delegated turn: one hop, not a tree.
          {},
        ),
      // The target backend's own defaults, with the parent's explicit section
      // for that backend on top; the parent's permission mode is never copied.
      resolveTarget: (backend: Backend) => {
        const resolved = resolveTargetConfig(agent, backend);
        // The target backend's own canonical default, offered *after* the tool
        // request and the routing rule — resolved and validated against the
        // **target's** effective config, so an `api` child that selects its own
        // provider is not handed the global provider's default.
        const canonical = deps.validateModel?.({ backend, config: resolved.config });
        // Same materialisation for a delegated child: the provider its model
        // was resolved against travels with it.
        if (canonical?.ok && canonical.provider) resolved.config.provider = canonical.provider;
        return {
          config: resolved.config,
          permissionMode: resolved.permissionMode,
          model: canonical?.ok ? canonical.model : null,
          validate: (model: string) => {
            const check = deps.validateModel?.({ backend, model, config: resolved.config });
            // A valid request/route may override an incompatible canonical
            // model. Capture its provider even when the canonical check above
            // failed; this config is the child-specific object used at start.
            if (check?.ok && check.provider) resolved.config.provider = check.provider;
            return check ? { ok: check.ok, ...(check.reason ? { reason: check.reason } : {}) } : { ok: true };
          },
        };
      },
      ...(deps.catalogue ? { catalogue: deps.catalogue } : {}),
      // The sub-agent's blocks, cards and usage land in the *parent's* turn,
      // which is the turn the user is looking at. They carry `delegatedFrom`
      // (set by `createDelegateRunner`) so the transcript can attribute them
      // and the round table can keep them out of the parent's "reply".
      onEvent: (event, harness) => {
        const parentTurn = active.get(agentKey(session.id, agent.id));
        if (!parentTurn) return;
        handleEvent(parentTurn, event, harness);
      },
      // Stop is a session verb (see `interrupt` below); this is what makes it
      // reach a delegated child too.
      onHarness: (child) => {
        let set = delegated.get(session.id);
        if (!set) {
          set = new Set();
          delegated.set(session.id, set);
        }
        set.add(child);
        return () => {
          set.delete(child);
          if (set.size === 0) delegated.delete(session.id);
        };
      },
      log,
    });

    if (agent.backend === "claude") extras.mcpServers = () => createDelegateMcpServer({ run, log });
    if (agent.backend === "api") extras.extraTools = [delegateTaskTool(run)];
    if (agent.backend === "codex") {
      extras.dynamicTools = [delegateTaskTool(run)];
      /**
       * R25 for a delegated answer, with a foreign key that has to hold.
       *
       * `tool_outputs.block_id` references a real block, and the block for a
       * dynamic call is the one Codex's own `dynamicToolCall` item owns — it
       * opens that item *before* it asks, so the row exists by the time this
       * runs. If it does not, this returns `null` and the harness tells the
       * model the output is unavailable, rather than orphaning a row or
       * stuffing megabytes into the block payload.
       */
      extras.storeDynamicToolOutput = ({ blockKey, output }) => {
        const parentTurn = active.get(agentKey(session.id, agent.id));
        const slot = parentTurn?.blocks.get(blockKey);
        if (!slot) {
          log.warn(`[engine] no block for ${blockKey}; the delegated output was not stored`);
          return null;
        }
        try {
          return store.toolOutputs.put({ blockId: slot.id, content: output }).id;
        } catch (err) {
          log.warn(`[engine] storing a delegated output failed`, err);
          return null;
        }
      };
    }
    log.info(
      `[engine] ${agent.mentionName} delegates sub-agents to ${target.backend}/` +
        `${target.model || "(backend default)"}`,
    );
    return extras;
  }

  /**
   * [7-P1] The configuration a harness is built with, captured **once** per
   * harness lifecycle: the canonical global default for the agent's own
   * backend, with that agent's own explicit override laid on top, field by
   * field. Unset fields fall through to the harness's own defaults exactly as
   * they always did.
   *
   * `harnessFor` used to hand over the raw `agent.config` and the flat
   * app-wide `permissionMode`, so `effectiveBackendConfig` — the function that
   * exists to express this rule — reached no shipping code at all: a global
   * `backends.claude.effort` was simply never sent, and a global
   * `bypassPermissions` meant for Claude loosened an `api` agent too.
   *
   * The result carries **only the agent's own backend section**. A delegated
   * child resolves the target backend's section separately (see
   * `resolveTargetConfig`), because that is a different backend's opinion.
   */
  function effectiveHarnessAgent(
    agent: Agent,
    extras: { promptAddition?: string; dynamicTools?: readonly { name: string; parameters: unknown }[] } = {},
  ): { agent: HarnessAgent; notice?: string } | { error: string } {
    const global = settings();
    // The effective config first: for `api` it names the provider, and which
    // model may run depends on that.
    const config = effectiveBackendConfig(global, agent.config, agent.backend);
    // The injected validator when there is one (it also catches a stored model
    // that belongs to another backend, or to another provider); otherwise the
    // resolution chain alone.
    const checked = deps.validateModel?.({
      backend: agent.backend,
      model: agent.model,
      name: agent.displayName,
      config,
    });
    if (checked && !checked.ok) return { error: checked.reason ?? "no model could be resolved" };
    const resolved = checked
      ? ({ ok: true, model: checked.model } as const)
      : resolveModel(global, agent, deps.catalogue);
    if (!resolved.ok) return { error: resolved.reason };
    // The provider the model was resolved against is written into the config
    // the harness reads. Resolving from one provider and leaving the field
    // unset — where `ApiHarness.resolveConfig` defaults it to Anthropic — is
    // how an OpenAI-only profile ended up sending `gpt-5` to Anthropic.
    if (checked?.provider) config.provider = checked.provider;
    const resume = resumeIdFor(agent, extras);
    return {
      ...(resume.notice ? { notice: resume.notice } : {}),
      agent: {
        agentId: agent.id,
        name: agent.name,
        backend: agent.backend,
        model: resolved.model,
        permissionMode: resolvePermissionMode(global, agent.config, agent.backend),
        resumeSessionId: resume.id,
        config: { [agent.backend]: config } as HarnessAgent["config"],
        ...(extras.promptAddition ? { promptAddition: extras.promptAddition } : {}),
      },
    };
  }

  /**
   * The stored backend session id, but only when it belongs to the backend this
   * agent runs on now. A row written before the backend was recorded is trusted
   * — `agents.update` clears both keys whenever the backend changes, so an
   * unlabelled id cannot have crossed backends.
   */
  function resumeIdFor(
    agent: Agent,
    extras: { dynamicTools?: readonly { name: string; parameters: unknown }[] },
  ): { id: string | null; notice?: string } {
    const id = store.settings.getRaw<string | null>(backendSessionKey(agent.id), null);
    if (!id) return { id: null };
    const recorded = store.settings.getRaw<string | null>(
      backendSessionBackendKey(agent.id),
      null,
    );
    if (recorded && recorded !== agent.backend) {
      log.info(
        `[engine] not resuming ${recorded} session ${id} on ${agent.backend} for ${agent.id}`,
      );
      return { id: null };
    }
    /**
     * A stored thread whose declared tool set no longer matches this agent's is
     * not a thread this agent can use: the set cannot be changed on resume. A
     * fresh thread is the only way to apply it — and the user is told, because
     * a backend conversation silently restarting is exactly the kind of thing
     * that looks like lost context. The native history is never touched; it
     * stays on disk under its own thread id.
     */
    // Only Codex fixes its tool set at thread start. Guarding on the backend
    // rather than on "are there tools" keeps a future extras flag on another
    // backend from throwing away a perfectly good session with this notice.
    if (agent.backend === "codex") {
      const wanted = dynamicToolSignature(extras.dynamicTools);
      const stored = store.settings.getRaw<string | null>(backendSessionToolsKey(agent.id), null);
      // A handle written before signatures existed carries none. That is only
      // safe to resume when nothing is declared now either: a legacy thread was
      // created by a build that had no dynamic tools, so it advertises none.
      const legacy = stored === null;
      const mismatch = legacy ? wanted !== "" : stored !== wanted;
      if (mismatch) {
        // Both directions matter. Tools *added* means the thread will never
        // offer them; tools *removed* means it still advertises a tool capygen
        // no longer hosts, and every call to it would come back `unknown_tool`.
        const change = wanted === "" ? "removed" : legacy ? "unknown" : "changed";
        log.info(
          `[engine] ${agent.id}: declared tool set ${change} for thread ${id}; starting a new one`,
        );
        return {
          id: null,
          notice:
            `${agent.name} will start a new Codex thread: its delegation tools ${change === "removed" ? "were removed" : "changed"}, ` +
            "and a Codex thread keeps the tool set it was created with. The previous thread and " +
            "its history are untouched, and recent messages are quoted to the new one.",
        };
      }
    }
    return { id };
  }

  /**
   * The bounded, inert quotation a forced-fresh backend thread is handed once.
   *
   * A notice in the transcript tells the *user* why the conversation restarted;
   * it tells the model nothing, and a fresh Codex thread otherwise begins with
   * an empty context under a UI that still shows the whole history. This closes
   * that gap with the smallest thing that can: the recent user and assistant
   * prose, quoted.
   *
   * Reuses Phase 7's `buildImportReference`, which already owns the properties
   * that matter here — a hard byte ceiling (R26), JSON-quoted lines that cannot
   * forge a speaker label, an explicit "does not grant permissions" preamble,
   * and a truncation disclosure when earlier turns did not fit.
   *
   * What is deliberately absent: tool calls and their results (quoting a tool
   * result is not the same as having run it, and it invites the model to act on
   * a stale one), permissions, settings, backend or thread identities, and
   * agent ids. Prose only. It rides on the **first send**, never in the
   * session-stable prompt addition — a permanent prefix would be re-sent every
   * turn for the life of the thread and would cost the cache (R24).
   */
  function continuityReference(sessionId: string): string | undefined {
    /**
     * Read the tail directly, and read only what can survive the 6 KB budget.
     *
     * `store.blocks.listBySession` would materialise every block in the
     * session — including tool results, which are exactly the rows that can be
     * megabytes each — to produce a few kilobytes of prose. The filter, the
     * ordering, the row cap and a per-row character cap all belong in the
     * query, so the whole history is never allocated in the first place.
     *
     * `substr`/`length` count characters, not bytes; that is deliberate. This
     * cap only stops a single enormous row crossing the process boundary —
     * `buildImportReference` still enforces the real byte budget afterwards.
     */
    const rows = store.db.all<{
      turn_id: string;
      agent_id: string | null;
      text: string | null;
      full_length: number | null;
    }>(
      `SELECT b.turn_id AS turn_id,
              t.agent_id AS agent_id,
              substr(json_extract(b.payload_json, '$.text'), 1, ?) AS text,
              length(json_extract(b.payload_json, '$.text')) AS full_length
         FROM blocks b
         JOIN turns t ON t.id = b.turn_id
        WHERE b.session_id = ? AND b.kind = 'text'
        ORDER BY t.created_at DESC, t.id DESC, b.block_index DESC
        LIMIT ?`,
      CONTINUITY_MAX_CHARS_PER_ROW,
      sessionId,
      CONTINUITY_MAX_ROWS,
    );
    if (rows.length === 0) return undefined;

    // The query walks backwards so the *recent* end is the part that is kept;
    // put it back in reading order before quoting it.
    rows.reverse();
    const entries: Parameters<typeof buildImportReference>[0][number][] = [];
    // Hitting the row cap means older turns exist and were not read. Starting
    // the index above zero is how `buildImportReference` learns to say so.
    let index = rows.length >= CONTINUITY_MAX_ROWS ? 1 : 0;
    for (const row of rows) {
      const text = (row.text ?? "").trim();
      if (!text) continue;
      const previous = entries[entries.length - 1];
      // "user" and "assistant" only: a peer agent's turn is quoted as
      // assistant prose rather than under its name, so nothing in here reads
      // as a dispatchable speaker or a real identity.
      const speaker = row.agent_id === null ? "user" : "assistant";
      const clipped = (row.full_length ?? 0) > CONTINUITY_MAX_CHARS_PER_ROW;
      // Several text blocks in one turn are one utterance.
      if (previous && previous.kind === "message" && previous.speaker === speaker) {
        previous.text = `${previous.text}\n${text}`;
        previous.truncated ||= clipped;
        continue;
      }
      entries.push({
        kind: "message",
        index: index++,
        at: null,
        label: speaker,
        speaker,
        truncated: clipped,
        text,
      });
    }
    if (entries.length === 0) return undefined;
    return buildImportReference(entries).text;
  }

  /**
   * The effective config for **another** backend, for a delegated child: that
   * backend's canonical global default with the parent's explicit
   * `config.<targetBackend>` section on top. The parent's section for the target
   * is a real, deliberate override (a Claude lead that sets
   * `codex.reasoningEffort` means it) and must survive; the parent's
   * *permission mode* is not carried across, which `resolvePermissionMode`
   * enforces by resolving the target's own.
   */
  function resolveTargetConfig(
    agent: Agent,
    backend: Backend,
  ): { config: Record<string, unknown>; permissionMode: PermissionMode } {
    const global = settings();
    return {
      config: effectiveBackendConfig(global, agent.config, backend),
      permissionMode: resolvePermissionMode(global, agent.config, backend),
    };
  }

  /**
   * Drop one agent's harness so the next turn rebuilds it from the current
   * settings. The backend resume id is deliberately **left in place**: the
   * conversation continues, only the options it runs under change.
   */
  function evict(key: string): void {
    const harness = harnesses.get(key);
    harnesses.delete(key);
    runtime.delete(key);
    restartPending.delete(key);
    if (!harness) return;
    // [7-P1] The disposal is **remembered**, not merely started. Building the
    // replacement is what the very next turn does, and a backend whose teardown
    // is still in flight is still holding that agent's resources — an MCP pool
    // lease, a child process, a streaming SDK session on the same resume id.
    // `harnessFor` waits on this before it constructs anything for the key, so
    // the old and new harnesses never overlap.
    const done = harness
      .dispose()
      .catch((err: unknown) => {
        log.warn(`[engine] disposing ${key} after a config change failed`, err);
      })
      .finally(() => {
        if (disposing.get(key) === done) disposing.delete(key);
      });
    disposing.set(key, done);
    log.info(`[engine] released ${key}; the next turn is built from the new configuration`);
  }

  /** Apply a restart that was waiting for this agent's turn to end. */
  function flushRestart(key: string): void {
    if (!restartPending.has(key)) return;
    evict(key);
    const agentId = key.slice(key.indexOf(":") + 1);
    broadcast("agent.runtime", { agentId, restartPending: false });
  }

  /** What an agent *would* run with, for an agent that has no harness yet. */
  function effectiveFallback(agent: Agent): HarnessAgent | null {
    const built = effectiveHarnessAgent(agent);
    return "error" in built ? null : built.agent;
  }

  /**
   * The harness for one agent, plus the promise that resolves once it is
   * genuinely ready to take a turn.
   *
   * Constructing acquires nothing; `start()` is where a backend binds its
   * session and agent, and where `ApiHarness` resolves its config and awaits
   * `loadHistory`. `send()` reads all of that, so the caller must await
   * `ready` before it sends — a started-but-unawaited harness answers the
   * first turn out of an uninitialised config.
   */
  function harnessFor(
    session: Session,
    agent: Agent,
  ): { harness: Harness; ready: Promise<void>; notice?: string; continuity?: string } {
    const key = agentKey(session.id, agent.id);
    const existing = harnesses.get(key);
    if (existing) return { harness: existing, ready: starting.get(key) ?? Promise.resolve() };

    const project = store.projects.get(session.projectId);
    if (!project) throw new Error(`session ${session.id} has no project row`);

    const harnessSession: HarnessSession = {
      sessionId: session.id,
      projectPath: project.path,
    };
    // [B1] Session-stable, built once here and never again for this harness
    // (SPEC R23/R24): the round-table roster and, when routing crosses
    // backends, the `delegate_task` notice.
    const promptAddition = promptAdditionFor(store, session.id, agent.id);
    // The tool set has to be known *before* the resume id is chosen: a Codex
    // thread cannot be re-declared, so whether this agent can reuse its stored
    // thread depends on what that thread was started with. The set itself is
    // fixed — one `delegate_task` with one schema — so it is derived from the
    // routing decision alone, without building the runner.
    const declaresTools =
      agent.backend === "codex" && delegationTarget(store, session.id, agent.id) !== null;
    const captured = effectiveHarnessAgent(agent, {
      ...(promptAddition ? { promptAddition } : {}),
      ...(declaresTools
        ? { dynamicTools: [{ name: DELEGATE_TASK_TOOL, parameters: DELEGATE_TASK_SCHEMA }] }
        : {}),
    });
    if ("error" in captured) {
      // [7-P1] Refused **before** the backend starts: a turn that cannot name a
      // model is not a turn a backend should be asked to interpret.
      throw new Error(captured.error);
    }
    const harnessAgent = captured.agent;
    const backendConfig = (
      harnessAgent.config as Record<string, unknown> | null | undefined
    )?.[agent.backend];
    const mcpServerConfigs = deps.resolveMcpServers?.({
      backend: agent.backend,
      projectId: session.projectId,
      ...(backendConfig !== undefined ? { agentConfig: backendConfig } : {}),
    }) ?? [];
    deps.widgets?.captureSession?.(session.id, agent.id, mcpServerConfigs);
    if (agent.backend === "api") {
      const turns = store.turns.list(session.id);
      historyWatermarks.set(key, turns[turns.length - 1]?.id ?? null);
    }
    // The **same** captured object reaches the factory and `start()`: two
    // independently rebuilt agents is how a child ends up running on something
    // other than what its factory was told (see `routing/delegate.ts`).
    const extras = harnessExtras(session, agent, harnessAgent);
    extras.mcpServerConfigs = mcpServerConfigs;
    const harness = makeHarness(harnessAgent, extras);
    harnesses.set(key, harness);
    runtime.set(key, harnessAgent);
    declaredToolSignature.set(key, dynamicToolSignature(extras.dynamicTools));
    // [7-P1] `start()` is where a backend actually takes hold of anything — the
    // SDK session, the `codex app-server` child, the MCP pool lease. Building
    // the object acquires nothing, so the constructor need not wait, but the
    // start does: an evicted harness whose teardown is still in flight is still
    // holding this agent's resources, and its resume id.
    const pending = disposing.get(key);
    if (pending) log.info(`[engine] ${key} waits for the previous harness to finish closing`);
    const ready = Promise.resolve(pending)
      .then(() => {
        // The previous harness's teardown may have taken a while; by now this
        // turn can have been stopped, or the app shut down. Starting a backend
        // for either is pure waste, and for the second it is a resource nobody
        // is left to release.
        if (shuttingDown || active.get(key)?.cancelled) return;
        return harness.start(harnessSession, harnessAgent);
      })
      .finally(() => {
        if (starting.get(key) === ready) starting.delete(key);
      });
    starting.set(key, ready);
    // The rejection is the caller's to report (it becomes the turn's error
    // block); this only keeps an unobserved rejection from escaping when the
    // harness is built for something other than a turn.
    void ready.catch(() => undefined);
    log.info(
      `[engine] harness ${agent.backend}/${harnessAgent.model} for ${key}` +
        `${harnessAgent.resumeSessionId ? ` resuming ${harnessAgent.resumeSessionId}` : ""}`,
    );
    // Built here, from history as it stands *before* this turn's own message is
    // sent, and only when a thread was actually discarded.
    const continuity = captured.notice ? continuityReference(session.id) : undefined;
    return {
      harness,
      ready,
      ...(captured.notice ? { notice: captured.notice } : {}),
      ...(continuity ? { continuity } : {}),
    };
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
  function maybeOpenWidget(turn: ActiveTurn, key: string, patch: BlockPatch): void {
    const widgets = deps.widgets;
    if (!widgets || patch.kind !== "tool_call") return;
    if (patch.status !== "success" && patch.status !== "error") return;
    if (patch.toolUseId === undefined) return;
    // `family` rather than the `mcp__` prefix: Codex names an MCP tool_call
    // after the raw tool (`generate_image`), so a name test skipped every
    // Codex-originated widget and left it loading forever.
    const isMcp = patch.family === "mcp" || patch.name.startsWith("mcp__");
    if (!isMcp) return;
    const toolCallId = patch.toolUseId;
    turn.toolCallKeys.set(toolCallId, key);
    // One widget per tool call, however many times its row is rewritten — and
    // none at all when the harness is resolving its own.
    if (turn.widgetOwner.has(toolCallId)) return;
    turn.widgetOwner.set(toolCallId, "runner");
    const widgetKey = `widget:${toolCallId}`;
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
      // The harness's own `widget` event lands on the very next iteration of
      // the consume loop, i.e. while this await is outstanding. If it claimed
      // the call, its row is already persisted and this slot is now *its*
      // slot: leave both alone.
      if (turn.widgetOwner.get(toolCallId) === "harness") return;
      if (!target?.resourceUri) {
        // No widget after all — drop the slot again so the index it reserved
        // is not left as a hole in the transcript. Safe because nothing has
        // been written to it: the first `writeBlock` is below.
        turn.blocks.delete(widgetKey);
        turn.widgetOwner.delete(toolCallId);
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
      turn.widgetOpening.add(toolCallId);
      const { patch: resolved } = await widgets.open({
        ...call,
        ...target,
        resourceUri: target.resourceUri,
        blockId,
        toolResult,
      });
      writeBlock(turn, widgetKey, resolved);
      markToolCallRendered(turn, toolCallId, resolved);
      log.info(`[engine] widget ${target.serverName}/${target.toolName} for block ${blockId}`);
    })().catch((err: unknown) => {
      if (turn.widgetOwner.get(toolCallId) === "runner") {
        turn.blocks.delete(widgetKey);
        turn.widgetOwner.delete(toolCallId);
      }
      log.warn(`[engine] widget resolution failed for ${patch.name}`, err);
    });
  }

  /**
   * A `widget` block the *harness* emitted (Codex, `api`). It carries the
   * `ui://` URI already, so no detection is needed — but nothing was fetching
   * the document either, which is why a Codex MCP App rendered as a card that
   * span forever with `html: null`. This is the only other caller of
   * `widgets.open()`.
   */
  function resolveHarnessWidget(turn: ActiveTurn, key: string, patch: BlockPatch): void {
    if (patch.kind !== "widget") return;
    const toolCallId = patch.toolCallId;
    turn.widgetOwner.set(toolCallId, "harness");
    // The runner may have resolved this same widget a microtask earlier;
    // writing the harness's `pending` patch over it would put the card back
    // into its loading state for good.
    if (turn.widgetResolved.has(toolCallId) && patch.htmlStatus === "pending") return;
    writeBlock(turn, key, patch);
    const widgets = deps.widgets;
    if (!widgets) return;
    if (patch.htmlStatus !== "pending" || patch.html !== null) return;
    if (turn.widgetOpening.has(toolCallId)) return;
    turn.widgetOpening.add(toolCallId);

    const blockId = turn.blocks.get(key)?.id;
    if (!blockId) return;
    const agentId = store.turns.get(turn.turnId)?.agentId ?? "";
    void (async (): Promise<void> => {
      const { patch: resolved } = await widgets.open({
        sessionId: turn.sessionId,
        agentId,
        blockId,
        toolCallId,
        serverName: patch.serverName,
        toolName: patch.toolName,
        resourceUri: patch.resourceUri,
        toolInput: patch.toolInput,
        toolResult: patch.toolResult ?? null,
        ...(patch.meta !== null && patch.meta !== undefined ? { resultMeta: patch.meta } : {}),
      });
      writeBlock(turn, key, resolved);
      markToolCallRendered(turn, toolCallId, resolved);
    })().catch((err: unknown) => {
      // Never leave the card spinning: say the widget is unavailable and keep
      // the ordinary tool-call card, which is R31's own fallback.
      writeBlock(turn, key, { ...patch, htmlStatus: "unavailable" });
      log.warn(`[engine] widget resolution failed for ${patch.serverName}/${patch.toolName}`, err);
    });
  }

  /**
   * R31: "Non-App tool results keep the tool-call card" — an App result does
   * not, or the same payload renders twice (the collapsible tool row and the
   * widget under it). The flag goes on only once the widget's HTML actually
   * resolved to `ready`, so an unavailable widget still leaves the tool card
   * standing rather than hiding the result altogether.
   */
  function markToolCallRendered(turn: ActiveTurn, toolCallId: string, resolved: BlockPatch): void {
    if (resolved.kind !== "widget") return;
    if (resolved.htmlStatus !== "pending") turn.widgetResolved.add(toolCallId);
    if (resolved.htmlStatus !== "ready") return;
    const toolKey = turn.toolCallKeys.get(toolCallId);
    if (!toolKey) return;
    const slot = turn.blocks.get(toolKey);
    if (!slot) return;
    const existing = store.blocks.get(slot.id);
    if (!existing || existing.kind !== "tool_call" || existing.hasWidget) return;
    // Strip the envelope `writeBlock` re-applies; what is left is the patch.
    const { id, turnId, sessionId, index, createdAt, updatedAt, ...rest } = existing;
    void id, turnId, sessionId, index, createdAt, updatedAt;
    writeBlock(turn, toolKey, { ...rest, hasWidget: true });
  }

  /**
   * One `EngineEvent` → rows and renderer events.
   *
   * `harness` is a parameter rather than `turn.harness` because a delegated
   * sub-agent (SPEC R12) streams *its* events into the parent's turn: its
   * permission and question requests must be answered on the harness that
   * asked, not on the one that owns the turn.
   */
  function handleEvent(
    turn: ActiveTurn,
    event: EngineEvent,
    harness: Harness = turn.harness,
  ): void {
    switch (event.type) {
      case "block": {
        if (event.patch.kind === "widget") {
          resolveHarnessWidget(turn, event.key, event.patch);
          break;
        }
        writeBlock(turn, event.key, event.patch);
        maybeOpenWidget(turn, event.key, event.patch);
        break;
      }
      case "permission": {
        awaiting.set(event.requestId, harness);
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
        awaiting.set(event.requestId, harness);
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
        awaiting.set(event.requestId, harness);
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
            costKnown: usage.costKnown ?? usage.costUsd > 0,
          });
        }
        break;
      }
      case "session": {
        const agentId = store.turns.get(turn.turnId)?.agentId;
        if (agentId && event.backendSessionId) {
          store.settings.setRaw(backendSessionKey(agentId), event.backendSessionId);
          // [7-P1] Tagged with the backend of the harness that **produced** it,
          // taken from the captured configuration rather than re-read from the
          // agent row: the row is mutable and the capture is not, so this
          // cannot record a handle against a backend that never issued it.
          const captured = runtime.get(agentKey(turn.sessionId, agentId));
          if (captured) {
            store.settings.setRaw(backendSessionBackendKey(agentId), captured.backend);
            // …and the tool set that handle was created with. A Codex thread
            // cannot be re-declared, so this is what tells the next launch
            // whether the stored thread still matches the agent's tools.
            store.settings.setRaw(
              backendSessionToolsKey(agentId),
              declaredToolSignature.get(agentKey(turn.sessionId, agentId)) ?? "",
            );
          }
        }
        // A backend that switched model on its own (`/model`, which Claude and
        // Codex both handle themselves and report back here) used to be
        // ignored, so the composer's picker, the agent row and the info drawer
        // all kept showing the model the agent no longer runs on. A delegated
        // sub-agent's `session` event never reaches this branch — it is
        // swallowed in `createDelegateRunner` — so this only ever renames the
        // agent that actually owns the turn.
        if (agentId && event.model) {
          const agent = store.sessions.agent(agentId);
          if (agent && agent.model !== event.model) {
            try {
              store.sessions.updateAgent(agentId, { model: event.model });
              broadcast("agents.updated", {
                sessionId: turn.sessionId,
                agents: store.sessions.agents(turn.sessionId),
              });
              log.info(`[engine] ${agent.mentionName} switched model to ${event.model}`);
            } catch (err) {
              // Never fail a streaming turn over a display detail.
              log.warn(`[engine] could not record the model switch for ${agentId}`, err);
            }
          }
        }
        break;
      }
      case "turn": {
        finishTurn(deps, turn.sessionId, turn.turnId, event.status, event.error);
        break;
      }
    }
  }

  async function consume(turn: ActiveTurn, events: AsyncIterable<EngineEvent>): Promise<void> {
    for await (const event of events) handleEvent(turn, event);
  }

  /** How the row ended, read back once the stream is finished. */
  function statusOf(turnId: string): TurnStatus {
    return store.turns.get(turnId)?.status ?? "error";
  }

  /**
   * Run one turn on its agent's harness and resolve when it has settled.
   *
   * The round-table dispatcher needs the completion, not just the start: a
   * sequential round waits on it, and a chain hop only exists once the turn
   * that mentioned it is done. `send` is the fire-and-forget wrapper the
   * `Engine` contract keeps for callers that do not care.
   */
  async function runTurn(args: EngineSendArgs): Promise<{ status: TurnStatus }> {
    const session = store.sessions.get(args.sessionId);
    if (!session) throw new Error(`unknown session: ${args.sessionId}`);
    const agentId = args.agentId ?? session.leadAgentId;
    const agent = agentId ? store.sessions.agent(agentId) : null;
    if (!agent) {
      errorBlock(deps, session.id, args.turnId, "This session has no agent to answer with.");
      finishTurn(deps, session.id, args.turnId, "error", "no agent");
      return Promise.resolve({ status: "error" as TurnStatus });
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
      return Promise.resolve({ status: "error" as TurnStatus });
    }

    // Anything that goes wrong before the stream exists must still close the
    // turn: a row left `streaming` is a composer that never unlocks.
    let harness: Harness;
    let events: AsyncIterable<EngineEvent>;
    let turn: ActiveTurn;
    try {
      const built = harnessFor(session, agent);
      harness = built.harness;
      turn = {
        sessionId: session.id,
        turnId: args.turnId,
        harness,
        blocks: new Map(),
        widgetOwner: new Map(),
        widgetOpening: new Set(),
        widgetResolved: new Set(),
        toolCallKeys: new Map(),
        starting: true,
        cancelled: false,
      };
      // [7-P1] Reserved **before** the first await. Everything that looks the
      // agent up — a second `chat.send`, a config edit, Stop — reads this map,
      // so a slot taken only after the await left a window in which two turns
      // could both pass the "already running" check.
      active.set(key, turn);
      // A backend conversation that silently restarts looks like lost context,
      // so the reason is written into the transcript before anything else in
      // this turn (the native history is untouched — it keeps its own thread).
      if (built.notice) {
        writeBlock(turn, `notice:tools:${args.turnId}`, {
          kind: "error",
          message: built.notice,
        });
      }
      // …and then the wait. `send()` reads state that only `start()` sets:
      // `ApiHarness` resolves its config and replays history there, and the
      // Claude and Codex harnesses bind their session and agent. Firing the
      // start on a later microtask and sending immediately meant the first
      // turn of every session raced it.
      await built.ready;
      turn.starting = false;
      // Shutdown while this was starting: no send, and no row written — the
      // caller closes the database as soon as `dispose()` resolves.
      if (shuttingDown) {
        active.delete(key);
        return { status: "interrupted" as TurnStatus };
      }
      // Stop can land while a backend is starting. The stream never existed,
      // so there is nothing to interrupt — the turn simply does not send.
      if (turn.cancelled) {
        active.delete(key);
        finishTurn(deps, session.id, args.turnId, "interrupted");
        flushRestart(key);
        return { status: "interrupted" as TurnStatus };
      }
      // Once, on the first send of the replacement thread: the quotation goes
      // ahead of the user's own message, which is passed through unchanged.
      events = harness.send({
        turnId: args.turnId,
        text: built.continuity ? `${built.continuity}\n\n${args.text}` : args.text,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[engine] could not start turn ${args.turnId}`, err);
      active.delete(key);
      // A backend that failed to start is not left in the registry pretending
      // to be usable — and it is disposed rather than orphaned: a partial start
      // may already hold a child process, a pool lease or an open stream, and
      // the replacement must not overlap it.
      const failed = harnesses.get(key);
      harnesses.delete(key);
      runtime.delete(key);
      if (failed) {
        const teardown = failed
          .dispose()
          .catch((disposeErr: unknown) => {
            log.warn(`[engine] disposing ${key} after a failed start`, disposeErr);
          })
          .finally(() => {
            if (disposing.get(key) === teardown) disposing.delete(key);
          });
        disposing.set(key, teardown);
      }
      if (shuttingDown) return { status: "error" as TurnStatus };
      errorBlock(deps, session.id, args.turnId, message);
      finishTurn(deps, session.id, args.turnId, "error", message);
      flushRestart(key);
      return { status: "error" as TurnStatus };
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
        // [7-P1] However this turn ended — done, error or cancel — a config
        // change that arrived while it was running is applied now.
        flushRestart(key);
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
    await running;
    return { status: statusOf(args.turnId) };
  }

  function send(args: EngineSendArgs): void {
    assertWritableSession(args.sessionId);
    void runTurn(args);
  }

  function assertWritableSession(sessionId: string): void {
    const session = store.sessions.get(sessionId);
    if (session?.origin === "import") {
      throw new Error(
        "Imported transcript sessions are read-only. Continue the transcript into a live session before sending a message.",
      );
    }
  }

  /**
   * [B1] The round table (ADR-0002). It owns turn rows, hop counting and the
   * queue; the runner owns harnesses. The two meet at exactly two points:
   * `runTurn` above, and the `api` history watermark below.
   */
  const roundTable: RoundTable = createRoundTable({
    ...deps,
    runTurn: (args) => runTurn(args),
    historyWatermark: (sessionId, agentId) =>
      historyWatermarks.get(agentKey(sessionId, agentId)) ?? null,
  });

  return {
    send,

    dispatch: (args) => {
      // `RoundTable.dispatch` persists the user's turn before it discovers
      // that an imported artifact has no agent. Refuse here so the source
      // transcript remains an immutable reference on every send path.
      assertWritableSession(args.sessionId);
      return roundTable.dispatch(args);
    },

    continueChain: (sessionId) => roundTable.continueChain(sessionId),

    hasPendingChain: (sessionId) => roundTable.hasPending(sessionId),

    /**
     * [7-P1] An agent's model or config changed (`agents.update`). An idle
     * agent's harness goes now; one that is mid-turn is marked and replaced
     * when that turn ends, because a running turn's options must not change
     * underneath it. Either way the *backend resume id* survives, so the next
     * turn continues the same conversation with the new configuration.
     */
    agentConfigChanged(agentId: string) {
      let evicted = false;
      let pending = false;
      for (const key of [...harnesses.keys(), ...active.keys()]) {
        if (key.slice(key.indexOf(":") + 1) !== agentId) continue;
        if (active.has(key)) {
          restartPending.add(key);
          pending = true;
        } else {
          evict(key);
          evicted = true;
        }
      }
      broadcast("agent.runtime", { agentId, restartPending: pending });
      return { evicted, pending };
    },

    /** [7-P1] Three scalars and a flag; never the config object. */
    agentRuntime(agentId: string): AgentRuntimeInfo | null {
      const agent = store.sessions.agent(agentId);
      if (!agent) return null;
      const key = agentKey(agent.sessionId, agentId);
      const captured = runtime.get(key);
      const source = captured ?? effectiveFallback(agent);
      return {
        agentId,
        // The backend of what is **running**, which is the capture's, not the
        // row's: while a restart is pending those two are allowed to differ,
        // and the honest answer is the one the harness was built with.
        backend: source?.backend ?? agent.backend,
        model: source?.model ?? "",
        effort: source ? readEffort(source) : null,
        permissionMode: source?.permissionMode ?? "default",
        restartPending: restartPending.has(key),
        running: captured !== undefined,
      };
    },

    /**
     * [C] SPEC R13. `agentsDescribe.ts` composes; this supplies the one input
     * it could not reach from `apps/desktop/src/ipc/` — the agent's running
     * harness. No harness (never spoken, or the app was relaunched) means no
     * snapshot, and the composer falls back to the agent's config rather than
     * inventing a tool list.
     */
    describeAgent(agentId: string): Promise<AgentDescribe> {
      const agent = store.sessions.agent(agentId);
      if (!agent) return Promise.reject(new Error(`unknown agent: ${agentId}`));
      const harness = harnesses.get(agentKey(agent.sessionId, agent.id));
      return harnessDescribeSnapshot(harness as never, agent).then((snapshot) =>
        describeAgentInfo(
          {
            getAgent: (id) => store.sessions.agent(id) ?? undefined,
            listOtherAgents: (sessionId, selfId) =>
              store.sessions
                .agents(sessionId)
                .filter((a) => a.id !== selfId)
                .map((a) => ({
                  agentId: a.id,
                  mentionName: a.mentionName,
                  backend: a.backend,
                  model: a.model,
                })),
            usageFor: (id) => store.usage.totalsByAgent(id),
            ...(snapshot ? { snapshotFor: () => snapshot } : {}),
          },
          agentId,
        ),
      );
    },

    async interrupt(sessionId) {
      // [B1] Stop is a *session* verb: the queued hops go with the running
      // turns, or the chain would carry on the moment this turn settled.
      roundTable.cancel(sessionId);
      // Every agent of this session, not just one: in round-table mode more
      // than one can be mid-turn and the user asked the *session* to stop.
      const prefix = `${sessionId}:`;
      const turns = [...active].filter(([key]) => key.startsWith(prefix)).map(([, t]) => t);
      // [7-P1] A turn whose backend is still starting has no stream to stop.
      // Marking it is what makes the Stop stick: `runTurn` checks this the
      // moment the start settles and never sends.
      let stoppedStarting = false;
      for (const t of turns) {
        if (!t.starting) continue;
        t.cancelled = true;
        stoppedStarting = true;
      }
      // …and every delegated sub-agent it has in flight (SPEC R12). Without
      // this a cross-backend sub-agent kept running for up to ten minutes
      // after the user believed the session had stopped.
      const children = [...(delegated.get(sessionId) ?? [])];
      if (turns.length === 0 && children.length === 0) return false;
      const results = await Promise.all([
        // A harness that has not been sent to yet typically answers `false`;
        // the cancellation above is the real stop, so it counts as one.
        ...turns.filter((t) => !t.starting).map((t) => t.harness.interrupt()),
        ...children.map((h) => h.interrupt().catch(() => false)),
      ]);
      return stoppedStarting || results.some(Boolean);
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
      // Set before anything is torn down: a start that resolves from here on
      // sends nothing and writes nothing, so no turn can land in a store the
      // caller is about to close.
      shuttingDown = true;
      for (const turn of active.values()) turn.cancelled = true;
      // Pending starts are part of "everything is down": a backend still
      // starting still acquires resources, and its `.finally` has to run before
      // the disposals below can see it.
      await withDeadline(
        Promise.allSettled([...starting.values()]),
        DISPOSE_DEADLINE_MS,
      );
      await withDeadline(
        Promise.allSettled([...harnesses.values()].map((h) => h.dispose())),
        DISPOSE_DEADLINE_MS,
      );
      // Bounded on purpose: a backend that never settles its turn must not be
      // able to hang the app's shutdown (the same rule ClaudeHarness.dispose
      // follows when it refuses to await the SDK's own teardown).
      await withDeadline(Promise.allSettled([...consuming]), DISPOSE_DEADLINE_MS);
      // The chain driver only writes through `runTurn`, which the two waits
      // above have already drained; this is the bounded wait for its own loop
      // to notice and stop rather than for anything it is still writing.
      await withDeadline(roundTable.settled(), DISPOSE_DEADLINE_MS);
      // Evictions started but not finished are part of "everything is down".
      await withDeadline(Promise.allSettled([...disposing.values()]), DISPOSE_DEADLINE_MS);
      harnesses.clear();
      runtime.clear();
      restartPending.clear();
      starting.clear();
      disposing.clear();
      active.clear();
      awaiting.clear();
      consuming.clear();
      historyWatermarks.clear();
      delegated.clear();
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
