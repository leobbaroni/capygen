/**
 * The Codex harness — drives `codex app-server` over JSON-RPC and turns its
 * notification stream into `EngineEvent`s (SPEC R8).
 *
 * Shape decisions, all taken from the Phase 1 spike
 * (`docs/spikes/codex-shapes.md`, raw frames in `docs/spikes/codex.raw.json`)
 * rather than from prose:
 *
 *  - **app-server, not `@openai/codex-sdk`.** The SDK's `codex exec` transport
 *    has no approval callback at all (spike §1) and does not pass `windowsHide`,
 *    so a GUI process flashes a console. app-server has approvals, user input,
 *    interrupt, resume, usage and discovery (spike §5).
 *  - **One process and one thread per agent**, started lazily on the first send
 *    and kept warm across turns — the same reason the Claude harness holds one
 *    streaming `query()` open (SPEC R24: do not re-pay the prefix every turn).
 *  - **`approvalsReviewer: "user"` is passed explicitly.** This machine's
 *    `~/.codex/config.toml` sets `approvals_reviewer = "auto_review"`, which
 *    would route approvals to a review subagent and capygen would never see an
 *    approval card (spike §2).
 *  - **`turn/completed` is the turn boundary**, and `thread/tokenUsage/updated`
 *    carries `last` (this turn) — never `total`, which is the whole thread.
 *  - **Cost is `[assumed]`** (see `./pricing.ts`): app-server reports tokens
 *    only, so an unknown model costs 0 rather than an invented number.
 *
 * Notification → block mapping (the table the rest of Phase 3 codes against):
 *
 * | wire | block |
 * |---|---|
 * | `item/started|completed` `agentMessage` + `item/agentMessage/delta` | `text` (`msg:<itemId>`) |
 * | `reasoning` items + `item/reasoning/{textDelta,summaryTextDelta}` | `thinking` (`think:<itemId>`) |
 * | `commandExecution` items + `item/commandExecution/outputDelta` | `tool_call` family `bash` (`tool:<itemId>`) |
 * | `fileChange` items + `item/fileChange/patchUpdated` | `tool_call` family `edit`/`write` + one `diff` per change |
 * | `mcpToolCall` items | `tool_call` family `mcp` (+ a `widget` block when the result names a `ui://` resource) |
 * | `webSearch` items | `tool_call` family `web` |
 * | `collabAgentToolCall` (`spawnAgent` + friends) | `subagent` (`subagent:<agentThreadId>`), one per `receiverThreadIds` entry |
 * | `subAgentActivity` | updates the same `subagent:<agentThreadId>` block (name from `agentPath`, status from `kind`) |
 * | `error` notification / `turn.error` | `error` + `turn: error` |
 * | `thread/tokenUsage/updated` + `turn/completed` | `usage` event + `usage` block |
 * | `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` | `permission` |
 * | `item/tool/requestUserInput` | `question` |
 * | `mcpServer/elicitation/request` | `elicitation` block + `elicitation` event |
 */
import {
  newId,
  type Backend,
  type PermissionMode,
  type PermissionRequest,
  type Question,
  type SlashCommand,
  type ToolCallFamily,
  type ToolCallStatus,
  type UsageTotals,
} from "@capygen/shared";
import { AsyncQueue } from "../asyncQueue.js";
import { cleanEnv, type EnvRecord } from "../env.js";
import {
  type BlockPatch,
  type EngineEvent,
  type Harness,
  type HarnessAgent,
  type HarnessCapabilities,
  type HarnessSession,
  type PermissionAnswer,
  type TurnContext,
  type TurnInput,
} from "../harness.js";
import {
  CodexAppServerClient,
  type CodexAppServerClientOptions,
  type CodexExitInfo,
  type CodexTransportFactory,
} from "./CodexAppServerClient.js";
import { codexUsageWithCost } from "./pricing.js";
import {
  CODEX_METHODS,
  CODEX_NOTIFICATIONS,
  CODEX_SERVER_REQUESTS,
  type CodexApprovalsReviewer,
  type CodexCollabAgentState,
  type CodexCollabAgentToolCallItem,
  type CodexCommandApprovalDecision,
  type CodexCommandApprovalParams,
  type CodexDeltaNotification,
  type CodexElicitationParams,
  type CodexErrorNotification,
  type CodexFileChange,
  type CodexFileChangeApprovalParams,
  type CodexItem,
  type CodexItemNotification,
  type CodexMcpServerStatus,
  type CodexMcpServerStatusListResponse,
  type CodexModel,
  type CodexModelListResponse,
  type CodexPatchUpdatedNotification,
  type CodexRawItem,
  type CodexSkill,
  type CodexSkillsListResponse,
  type CodexSubAgentActivityItem,
  type CodexThreadStartResponse,
  type CodexTokenUsageBreakdown,
  type CodexTokenUsageNotification,
  type CodexTurnPlanUpdatedNotification,
  type CodexTurnCompletedNotification,
  type CodexTurnStartResponse,
  type CodexDynamicToolCallItem,
  type CodexDynamicToolCallOutputContentItem,
  type CodexDynamicToolCallParams,
  type CodexDynamicToolCallResponse,
  type CodexDynamicToolSpec,
  type CodexUserInput,
  type CodexUserInputParams,
} from "./protocol.js";
import { gateFor, gateDenialMessage } from "../tools/registry.js";
import {
  authorizeLocally,
  jsonSnapshot,
  type LocalAuthorize,
  type PolicyBoundarySupport,
} from "../policy/types.js";
import {
  CatalogueRunner,
  MAX_SCANNED_SERVERS,
  MAX_SCANNED_TOOLS_PER_SERVER,
  type CatalogueOptions,
  type CatalogueServerState,
  type RawCatalogueServer,
  type ToolCatalogue,
} from "../catalogue/types.js";
import { type ToolContext, type ToolDefinition } from "../tools/types.js";

export interface HarnessLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

const NO_LOG: HarnessLogger = { info: () => {}, warn: () => {}, error: () => {} };

export interface CodexHarnessDeps {
  /** Builds the JSON-RPC client. Tests inject one over a fake transport. */
  makeClient?: (options: CodexAppServerClientOptions) => CodexAppServerClient;
  /** Shortcut for the same thing: a transport factory for the default client. */
  transport?: CodexTransportFactory;
  /** Explicit `codex` executable; otherwise resolved (see `./binary.ts`). */
  binaryPath?: string;
  /** Base environment for the child; `cleanEnv` is applied on top. */
  env?: EnvRecord;
  log?: HarnessLogger;
  /** Tool output kept in a block before it is stubbed (SPEC R25). */
  maxToolOutputChars?: number;
  /** How long to wait for `turn/completed` after `turn/interrupt`. */
  interruptGraceMs?: number;
  /** How long a `/compact` waits for the thread to finish compacting. */
  compactGraceMs?: number;
  /** Per-request deadline for ordinary JSON-RPC calls. */
  requestTimeoutMs?: number;
  /**
   * Tools capygen hosts and lends to Codex for this thread (Phase 9
   * prerequisite; ADR-0004's missing `delegate_task` path for the `codex`
   * backend).
   *
   * The shape is the same `ToolDefinition` the `api` backend's registry uses,
   * so `routing/delegate.ts`'s `delegateTaskTool()` can be handed straight in
   * without a second adapter. They are declared **once**, on `thread/start`
   * (`ThreadStartParams.dynamicTools`) — the tool list is part of the request
   * shape the provider caches on (SPEC R24), and the protocol offers no
   * per-turn override anyway.
   *
   * Absent or empty means the thread is started exactly as it is today and
   * every `item/tool/call` is refused, so an agent with no delegation rule
   * pays nothing for this existing.
   */
  dynamicTools?: readonly ToolDefinition[];
  /** Suppress native collaboration tools for Custom Mode (ADR-0006). */
  disableNativeSubagents?: boolean;
  /** capygen's own restrictions (ADR-0007) at the boundaries Codex offers. */
  authorizeLocal?: LocalAuthorize;
  /**
   * The session's own MCP entries, **merged** into what `config.toml` already
   * gives this thread.
   *
   * Passed as `thread/start`'s `config.mcp_servers`, the same table the user's
   * file uses (app-server `ThreadStartParams.config`) — so an override is
   * expressed in Codex's own vocabulary, without capygen writing to the user's
   * file or opening a second MCP client.
   *
   * Additive, not authoritative. Probed against the pinned binary: a thread
   * that passes its own config still sees the home's servers
   * (`hardened-excludes-inherited-mcp`, refuted, `e2e-out/9c-isolation.json`),
   * so omitting a server here does **not** suppress it. Suppression is
   * attempted through the table's own `enabled = false` key instead, which is
   * proven for `config.toml` and unproven for this channel.
   */
  resolvedMcpServers?: () =>
    | Promise<Record<string, Record<string, unknown>> | null>
    | Record<string, Record<string, unknown>>
    | null;
  /**
   * Persist a dynamic tool's **full** output and return an opaque reference the
   * transcript can retrieve it by (SPEC R25).
   *
   * A result over the byte cap is stubbed before it reaches the model, and R25
   * requires the original to remain reachable rather than be dropped. capygen's
   * store lives in the desktop process, so the harness takes it as a callback
   * instead of reaching for one.
   *
   * Returning `null`, or throwing, means "not saved" — the stub then says the
   * output is unavailable. Left unwired (tests, older callers) the stub says
   * the output was not retained. Neither ever claims a reference that does not
   * exist.
   *
   * It is raced against the call's abort signal, so a store that hangs cannot
   * hold the reply open and one that settles after a cancellation is ignored.
   */
  storeDynamicToolOutput?: (info: {
    callId: string;
    /**
     * The block key Codex's own `dynamicToolCall` item owns (`tool:<callId>`).
     * `tool_outputs.block_id` is a foreign key, so a caller that cannot resolve
     * this key to a persisted block must return `null` rather than orphan the
     * row.
     */
    blockKey: string;
    toolName: string;
    output: string;
  }) => Promise<string | null> | string | null;
}

export const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 64 * 1024;
const DEFAULT_INTERRUPT_GRACE_MS = 5_000;
const DEFAULT_COMPACT_GRACE_MS = 60_000;
/** How long an approval waits for this turn to learn its own Codex turn id. */
const TURN_CORRELATION_TIMEOUT_MS = 10_000;
/** How long `dispose()` waits for aborted dynamic-tool calls to answer. */
const DYNAMIC_CALL_DRAIN_MS = 1_000;
/** SPEC R25's ceiling on a dynamic-tool result, in UTF-8 bytes. */
const DYNAMIC_RESULT_MAX_BYTES = 64 * 1024;
/** A refusal is one sentence; the cap only exists so nothing can grow one. */
const DYNAMIC_FAILURE_MAX_BYTES = 1_024;
/** `turn/start` answers as soon as the turn is accepted, not when it finishes. */
const TURN_START_TIMEOUT_MS = 120_000;
/** Discovery must never hold a turn: it is decoration on the slash menu. */
const DISCOVERY_TIMEOUT_MS = 15_000;

/** SPEC §Edge Cases: the "needs sign-in" card keys on this. */
export const CODEX_UNAUTHORIZED = "unauthorized";

/**
 * Built-ins capygen implements itself for Codex. Slash commands are **not** a
 * protocol concept (spike §2 "Slash commands are not a protocol concept"), so
 * each of these maps onto a real method; anything else is sent as prompt text.
 */
export const CODEX_BUILTIN_COMMANDS: SlashCommand[] = [
  {
    name: "/compact",
    description: "Summarise the thread so far to free context (thread/compact/start)",
    source: "builtin",
  },
  {
    name: "/review",
    description: "Review the uncommitted changes, or custom instructions (review/start)",
    source: "builtin",
    argumentHint: "[what to review]",
  },
  {
    name: "/model",
    description: "Show or switch this agent's Codex model (thread/settings/update)",
    source: "builtin",
    argumentHint: "[model id]",
  },
  { name: "/status", description: "Thread, model, sandbox and token usage", source: "builtin" },
  { name: "/clear", description: "Start a fresh Codex thread (thread/start)", source: "builtin" },
];

