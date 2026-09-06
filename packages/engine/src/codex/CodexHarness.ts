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
  type PermissionRequest,
  type Question,
  type SlashCommand,
  type ToolCallFamily,
  type ToolCallStatus,
  type UsageTotals,
} from "@capygen/shared";
import { AsyncQueue } from "../asyncQueue.js";
import type { EnvRecord } from "../env.js";
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
  type CodexTurnCompletedNotification,
  type CodexTurnStartResponse,
  type CodexUserInput,
  type CodexUserInputParams,
} from "./protocol.js";

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
}

export const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 64 * 1024;
const DEFAULT_INTERRUPT_GRACE_MS = 5_000;
const DEFAULT_COMPACT_GRACE_MS = 60_000;
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
  private sandbox = "workspace-write";

  private active: ActiveTurn | null = null;
  private readonly pending = new Map<string, PendingAnswer>();
  /** questionRequestId → question text → Codex's own question id. */
  private readonly questionIds = new Map<string, Map<string, string>>();

  private commands: SlashCommand[] = [...CODEX_BUILTIN_COMMANDS];
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
      usage: null,
      fatal: null,
      settled: false,
      interrupted: false,
      timer: null,
    };
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
    };

    if (this.threadId) {
      try {
        const resumed = await this.client!.request<CodexThreadStartResponse>(
          CODEX_METHODS.threadResume,
          { threadId: this.threadId, ...base, excludeTurns: true },
        );
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
      base,
    );
    this.applyThreadResponse(started, approvalPolicy, sandbox);
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
        if (turn && !turn.codexTurnId && id) turn.codexTurnId = id;
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
      case CODEX_SERVER_REQUESTS.currentTime:
        return { currentTimeAt: Math.floor(Date.now() / 1000) };
      default:
        // Everything else (permission-profile grants, dynamic client tools,
        // token refresh, attestation) is declined with a JSON-RPC error rather
        // than answered with a guess — Codex then applies its own default.
        throw new Error(`capygen does not handle ${method} yet`);
    }
  }

  private async askCommandApproval(params: CodexCommandApprovalParams): Promise<CodexCommandApprovalDecision> {
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
    return commandDecision(answer);
  }

  private async askFileChangeApproval(
    params: CodexFileChangeApprovalParams,
  ): Promise<CodexCommandApprovalDecision> {
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
    return commandDecision(answer);
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