interface ActiveTurn {
  /** capygen's turn row id. */
  turnId: string;
  /** Codex's own turn id, once `turn/start` (or `review/start`) answers. */
  codexTurnId: string | null;
  out: AsyncQueue<EngineEvent>;
  /** Accumulated text per block key, so a delta only needs the tail. */
  text: Map<string, string>;
  /** itemId → the last item seen, so a delta can re-upsert the whole block. */
  items: Map<string, CodexItem>;
  /** itemId → streamed command output, which the item itself lacks mid-run. */
  streamed: Map<string, string>;
  /** Sub-agent blocks by their own thread id, keyed for later status updates
   *  from a later `collabAgentToolCall`/`subAgentActivity` item (Claude's
   *  `ActiveTurn.subagents` equivalent, keyed by thread rather than tool_use
   *  id because that is the identifier every Codex item referencing a
   *  sub-agent shares). */
  subagents: Map<string, { name: string; description: string; model: string | null }>;
  /**
   * `callId` → the dynamic-tool call it named, for the turn it named.
   *
   * Codex mints one `callId` per model tool call, so a second frame carrying a
   * `callId` this turn has already seen is a retransmission, not a second call.
   * Re-running it would spend another sub-agent's tokens for one model
   * decision, so the entry survives the call completing: `running` refuses the
   * duplicate while the first is in flight, `settled` refuses it afterwards.
   * The map dies with the turn, which is the only scope a `callId` has.
   */
  dynamicCalls: Map<
    string,
    { state: "running" | "settled"; abort: AbortController; done: Promise<void> }
  >;
  /**
   * `callId` → the `tool_outputs` reference its full result was stored under.
   *
   * Written when the call is answered, read when Codex's own
   * `dynamicToolCall` item completes — that item, not a block of the harness's
   * own, is where R25's `outputRef` belongs.
   */
  dynamicRefs: Map<string, string>;
  /**
   * Aborted when this turn ends, however it ends. A local authorization waiting
   * on a card belongs to the turn it was admitted in, and must be released the
   * moment that turn is interrupted, completed or disposed.
   */
  cancel: AbortController;
  /**
   * Resolves once Codex's own turn id is known, so an approval that arrives in
   * the window before `turn/start` answers can be *correlated* rather than
   * admitted on trust.
   */
  turnIdKnown: Promise<void>;
  markTurnIdKnown: () => void;
  /** `last` from the most recent `thread/tokenUsage/updated` for this turn. */
  usage: CodexTokenUsageBreakdown | null;
  /** Fatal `error` notification text, used when `turn/completed` says failed. */
  fatal: string | null;
  settled: boolean;
  interrupted: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Everything an outstanding server request needs to be *cancelled* rather than
 * merely dropped: the block key so the card can be told the request died, a
 * `cancelPatch` that writes that terminal state, and the resolver that lets the
 * app-server's own JSON-RPC request finally get an answer. Before this, a turn
 * that completed with an approval still open left the promise unresolved
 * forever — the card stayed pending, `SessionRunner` forgot the request id, and
 * codex app-server waited on a reply that could no longer come.
 */
type PendingBase = { key: string; cancelPatch: (why: string) => BlockPatch };
type PendingPermission = PendingBase & {
  kind: "permission";
  resolve: (a: PermissionAnswer) => void;
};
type PendingQuestion = PendingBase & {
  kind: "question";
  resolve: (a: Record<string, string>) => void;
};
type PendingElicitation = PendingBase & {
  kind: "elicitation";
  resolve: (a: Record<string, unknown> | null) => void;
};
type PendingAnswer = PendingPermission | PendingQuestion | PendingElicitation;

export class CodexHarness implements Harness {
  readonly backend: Backend = "codex";

  private readonly deps: CodexHarnessDeps;
  private readonly log: HarnessLogger;

  private session: HarnessSession | null = null;
  private agent: HarnessAgent | null = null;

  private client: CodexAppServerClient | null = null;
  private ready: Promise<void> | null = null;
  private unsubscribe: (() => void) | null = null;

  private threadId: string | null = null;
  private resolvedModel: string | null = null;
  private contextWindow: number | null = null;
  private threadUsage: CodexTokenUsageBreakdown | null = null;
  private approvalPolicy = "on-request";
  /**
   * The reviewer the app-server actually kept. capygen always asks for `user`,
   * but a thread may come back reviewed by `auto_review` or a guardian
   * subagent — in which case no approval ever reaches this client and an
   * approval-category restriction could not be enforced.
   */
  private approvalsReviewer = "user";
  private sandbox = "workspace-write";
  /**
   * Whether the *current* thread was actually started with capygen's tools.
   *
   * Not the same question as "were any configured": a `thread/start` that was
   * refused must not leave the harness believing it owns tools the thread never
   * heard of. A *resumed* thread does keep the set it was started with (proven
   * against the pinned binary, see `startThread`), so this stays true there.
   */
  private dynamicToolsDeclared = false;
  /** name → definition, built once per thread from what was actually declared. */
  private dynamicToolsByName = new Map<string, ToolDefinition>();

  private active: ActiveTurn | null = null;
  private readonly pending = new Map<string, PendingAnswer>();
  /** questionRequestId → question text → Codex's own question id. */
  private readonly questionIds = new Map<string, Map<string, string>>();
  /**
   * Approval replies still being decided. Like an in-flight dynamic tool call,
   * one must get its answer onto the wire before shutdown closes the transport,
   * or the app-server is left blocked on a reply that can no longer be written.
   */
  private readonly outstandingApprovals = new Set<Promise<unknown>>();

  private commands: SlashCommand[] = [...CODEX_BUILTIN_COMMANDS];
  private readonly catalogueRunner = new CatalogueRunner({
    // The thread is the runtime identity here: a `/clear`, a restart or a
    // fresh thread while a listing is in flight makes that listing stale.
    initialize: () => this.ensureThread(),
    lifecycle: () => this.threadId,
    fetch: () => this.fetchCatalogue(),
    onFailure: (code) => this.log.warn(`[codex] the MCP catalogue is unavailable (${code})`),
  });
  private skills: CodexSkill[] = [];
  private disposed = false;

  constructor(deps: CodexHarnessDeps = {}) {
    this.deps = deps;
    this.log = deps.log ?? NO_LOG;
  }

  async start(session: HarnessSession, agent: HarnessAgent): Promise<void> {
    this.session = session;
    this.agent = agent;
    this.threadId = agent.resumeSessionId ?? null;
  }

  capabilities(): HarnessCapabilities {
    return {
      streamingDeltas: true,
      permissions: true,
      questions: true,
      // Phase 4: `collabAgentToolCall` (`spawnAgent`) / `subAgentActivity`
      // items are now mapped to `subagent` blocks (`emitCollabAgentToolCall`,
      // `emitSubAgentActivity`), so this is no longer aspirational.
      subagents: true,
      resume: true,
      interrupt: true,
      slashCommands: true,
    };
  }

  listCommands(): SlashCommand[] {
    return this.commands;
  }

  backendSessionId(): string | null {
    return this.threadId;
  }

  /** The model `thread/start` actually chose (config, then Codex's default). */
  model(): string | null {
    return this.resolvedModel;
  }

  // -------------------------------------------------------------------------
  // sending a turn
  // -------------------------------------------------------------------------

  send(input: TurnInput, ctx: TurnContext = {}): AsyncIterable<EngineEvent> {
    const out = new AsyncQueue<EngineEvent>();
    if (this.disposed) {
      out.push({ type: "turn", status: "error", error: "harness disposed" });
      out.close();
      return out;
    }
    if (this.active && !this.active.settled) {
      out.push({
        type: "turn",
        status: "error",
        error: "this agent is already running a turn",
      });
      out.close();
      return out;
    }

    const turn: ActiveTurn = {
      turnId: input.turnId,
      codexTurnId: null,
      out,
      text: new Map(),
      items: new Map(),
      streamed: new Map(),
      subagents: new Map(),
      dynamicCalls: new Map(),
      dynamicRefs: new Map(),
      cancel: new AbortController(),
      turnIdKnown: undefined as unknown as Promise<void>,
      markTurnIdKnown: () => {},
      usage: null,
      fatal: null,
      settled: false,
      interrupted: false,
      timer: null,
    };
    // The deferred is armed before anything can await it.
    turn.turnIdKnown = new Promise<void>((resolve) => {
      turn.markTurnIdKnown = resolve;
    });
    this.active = turn;

    if (ctx.signal) {
      const onAbort = (): void => void this.interrupt();
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener("abort", onAbort, { once: true });
    }

    void this.dispatch(turn, input.text).catch((err: unknown) => {
      const message = describe(err);
      this.emitBlock(`error:${turn.turnId}`, { kind: "error", message });
      this.settle(turn, "error", message);
    });

    return out;
  }

  private async dispatch(turn: ActiveTurn, text: string): Promise<void> {
    await this.ensureThread();
    const threadId = this.threadId;
    if (!threadId) throw new Error("codex thread was not started");

    const trimmed = text.trim();
    if (trimmed.startsWith("/")) {
      const handled = await this.runBuiltin(turn, threadId, trimmed);
      if (handled) return;
    }

    const started = await this.client!.request<CodexTurnStartResponse>(
      CODEX_METHODS.turnStart,
      {
        threadId,
        input: this.turnInput(trimmed || text),
        ...(this.effort() ? { effort: this.effort() } : {}),
      },
      TURN_START_TIMEOUT_MS,
    );
    turn.codexTurnId = started?.turn?.id ?? null;
    turn.markTurnIdKnown();
  }

  /**
   * A leading `/name` that matches a skill from `skills/list` becomes a
   * `{type:"skill"}` input part — that is how the TUI's `/skill` maps onto the
   * protocol (spike §2) — and anything else is sent verbatim as text.
   */
  private turnInput(text: string): CodexUserInput[] {
    const match = /^\/([^\s]+)\s*([\s\S]*)$/.exec(text);
    const skill = match ? this.skills.find((s) => s.name === match[1]) : undefined;
    if (!match || !skill) {
      return [{ type: "text", text, text_elements: [] }];
    }
    const rest = (match[2] ?? "").trim();
    const parts: CodexUserInput[] = [{ type: "skill", name: skill.name, path: skill.path }];
    if (rest) parts.push({ type: "text", text: rest, text_elements: [] });
    return parts;
  }

  /** True when the text was a capygen built-in and no `turn/start` is needed. */
  private async runBuiltin(turn: ActiveTurn, threadId: string, text: string): Promise<boolean> {
    const [word = "", ...rest] = text.split(/\s+/);
    const argument = text.slice(word.length).trim();
    switch (word) {
      case "/compact": {
        await this.client!.request(CODEX_METHODS.threadCompactStart, { threadId });
        this.emitBlock(`text:${turn.turnId}`, {
          kind: "text",
          text: "Compacting the Codex thread…",
        });
        // Compaction runs as a turn on the thread, so the ordinary
        // `turn/completed` path settles it; the timer is the safety net for a
        // build that compacts without announcing a turn.
        this.armFallback(turn, this.deps.compactGraceMs ?? DEFAULT_COMPACT_GRACE_MS, "done");
        return true;
      }
      case "/review": {
        const target = argument
          ? { type: "custom", instructions: argument }
          : { type: "uncommittedChanges" };
        const started = await this.client!.request<{ turn?: { id?: string } }>(
          CODEX_METHODS.reviewStart,
          { threadId, target },
          TURN_START_TIMEOUT_MS,
        );
        turn.codexTurnId = started?.turn?.id ?? null;
        turn.markTurnIdKnown();
        return true;
      }
      case "/model": {
        if (!argument) {
          const models = await this.listModels().catch(() => [] as CodexModel[]);
          const list = models
            .filter((m) => !m.hidden)
            .map((m) => `  ${m.id}${m.id === this.resolvedModel ? "  (current)" : ""}`)
            .join("\n");
          this.emitBlock(`text:${turn.turnId}`, {
            kind: "text",
            text: `Model: ${this.resolvedModel ?? "unknown"}\n${list || "  (model/list unavailable)"}`,
          });
        } else {
          await this.client!.request(CODEX_METHODS.threadSettingsUpdate, {
            threadId,
            model: argument,
          });
          this.resolvedModel = argument;
          this.emitBlock(`text:${turn.turnId}`, {
            kind: "text",
            text: `Model set to ${argument} for this thread.`,
          });
          this.emitSession();
        }
        this.settle(turn, "done");
        return true;
      }
      case "/status": {
        this.emitBlock(`text:${turn.turnId}`, { kind: "text", text: this.statusText() });
        this.settle(turn, "done");
        return true;
      }
      case "/clear": {
        this.threadId = null;
        this.threadUsage = null;
        await this.startThread();
        this.emitBlock(`text:${turn.turnId}`, {
          kind: "text",
          text: `Started a fresh Codex thread (${this.threadId ?? "?"}).`,
        });
        this.settle(turn, "done");
        return true;
      }
      default:
        // `rest` is only destructured to keep the split honest about arguments.
        void rest;
        return false;
    }
  }

  private statusText(): string {
    const usage = this.threadUsage;
    const lines = [
      `thread   ${this.threadId ?? "-"}`,
      `model    ${this.resolvedModel ?? "-"}`,
      `cwd      ${this.session?.projectPath ?? "-"}`,
      `approval ${this.approvalPolicy}   sandbox ${this.sandbox}`,
    ];
    if (usage) {
      const total = usage.totalTokens ?? 0;
      const window = this.contextWindow;
      lines.push(
        `tokens   ${total} used${window ? ` of ${window} (${Math.round((total / window) * 100)}%)` : ""}`,
      );
    }
    return lines.join("\n");
  }

  // -------------------------------------------------------------------------
  // process + thread lifecycle
  // -------------------------------------------------------------------------

  private async ensureThread(): Promise<void> {
    if (this.client?.running && this.threadId) return;
    this.ready ??= this.doEnsureThread().catch((err: unknown) => {
      this.ready = null;
      throw err;
    });
    await this.ready;
  }

  private async doEnsureThread(): Promise<void> {
    const session = this.session;
    const agent = this.agent;
    if (!session || !agent) throw new Error("CodexHarness.start() was never called");

    if (!this.client?.running) {
      this.unsubscribe?.();
      const options: CodexAppServerClientOptions = {
        ...(this.deps.transport ? { transport: this.deps.transport } : {}),
        ...(this.deps.binaryPath ? { binaryPath: this.deps.binaryPath } : {}),
        ...(this.deps.env ? { spawnEnv: this.deps.env } : {}),
        ...(this.deps.requestTimeoutMs ? { requestTimeoutMs: this.deps.requestTimeoutMs } : {}),
        log: this.log,
        onExit: (info) => this.onServerExit(info),
      };
      this.client = (this.deps.makeClient ?? ((o) => new CodexAppServerClient(o)))(options);
      this.client.serverRequestHandler = (method, params) => this.onServerRequest(method, params);
      this.unsubscribe = this.client.onNotification((m, p) => this.onNotification(m, p));
      await this.client.start();
    }
    await this.startThread();
    await this.refreshCommands();
    this.emitSession();
  }

  /** `thread/resume` when a thread id survived a restart, else `thread/start`. */
  private async startThread(): Promise<void> {
    const session = this.session!;
    const agent = this.agent!;
    const config = readCodexConfig(agent.config);
    const model = config.model ?? agent.model;
    const approvalPolicy = config.approvalPolicy ?? "on-request";
    const sandbox = config.sandbox ?? "workspace-write";
    const reviewer: CodexApprovalsReviewer = "user";
    // Resolved before the params object so the thread is started with it: a
    // server table that moved after the thread began would not apply to it.
    let mcpOverride: Record<string, Record<string, unknown>> | null = null;
    try {
      mcpOverride = (await this.deps.resolvedMcpServers?.()) ?? null;
    } catch (err) {
      // Fails closed: starting the thread anyway would silently run it without
      // the session's own entries, and without whatever disable it asked for.
      this.log.warn("[codex] the session MCP server list could not be resolved");
      throw new Error("The session MCP server list could not be resolved.");
    }
    const base = {
      cwd: session.projectPath,
      approvalPolicy,
      sandbox,
      // Explicit, because the user's own config.toml may say `auto_review`,
      // which would hide every approval card from capygen (spike §2).
      approvalsReviewer: reviewer,
      ...(model ? { model } : {}),
      // [B1] The round table's session-stable prompt addition (ADR-0002,
      // SPEC R23/R24). `developerInstructions` is a `thread/start` /
      // `thread/resume` parameter (app-server schema v0.153.4
      // `ThreadStartParams`), i.e. set once for the thread — nothing per-turn
      // may go in it, or every turn would re-write the thread's prefix.
      ...(agent.promptAddition ? { developerInstructions: agent.promptAddition } : {}),
      // Merged into the thread's own table. `mcp_servers` is the file's own
      // key, so this reads exactly the way the user's `config.toml` does.
      ...(mcpOverride || this.deps.disableNativeSubagents ? {
        config: {
          ...(mcpOverride ? { mcp_servers: mcpOverride } : {}),
          // Both keys are stable features in pinned Codex 0.153.4. Override
          // explicitly on start AND resume, including inherited true values.
          ...(this.deps.disableNativeSubagents
            ? { features: { multi_agent: false, multi_agent_v2: false } }
            : {}),
        },
      } : {}),
    };

    const tools = this.validatedDynamicTools();
    const declared = this.dynamicToolSpecs(tools);

    if (this.threadId) {
      try {
        const resumed = await this.client!.request<CodexThreadStartResponse>(
          CODEX_METHODS.threadResume,
          { threadId: this.threadId, ...base, excludeTurns: true },
        );
        // `ThreadResumeParams` has no `dynamicTools` field (schema v0.153.4),
        // so a resume can neither declare nor change a tool set — but it does
        // not lose one either. `scripts/probe-codex-dynamic-tools.ts` proves
        // against the pinned binary that the set declared at `thread/start` is
        // persisted in the rollout and restored on resume, and that a *fresh
        // app-server process* still routes `item/tool/call` back to the client
        // for it. So the executors stay registered here: switching them off
        // would refuse a call the thread is entitled to make.
        //
        // What is genuinely lost is the ability to *change* the set. If this
        // agent's configured tools differ from the ones its thread was started
        // with, the thread keeps the old ones and a call for a name capygen no
        // longer hosts is refused as `unknown_tool`.
        this.setDynamicTools(tools.length > 0, tools);
        if (declared.length > 0) {
          this.log.info(
            `[codex] resumed thread ${this.threadId}: its dynamic tool set is whatever ` +
              "thread/start declared and cannot be changed on resume " +
              "(ThreadResumeParams has no dynamicTools field)",
          );
        }
        this.applyThreadResponse(resumed, approvalPolicy, sandbox);
        return;
      } catch (err) {
        // Never swallow: the user gets the backend's own words, and the session
        // continues on a fresh thread rather than refusing to talk at all.
        const message = describe(err);
        this.log.warn(`[codex] thread/resume ${this.threadId} failed: ${message}`);
        this.emitBlock(`error:resume:${this.threadId}`, {
          kind: "error",
          message: "Could not resume the previous Codex thread; started a new one.",
          detail: message,
        });
        this.threadId = null;
      }
    }

    const started = await this.client!.request<CodexThreadStartResponse>(
      CODEX_METHODS.threadStart,
      declared.length > 0 ? { ...base, dynamicTools: declared } : base,
    );
    // Only after `thread/start` resolved: a rejected start (an app-server that
    // does not know the field, an auth failure) must not leave the harness
    // believing it owns tools the thread never heard of.
    this.setDynamicTools(declared.length > 0, tools);
    this.applyThreadResponse(started, approvalPolicy, sandbox);
  }

  /**
   * The one validated tool set, and the only source for both the specs Codex is
   * sent and the executors a call resolves against.
   *
   * [review] These used to be derived separately — the spec list kept the
   * *first* definition of a duplicated name and the executor map kept the
   * *last*. Codex would then have been advertised one tool's JSON Schema and
   * capygen would have run a different tool's code against arguments validated
   * for the other one. Deduplicating once, here, is what makes that
   * unrepresentable rather than merely unlikely.
   */
  private validatedDynamicTools(): ToolDefinition[] {
    const kept: ToolDefinition[] = [];
    const seen = new Set<string>();
    for (const tool of this.deps.dynamicTools ?? []) {
      const name = typeof tool?.name === "string" ? tool.name : "";
      if (!name || typeof tool.run !== "function") {
        this.log.warn("[codex] a dynamic tool without a name or a runner was ignored");
        continue;
      }
      if (seen.has(name)) {
        this.log.warn(`[codex] duplicate dynamic tool ${safeLabel(name)} ignored (first wins)`);
        continue;
      }
      seen.add(name);
      kept.push(tool);
    }
    return kept;
  }

  /** `thread/start`'s `dynamicTools`, derived from the validated set. */
  private dynamicToolSpecs(tools: readonly ToolDefinition[]): CodexDynamicToolSpec[] {
    return tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
    }));
  }

  private setDynamicTools(declared: boolean, tools: readonly ToolDefinition[]): void {
    this.dynamicToolsDeclared = declared;
    this.dynamicToolsByName = new Map(declared ? tools.map((tool) => [tool.name, tool]) : []);
  }

  /**
   * Whether this thread can serve an `item/tool/call` for one of capygen's
   * tools: true once a `thread/start` declared them, and true on a resumed
   * thread, which keeps the set it was started with. False when `thread/start`
   * was refused or nothing is configured.
   *
   * It does **not** promise the live set matches this agent's configuration: a
   * resume cannot change a thread's tools, so a name added since that thread
   * started is refused as `unknown_tool`.
   */
  dynamicToolsActive(): boolean {
    return this.dynamicToolsDeclared && this.dynamicToolsByName.size > 0;
  }

  private applyThreadResponse(
    response: CodexThreadStartResponse,
    approvalPolicy: string,
    sandbox: string,
  ): void {
    this.threadId = response?.thread?.id ?? null;
    this.resolvedModel = response?.model ?? response?.thread?.model ?? this.agent?.model ?? null;
    this.approvalPolicy =
      typeof response?.approvalPolicy === "string" ? response.approvalPolicy : approvalPolicy;
    this.sandbox = sandbox;
    this.approvalsReviewer =
      typeof response?.approvalsReviewer === "string" ? response.approvalsReviewer : "user";
    if (response?.approvalsReviewer && response.approvalsReviewer !== "user") {
      // Worth a loud line: approvals would be answered by Codex's own reviewer
      // and capygen's permission cards would never appear.
      this.log.warn(
        `[codex] app-server kept approvalsReviewer=${response.approvalsReviewer}; approval cards may not reach capygen`,
      );
    }
    this.log.info(
      `[codex] thread ${this.threadId ?? "?"} model=${this.resolvedModel ?? "?"} ` +
        `approval=${this.approvalPolicy} sandbox=${this.sandbox}`,
    );
  }

  /** `skills/list` → the slash menu, on top of capygen's own built-ins (R14). */
  private async refreshCommands(): Promise<void> {
    try {
      const response = await this.client!.request<CodexSkillsListResponse>(
        CODEX_METHODS.skillsList,
        { cwds: this.session ? [this.session.projectPath] : [] },
        DISCOVERY_TIMEOUT_MS,
      );
      const skills: CodexSkill[] = [];
      for (const entry of response?.data ?? []) {
        for (const skill of entry?.skills ?? []) {
          if (skill?.name && skill.enabled !== false) skills.push(skill);
        }
      }
      this.skills = skills;
      this.commands = [
        ...CODEX_BUILTIN_COMMANDS,
        ...skills.map((skill) => ({
          name: `/${skill.name}`,
          description: firstLine(skill.shortDescription ?? skill.description ?? ""),
          source: "skill" as const,
        })),
      ];
    } catch (err) {
      // The menu keeps its built-ins; a missing skill list is not a turn error.
      this.log.warn(`[codex] skills/list failed: ${describe(err)}`);
    }
  }

  private emitSession(): void {
    this.emit({
      type: "session",
      backendSessionId: this.threadId ?? "",
      ...(this.resolvedModel ? { model: this.resolvedModel } : {}),
      commands: this.commands,
    });
  }

  private onServerExit(info: CodexExitInfo): void {
    this.ready = null;
    const turn = this.active;
    const detail = this.client?.recentStderr() ?? "";
    const message = `codex app-server exited (code ${info.code ?? "null"}${
      info.signal ? `, ${String(info.signal)}` : ""
    })`;
    // A child that exits *because capygen closed it* is not an error; only an
    // exit nobody asked for is worth an error line in the app log.
    if (this.disposed) {
      this.log.info(`[codex] ${message} after dispose`);
      return;
    }
    this.log.error(`[codex] ${message}`);
    this.cancelPending("the backend exited");
    if (turn && !turn.settled) {
      if (turn.interrupted) {
        this.settle(turn, "interrupted");
        return;
      }
      this.emitBlock(`error:${turn.turnId}`, {
        kind: "error",
        message,
        ...(detail ? { detail } : {}),
      });
      this.settle(turn, "error", message);
    }
  }

  // -------------------------------------------------------------------------
  // notifications → blocks
  // -------------------------------------------------------------------------

  private onNotification(method: string, rawParams: unknown): void {
    const params = isRecord(rawParams) ? rawParams : {};
    const threadId = str(params.threadId);
    // Every turn-scoped notification names its thread; a frame for another
    // thread (a detached review, another agent's) is not this harness's.
    if (threadId && this.threadId && threadId !== this.threadId) return;

    switch (method) {
      case CODEX_NOTIFICATIONS.turnStarted: {
        const turn = this.active;
        const id = str((params.turn as { id?: unknown } | undefined)?.id);
        if (turn && !turn.codexTurnId && id) {
          turn.codexTurnId = id;
          turn.markTurnIdKnown();
        }
        return;
      }
      case CODEX_NOTIFICATIONS.itemStarted:
      case CODEX_NOTIFICATIONS.itemCompleted: {
        const notification = params as unknown as CodexItemNotification;
        if (notification.item) this.routeItem(notification.item);
        return;
      }
      case CODEX_NOTIFICATIONS.agentMessageDelta: {
        const { itemId, delta } = params as unknown as CodexDeltaNotification;
        if (itemId) this.appendText(`msg:${itemId}`, delta ?? "", "text");
        return;
      }
      case CODEX_NOTIFICATIONS.reasoningTextDelta:
      case CODEX_NOTIFICATIONS.reasoningSummaryTextDelta: {
        const { itemId, delta } = params as unknown as CodexDeltaNotification;
        if (itemId) this.appendText(`think:${itemId}`, delta ?? "", "thinking");
        return;
      }
      case CODEX_NOTIFICATIONS.commandExecutionOutputDelta: {
        const { itemId, delta } = params as unknown as CodexDeltaNotification;
        const turn = this.active;
        if (!turn || !itemId) return;
        turn.streamed.set(itemId, (turn.streamed.get(itemId) ?? "") + (delta ?? ""));
        const item = turn.items.get(itemId);
        if (item && item.type === "commandExecution") this.emitCommand(item);
        return;
      }
      case CODEX_NOTIFICATIONS.fileChangePatchUpdated: {
        const { itemId, changes } = params as unknown as CodexPatchUpdatedNotification;
        const turn = this.active;
        const item = turn?.items.get(itemId);
        if (!turn || !item || item.type !== "fileChange") return;
        const next: CodexItem = { ...item, changes: changes ?? [] };
        turn.items.set(itemId, next);
        this.emitFileChange(next);
        return;
      }
      case CODEX_NOTIFICATIONS.turnPlanUpdated: {
        this.onTurnPlanUpdated(params);
        return;
      }
      case CODEX_NOTIFICATIONS.threadTokenUsageUpdated: {
        const { tokenUsage } = params as unknown as CodexTokenUsageNotification;
        if (!tokenUsage) return;
        this.threadUsage = tokenUsage.total ?? this.threadUsage;
        this.contextWindow = tokenUsage.modelContextWindow ?? this.contextWindow;
        if (this.active) this.active.usage = tokenUsage.last ?? this.active.usage;
        return;
      }
      case CODEX_NOTIFICATIONS.error: {
        const notification = params as unknown as CodexErrorNotification;
        const turn = this.active;
        const message = notification.error?.message ?? "Codex reported an error";
        const unauthorized = notification.error?.codexErrorInfo === CODEX_UNAUTHORIZED;
        this.emitBlock(`error:${notification.turnId ?? turn?.turnId ?? "thread"}`, {
          kind: "error",
          message: unauthorized
            ? "Codex is not signed in. Run `codex login` in a terminal, then retry."
            : message,
          ...(unauthorized ? { detail: message } : {}),
        });
        // A retryable error is a hiccup Codex handles itself; only a final one
        // decides the turn.
        if (turn && notification.willRetry === false) turn.fatal = message;
        return;
      }
      case CODEX_NOTIFICATIONS.warning: {
        this.log.warn(`[codex] ${str(params.message) ?? "warning"}`);
        return;
      }
      case CODEX_NOTIFICATIONS.turnCompleted: {
        this.onTurnCompleted(params as unknown as CodexTurnCompletedNotification);
        return;
      }
      default:
        return;
    }
  }

  private onTurnPlanUpdated(rawParams: unknown): void {
    const turn = this.active;
    if (!turn || turn.settled || !isRecord(rawParams)) return;
    const params = rawParams as Partial<CodexTurnPlanUpdatedNotification>;
    if (params.threadId !== this.threadId || params.turnId !== turn.codexTurnId) return;

    if (typeof params.explanation !== "string" && params.explanation !== null) {
      this.log.warn("[codex] ignored malformed plan update");
      return;
    }
    if (!Array.isArray(params.plan) || params.plan.length > 200) {
      this.log.warn("[codex] ignored oversized or malformed plan update");
      return;
    }
    const plan = [] as { step: string; status: "pending" | "inProgress" | "completed" }[];
    for (const rawStep of params.plan) {
      if (!isRecord(rawStep)) {
        this.log.warn("[codex] ignored malformed plan update");
        return;
      }
      const step = rawStep.step;
      const status = rawStep.status;
      if (
        typeof step !== "string" ||
        (status !== "pending" && status !== "inProgress" && status !== "completed")
      ) {
        this.log.warn("[codex] ignored malformed plan update");
        return;
      }
      plan.push({ step, status });
    }

    const input = { explanation: params.explanation ?? null, plan };
    if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 64 * 1024) {
      this.log.warn("[codex] ignored oversized plan update");
      return;
    }
    const key = `plan:${turn.turnId}`;
    this.emitBlock(key, {
      kind: "tool_call",
      name: "update_plan",
      family: "other",
      input,
      output: null,
      status: "success",
      toolUseId: key,
    });
  }

  private routeItem(item: CodexItem): void {
    const turn = this.active;
    if (!turn || turn.settled) return;
    turn.items.set(item.id, item);
    switch (item.type) {
      case "userMessage":
        // capygen already has the user's turn row; echoing it would duplicate it.
        return;
      case "agentMessage": {
        const text = item.text ?? "";
        const key = `msg:${item.id}`;
        // `item/started` carries an empty text; keep whatever the deltas built
        // rather than blanking the block back out. An item that is *still*
        // empty raises no block at all: an empty text card is not something R6
        // asks anyone to render.
        const current = turn.text.get(key) ?? "";
        const next = text.length >= current.length ? text : current;
        turn.text.set(key, next);
        if (next.length > 0) this.emitBlock(key, { kind: "text", text: next });
        return;
      }
      case "reasoning": {
        const text = [...(item.summary ?? []), ...(item.content ?? [])]
          .filter((part) => typeof part === "string" && part.length > 0)
          .join("\n\n");
        const key = `think:${item.id}`;
        const current = turn.text.get(key) ?? "";
        const next = text.length >= current.length ? text : current;
        turn.text.set(key, next);
        // Same rule as `agentMessage`, and it matters more here: the live run
        // showed a reasoning item whose summary never arrives, which would
        // otherwise leave an empty collapsed "thinking" card in the transcript.
        if (next.length > 0) this.emitBlock(key, { kind: "thinking", text: next });
        return;
      }
      case "commandExecution":
        this.emitCommand(item);
        return;
      case "fileChange":
        this.emitFileChange(item);
        return;
      case "dynamicToolCall":
        this.emitDynamicToolCall(item);
        return;
      case "mcpToolCall":
        this.emitMcpToolCall(item);
        return;
      case "webSearch":
        this.emitWebSearch(item);
        return;
      case "collabAgentToolCall":
        this.emitCollabAgentToolCall(item);
        return;
      case "subAgentActivity":
        this.emitSubAgentActivity(item);
        return;
      default:
        // Unreachable for the mapped union; reached at runtime by every other
        // `ThreadItem` variant (`imageGeneration`, `contextCompaction`, …),
        // which is why the cast is a `CodexRawItem` and not a lie about `item`.
        this.log.info(
          `[codex] item type ${(item as CodexRawItem).type} is not mapped to a block`,
        );
        return;
    }
  }

  private appendText(key: string, delta: string, kind: "text" | "thinking"): void {
    const turn = this.active;
    if (!turn || turn.settled || !delta) return;
    const next = (turn.text.get(key) ?? "") + delta;
    turn.text.set(key, next);
    this.emitBlock(key, kind === "text" ? { kind: "text", text: next } : { kind: "thinking", text: next });
  }

  private emitCommand(item: CodexItem & { type: "commandExecution" }): void {
    const turn = this.active;
    if (!turn) return;
    const streamed = turn.streamed.get(item.id) ?? "";
    const raw = item.aggregatedOutput ?? (streamed || null);
    const { output, truncated, fullOutput } = this.clampOutput(raw);
    this.emitBlock(`tool:${item.id}`, {
      kind: "tool_call",
      name: "shell",
      family: "bash",
      input: {
        command: item.command ?? "",
        cwd: item.cwd ?? this.session?.projectPath ?? "",
        ...(item.commandActions ? { commandActions: item.commandActions } : {}),
      },
      output,
      status: commandStatus(item),
      toolUseId: item.id,
      ...(truncated ? { truncated: true, fullOutput } : {}),
    });
  }

  private emitFileChange(item: CodexItem & { type: "fileChange" }): void {
    const changes = item.changes ?? [];
    const family: ToolCallFamily =
      changes.length > 0 && changes.every((c) => c.kind?.type === "add") ? "write" : "edit";
    this.emitBlock(`tool:${item.id}`, {
      kind: "tool_call",
      name: "apply_patch",
      family,
      input: { changes: changes.map((c) => ({ path: c.path, kind: c.kind?.type ?? "update" })) },
      output: `${changes.length} file${changes.length === 1 ? "" : "s"}`,
      status: patchStatus(item.status),
      toolUseId: item.id,
    });
    changes.forEach((change, index) => {
      const { additions, deletions } = countDiff(change.diff ?? "");
      this.emitBlock(`diff:${item.id}:${index}`, {
        kind: "diff",
        path: change.path,
        patch: change.diff ?? "",
        additions,
        deletions,
      });
    });
  }

  /**
   * Codex's own `dynamicToolCall` item → the one `tool_call` block for that
   * call.
   *
   * The harness deliberately emits **no block of its own** when it answers
   * `item/tool/call`: Codex already opens this item before it asks, under an
   * `id` that is the `callId`, so a second block would be a duplicate card for
   * one tool call. The reply path only records the reference (`dynamicRefs`),
   * and it is stamped on here.
   *
   * R25's contract in one place: `output` is the stub, `outputRef` points at
   * the stored original, and the payload never carries the original itself —
   * a delegated answer can be megabytes, and a block row is not where that
   * belongs.
   */
  private emitDynamicToolCall(item: CodexDynamicToolCallItem): void {
    const text = (item.contentItems ?? [])
      .map((entry) => (entry.type === "inputText" ? entry.text : `[${entry.type}]`))
      .join("");
    const ref = this.active?.dynamicRefs.get(item.id);
    const status: ToolCallStatus =
      item.status === "completed"
        ? item.success === false
          ? "error"
          : "success"
        : item.status === "failed"
          ? "error"
          : "running";
    this.emitBlock(`tool:${item.id}`, {
      kind: "tool_call",
      name: item.tool,
      family: "task",
      input: isRecord(item.arguments) ? item.arguments : {},
      output: text,
      status,
      toolUseId: item.id,
      ...(ref ? { truncated: true, outputRef: ref } : {}),
    });
  }

  private emitMcpToolCall(item: CodexItem & { type: "mcpToolCall" }): void {
    const result = item.result ?? null;
    const errorMessage = item.error?.message;
    // The whole result object is kept — `content`, `structuredContent` *and*
    // `_meta` — because the MCP Apps widget host (R31) reads `_meta`, and a
    // harness that strips it makes the widget unrenderable.
    const value = errorMessage ? { error: errorMessage } : result;
    const { output, truncated, fullOutput } = this.clampOutput(value);
    this.emitBlock(`tool:${item.id}`, {
      kind: "tool_call",
      name: item.tool,
      family: "mcp",
      serverName: item.server,
      input: item.arguments ?? null,
      output,
      status: mcpStatus(item.status, Boolean(errorMessage)),
      toolUseId: item.id,
      ...(truncated ? { truncated: true, fullOutput } : {}),
    });

    const resourceUri = item.appContext?.resourceUri ?? item.mcpAppResourceUri ?? null;
    if (!resourceUri || !resourceUri.startsWith("ui://")) return;
    // An MCP App result: the card is a widget, and the HTML behind `ui://` is
    // fetched by the widget host, not here (A13 / `mcp.readResource`).
    this.emitBlock(`widget:${item.id}`, {
      kind: "widget",
      toolCallId: item.id,
      serverName: item.server,
      toolName: item.tool,
      resourceUri,
      html: null,
      htmlStatus: "pending",
      toolInput: item.arguments ?? null,
      toolResult: result
        ? {
            content: Array.isArray(result.content) ? result.content : [],
            ...(result.structuredContent !== undefined
              ? { structuredContent: result.structuredContent }
              : {}),
            ...(errorMessage ? { isError: true } : {}),
          }
        : null,
      meta: result?._meta ?? null,
    });
  }

  private emitWebSearch(item: CodexItem & { type: "webSearch" }): void {
    const { output, truncated, fullOutput } = this.clampOutput(item.results ?? null);
    this.emitBlock(`tool:${item.id}`, {
      kind: "tool_call",
      name: "web_search",
      family: "web",
      input: { query: item.query ?? "" },
      output,
      status: item.results ? "success" : "running",
      toolUseId: item.id,
      ...(truncated ? { truncated: true, fullOutput } : {}),
    });
  }

  /**
   * Codex's multi-agent collaboration mode (SPEC R12): `spawnAgent` and the
   * other `CollabAgentTool` operations all arrive as one `collabAgentToolCall`
   * item on the *orchestrating* agent's own thread — never on the sub-agent's
   * thread, which is why this needs no second app-server connection the way
   * the widget host does (A13's problem is different: reading a *resource*
   * hosted by another process, not reading another thread's own items).
   *
   * A call with no `receiverThreadIds` (`listAgents`, or a `wait`/`sendMessage`
   * that named nobody yet) has no sub-agent to render and is dropped — the same
   * "nothing to show yet" rule `emitCommand`'s siblings apply to an empty item.
   *
   * `agentsStates[threadId]` — when app-server has it — is preferred over the
   * call's own `status` for that thread's block: the call's status describes
   * whether *issuing the call* succeeded, while `agentsStates` describes the
   * target agent itself, which is what the block is about.
   */
  private emitCollabAgentToolCall(item: CodexItem & { type: "collabAgentToolCall" }): void {
    const turn = this.active;
    if (!turn) return;
    const receivers = item.receiverThreadIds ?? [];
    if (receivers.length === 0) return;
    const fallbackStatus = collabToolCallStatus(item.status);
    const description = item.prompt ? firstLine(item.prompt) : "";
    for (const agentThreadId of receivers) {
      if (!agentThreadId) continue;
      const state = item.agentsStates?.[agentThreadId];
      this.upsertSubagentBlock(turn, agentThreadId, {
        model: item.model ?? null,
        ...(description ? { description } : {}),
        status: state ? collabAgentStatus(state.status) : fallbackStatus,
      });
    }
  }

  /**
   * A `subAgentActivity` item is a lifecycle ping for one sub-agent thread,
   * named by `agentPath` — the only place a human-readable name for the
   * sub-agent ever appears on the wire (`collabAgentToolCall` only knows the
   * thread id). It arrives both for agents this harness's own
   * `collabAgentToolCall` items already know about and, on a resumed thread,
   * for ones whose spawn call was never replayed — `upsertSubagentBlock`
   * handles either by keying on `agentThreadId` alone.
   */
  private emitSubAgentActivity(item: CodexItem & { type: "subAgentActivity" }): void {
    const turn = this.active;
    if (!turn || !item.agentThreadId) return;
    this.upsertSubagentBlock(turn, item.agentThreadId, {
      ...(item.agentPath ? { name: item.agentPath } : {}),
      status: subAgentActivityStatus(item.kind),
    });
  }

  /** Same merge-and-emit shape as `ClaudeHarness.upsertSubagent`: only the
   *  fields a caller actually knows this time are overwritten, so a later
   *  `subAgentActivity` naming the agent does not blank out the model a
   *  `collabAgentToolCall` reported earlier, and vice versa. */
  private upsertSubagentBlock(
    turn: ActiveTurn,
    agentThreadId: string,
    patch: {
      name?: string;
      description?: string;
      model?: string | null;
      status: "spawned" | "running" | "done" | "error";
    },
  ): void {
    const prev = turn.subagents.get(agentThreadId) ?? {
      name: "sub-agent",
      description: "",
      model: null,
    };
    const next = {
      name: patch.name ?? prev.name,
      description: patch.description ?? prev.description,
      model: patch.model !== undefined ? patch.model : prev.model,
    };
    turn.subagents.set(agentThreadId, next);
    this.emitBlock(`subagent:${agentThreadId}`, {
      kind: "subagent",
      agentId: null,
      name: next.name,
      backend: "codex",
      model: next.model,
      description: next.description,
      status: patch.status,
      // Not derivable yet: `thread/tokenUsage/updated` for the sub-agent's own
      // thread id is filtered out at the top of `onNotification` (only frames
      // for *this* harness's own `threadId` pass), so no token count — and
      // therefore no cost — ever reaches a `collabAgentToolCall`/
      // `subAgentActivity` item. Reading it would mean a second subscription
      // scoped to `agentThreadId`; left as a documented gap rather than a
      // guessed number (SPEC R23's "never a guess" rule, `pricing.ts`).
    });
  }

  private onTurnCompleted(notification: CodexTurnCompletedNotification): void {
    const turn = this.active;
    if (!turn || turn.settled) return;
    const completed = notification.turn;

    // Items the stream never announced individually (a resumed or summarised
    // turn) still have to render.
    for (const item of completed?.items ?? []) {
      if (item && !turn.items.has(item.id)) this.routeItem(item);
    }

    const model = this.resolvedModel ?? this.agent?.model ?? "";
    const usage = codexUsageWithCost(model, turn.usage ?? undefined);
    if (usage.inputTokens + usage.outputTokens + usage.cacheReadTokens > 0) {
      this.emit({
        type: "usage",
        backend: this.backend,
        model,
        usage,
        byModel: { [model]: usage },
      });
      this.emitBlock(`usage:${turn.turnId}`, { kind: "usage", model, usage });
    }

    const status = completed?.status;
    if (status === "interrupted" || turn.interrupted) {
      this.settle(turn, "interrupted");
      return;
    }
    if (status === "failed") {
      const message = completed?.error?.message ?? turn.fatal ?? "the Codex turn failed";
      const unauthorized = completed?.error?.codexErrorInfo === CODEX_UNAUTHORIZED;
      this.emitBlock(`error:${turn.turnId}`, {
        kind: "error",
        message: unauthorized
          ? "Codex is not signed in. Run `codex login` in a terminal, then retry."
          : message,
        ...(completed?.error?.additionalDetails ? { detail: completed.error.additionalDetails } : {}),
      });
      this.settle(turn, "error", message);
      return;
    }
    this.settle(turn, "done");
  }

  // -------------------------------------------------------------------------
  // server requests: approvals, user input, elicitation
  // -------------------------------------------------------------------------

  private async onServerRequest(method: string, rawParams: unknown): Promise<unknown> {
    const params = isRecord(rawParams) ? rawParams : {};
    switch (method) {
      case CODEX_SERVER_REQUESTS.commandApproval:
        return { decision: await this.askCommandApproval(params as unknown as CodexCommandApprovalParams) };
      case CODEX_SERVER_REQUESTS.fileChangeApproval:
        return {
          decision: await this.askFileChangeApproval(
            params as unknown as CodexFileChangeApprovalParams,
          ),
        };
      case CODEX_SERVER_REQUESTS.requestUserInput:
        return this.askUserInput(params as unknown as CodexUserInputParams);
      case CODEX_SERVER_REQUESTS.elicitation:
        return this.askElicitation(params as unknown as CodexElicitationParams);
      case CODEX_SERVER_REQUESTS.dynamicToolCall:
        return this.runDynamicTool(params as unknown as CodexDynamicToolCallParams);
      case CODEX_SERVER_REQUESTS.currentTime:
        return { currentTimeAt: Math.floor(Date.now() / 1000) };
      default:
        // Everything else (permission-profile grants, token refresh,
        // attestation) is declined with a JSON-RPC error rather than answered
        // with a guess — Codex then applies its own default.
        throw new Error(`capygen does not handle ${method} yet`);
    }
  }

  private async askCommandApproval(params: CodexCommandApprovalParams): Promise<CodexCommandApprovalDecision> {
    // Captured at admission, before anything awaits: this is the turn the
    // request belongs to for the rest of its life.
    const admitted = await this.admitApproval(params);
    if (!admitted) return "decline";
    const requestId = newId("request");
    const request: PermissionRequest = {
      requestId,
      toolName: "shell",
      input: {
        command: params.command ?? "",
        cwd: params.cwd ?? this.session?.projectPath ?? "",
        kind: params.kind ?? "command",
        ...(params.commandActions ? { commandActions: params.commandActions } : {}),
      },
      ...(params.reason ? { reason: params.reason } : {}),
      suggestions: [],
    };
    const key = `permission:${params.approvalId ?? params.itemId}`;
    // R32: the card renders a command + cwd view, not the transport JSON — but
    // it needs a header to do it with. Codex names neither, so the harness does
    // (the reference's ApprovalCard calls this one "Command approval").
    const answer = await this.askPermission(key, requestId, request, {
      title: "Command approval",
      description: "Codex wants to run this command.",
    });
    // [review] The card shows a summary; authorization gets the *complete*
    // approval parameters. Anything omitted here is something a rule could not
    // see and an exact grant could silently be reused across.
    return this.applyLocalApproval(
      "codex-command-approval",
      "shell",
      { params },
      answer,
      admitted,
      String(params.approvalId ?? params.itemId ?? requestId),
    );
  }

  private async askFileChangeApproval(
    params: CodexFileChangeApprovalParams,
  ): Promise<CodexCommandApprovalDecision> {
    const admitted = await this.admitApproval(params);
    if (!admitted) return "decline";
    const requestId = newId("request");
    const item = this.active?.items.get(params.itemId);
    const changes = item && item.type === "fileChange" ? (item.changes ?? []) : [];
    const request: PermissionRequest = {
      requestId,
      toolName: "apply_patch",
      input: {
        changes: changes.map((c) => ({ path: c.path, kind: c.kind?.type ?? "update" })),
        ...(params.grantRoot ? { grantRoot: params.grantRoot } : {}),
      },
      ...(params.reason ? { reason: params.reason } : {}),
      suggestions: [],
    };
    const answer = await this.askPermission(`permission:${params.itemId}`, requestId, request, {
      title: "File change approval",
      description: `Codex wants to change ${changes.length} file${changes.length === 1 ? "" : "s"}.`,
    });
    // [review] Paths and kinds alone let two entirely different edits to the
    // same files share one exact grant. Authorization sees the full captured
    // change set, diffs included, alongside the complete approval parameters.
    return this.applyLocalApproval(
      "codex-file-approval",
      "apply_patch",
      { params, changes },
      answer,
      admitted,
      String(params.itemId ?? requestId),
    );
  }

  /**
   * ADR-0007 for Codex's native approval categories: the local restriction is
   * consulted **after** the user's answer arrives and **before** the reply goes
   * back, so a rule edited or revoked while the card was open still decides.
   *
   * `allowInputReplacement: false` because the protocol accepts a *decision*,
   * not a rewritten command or patch. An authorizer that returns a different
   * input is declined rather than run unchanged — capygen will not advertise an
   * editable approval it cannot actually apply.
   */
  private async applyLocalApproval(
    boundary: "codex-command-approval" | "codex-file-approval",
    toolName: string,
    input: unknown,
    answer: PermissionAnswer,
    /** The turn this request was **admitted** in, captured before the card. */
    admitted: ActiveTurn | null,
    callId: string,
  ): Promise<CodexCommandApprovalDecision> {
    const work = this.decideLocalApproval(boundary, toolName, input, answer, admitted, callId);
    this.outstandingApprovals.add(work);
    void work.then(
      () => this.outstandingApprovals.delete(work),
      () => this.outstandingApprovals.delete(work),
    );
    return work;
  }

  private async decideLocalApproval(
    boundary: "codex-command-approval" | "codex-file-approval",
    toolName: string,
    input: unknown,
    answer: PermissionAnswer,
    admitted: ActiveTurn | null,
    callId: string,
  ): Promise<CodexCommandApprovalDecision> {
    const native = commandDecision(answer);
    // A refusal needs no policy check, and asking about one would only create
    // an audit record for something nobody approved.
    if (native === "decline" || native === "cancel") return native;
    // Oversized native metadata is refused rather than trimmed: a truncated
    // value would authorize something other than what runs.
    const snapshot = jsonSnapshot(input);
    if (!snapshot.ok) {
      this.log.warn(`[codex] an approval could not be authorized exactly (${snapshot.reason})`);
      return "decline";
    }
    const verdict = await authorizeLocally(
      this.deps.authorizeLocal,
      {
        boundary,
        toolName,
        input,
        cwd: this.session?.projectPath ?? process.cwd(),
        signal: this.approvalSignal(admitted),
        stage: "final",
        callId: `${boundary}:${callId}`,
      },
      { allowInputReplacement: false, requireObject: false },
    );
    // [review] Re-checked *after* the wait, against the turn this request was
    // admitted in — not against whichever turn `this.active` happens to be by
    // now. A replacement turn is a different authorization context, and a
    // finished one is none at all.
    if (this.disposed || !admitted || admitted.settled || admitted.interrupted) return "decline";
    if (this.active !== admitted) return "decline";
    return verdict.allowed ? native : "decline";
  }

  /**
   * Whether an approval request belongs here at all, decided **before** a card
   * is raised or the local authorizer is consulted.
   *
   * [review] The params were previously cast and the active turn captured
   * without ever comparing the two, so a frame naming another thread — or a
   * turn that had already ended — still raised a card and still asked the
   * policy about it. The cancellation fix covers a request that *was* validly
   * admitted; this is the admission itself.
   */
  private async admitApproval(params: {
    threadId?: unknown;
    turnId?: unknown;
  }): Promise<ActiveTurn | null> {
    if (this.disposed) return null;
    const threadId = str(params.threadId);
    if (!threadId || threadId !== this.threadId) {
      this.log.warn("[codex] an approval named a thread this harness does not own");
      return null;
    }
    const turn = this.active;
    if (!turn || turn.settled || turn.interrupted) return null;
    /**
     * [review] An approval must *name* its turn. Admitting one that carries no
     * id — or any id, because the client has not learned its own yet — lets a
     * stale request from the previous native turn through the window between
     * `turn/start` being sent and its response arriving. The later identity
     * check compares the captured turn *object*, which in that window is the
     * new turn, so it catches nothing: the comment claiming otherwise was
     * wrong.
     */
    const turnId = str(params.turnId);
    if (!turnId) {
      this.log.warn("[codex] an approval carried no turn id");
      return null;
    }
    if (!turn.codexTurnId) {
      // Bounded and cancellable: wait for the id this turn is about to learn,
      // rather than guessing. `settle`/`interrupt` release the deferred, and
      // the deadline covers a `turn/start` that never answers at all.
      await Promise.race([
        turn.turnIdKnown,
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, TURN_CORRELATION_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
      if (this.disposed || turn.settled || turn.interrupted || this.active !== turn) return null;
    }
    if (!turn.codexTurnId || turnId !== turn.codexTurnId) {
      this.log.warn("[codex] an approval named a turn that is not the active one");
      return null;
    }
    return turn;
  }

  /**
   * The cancellation an approval's local authorization runs under.
   *
   * [review] `turnSignal()` built a controller, sampled the turn once and
   * returned a signal that could never fire — so a hung authorizer sat there
   * after the user pressed Stop and could still answer into a dead turn. This
   * returns the turn's **own** controller, which `interrupt`, `settle` and
   * `dispose` all abort, and an already-aborted signal when there is no turn.
   */
  private approvalSignal(turn: ActiveTurn | null): AbortSignal {
    if (turn && !turn.settled && !turn.interrupted && !this.disposed) return turn.cancel.signal;
    const controller = new AbortController();
    controller.abort();
    return controller.signal;
  }

  /**
   * Which boundaries **this** agent, on **this** captured thread, can actually
   * enforce. Never a static list: a thread started with `approvalPolicy:
   * "never"` is told nothing to approve, so advertising an approval-category
   * restriction for it would be a promise the runtime cannot keep.
   */
  localPolicyCapabilities(): PolicyBoundarySupport[] {
    // Both halves matter: `never` means Codex asks nobody, and a reviewer other
    // than `user` means it asks somebody who is not this client.
    const approvals = this.approvalPolicy !== "never" && this.approvalsReviewer === "user";
    const approvalReason = approvals ? null : ("native-approval-disabled" as const);
    return [
      {
        boundary: "codex-dynamic-tool",
        available: this.dynamicToolsActive(),
        reason: this.dynamicToolsActive() ? null : "harness-unavailable",
      },
      { boundary: "codex-command-approval", available: approvals, reason: approvalReason },
      { boundary: "codex-file-approval", available: approvals, reason: approvalReason },
      // `item/permissions/requestApproval` is a request capygen does not answer:
      // its reply shape is a permission *profile*, and guessing one would grant
      // filesystem or network access nobody asked for. Unavailable until a
      // concrete supported path is proved (ADR-0007).
      {
        boundary: "codex-permissions-approval",
        available: false,
        reason: "capability-unproven",
      },
    ];
  }

  private async askPermission(
    key: string,
    requestId: string,
    request: PermissionRequest,
    display: { title?: string; description?: string },
  ): Promise<PermissionAnswer> {
    const turn = this.active;
    if (!turn || turn.settled) {
      // Nobody can be asked, so nothing is approved (SPEC R27).
      return { behavior: "deny", message: "capygen has no active turn to ask in" };
    }
    this.emitBlock(key, { kind: "permission", request, decision: null, ...display });
    this.emit({ type: "permission", requestId, key, request });

    const answer = await new Promise<PermissionAnswer>((resolve) => {
      this.pending.set(requestId, {
        kind: "permission",
        key,
        resolve,
        cancelPatch: (why) => ({
          kind: "permission",
          request,
          decision: { behavior: "deny", message: why, scope: "once", decidedAt: Date.now() },
          ...display,
        }),
      });
    });

    const scope = scopeOf(answer);
    this.emitBlock(key, {
      kind: "permission",
      request,
      decision: {
        behavior: answer.behavior === "allow" && scope !== "once" ? "allow_always" : answer.behavior,
        ...(answer.updatedInput !== undefined ? { updatedInput: answer.updatedInput } : {}),
        ...(answer.message !== undefined ? { message: answer.message } : {}),
        scope,
        decidedAt: Date.now(),
      },
      ...display,
    });
    return answer;
  }

  /**
   * Codex's `item/tool/requestUserInput` is its AskUserQuestion: headers,
   * options, an "other" flag. It maps onto capygen's question card exactly, so
   * it travels as a `question` event and is answered with `answerQuestion`.
   */
  private async askUserInput(params: CodexUserInputParams): Promise<unknown> {
    const turn = this.active;
    const questions: Question[] = (params.questions ?? []).map((q) => ({
      question: q.question,
      ...(q.header ? { header: q.header } : {}),
      multiSelect: false,
      options: (q.options ?? []).map((o) => ({
        label: o.label,
        ...(o.description ? { description: o.description } : {}),
      })),
    }));
    if (!turn || turn.settled || questions.length === 0) {
      return { answers: {} };
    }
    const requestId = newId("request");
    const byText = new Map<string, string>();
    for (const q of params.questions ?? []) byText.set(q.question, q.id);
    this.questionIds.set(requestId, byText);

    const key = `question:${params.itemId}`;
    const allowOther = (params.questions ?? []).some((q) => q.isOther === true);
    this.emitBlock(key, {
      kind: "question",
      requestId,
      questions,
      answers: null,
      allowOther,
      status: "pending",
    });
    this.emit({ type: "question", requestId, key, questions });

    const answers = await new Promise<Record<string, string>>((resolve) => {
      this.pending.set(requestId, {
        kind: "question",
        key,
        resolve,
        cancelPatch: () => ({
          kind: "question",
          requestId,
          questions,
          answers: null,
          allowOther,
          status: "cancelled",
        }),
      });
    });
    this.questionIds.delete(requestId);
    const cancelled = Object.keys(answers).length === 0;
    this.emitBlock(key, {
      kind: "question",
      requestId,
      questions,
      answers: cancelled ? null : answers,
      allowOther,
      status: cancelled ? "cancelled" : "answered",
    });

    // `{questionId: {answers: [label]}}` — `ToolRequestUserInputAnswer` takes a
    // list; capygen's card produces one choice per question, so the list has at
    // most one entry.
    const payload: Record<string, { answers: string[] }> = {};
    for (const q of params.questions ?? []) {
      const value = answers[q.question] ?? answers[q.id];
      if (typeof value === "string" && value.length > 0) payload[q.id] = { answers: [value] };
    }
    return { answers: payload };
  }

  /**
   * MCP `elicitation/create` relayed by Codex (R32).
   *
   * It travels as its own `elicitation` event — the same shape `permission`
   * and `question` use — so the session runner learns the `requestId` the card
   * is waiting on and `elicitation.answer` can route the user's form back here
   * through `answerElicitation`. With no active turn nobody can be asked, so
   * the request is declined rather than silently accepted (the R27 rule the
   * approval path follows too).
   */
  private async askElicitation(params: CodexElicitationParams): Promise<unknown> {
    const turn = this.active;
    const requestId = newId("request");
    const key = `elicitation:${requestId}`;
    if (!turn || turn.settled) return { action: "decline", content: null };

    this.emitBlock(key, {
      kind: "elicitation",
      requestId,
      title: params.serverName,
      ...(params.message ? { description: params.message } : {}),
      schema: params.requestedSchema ?? null,
      answers: null,
      status: "pending",
    });
    this.emit({
      type: "elicitation",
      requestId,
      key,
      title: params.serverName,
      ...(params.message ? { description: params.message } : {}),
      schema: params.requestedSchema ?? null,
    });

    const answers = await new Promise<Record<string, unknown> | null>((resolve) => {
      this.pending.set(requestId, {
        kind: "elicitation",
        key,
        resolve,
        cancelPatch: () => ({
          kind: "elicitation",
          requestId,
          title: params.serverName,
          ...(params.message ? { description: params.message } : {}),
          schema: params.requestedSchema ?? null,
          answers: null,
          status: "cancelled",
        }),
      });
    });

    this.emitBlock(key, {
      kind: "elicitation",
      requestId,
      title: params.serverName,
      ...(params.message ? { description: params.message } : {}),
      schema: params.requestedSchema ?? null,
      answers,
      status: answers ? "accepted" : "declined",
    });
    return answers
      ? { action: "accept", content: answers, _meta: null }
      : { action: "decline", content: null, _meta: null };
  }

  // -------------------------------------------------------------------------
  // server requests: dynamic (client-hosted) tools
  // -------------------------------------------------------------------------

  /**
   * `item/tool/call` — the model called one of the tools capygen declared on
   * `thread/start`.
   *
   * Three properties this has to hold, none of which the transport gives away:
   *
   *  - **It always answers.** Everything invalid is a `success: false` reply
   *    carrying a short code, never a JSON-RPC error (which would tell Codex
   *    the method is unimplemented and stop it routing calls here) and never a
   *    silent drop (which would leave the app-server blocked forever). The
   *    reply is bounded and generic: it names a code, not an exception message,
   *    a stack, or an identifier the caller chose — a tool's error text can
   *    carry a connection string, and this text goes straight into a model's
   *    context.
   *  - **Nothing runs without capygen's own permission gate.** Codex's sandbox
   *    and `approvalPolicy` govern the tools *Codex* executes; a client-hosted
   *    tool runs in capygen's process, outside all of it. `delegate_task` is
   *    `permissionClass: "execute"` and spends another model's tokens, so it
   *    goes through `gateFor` and the same permission card every other backend
   *    raises (SPEC R27) — `plan` denies, `default` asks.
   *  - **Cancellation is a deadline, not a request.** The tool is raced against
   *    its abort signal, so a tool that ignores the signal cannot hold the
   *    reply (and the app-server) open; its late result or rejection is
   *    discarded rather than written after the fact.
   *
   * The identity checks are not defensive noise. `threadId` guards a frame
   * belonging to another thread on the same process; `turnId` plus the active
   * turn's own state guards a call that outlived, or was cancelled inside, the
   * turn it was made in; `callId` guards re-executing one model decision twice,
   * which for a delegating tool is a second sub-agent's bill.
   */
  private async runDynamicTool(
    raw: CodexDynamicToolCallParams,
  ): Promise<CodexDynamicToolCallResponse> {
    const params = isRecord(raw) ? raw : ({} as Record<string, unknown>);

    if (!this.dynamicToolsActive()) return dynamicFailure("unavailable");
    if (!isNonEmptyString(params.threadId) || params.threadId !== this.threadId) {
      this.log.warn("[codex] item/tool/call named a thread this harness does not own");
      return dynamicFailure("wrong_thread");
    }
    const turn = this.active;
    // `interrupted` matters as much as `settled`: `interrupt()` marks the turn
    // and asks Codex to stop, but `turn/completed` arrives later. A call
    // landing in that window must not start work the user already cancelled.
    if (!turn || turn.settled || turn.interrupted) return dynamicFailure("no_active_turn");
    // `codexTurnId` is null only between `turn/start` being sent and answered,
    // and Codex cannot have called a tool inside that window.
    if (!isNonEmptyString(params.turnId) || !turn.codexTurnId || params.turnId !== turn.codexTurnId) {
      this.log.warn("[codex] item/tool/call named a turn that is not the active one");
      return dynamicFailure("wrong_turn");
    }
    // capygen declares only `{type:"function"}` specs, so the pinned
    // `namespace: string | null` may only arrive as `null` — or absent, which
    // an older or partial serialiser may send for the same thing. Anything
    // else (a number, `""`, an object) is a call for something never
    // advertised, not a namespace to look up.
    if (params.namespace !== null && params.namespace !== undefined) {
      return dynamicFailure("namespace_unsupported");
    }
    if (!isNonEmptyString(params.callId)) return dynamicFailure("bad_call_id");
    if (!isNonEmptyString(params.tool)) return dynamicFailure("unknown_tool");
    const tool = this.dynamicToolsByName.get(params.tool);
    // The name is not logged: it is caller-supplied, the code already says what
    // happened, and capygen's own declared list is the useful half anyway.
    if (!tool) return dynamicFailure("unknown_tool");
    // `DynamicToolCallParams.arguments` is a required field and every tool
    // capygen declares takes an object, so a missing or non-object value is a
    // malformed frame rather than an empty argument list to guess at.
    if (!isRecord(params.arguments)) return dynamicFailure("bad_arguments");
    let input: Record<string, unknown> = params.arguments;
    const callId = params.callId;
    const existing = turn.dynamicCalls.get(callId);
    if (existing) {
      this.log.warn(`[codex] item/tool/call repeated a callId already ${existing.state}`);
      return dynamicFailure("duplicate_call");
    }

    const abort = new AbortController();
    let markDone: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      markDone = resolve;
    });
    turn.dynamicCalls.set(callId, { state: "running", abort, done });
    const aborted = abortPromise(abort.signal);
    const settleEntry = (): void => {
      const entry = turn.dynamicCalls.get(callId);
      if (entry) entry.state = "settled";
      markDone();
    };

    try {
      // R27's gate, before anything runs and before the card: `plan` refuses
      // outright rather than offering a button that would break plan mode's
      // contract, and `bypassPermissions` is the only mode that skips the card.
      const mode: PermissionMode = this.agent?.permissionMode ?? "default";
      const gate = gateFor(mode, tool.permissionClass);
      if (gate === "deny") {
        return dynamicFailure("denied_by_mode", gateDenialMessage(mode, tool));
      }
      if (gate === "ask") {
        const requestId = newId("request");
        const request: PermissionRequest = {
          requestId,
          toolName: tool.name,
          input,
          reason: `${tool.name} needs ${tool.permissionClass} access.`,
          suggestions: [],
        };
        const answer = await Promise.race([
          this.askPermission(`permission:dyn:${callId}`, requestId, request, {
            title: "Tool permission",
            description: "Codex asked capygen to run one of its own tools.",
          }),
          aborted,
        ]);
        // An interrupt while the card was open cancels the call itself, not
        // just the question: `cancelPending` denies the card *and* aborts here.
        if (answer === ABORTED || abort.signal.aborted) return dynamicFailure("cancelled");
        if (answer.behavior !== "allow") return dynamicFailure("denied");
        // The card may hand back edited arguments — the `api` backend already
        // honours this, and a permission surface that shows an editable command
        // and then runs the original would be worse than not offering the edit.
        // A replacement that is not an object is refused outright rather than
        // silently discarded back to the model's version: the user meant to
        // change the call, and the tool (`delegate_task` validates its own
        // arguments) would otherwise run on input nobody approved.
        if (answer.updatedInput !== undefined) {
          if (!isRecord(answer.updatedInput)) return dynamicFailure("bad_arguments");
          input = answer.updatedInput;
        }
      }
      if (abort.signal.aborted) return dynamicFailure("cancelled");

      // ADR-0007, after the host gate and any native approval above, on the
      // input that will actually run.
      const verdict = await authorizeLocally(
        this.deps.authorizeLocal,
        {
          boundary: "codex-dynamic-tool",
          toolName: tool.name,
          input,
          cwd: this.session?.projectPath ?? process.cwd(),
          signal: abort.signal,
          stage: "final",
          callId,
        },
        { allowInputReplacement: true, requireObject: true },
      );
      if (!verdict.allowed) return dynamicFailure("denied", verdict.message);
      // No fallback to the model's original: `requireObject` refused anything
      // that could not be executed as approved.
      input = verdict.input as Record<string, unknown>;
      if (abort.signal.aborted) return dynamicFailure("cancelled");

      const maxOutputChars = this.deps.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS;
      const ctx: ToolContext = {
        cwd: this.session?.projectPath ?? process.cwd(),
        signal: abort.signal,
        env: cleanEnv(this.deps.env),
        log: this.log,
        maxOutputChars,
        // No `ask` surface exists here: an interactive tool would have to raise
        // its card inside a turn Codex is blocking on, and capygen declares no
        // such tool. Refusing is honest; a silent empty answer would not be.
        ask: () => Promise.reject(new Error("this tool cannot ask questions from a Codex dynamic call")),
      };

      // The whole point of the race: `signal` is advice a tool may ignore, and
      // an ignored abort used to mean this promise — and the app-server's
      // request — never settled. Whatever the tool eventually does is caught
      // and dropped here, so a late rejection is never unhandled and a late
      // result is never written after the reply.
      const outcome = await Promise.race([
        (async () => tool.run(input, ctx))().then(
          (result) => ({ ok: true as const, result }),
          (err: unknown) => ({ ok: false as const, err }),
        ),
        aborted,
      ]);
      if (outcome === ABORTED || abort.signal.aborted) return dynamicFailure("cancelled");
      if (!outcome.ok) {
        // Deliberately not `describe(outcome.err)`: a tool's message can carry
        // a URL with credentials in it, and this string is both replied to the
        // model and written to the log.
        this.log.warn(`[codex] dynamic tool ${safeLabel(tool.name)} failed`);
        return dynamicFailure("tool_error");
      }
      // A tool that already stubbed itself keeps the original in `fullOutput`
      // (`ToolResult`); that is the value R25 is about, not the stub.
      const produced =
        typeof outcome.result.fullOutput === "string"
          ? outcome.result.fullOutput
          : (outcome.result.content ?? "");
      // Raced like the tool itself, and for the same reason: persisting the
      // output is somebody else's `await`. A store that never settles would
      // otherwise hold `item/tool/call` open through an interrupt, and one that
      // settles late would answer success for a call already cancelled. Its
      // late result — or rejection — is caught here and dropped.
      const bounded = await Promise.race([
        this.boundDynamicOutput(callId, tool.name, produced).then(
          (text) => ({ ok: true as const, text }),
          () => ({ ok: false as const, text: "" }),
        ),
        aborted,
      ]);
      if (bounded === ABORTED || abort.signal.aborted) return dynamicFailure("cancelled");
      if (!bounded.ok) return dynamicFailure("tool_error");
      return {
        contentItems: [{ type: "inputText", text: bounded.text }],
        success: outcome.result.isError !== true,
      };
    } finally {
      // Kept, not deleted: the entry is what refuses a retransmitted `callId`
      // after the first call has finished.
      settleEntry();
    }
  }

  /**
   * SPEC R25 for a dynamic-tool result: keep the model's copy under the byte
   * cap, and keep the original reachable — or say plainly that it is not.
   *
   * The stub and its notice are budgeted **together**, so nothing above the cap
   * ever reaches the model. Three honest endings, and no fourth that pretends:
   * a reference when the store took it, "could not be saved" when the store
   * refused or failed, "not retained" when there is no store wired at all.
   */
  private async boundDynamicOutput(
    callId: string,
    toolName: string,
    output: string,
  ): Promise<string> {
    if (byteLength(output) <= DYNAMIC_RESULT_MAX_BYTES) return output;

    let ending: string;
    const store = this.deps.storeDynamicToolOutput;
    if (!store) {
      ending = "the full output was not retained and cannot be retrieved";
    } else {
      let reference: string | null = null;
      try {
        reference = await store({ callId, blockKey: `tool:${callId}`, toolName, output });
      } catch {
        // Deliberately no message and no `describe(err)`: a store failure can
        // name a path or a connection string, and this is written to the log.
        this.log.warn("[codex] a dynamic tool's full output could not be stored");
        reference = null;
      }
      if (typeof reference === "string" && reference.trim().length > 0) {
        // Recorded, not emitted: the block this belongs on is Codex's own item,
        // which completes after the reply (`emitDynamicToolCall`).
        this.active?.dynamicRefs.set(callId, reference);
        ending = `the full output is saved as ${safeLabel(reference)}`;
      } else {
        ending = "the full output could not be saved and is unavailable";
      }
    }
    const notice = `\n… truncated by capygen at ${DYNAMIC_RESULT_MAX_BYTES} bytes; ${ending}`;
    return `${headUtf8Bytes(output, DYNAMIC_RESULT_MAX_BYTES - byteLength(notice))}${notice}`;
  }

  /**
   * Abort every dynamic-tool call still running on the active turn, so an
   * interrupt, a settle or a dispose cannot leave a sub-agent billing against a
   * turn nobody is watching. The call's own `await` resolves to a `success:
   * false` answer, which is what unblocks the app-server.
   */
  private abortDynamicCalls(): Promise<void>[] {
    const turn = this.active;
    if (!turn) return [];
    const running: Promise<void>[] = [];
    for (const entry of turn.dynamicCalls.values()) {
      if (entry.state !== "running") continue;
      entry.abort.abort();
      running.push(entry.done);
    }
    return running;
  }

  /**
   * `dispose()`'s version: abort, then give the aborted calls a bounded moment
   * to produce their `success: false` answer **before** the transport closes.
   *
   * Without the wait, a dispose that races an in-flight call closes the pipe
   * first and the app-server is left blocked on a reply that can no longer be
   * written. The deadline is what keeps a tool that ignores its abort signal
   * from holding shutdown open.
   */
  /** The same bounded wait, for approval replies still being authorized. */
  private async drainOutstandingApprovals(): Promise<void> {
    if (this.outstandingApprovals.size === 0) return;
    await Promise.race([
      Promise.allSettled([...this.outstandingApprovals]),
      new Promise((resolve) => {
        const timer = setTimeout(resolve, DYNAMIC_CALL_DRAIN_MS);
        timer.unref?.();
      }),
    ]);
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 0);
      timer.unref?.();
    });
  }

  private async drainDynamicCalls(): Promise<void> {
    const running = this.abortDynamicCalls();
    if (running.length === 0) return;
    await Promise.race([
      Promise.allSettled(running),
      new Promise((resolve) => {
        const timer = setTimeout(resolve, DYNAMIC_CALL_DRAIN_MS);
        timer.unref?.();
      }),
    ]);
    // One macrotask so the reply frames each call produced are actually written
    // to the transport before the caller closes it.
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 0);
      timer.unref?.();
    });
  }

  answerPermission(requestId: string, answer: PermissionAnswer): boolean {
    const entry = this.pending.get(requestId);
    if (!entry || entry.kind !== "permission") return false;
    this.pending.delete(requestId);
    entry.resolve(answer);
    return true;
  }

  answerQuestion(requestId: string, answers: Record<string, string>): boolean {
    const entry = this.pending.get(requestId);
    if (!entry || entry.kind !== "question") return false;
    this.pending.delete(requestId);
    entry.resolve(answers);
    return true;
  }

  /** Resolve a pending `elicitation` event; `null` declines it. */
  answerElicitation(requestId: string, answers: Record<string, unknown> | null): boolean {
    const entry = this.pending.get(requestId);
    if (!entry || entry.kind !== "elicitation") return false;
    this.pending.delete(requestId);
    entry.resolve(answers);
    return true;
  }

  // -------------------------------------------------------------------------
  // discovery (Settings ▸ Harnesses / MCP servers, R28)
  // -------------------------------------------------------------------------

  async listModels(): Promise<CodexModel[]> {
    await this.ensureThread();
    const response = await this.client!.request<CodexModelListResponse>(
      CODEX_METHODS.modelList,
      {},
      DISCOVERY_TIMEOUT_MS,
    );
    return response?.data ?? [];
  }

  async listMcpServers(): Promise<CodexMcpServerStatus[]> {
    await this.ensureThread();
    const response = await this.client!.request<CodexMcpServerStatusListResponse>(
      CODEX_METHODS.mcpServerStatusList,
      { ...(this.threadId ? { threadId: this.threadId } : {}) },
      DISCOVERY_TIMEOUT_MS,
    );
    return response?.data ?? [];
  }

  /**
   * `mcpServerStatus/list` on the thread this harness already owns
   * (`v2/ListMcpServerStatusParams.ts`). No extra client, no extra configured
   * stdio child, and no turn: the app-server answers from the servers it has
   * already started for this thread.
   *
   * `detail: "toolsAndAuthOnly"` asks for exactly the half a catalogue shows —
   * resources and resource templates are not requested, so they are not paid
   * for in transport or in memory.
   */
  async catalogue(options: CatalogueOptions = {}): Promise<ToolCatalogue> {
    if (this.disposed) return { kind: "notStarted" };
    const live = this.client?.running === true && this.threadId !== null;
    if (!live && options.initialize !== true) return { kind: "notStarted" };
    return this.catalogueRunner.run(options);
  }

  private async fetchCatalogue(): Promise<{
    servers: RawCatalogueServer[];
    moreServers: boolean;
  }> {
    const response = await this.client!.request<CodexMcpServerStatusListResponse>(
      CODEX_METHODS.mcpServerStatusList,
      {
        ...(this.threadId ? { threadId: this.threadId } : {}),
        detail: "toolsAndAuthOnly",
      },
      DISCOVERY_TIMEOUT_MS,
    );
    // One page. A cursor means there is more, which is exactly what the
    // truncation flag is for — paging a display list without a bound is how a
    // hostile configuration turns a refresh into an unbounded loop.
    const more = typeof response?.nextCursor === "string" && response.nextCursor.length > 0;
    const data = response?.data ?? [];
    // [review] Capped before mapping, as on the Claude side.
    const serverLimit = Math.min(data.length, MAX_SCANNED_SERVERS);
    const servers: RawCatalogueServer[] = [];
    for (let index = 0; index < serverLimit; index += 1) {
      const entry = data[index];
      // `tools` is a map keyed by tool name; the values are full `Tool` objects
      // with schemas, and only the keys are taken. `Object.keys` would build
      // the whole key array first, so the keys are walked and counted instead.
      const toolNames: string[] = [];
      let more_tools = false;
      const tools = entry?.tools;
      if (isRecord(tools)) {
        for (const key in tools) {
          if (!Object.prototype.hasOwnProperty.call(tools, key)) continue;
          if (toolNames.length >= MAX_SCANNED_TOOLS_PER_SERVER) {
            more_tools = true;
            break;
          }
          toolNames.push(key);
        }
      }
      servers.push({
        name: entry?.name,
        state: codexServerState(entry?.runtimeStatus),
        toolNames,
        ...(more_tools ? { truncated: true } : {}),
      });
    }
    return { moreServers: more || data.length > serverLimit, servers };
  }

  listSkills(): CodexSkill[] {
    return this.skills;
  }

  /**
   * What `agents.describe` (SPEC R13) needs from a *live* Codex thread. The
   * other three fields of a `CodexDescribeSnapshot` (model, approvalPolicy,
   * sandbox) come from the agent's own config and need no harness at all —
   * `apps/desktop/src/ipc/agentsDescribe.ts`'s `codexConfigDefaults` builds
   * them, and this fills in the halves that only the app-server can answer.
   *
   * `listMcpServers` is a request with a timeout, and a Codex that is busy or
   * shutting down must not make an info card throw: a failed listing degrades
   * to no servers, which is what the card would honestly show anyway.
   */
  async describeSnapshot(): Promise<{
    mcpServers: CodexMcpServerStatus[];
    skills: CodexSkill[];
  }> {
    let mcpServers: CodexMcpServerStatus[] = [];
    try {
      mcpServers = await this.listMcpServers();
    } catch (err) {
      this.log.warn("[codex] MCP server listing unavailable for describe", err);
    }
    return { mcpServers, skills: this.skills };
  }

  // -------------------------------------------------------------------------
  // interrupt / dispose
  // -------------------------------------------------------------------------

  async interrupt(): Promise<boolean> {
    const turn = this.active;
    if (!turn || turn.settled) return false;
    turn.interrupted = true;
    turn.markTurnIdKnown();
    // Releases a local authorization still waiting on this turn's card;
    // `settle()` only runs once Codex answers, which may be much later.
    turn.cancel.abort();

    // Anything waiting on the user would otherwise hold the turn open forever.
    this.cancelPending("interrupted");

    if (this.threadId && turn.codexTurnId && this.client?.running) {
      try {
        await this.client.request(CODEX_METHODS.turnInterrupt, {
          threadId: this.threadId,
          turnId: turn.codexTurnId,
        });
      } catch (err) {
        this.log.warn(`[codex] turn/interrupt was refused: ${describe(err)}`);
      }
    }
    // Codex normally answers with `turn/completed` (status `interrupted`); if it
    // does not, end the turn anyway rather than leaving the UI spinning.
    this.armFallback(turn, this.deps.interruptGraceMs ?? DEFAULT_INTERRUPT_GRACE_MS, "interrupted");
    return true;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.active?.cancel.abort();
    // Before `cancelPending`, and awaited: an in-flight dynamic tool call or
    // approval reply has to reach the wire while the transport is still open.
    await this.drainDynamicCalls();
    await this.drainOutstandingApprovals();
    this.cancelPending("closed");
    const turn = this.active;
    if (turn && !turn.settled) this.settle(turn, "interrupted");
    this.unsubscribe?.();
    this.unsubscribe = null;
    const client = this.client;
    this.client = null;
    this.ready = null;
    await client?.close();
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  /**
   * Release every outstanding server request: the card gets its terminal state
   * (denied / cancelled / declined — never an approval, SPEC R27) and the
   * app-server gets the reply it is blocked on.
   *
   * Called from `settle()` too, which is the bug this exists for: a
   * `turn/completed` that arrived while an approval was still open used to
   * close the turn and leave the promise dangling, so the card stayed pending
   * for the rest of the session and Codex waited forever for a decision.
   */
  private cancelPending(why: string): void {
    // Dynamic-tool calls are outstanding server requests too — they just settle
    // by aborting their tool rather than by answering a card.
    this.abortDynamicCalls();
    for (const [requestId, entry] of [...this.pending]) {
      this.pending.delete(requestId);
      this.questionIds.delete(requestId);
      this.emitBlock(entry.key, entry.cancelPatch(why));
      resolvePending(entry, why);
    }
  }

  private emit(event: EngineEvent): void {
    this.active?.out.push(event);
  }

  private emitBlock(key: string, patch: BlockPatch): void {
    this.active?.out.push({ type: "block", key, patch });
  }

  private armFallback(turn: ActiveTurn, ms: number, status: "done" | "interrupted"): void {
    if (turn.timer) clearTimeout(turn.timer);
    turn.timer = setTimeout(() => {
      if (!turn.settled) this.settle(turn, status);
    }, ms);
    turn.timer.unref?.();
  }

  private effort(): string | undefined {
    return readCodexConfig(this.agent?.config).reasoningEffort;
  }

  /**
   * SPEC R25: keep the whole output in the row, show a stub when it is huge.
   * Same contract as the Claude harness — `fullOutput` carries the original so
   * the stub is expandable and nothing is lost at the harness boundary.
   */
  private clampOutput(value: unknown): {
    output: unknown;
    truncated: boolean;
    fullOutput?: unknown;
  } {
    const limit = this.deps.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS;
    if (typeof value === "string") {
      if (value.length <= limit) return { output: value, truncated: false };
      return {
        output: `${value.slice(0, limit)}\n… ${value.length - limit} more characters`,
        truncated: true,
        fullOutput: value,
      };
    }
    if (value === null || value === undefined) return { output: value ?? null, truncated: false };
    let serialised: string;
    try {
      serialised = JSON.stringify(value) ?? "";
    } catch {
      return { output: String(value), truncated: false };
    }
    if (serialised.length <= limit) return { output: value, truncated: false };
    return {
      output: `${serialised.slice(0, limit)}\n… ${serialised.length - limit} more characters`,
      truncated: true,
      fullOutput: value,
    };
  }

  private settle(turn: ActiveTurn, status: "done" | "error" | "interrupted", error?: string): void {
    if (turn.settled) return;
    turn.cancel.abort();
    // Releases anything still waiting to correlate against an id this turn will
    // now never learn.
    turn.markTurnIdKnown();
    // Before the queue closes, not after: a request still waiting on the user
    // has to be cancelled while its card update can still reach the transcript.
    this.cancelPending(status === "interrupted" ? "interrupted" : "the turn ended");
    turn.settled = true;
    if (turn.timer) clearTimeout(turn.timer);
    turn.out.push({ type: "turn", status, ...(error ? { error } : {}) });
    turn.out.close();
    if (this.active === turn) this.active = null;
  }
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The refusal vocabulary for `item/tool/call`.
 *
 * A fixed code plus a fixed sentence, and nothing else. The reply goes into a
 * model's context and the log goes to disk, so neither may carry an exception
 * message, a stack, or an identifier the caller chose — a tool error can quote
 * a URL with a token in it, and a hostile `tool` name can be a megabyte long.
 * The model is told what to do next; the operator reads the code.
 */
const DYNAMIC_FAILURES = {
  unavailable: "capygen declared no client-hosted tools on this Codex thread.",
  wrong_thread: "This call names a different Codex thread than the one capygen is running.",
  no_active_turn: "The capygen turn this call belongs to has ended or was cancelled.",
  wrong_turn: "This call names a Codex turn that is no longer the active one.",
  namespace_unsupported: "capygen declares no tool namespace, so this call cannot be resolved.",
  bad_call_id: "This call carries no usable callId, so capygen will not run it.",
  unknown_tool: "capygen declares no tool under that name on this thread.",
  bad_arguments: "The arguments must be a JSON object matching the tool's declared schema.",
  duplicate_call: "capygen has already handled a call with this callId and will not run it twice.",
  denied_by_mode: "capygen's current permission mode does not allow this tool.",
  denied: "The user denied this tool call in capygen.",
  cancelled: "This tool call was cancelled in capygen.",
  tool_error: "The tool failed inside capygen. The failure was not reported here.",
} as const;

type DynamicFailureCode = keyof typeof DYNAMIC_FAILURES;

/**
 * A refused or failed `item/tool/call`. `success: false` with one text item is
 * the schema's own way of saying "the tool ran and did not work" — the model
 * reads the sentence and can pick another route.
 *
 * `detail` is only ever passed a string capygen composed itself (the permission
 * gate's own explanation), never anything from the wire or a tool.
 */
function dynamicFailure(code: DynamicFailureCode, detail?: string): CodexDynamicToolCallResponse {
  const text = clampUtf8Bytes(
    `${code}: ${detail ?? DYNAMIC_FAILURES[code]}`,
    DYNAMIC_FAILURE_MAX_BYTES,
  );
  const item: CodexDynamicToolCallOutputContentItem = { type: "inputText", text };
  return { contentItems: [item], success: false };
}

/** The sentinel a raced abort resolves with; a unique object, so no tool result
 *  can ever be mistaken for it. */
const ABORTED: unique symbol = Symbol("capygen.dynamicToolAborted");

function abortPromise(signal: AbortSignal): Promise<typeof ABORTED> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(ABORTED);
      return;
    }
    signal.addEventListener("abort", () => resolve(ABORTED), { once: true });
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * An identifier from the wire, made safe to put in a log line: bounded, on one
 * line, and with control characters removed so it cannot forge log structure.
 */
function safeLabel(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ");
  return cleaned.length > 64 ? `${cleaned.slice(0, 64)}…` : cleaned;
}

/**
 * SPEC R25's arithmetic, done in **UTF-8 bytes** rather than JS characters.
 *
 * `clampText` counts `String.length`, which is UTF-16 code units: 40 000 emoji
 * are 80 000 units but 160 000 bytes, so a 64 K *character* budget lets a
 * quarter of a megabyte through. `TextEncoder`/`TextDecoder` do it exactly.
 */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * The longest prefix of `text` that fits in `maxBytes`, cut on a character
 * boundary. Decoding a truncated buffer without `fatal` replaces the sequence
 * the cut split; trimming that replacement character is what keeps the result
 * valid text rather than ending in U+FFFD.
 */
function headUtf8Bytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= maxBytes) return text;
  return new TextDecoder("utf-8").decode(encoded.subarray(0, maxBytes)).replace(/\uFFFD+$/, "");
}

/** `headUtf8Bytes` plus a fixed notice, budgeted together so the result — the
 *  notice included — never exceeds `maxBytes`. */
function clampUtf8Bytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  const notice = "\n… truncated by capygen";
  return `${headUtf8Bytes(text, maxBytes - byteLength(notice))}${notice}`;
}

/** `v2/McpServerConnectionStatus.ts` → the shared vocabulary. `null` means the
 *  runtime state is unavailable or the configuration changed, which is not the
 *  same claim as "not started". */
function codexServerState(raw: unknown): CatalogueServerState {
  switch (raw) {
    case "connected":
      return "connected";
    case "failed":
      return "failed";
    case "authenticationRequired":
      return "needsAuth";
    case "starting":
      return "pending";
    case "disabled":
      return "disabled";
    case "notStarted":
      return "notStarted";
    case "cancelled":
      return "cancelled";
    default:
      return "unknown";
  }
}

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

function resolvePending(entry: PendingAnswer, why: string): void {
  if (entry.kind === "permission") entry.resolve({ behavior: "deny", message: why });
  else if (entry.kind === "question") entry.resolve({});
  else entry.resolve(null);
}

/**
 * `PermissionAnswer` (harness.ts) is `allow | deny` only, because a Codex or API
 * harness never needs to know about "always". The desktop's `permission.answer`
 * channel *does* carry a three-way choice and collapses it, so an optional
 * `scope` may ride along on the same object; reading it here is what turns
 * "always" into Codex's `acceptForSession` without widening the interface.
 */
function scopeOf(answer: PermissionAnswer): "once" | "session" | "always" {
  const scope = (answer as { scope?: unknown }).scope;
  return scope === "session" || scope === "always" ? scope : "once";
}

export function commandDecision(answer: PermissionAnswer): CodexCommandApprovalDecision {
  if (answer.behavior !== "allow") return "decline";
  return scopeOf(answer) === "once" ? "accept" : "acceptForSession";
}

function commandStatus(item: CodexItem & { type: "commandExecution" }): ToolCallStatus {
  switch (item.status) {
    case "completed":
      return item.exitCode === null || item.exitCode === undefined || item.exitCode === 0
        ? "success"
        : "error";
    case "failed":
      return "error";
    case "declined":
      return "denied";
    default:
      return "running";
  }
}

function patchStatus(status: string | undefined): ToolCallStatus {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "error";
    case "declined":
      return "denied";
    default:
      return "running";
  }
}

function mcpStatus(status: string | undefined, hasError: boolean): ToolCallStatus {
  if (hasError || status === "failed") return "error";
  return status === "completed" ? "success" : "running";
}

/**
 * `CollabAgentStatus` → the four-value `SubagentBlock.status` enum
 * (`packages/shared/src/domain.ts`), the same target `ClaudeHarness`'s own
 * `subagentStatus` maps onto. This is the *target agent's* state — preferred
 * over the tool call's own status whenever `agentsStates` has an entry.
 */
function collabAgentStatus(
  status: CodexCollabAgentState["status"],
): "spawned" | "running" | "done" | "error" {
  switch (status) {
    case "completed":
      return "done";
    case "running":
      return "running";
    case "pendingInit":
      return "spawned";
    case "interrupted":
    case "errored":
    case "shutdown":
    case "notFound":
    default:
      return "error";
  }
}

/** `CollabAgentToolCallStatus` → the same four-value enum, used only when the
 *  item carries no `agentsStates` entry for a given receiver yet. */
function collabToolCallStatus(
  status: CodexCollabAgentToolCallItem["status"],
): "spawned" | "running" | "done" | "error" {
  switch (status) {
    case "completed":
      return "done";
    case "inProgress":
      return "running";
    case "failed":
    case "interrupted":
    default:
      return "error";
  }
}

/** `SubAgentActivityKind` → the same four-value enum. `interrupted` reads as
 *  `error` rather than a fifth status the schema does not have — the same
 *  choice `ClaudeHarness.subagentStatus` makes for `killed`/`failed`. */
function subAgentActivityStatus(
  kind: CodexSubAgentActivityItem["kind"],
): "spawned" | "running" | "done" | "error" {
  switch (kind) {
    case "completed":
      return "done";
    case "started":
    case "interacted":
      return "running";
    case "interrupted":
    default:
      return "error";
  }
}

/** Additions/deletions from a unified diff, ignoring the `+++`/`---` headers. */
export function countDiff(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

export interface CodexAgentSettings {
  model?: string;
  approvalPolicy?: "untrusted" | "on-request" | "on-failure" | "never";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  reasoningEffort?: string;
}

/**
 * Reads the optional `agent.config.codex` block (`CodexAgentConfigSchema` in
 * `@capygen/shared`), ignoring anything unknown. Defaults live at the call site
 * so they are visible next to the request that uses them: `on-request` +
 * `workspace-write`.
 */
export function readCodexConfig(config: unknown): CodexAgentSettings {
  const root = isRecord(config) && isRecord(config.codex) ? config.codex : {};
  const out: CodexAgentSettings = {};
  const model = str(root.model);
  if (model) out.model = model;
  const policy = str(root.approvalPolicy);
  if (
    policy === "untrusted" ||
    policy === "on-request" ||
    policy === "on-failure" ||
    policy === "never"
  ) {
    out.approvalPolicy = policy;
  }
  const sandbox = str(root.sandbox);
  if (
    sandbox === "read-only" ||
    sandbox === "workspace-write" ||
    sandbox === "danger-full-access"
  ) {
    out.sandbox = sandbox;
  }
  const effort = str(root.reasoningEffort);
  if (effort) out.reasoningEffort = effort;
  return out;
}

export type { UsageTotals };
