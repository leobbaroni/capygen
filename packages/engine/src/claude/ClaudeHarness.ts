/**
 * The Claude Code harness — drives the Claude Agent SDK headlessly and turns its
 * message stream into `EngineEvent`s (SPEC R7).
 *
 * Shape decisions, all taken from the Phase 1 spike
 * (`docs/spikes/claude-sdk-shapes.md`, `docs/spikes/engine.md`) rather than from
 * the SDK's prose:
 *
 *  - **One long-lived `query()` per agent, streaming input.** Each `query()` is a
 *    new process with a new session id, and a cold process re-writes the whole
 *    ~20 k-token prefix (spike §8.7). Holding one streaming-input session open
 *    and pushing each turn's `SDKUserMessage` into it keeps `cache_read` high and
 *    injects no per-turn system text — SPEC R24's "do not break the SDK's cache".
 *  - **`result` is the turn boundary** (`sdk.d.ts:5000-5003`): exactly one per
 *    turn, and it carries the usage totals.
 *  - **`modelUsage` is cumulative** inside a streaming session, so per-turn usage
 *    is the delta against the previous result — never the raw numbers.
 *  - **Sub-agents arrive as `Agent`, not `Task`** (spike §8.6): the `PreToolUse`
 *    matcher is `'Task|Agent'`.
 *  - **`AskUserQuestion` is answered through `canUseTool`** by returning
 *    `{behavior:'allow', updatedInput:{...input, answers}}` (spike §4).
 *  - **`Options.env` replaces the child environment**, so `cleanEnv()` returns a
 *    complete one.
 */
import {
  newId,
  type Backend,
  type PermissionRequest,
  type Question,
  type SlashCommand,
  type ToolCallStatus,
  type UsageTotals,
} from "@capygen/shared";
import { AsyncQueue } from "../asyncQueue.js";
import { cleanEnv, type EnvRecord } from "../env.js";
import {
  EMPTY_USAGE,
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
  loadClaudeQuery,
  type ClaudeHookInput,
  type ClaudeHookOutput,
  type ClaudeOptions,
  type ClaudeQuery,
  type ClaudeQueryFn,
  type SDKUserMessage,
} from "./sdk.js";
import type { ClaudeInitSnapshot } from "./describe.js";
import {
  authorizeLocally,
  jsonSnapshot,
  type LocalAuthorize,
  type PolicyBoundarySupport,
} from "../policy/types.js";
import { mergeReservedServers } from "../config/nativeMcpOverrides.js";
import {
  CatalogueRunner,
  MAX_SCANNED_SERVERS,
  MAX_SCANNED_TOOLS_PER_SERVER,
  type CatalogueOptions,
  type CatalogueServerState,
  type RawCatalogueServer,
  type ToolCatalogue,
} from "../catalogue/types.js";

export interface HarnessLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

const NO_LOG: HarnessLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** What the routing policy is asked about when an agent spawns a sub-agent. */
export interface SubagentRouteRequest {
  sessionId: string;
  agentId: string;
  toolName: string;
  toolUseId: string | undefined;
  description: string;
  subagentType: string | undefined;
  /** The Task/Agent tool input, verbatim. */
  input: Record<string, unknown>;
}

/** A decision from the routing policy. `null`/throw ⇒ fail open (SPEC R12). */
export interface SubagentRoute {
  /** `'sonnet' | 'opus' | 'haiku' | 'fable'` — rewrites `AgentInput.model`. */
  model?: string;
  /**
   * [B1] The backend the sub-agent runs on. Only ever this harness's own
   * backend here: the hook's single lever is `updatedInput.model`, so a
   * cross-backend decision is enforced by `delegate_task` instead and the
   * router returns nothing at all (`routing/policy.ts`). Recorded on the
   * `subagent` block so the agent tree (R13) can show where a spawn went.
   */
  backend?: Backend;
}

export interface ClaudeHarnessDeps {
  /** Bounded no-tools policy authoring; never a Claude Code preset. */
  authoringSystemPrompt?: string;
  /** Custom Mode routes every spawn through structured delegate_task (ADR-0006). */
  disableNativeSubagents?: boolean;
  /** Injected in tests; the real `query` is loaded lazily when absent. */
  query?: ClaudeQueryFn;
  loadQuery?: () => Promise<ClaudeQueryFn>;
  /** Base environment; `cleanEnv` is applied on top. Defaults to `process.env`. */
  env?: EnvRecord;
  log?: HarnessLogger;
  /**
   * Sub-agent routing policy (SPEC R12). With nothing wired the hook returns
   * `{}` and the sub-agent inherits its parent's model; `routing/policy.ts`'s
   * `createSubagentRouter` is what the desktop passes.
   */
  routeSubagent?: (req: SubagentRouteRequest) => SubagentRoute | null | undefined;
  /**
   * [B1] Extra `mcpServers` for the backend session — today only capygen's own
   * in-process `delegate_task` server (SPEC R12, `routing/sdkMcp.ts`).
   *
   * Resolved **once**, when the session's `query()` is created, never per
   * turn: `mcpServers` is part of the request shape the prompt cache keys on
   * (R24), and an MCP server list that changed between turns would cost the
   * whole prefix each time. Returning `null` is normal — it means this agent's
   * sub-agents run natively and there is nothing to add.
   */
  /**
   * The complete MCP server set this backend session must run, when capygen's
   * resolution differs from what the CLI would read on its own.
   *
   * Authoritative, not additive: it is accompanied by `strictMcpConfig`, so the
   * CLI uses exactly this set instead of also loading its own files. That is
   * the only way a session can *remove* a server the user's files enable, and
   * it is what stops every native server being started twice. Absent means the
   * session adds nothing, and the CLI's own configuration is left alone.
   */
  resolvedMcpServers?: () =>
    | Promise<Record<string, Record<string, unknown>> | null>
    | Record<string, Record<string, unknown>>
    | null;
  mcpServers?: () =>
    | Promise<Record<string, unknown> | null>
    | Record<string, unknown>
    | null;
  /** `settingSources` for the child (spike §8.8 gotcha 4). */
  settingSources?: ("user" | "project" | "local")[];
  /** capygen's own restrictions (ADR-0007), enforced in the pre-tool hook. */
  authorizeLocal?: LocalAuthorize;
  /**
   * What the hook answers when it rewrites a spawn's model (SPEC R12).
   *
   * `"neutral"` is the default, **on evidence**: `probe-claude-hook-precedence`
   * drives the real CLI and shows a routed spawn reaching the routed model with
   * no `permissionDecision` at all (`routing-neutral`), while a native `deny` on
   * the spawn still stops it (`routing-neutral-under-native-deny`).
   *
   * `"allow"` — the Phase 1 spike's original lever — is kept only so that probe
   * can compare the two. It is an unconditional native allow, which ADR-0007
   * forbids for anything downstream of a policy verdict, so nothing should ship
   * with it.
   */
  routingPermissionDecision?: "allow" | "neutral";
  /** Tool output kept in a block before it is stubbed (SPEC R25). */
  maxToolOutputChars?: number;
  /** How long to wait for the backend's own `result` after an interrupt. */
  interruptGraceMs?: number;
}

export const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 64 * 1024;
const DEFAULT_INTERRUPT_GRACE_MS = 5_000;
/** Wire names of the sub-agent tool: `init.tools` says Task, the model emits Agent. */
const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);
export const SUBAGENT_HOOK_MATCHER = "Task|Agent";

/**
 * The wire names of Claude's sub-agent tool. `init.tools` advertises `Task`
 * while the hook and `tool_use` frames both say `Agent` (spike §8.6), so the
 * routing branch of the matcher-less hook keys on either.
 */
export const SUBAGENT_TOOL_NAMES = new Set(SUBAGENT_HOOK_MATCHER.split("|"));
/**
 * Tools whose whole purpose is the card `canUseTool` already emitted. Their
 * `tool_use` / `tool_result` frames would otherwise render a second, raw
 * tool-call card next to the interactive one (the question card *is* the
 * rendering of this call), so they are folded into the block keyed
 * `question:<toolUseId>` instead. Matches Claude Code's own transcript.
 */
const INTERACTION_TOOLS = new Set(["AskUserQuestion"]);

interface ActiveTurn {
  turnId: string;
  out: AsyncQueue<EngineEvent>;
  /** Accumulated text per block key, so a delta only needs the tail. */
  text: Map<string, string>;
  /**
   * [C] `<messageId>:<streamIndex>` → the block key that stream position was
   * given. Text and thinking blocks are keyed by their ordinal **within their
   * kind**, not by the raw content index, because the two representations of
   * one message disagree about indices: the settled `assistant` message drops
   * the thinking block the `content_block_delta` stream sent, so a reply whose
   * stream was `[0]=thinking, [1]=text` arrives settled as `[0]=text`. Keyed by
   * index, that wrote the answer twice — once over the thinking block and once
   * under its own key — and the transcript showed the whole reply twice.
   */
  contentKeys: Map<string, string>;
  /** Per message, how many blocks of each kind have been seen so far. */
  contentCounts: Map<string, number>;
  /** tool_use id → block key, so a tool_result finds the block it belongs to. */
  toolKeys: Map<string, string>;
  /** task_id → tool_use id, for the `system/task_*` frames. */
  taskToolUse: Map<string, string>;
  /** Sub-agent blocks by tool_use id, keyed for later status updates. */
  subagents: Map<
    string,
    {
      name: string;
      description: string;
      model: string | null;
      backend: Backend;
      delegated: boolean;
    }
  >;
  /** tool_use ids of INTERACTION_TOOLS calls, whose frames are not re-rendered. */
  interactionToolUseIds: Set<string>;
  /**
   * Callbacks that abort work bound to this turn — a hook waiting on a local
   * authorization, today. Run on settle, so an interrupt cannot leave an
   * approval outstanding that later authorizes a call into a finished turn.
   */
  cancellations: Set<() => void>;
  settled: boolean;
  interrupted: boolean;
  interruptTimer: ReturnType<typeof setTimeout> | null;
}

type PendingPermission = {
  kind: "permission";
  resolve: (a: PermissionAnswer) => void;
};
/**
 * `null` is the *cancelled* sentinel, not an empty answer map. Resolving a
 * torn-down question with `{}` used to look like a real submission all the way
 * to the card (`{}` is truthy), so an interrupted AskUserQuestion rendered as a
 * green "Submitted" with nothing in it — see `QuestionBlockSchema.status`.
 */
type PendingQuestion = {
  kind: "question";
  resolve: (a: Record<string, string> | null) => void;
};

export class ClaudeHarness implements Harness {
  readonly backend: Backend = "claude";

  private readonly deps: ClaudeHarnessDeps;
  private readonly log: HarnessLogger;

  private session: HarnessSession | null = null;
  private agent: HarnessAgent | null = null;

  private query: ClaudeQuery | null = null;
  private queryInput: AsyncQueue<SDKUserMessage> | null = null;
  private pump: Promise<void> | null = null;
  private abort: AbortController | null = null;

  private active: ActiveTurn | null = null;
  private readonly pending = new Map<string, PendingPermission | PendingQuestion>();

  private commands: SlashCommand[] = [];
  /** The last `system/init` payload, so the list can be rebuilt when the
   *  descriptions arrive from `supportedCommands()` (R14). */
  private commandSource: { slash_commands?: unknown; skills?: unknown; plugins?: unknown } = {};
  /** `{name, description, argumentHint, aliases}` from the SDK control request. */
  private commandDetails: SdkSlashCommandDetail[] = [];
  /**
   * The last `system/init`, narrowed to what an info card reads (SPEC R13).
   * Null until the first turn starts: `init` is the *only* place the SDK
   * reports this session's tool list, MCP servers and permission mode, so an
   * agent that has not spoken yet honestly has no snapshot rather than a guess
   * assembled from its config.
   */
  private initSnapshot: ClaudeInitSnapshot | null = null;
  private sdkSessionId: string | null = null;
  /** In-flight `ensureQuery`, so racing callers share one backend session. */
  private starting: Promise<void> | null = null;
  private readonly catalogueRunner = new CatalogueRunner({
    initialize: () => this.ensureQuery(),
    lifecycle: () => this.query,
    fetch: () => this.fetchCatalogue(),
    // A code, never the backend's own words: an MCP launch failure quotes the
    // command line it tried, and this line is written to a log file.
    onFailure: (code) => this.log.warn(`[claude] the MCP catalogue is unavailable (${code})`),
  });
  private resolvedModel: string | null = null;
  /** Latest cumulative `modelUsage`, so each turn reports its own delta. */
  private lastByModel: Record<string, UsageTotals> = {};
  private disposed = false;
  /**
   * Bumped whenever the backend session this harness owns is torn down.
   *
   * [review] `ensureQuery`'s memo stops two callers *starting* two sessions; it
   * does nothing about a dispose that lands while the one in flight is still
   * awaiting. `doEnsureQuery` awaits the SDK module and the extra MCP server
   * list before it calls `queryFn`, and both are somebody else's promise — so a
   * catalogue refresh that raced a dispose used to spawn a CLI child for a
   * harness the app had already released, with nothing left to dispose it.
   */
  private generation = 0;
  /** Anchors block keys to the assistant message they came from. */
  private currentMessageId = "m0";
  /** tool_use id → name/input, so a later tool_result re-upserts a whole block. */
  private readonly toolNames = new Map<string, string>();
  private readonly toolInputs = new Map<string, unknown>();

  constructor(deps: ClaudeHarnessDeps = {}) {
    this.deps = deps;
    this.log = deps.log ?? NO_LOG;
  }

  async start(session: HarnessSession, agent: HarnessAgent): Promise<void> {
    this.session = session;
    this.agent = agent;
    this.sdkSessionId = agent.resumeSessionId ?? null;
  }

  capabilities(): HarnessCapabilities {
    return {
      streamingDeltas: true,
      permissions: true,
      questions: true,
      subagents: true,
      resume: true,
      interrupt: true,
      slashCommands: true,
    };
  }

  listCommands(): SlashCommand[] {
    return this.commands;
  }

  /**
   * What `agents.describe` (SPEC R13) needs from this backend: the fields of
   * the last `system/init`, or `null` before the first turn has started one.
   * `describeClaudeAgent` in `./describe.ts` turns it into the card's text;
   * this getter is the "wiring a getter that also remembers `tools`,
   * `mcp_servers` and `permissionMode`" that file's header asks for.
   */
  describeSnapshot(): ClaudeInitSnapshot | null {
    return this.initSnapshot;
  }

  backendSessionId(): string | null {
    return this.sdkSessionId;
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
      out,
      text: new Map(),
      contentKeys: new Map(),
      contentCounts: new Map(),
      toolKeys: new Map(),
      taskToolUse: new Map(),
      subagents: new Map(),
      interactionToolUseIds: new Set(),
      cancellations: new Set(),
      settled: false,
      interrupted: false,
      interruptTimer: null,
    };
    this.active = turn;

    if (ctx.signal) {
      const onAbort = (): void => void this.interrupt();
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener("abort", onAbort, { once: true });
    }

    void this.dispatch(turn, input.text).catch((err: unknown) => {
      this.settle(turn, "error", describe(err));
    });

    return out;
  }

  /** Make sure a query exists, then push this turn's user message into it. */
  private async dispatch(turn: ActiveTurn, text: string): Promise<void> {
    await this.ensureQuery();
    const message: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    };
    this.queryInput?.push(message);
  }

  /**
   * Concurrency-safe: `ensureQuery` awaits before it assigns `this.query`, so
   * two callers arriving together — a turn and a catalogue refresh, or two
   * refreshes — both used to pass the guard and build a second streaming
   * session, orphaning the first CLI child. The in-flight promise is memoised.
   */
  private ensureQuery(): Promise<void> {
    if (this.query && this.queryInput && !this.queryInput.isClosed) return Promise.resolve();
    this.starting ??= this.doEnsureQuery().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doEnsureQuery(): Promise<void> {
    if (this.query && this.queryInput && !this.queryInput.isClosed) return;
    const session = this.session;
    const agent = this.agent;
    if (!session || !agent) throw new Error("ClaudeHarness.start() was never called");

    // Sampled once, compared after every await below: a dispose (or a teardown
    // that starts a new session) while this is in flight must abandon it rather
    // than finish building a backend nobody owns any more.
    const generation = this.generation;
    const superseded = (): boolean => this.disposed || this.generation !== generation;

    const queryFn =
      this.deps.query ?? (await (this.deps.loadQuery ?? loadClaudeQuery)());
    // Nothing has been assigned yet, so there is nothing to unwind.
    if (superseded()) return;

    const inputQueue = new AsyncQueue<SDKUserMessage>();
    const abort = new AbortController();
    this.queryInput = inputQueue;
    this.abort = abort;

    // Resolved before `buildOptions` so it is part of the one options object
    // this backend session is built from (see `mcpServers` on the deps).
    let extraServers: Record<string, unknown> | null = null;
    try {
      extraServers = (await this.deps.mcpServers?.()) ?? null;
    } catch (err) {
      // R12 fails open: no delegation tool beats no session.
      this.log.warn("[claude] the extra MCP server list could not be built", err);
    }
    // The session's own resolved set, when it differs from the CLI's files.
    // Built here, with `extraServers`, so both are part of the one options
    // object this backend session is created from (R24: an MCP list that moved
    // between turns is a cache miss on every turn).
    let resolvedServers: Record<string, Record<string, unknown>> | null = null;
    try {
      resolvedServers = (await this.deps.resolvedMcpServers?.()) ?? null;
    } catch (err) {
      // Fails *closed* on purpose, unlike delegation: silently starting the
      // session with the CLI's own list would run servers a session had
      // switched off, which is the opposite of what the user asked for.
      this.log.warn("[claude] the session MCP server list could not be resolved");
      throw new Error("The session MCP server list could not be resolved.");
    }
    if (superseded()) {
      // `dispose()` already nulled these; only clear them when they are still
      // the ones this call put there, so a newer session is never disturbed.
      inputQueue.close();
      if (this.queryInput === inputQueue) this.queryInput = null;
      if (this.abort === abort) this.abort = null;
      return;
    }

    const options = this.buildOptions(session, agent, abort, extraServers, resolvedServers);
    this.log.info(
      `[claude] starting session for agent ${agent.agentId} model=${agent.model}` +
        `${options.resume ? ` resume=${options.resume}` : ""}`,
    );

    const q = queryFn({ prompt: inputQueue, options });
    // The last possible moment: `queryFn` is synchronous, but a dispose that
    // landed during `buildOptions` must not leave the child running.
    if (superseded()) {
      try {
        void q.return?.(undefined);
      } catch {
        /* a generator mid-yield refuses; the abort below is what matters */
      }
      try {
        abort.abort();
      } catch {
        /* already aborted */
      }
      inputQueue.close();
      if (this.queryInput === inputQueue) this.queryInput = null;
      if (this.abort === abort) this.abort = null;
      return;
    }
    this.query = q;
    this.pump = this.runPump(q);
  }

  /**
   * Built once per backend session, never per turn: a changing system prompt or
   * tool list is exactly what invalidates the prefix cache (SPEC R24). Note that
   * `systemPrompt` is deliberately absent — the SDK's own Claude Code preset is
   * what the CLI uses, and matching it is what keeps the cache warm.
   */
  private buildOptions(
    session: HarnessSession,
    agent: HarnessAgent,
    abort: AbortController,
    extraServers: Record<string, unknown> | null = null,
    resolvedServers: Record<string, Record<string, unknown>> | null = null,
  ): ClaudeOptions {
    const config = readClaudeConfig(agent.config);
    const permissionMode = agent.permissionMode ?? config.permissionMode ?? "default";
    const options: ClaudeOptions = {
      cwd: session.projectPath,
      env: cleanEnv(this.deps.env),
      abortController: abort,
      model: agent.model,
      permissionMode,
      settingSources: config.settingSources ??
        this.deps.settingSources ?? ["user", "project"],
      includePartialMessages: true,
      canUseTool: (toolName, toolInput, opts) =>
        this.onCanUseTool(toolName, toolInput, opts),
      hooks: {
        PreToolUse: [
          // No matcher: every tool call, so a local restriction can reach one.
          {
            hooks: [
              (hookInput, toolUseId, hookOptions) =>
                this.onPreToolUse(hookInput, toolUseId, hookOptions as { signal?: AbortSignal }),
            ],
          },
        ],
      },
      stderr: (chunk: string) => this.log.warn(`[claude:stderr] ${chunk.trimEnd()}`),
    };
    // [B1] The round table's session-stable addition (ADR-0002). `append` on
    // the `claude_code` preset, not a custom prompt: the preset *is* what the
    // CLI sends, and replacing it would cost the cache and the CLI's own
    // behaviour. `snapshot: true` records the rendered prompt for the
    // conversation, so a later launch with a changed roster does not silently
    // rewrite the prefix mid-session (sdk.d.ts on `systemPrompt.snapshot`).
    if (agent.promptAddition) {
      options.systemPrompt = {
        type: "preset",
        preset: "claude_code",
        append: agent.promptAddition,
        snapshot: true,
      };
    }
    if (resolvedServers) {
      // Authoritative for Claude, and only for Claude: `strictMcpConfig` is
      // documented as "only use MCP servers passed via the `mcpServers` option
      // … ignoring all other MCP configurations" (sdk.d.ts:2128-2134). Without
      // it the CLI would *also* load its own files, starting every native
      // server twice — and a session could never switch one off, because
      // omission would mean nothing.
      const { merged, displaced } = mergeReservedServers(
        resolvedServers,
        (extraServers ?? {}) as Record<string, Record<string, unknown>>,
      );
      for (const name of displaced) {
        // capygen's own server keeps the name the model's tool name is built
        // from; the configured entry that wanted it is not applied, and says so.
        this.log.warn(
          `[claude] the configured MCP server "${name}" was not applied: capygen reserves that name for its own tools`,
        );
      }
      options.mcpServers = merged as ClaudeOptions["mcpServers"];
      // A session override is the resolved effective set; strictness is
      // required to honor a disabled entry instead of loading it again.
      options.strictMcpConfig = true;
    } else if (extraServers && Object.keys(extraServers).length > 0) {
      options.mcpServers = {
        ...(options.mcpServers ?? {}),
        ...extraServers,
      } as ClaudeOptions["mcpServers"];
    }
    if (permissionMode === "bypassPermissions") options.allowDangerouslySkipPermissions = true;
    if (this.sdkSessionId) options.resume = this.sdkSessionId;
    if (!resolvedServers && config.strictMcpConfig !== undefined) options.strictMcpConfig = config.strictMcpConfig;
    if (config.allowedTools) options.allowedTools = config.allowedTools;
    if (config.skills) options.skills = config.skills;
    // Session-scoped like the rest of this object: effort is part of what the
    // backend session is started with, so it is set here rather than per turn
    // (SPEC R23/R24). Left unset when unconfigured, so the CLI's own default
    // applies rather than us pinning one.
    if (config.effort) options.effort = config.effort;
    if (this.deps.authoringSystemPrompt !== undefined) {
      options.systemPrompt = this.deps.authoringSystemPrompt;
      options.tools = [];
      options.settingSources = [];
      options.strictMcpConfig = true;
      options.mcpServers = {};
      options.hooks = {};
      options.maxTurns = 1;
      options.canUseTool = async () => ({ behavior: "deny", message: "Tools are disabled for policy authoring" });
      options.stderr = () => {};
      delete options.resume;
      delete options.skills;
      delete options.allowedTools;
    }
    return options;
  }

  /** Drain the SDK's message stream for the whole backend session. */
  private async runPump(q: ClaudeQuery): Promise<void> {
    try {
      for await (const message of q) {
        try {
          this.route(message as SdkMessageLike);
        } catch (err) {
          this.log.error("[claude] failed to map a message", err);
        }
      }
      this.onStreamEnded(null);
    } catch (err) {
      this.onStreamEnded(err);
    }
  }

  /** The SDK process ended (cleanly or not); the next send starts a new one. */
  private onStreamEnded(err: unknown): void {
    const wasActive = this.active;
    this.query = null;
    this.pump = null;
    this.queryInput?.close();
    this.queryInput = null;
    // A new backend process restarts the cumulative counters, so the next
    // result must be read as an absolute value, not a delta against this one.
    this.lastByModel = {};
    if (wasActive && !wasActive.settled) {
      if (wasActive.interrupted) this.settle(wasActive, "interrupted");
      else if (err) this.settle(wasActive, "error", describe(err));
      else this.settle(wasActive, "error", "the backend ended the stream mid-turn");
    } else if (err) {
      this.log.error("[claude] stream ended with an error", err);
    }
  }

  // -------------------------------------------------------------------------
  // message → event mapping
  // -------------------------------------------------------------------------

  private route(message: SdkMessageLike): void {
    switch (message.type) {
      case "system":
        this.routeSystem(message);
        return;
      case "stream_event":
        this.routeStreamEvent(message);
        return;
      case "assistant":
        this.routeAssistant(message);
        return;
      case "user":
        this.routeUser(message);
        return;
      case "result":
        this.routeResult(message);
        return;
      default:
        return;
    }
  }

  private routeSystem(message: SdkMessageLike): void {
    if (message.subtype === "init") {
      if (typeof message.session_id === "string") this.sdkSessionId = message.session_id;
      if (typeof message.model === "string") this.resolvedModel = message.model;
      this.commandSource = {
        slash_commands: message.slash_commands,
        skills: message.skills,
        plugins: message.plugins,
      };
      this.initSnapshot = readInitSnapshot(message, this.resolvedModel ?? this.agent?.model ?? "");
      this.rebuildCommands();
      this.emit({
        type: "session",
        backendSessionId: this.sdkSessionId ?? "",
        ...(this.resolvedModel ? { model: this.resolvedModel } : {}),
        commands: this.commands,
      });
      // `slash_commands` is a bare `string[]`; the descriptions and argument
      // hints the slash menu needs only exist behind this control request
      // (spike §8.1: 92 entries of `{name, description, argumentHint, aliases}`).
      void this.refreshCommandDetails();
      return;
    }
    // The CLI pushes the whole list again when it changes mid-session
    // (`SDKCommandsChangedMessage`, sdk.d.ts:3420-3427) — replace, don't merge.
    if (message.subtype === "commands_changed") {
      const commands = readCommandDetails((message as { commands?: unknown }).commands);
      if (commands.length > 0) {
        this.commandDetails = commands;
        this.rebuildCommands();
      }
      return;
    }
    const turn = this.active;
    if (!turn) return;

    if (message.subtype === "task_started") {
      const toolUseId = str(message.tool_use_id);
      if (!toolUseId) return;
      const taskId = str(message.task_id);
      if (taskId) turn.taskToolUse.set(taskId, toolUseId);
      this.upsertSubagent(turn, toolUseId, {
        name: str(message.subagent_type) ?? "sub-agent",
        description: str(message.description) ?? "",
        status: "running",
      });
      return;
    }
    if (message.subtype === "task_updated") {
      const toolUseId = this.toolUseForTask(turn, message);
      const patch = message.patch as { status?: unknown } | undefined;
      const status = str(patch?.status);
      if (toolUseId && status) {
        this.upsertSubagent(turn, toolUseId, { status: subagentStatus(status) });
      }
      return;
    }
    if (message.subtype === "task_notification") {
      const toolUseId = this.toolUseForTask(turn, message);
      if (!toolUseId) return;
      const summary = str(message.summary);
      this.upsertSubagent(turn, toolUseId, {
        status: subagentStatus(str(message.status) ?? "completed"),
        ...(summary ? { description: summary } : {}),
      });
    }
  }

  private rebuildCommands(): void {
    this.commands = enrichCommands(buildCommands(this.commandSource), this.commandDetails);
  }

  /**
   * `Query.supportedCommands()` (`sdk.d.ts:2747`) — the only place the CLI
   * publishes a command's description and `argumentHint`. Without it every
   * Claude command was `description: ""`, which made the slash menu name-only
   * and, worse, made the composer treat every argument-taking command as
   * argument-less: selecting `/cockpit:pilot` ran it immediately with no
   * argument (R14). Fire-and-forget — a backend that does not answer keeps the
   * bare names it already has, and a turn never waits on it.
   */
  private async refreshCommandDetails(): Promise<void> {
    const query = this.query as unknown as {
      supportedCommands?: () => Promise<unknown>;
    } | null;
    if (typeof query?.supportedCommands !== "function") return;
    try {
      const commands = readCommandDetails(await query.supportedCommands());
      if (commands.length === 0) return;
      this.commandDetails = commands;
      this.rebuildCommands();
    } catch (err) {
      this.log.warn("[claude] supportedCommands() failed; slash menu stays name-only", err);
    }
  }

  private toolUseForTask(turn: ActiveTurn, message: SdkMessageLike): string | undefined {
    const direct = str(message.tool_use_id);
    if (direct) return direct;
    const taskId = str(message.task_id);
    return taskId ? turn.taskToolUse.get(taskId) : undefined;
  }

  private routeStreamEvent(message: SdkMessageLike): void {
    const turn = this.active;
    if (!turn || message.parent_tool_use_id) return;
    const event = message.event as StreamEventLike | undefined;
    if (!event) return;

    if (event.type === "message_start") {
      this.currentMessageId = str(event.message?.id) ?? this.currentMessageId;
      return;
    }
    if (event.type !== "content_block_delta") return;
    const index = typeof event.index === "number" ? event.index : 0;
    const delta = event.delta;
    if (!delta) return;

    if (delta.type === "text_delta" && typeof delta.text === "string") {
      const key = this.streamBlockKey(turn, "text", index);
      const next = (turn.text.get(key) ?? "") + delta.text;
      turn.text.set(key, next);
      this.emitBlock(key, { kind: "text", text: next });
      return;
    }
    if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
      const key = this.streamBlockKey(turn, "thinking", index);
      const next = (turn.text.get(key) ?? "") + delta.thinking;
      turn.text.set(key, next);
      this.emitBlock(key, { kind: "thinking", text: next });
    }
  }

  /**
   * The block key for the n-th `text`/`thinking` block of one message.
   *
   * Keyed by **ordinal within the kind**, not by the raw content index, because
   * the two representations of one message disagree about indices (see
   * `ActiveTurn.contentKeys`). Both the delta stream and the settled `content`
   * walk count their own kinds from zero, so both land on the same key even
   * when the settled message omits the thinking block the stream sent.
   */
  private blockKey(kind: "text" | "thinking", ordinal: number): string {
    return `msg:${this.currentMessageId}:${kind}:${ordinal}`;
  }

  /** The key for a streamed content index, allocated once and remembered. */
  private streamBlockKey(turn: ActiveTurn, kind: "text" | "thinking", index: number): string {
    const slot = `${this.currentMessageId}:${index}`;
    const seen = turn.contentKeys.get(slot);
    if (seen) return seen;
    const counter = `${this.currentMessageId}:${kind}`;
    const ordinal = turn.contentCounts.get(counter) ?? 0;
    turn.contentCounts.set(counter, ordinal + 1);
    const key = this.blockKey(kind, ordinal);
    turn.contentKeys.set(slot, key);
    return key;
  }

  private routeAssistant(message: SdkMessageLike): void {
    const turn = this.active;
    if (!turn) return;

    // A sub-agent's own frames: the sub-agent block already stands in for them.
    if (message.parent_tool_use_id) {
      const toolUseId = str(message.parent_tool_use_id);
      if (toolUseId && turn.subagents.has(toolUseId)) {
        this.upsertSubagent(turn, toolUseId, { status: "running" });
      }
      return;
    }

    const inner = message.message as AssistantMessageLike | undefined;
    const messageId = str(inner?.id);
    if (messageId) this.currentMessageId = messageId;
    const content = Array.isArray(inner?.content) ? inner.content : [];

    // Counted per kind, from zero, exactly as the delta stream counted them.
    const seen = { text: 0, thinking: 0 };
    content.forEach((block, index) => {
      if (block.type === "text" && typeof block.text === "string") {
        const key = this.blockKey("text", seen.text++);
        turn.text.set(key, block.text);
        this.emitBlock(key, { kind: "text", text: block.text });
        return;
      }
      if (block.type === "thinking" && typeof block.thinking === "string") {
        const key = this.blockKey("thinking", seen.thinking++);
        turn.text.set(key, block.thinking);
        this.emitBlock(key, {
          kind: "thinking",
          text: block.thinking,
          ...(typeof block.signature === "string" ? { signature: block.signature } : {}),
        });
        return;
      }
      if (block.type === "tool_use") {
        const toolUseId = str(block.id) ?? `msg:${this.currentMessageId}:${index}:tool`;
        const name = str(block.name) ?? "tool";
        if (INTERACTION_TOOLS.has(name)) {
          // The `question:<toolUseId>` block is the card for this call.
          turn.interactionToolUseIds.add(toolUseId);
          return;
        }
        if (SUBAGENT_TOOLS.has(name)) {
          const input = (block.input ?? {}) as Record<string, unknown>;
          // `model` only when the *model itself* named one. Passing `null`
          // here would erase a routed model (SPEC R12): the `PreToolUse` hook
          // runs before this message is delivered, and `upsertSubagent` treats
          // an explicit `null` as "clear it" — so a spawn the policy had just
          // re-homed onto haiku came back as no model at all.
          const asked = str(input.model);
          this.upsertSubagent(turn, toolUseId, {
            name: str(input.subagent_type) ?? name,
            description: str(input.description) ?? "",
            ...(asked ? { model: asked } : {}),
            status: "spawned",
          });
          return;
        }
        const toolKey = `tool:${toolUseId}`;
        turn.toolKeys.set(toolUseId, toolKey);
        this.emitBlock(toolKey, {
          kind: "tool_call",
          name,
          input: block.input ?? null,
          status: "running",
          toolUseId,
        });
      }
    });

    const error = message.error as { message?: unknown } | undefined;
    if (error) {
      this.emitBlock(`error:${messageId ?? this.currentMessageId}`, {
        kind: "error",
        message: str(error.message) ?? "the model reported an error",
      });
    }
  }

  private routeUser(message: SdkMessageLike): void {
    const turn = this.active;
    if (!turn || message.parent_tool_use_id) return;
    const inner = message.message as { content?: unknown } | undefined;
    const content = Array.isArray(inner?.content) ? inner.content : [];

    for (const raw of content) {
      const block = raw as ToolResultLike;
      if (block?.type !== "tool_result") continue;
      const toolUseId = str(block.tool_use_id);
      if (!toolUseId) continue;

      if (turn.subagents.has(toolUseId)) {
        this.upsertSubagent(turn, toolUseId, {
          status: block.is_error ? "error" : "done",
        });
        continue;
      }
      // The answer is already on the question card; a tool_result card here
      // would just repeat it.
      if (turn.interactionToolUseIds.has(toolUseId)) continue;
      const key = turn.toolKeys.get(toolUseId) ?? `tool:${toolUseId}`;
      turn.toolKeys.set(toolUseId, key);
      const structured = message.tool_use_result;
      const { output, truncated, fullOutput } = this.clampOutput(
        structured !== undefined ? structured : (block.content ?? null),
      );
      const status: ToolCallStatus = block.is_error ? "error" : "success";
      this.emitBlock(key, {
        kind: "tool_call",
        name: this.toolNames.get(toolUseId) ?? "tool",
        input: this.toolInputs.get(toolUseId) ?? null,
        output,
        status,
        toolUseId,
        ...(truncated ? { truncated: true, fullOutput } : {}),
      });
    }
  }

  private routeResult(message: SdkMessageLike): void {
    const turn = this.active;
    const byModel = readModelUsage(message.modelUsage);
    const delta = deltaUsage(this.lastByModel, byModel);
    this.lastByModel = byModel;

    if (turn && !turn.settled) {
      const totals = sumUsage(delta);
      const fallback = readResultUsage(message);
      const usage = totals.inputTokens + totals.outputTokens + totals.costUsd > 0
        ? totals
        : fallback;
      if (usage.inputTokens + usage.outputTokens + usage.costUsd > 0) {
        this.emit({
          type: "usage",
          backend: this.backend,
          model: this.resolvedModel ?? this.agent?.model ?? "",
          usage,
          byModel: delta,
        });
        this.emitBlock(`usage:${turn.turnId}`, {
          kind: "usage",
          model: this.resolvedModel ?? this.agent?.model ?? "",
          usage,
        });
      }

      if (turn.interrupted) {
        this.settle(turn, "interrupted");
        return;
      }
      const isError = message.is_error === true || message.subtype !== "success";
      if (isError) {
        const errors = Array.isArray(message.errors) ? message.errors.map(String) : [];
        const detail = errors.join("\n") || str(message.result) || str(message.subtype) || "";
        this.emitBlock(`error:${turn.turnId}`, {
          kind: "error",
          message: `The backend ended the turn with ${str(message.subtype) ?? "an error"}.`,
          ...(detail ? { detail } : {}),
        });
        this.settle(turn, "error", detail || "backend error");
        return;
      }
      this.settle(turn, "done");
    }
  }

  // -------------------------------------------------------------------------
  // permission / question round-trip
  // -------------------------------------------------------------------------

  private async onCanUseTool(
    toolName: string,
    input: Record<string, unknown>,
    // `title` / `displayName` / `description` are the CLI's own rendering of
    // the prompt — what it lifts out of the tool's
    // `_meta['anthropic/permissionDisplay']` (`sdk.d.ts:209-269`, spike §4).
    // Passing them onto the block is what stops every real Claude permission
    // card reading "Permission requested" over a raw JSON dump (R32).
    opts: {
      signal?: AbortSignal;
      toolUseID?: string;
      decisionReason?: string;
      title?: string;
      displayName?: string;
      description?: string;
    },
  ): Promise<PermissionResultLike> {
    const turn = this.active;
    if (!turn || turn.settled) {
      // Nobody can be asked, so nothing is approved (SPEC R27).
      return { behavior: "deny", message: "capygen has no active turn to ask in" };
    }
    const requestId = newId("request");
    const anchor = opts.toolUseID ?? requestId;

    if (toolName === "AskUserQuestion") {
      const questions = parseQuestions(input);
      const key = `question:${anchor}`;
      this.emitBlock(key, {
        kind: "question",
        requestId,
        questions,
        answers: null,
        status: "pending",
      });
      this.emit({ type: "question", requestId, key, questions });
      const answers = await new Promise<Record<string, string> | null>((resolve) => {
        this.pending.set(requestId, { kind: "question", resolve });
        opts.signal?.addEventListener("abort", () => {
          if (this.pending.delete(requestId)) resolve(null);
        });
      });
      // Cancelled (interrupt, abort, quit): the card says so and the tool is
      // denied. Answering it with `{}` would tell both the user and the model
      // that a question nobody answered had been submitted.
      if (answers === null) {
        this.emitBlock(key, {
          kind: "question",
          requestId,
          questions,
          answers: null,
          status: "cancelled",
        });
        return { behavior: "deny", message: "The question was cancelled in capygen." };
      }
      this.emitBlock(key, {
        kind: "question",
        requestId,
        questions,
        answers,
        status: "answered",
      });
      return { behavior: "allow", updatedInput: { ...input, answers } };
    }

    const request: PermissionRequest = {
      requestId,
      toolName,
      input,
      ...(opts.decisionReason ? { reason: opts.decisionReason } : {}),
      suggestions: [],
    };
    const key = `permission:${anchor}`;
    const display = {
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.displayName ? { displayName: opts.displayName } : {}),
      ...(opts.description ? { description: opts.description } : {}),
    };
    this.emitBlock(key, { kind: "permission", request, decision: null, ...display });
    this.emit({ type: "permission", requestId, key, request });

    const answer = await new Promise<PermissionAnswer>((resolve) => {
      this.pending.set(requestId, { kind: "permission", resolve });
      opts.signal?.addEventListener("abort", () => {
        if (this.pending.delete(requestId)) {
          resolve({ behavior: "deny", message: "the turn was cancelled" });
        }
      });
    });

    this.emitBlock(key, {
      kind: "permission",
      request,
      decision: {
        behavior: answer.behavior,
        ...(answer.updatedInput !== undefined ? { updatedInput: answer.updatedInput } : {}),
        ...(answer.message !== undefined ? { message: answer.message } : {}),
        scope: "once",
        decidedAt: Date.now(),
      },
      ...display,
    });

    if (answer.behavior !== "allow") {
      // A native refusal is already the answer. Asking the local policy about
      // it could only mint a record for something nobody is going to run.
      return { behavior: "deny", message: answer.message ?? "Denied in capygen" };
    }

    /**
     * [review] The pre-tool hook is not the last word.
     *
     * Between the hook approving and this card being answered, a rule can be
     * edited or a grant revoked — and the operator can *edit the input*. So the
     * final input is re-checked here, immediately before the allow goes back to
     * the CLI, exactly as the `api` boundary re-checks at dequeue.
     *
     * `callId` is the same `toolUseID` the hook used and the stage is `final`,
     * so an authorizer that already prompted for this call can resolve what it
     * asked instead of asking twice — bound to this one pending call, never by
     * widening a grant.
     */
    const updated = isRecord(answer.updatedInput) ? answer.updatedInput : input;
    const verdict = await authorizeLocally(
      this.deps.authorizeLocal,
      {
        boundary: "claude-pre-tool",
        toolName,
        input: updated,
        cwd: this.session?.projectPath ?? process.cwd(),
        signal: opts.signal ?? this.turnCancellation(turn),
        stage: "final",
        callId: anchor,
      },
      { allowInputReplacement: true, requireObject: true },
    );
    if (!verdict.allowed) return { behavior: "deny", message: verdict.message };
    return { behavior: "allow", updatedInput: verdict.input as Record<string, unknown> };
  }

  /**
   * Matcher-less interception is proved against the pinned native CLI by
   * probe-claude-hook-precedence: local denials hold under native allow and
   * bypass, neutral decisions preserve native denial, and neutral model
   * rewrites still route sub-agent execution.
   */
  localPolicyCapabilities(): PolicyBoundarySupport[] {
    return [{ boundary: "claude-pre-tool", available: true, reason: null }];
  }

  /** Query.mcpServerStatus is a control request, never a model turn. */
  async catalogue(options: CatalogueOptions = {}): Promise<ToolCatalogue> {
    const live = this.query && this.queryInput && !this.queryInput.isClosed;
    if (!live && options.initialize !== true) return { kind: "notStarted" };
    if (this.disposed) return { kind: "notStarted" };
    return this.catalogueRunner.run(options);
  }

  private async fetchCatalogue(): Promise<RawCatalogueServer[]> {
    const query = this.query as (ClaudeQuery & {
      mcpServerStatus?: () => Promise<unknown[]>;
    }) | null;
    // Older CLIs do not implement the control request at all; that is
    // "unsupported", which the caller sees as an error rather than as a
    // confident empty list — `fetchCatalogue` throwing is what produces it.
    if (typeof query?.mcpServerStatus !== "function") {
      throw new Error("this Claude CLI does not implement mcpServerStatus");
    }
    const statuses = await query.mcpServerStatus();
    if (!Array.isArray(statuses)) return [];
    // [review] Capped *before* mapping, not after. A `.map()` over the whole
    // reply materialises one object per server and one array per tool list
    // before a single bound is applied, which is precisely the allocation a
    // hostile or broken server should not be able to force.
    const rows: RawCatalogueServer[] = [];
    const serverLimit = Math.min(statuses.length, MAX_SCANNED_SERVERS);
    for (let index = 0; index < serverLimit; index += 1) {
      const candidate: unknown = statuses[index];
      const row: Record<string, unknown> = isRecord(candidate) ? candidate : {};
      const tools: unknown[] = Array.isArray(row.tools) ? row.tools : [];
      const toolLimit = Math.min(tools.length, MAX_SCANNED_TOOLS_PER_SERVER);
      const toolNames: unknown[] = [];
      for (let cursor = 0; cursor < toolLimit; cursor += 1) {
        const tool = tools[cursor];
        // Names only: `description` and `annotations` are deliberately dropped
        // here rather than carried across and filtered later.
        toolNames.push(isRecord(tool) ? tool.name : undefined);
      }
      rows.push({
        name: row.name,
        state: claudeServerState(row.status),
        toolNames,
        ...(tools.length > toolLimit ? { truncated: true } : {}),
      });
    }
    return rows;
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
    // An empty map is the card's Decline button, not an answer: resolve it as
    // cancelled so the tool is denied rather than handed `{}` (R32).
    entry.resolve(Object.keys(answers).length === 0 ? null : answers);
    return true;
  }

  // -------------------------------------------------------------------------
  // the pre-tool hook: local policy (ADR-0007) and sub-agent routing (R12)
  // -------------------------------------------------------------------------

  /** An already-aborted signal when this turn can no longer run anything. */
  private turnCancellation(turn: ActiveTurn | null): AbortSignal {
    const controller = new AbortController();
    if (!turn || turn.settled || turn.interrupted || this.disposed) controller.abort();
    else turn.cancellations.add(() => controller.abort());
    return controller.signal;
  }

  /**
   * One matcher-less `PreToolUse` hook for both jobs.
   *
   * [review] It used to be registered as `'Task|Agent'`, which never fires for
   * `Bash`, `Write` or an MCP tool — precisely the tools a restriction is
   * usually about. `canUseTool` is not a substitute: it is not called at all
   * under a native allow rule or `bypassPermissions` (spike §8.5), so the hook
   * is the only place a local rule can stand in Claude's execution path.
   * Routing is a *branch* inside it rather than a second registration, because
   * two hooks on the same event would each have to know about the other's
   * decision.
   *
   * What this hook must never do is return `permissionDecision: "allow"` for a
   * local allow. A local allow means only "capygen has no restriction here";
   * answering `allow` would override the user's own Claude permission rules,
   * which capygen has no authority to widen. The neutral `{}` lets those rules
   * decide, exactly as they would without capygen.
   */
  private async onPreToolUse(
    hookInput: ClaudeHookInput,
    toolUseId: string | undefined,
    options?: { signal?: AbortSignal },
  ): Promise<ClaudeHookOutput> {
    const turn = this.active;
    const raw = hookInput as unknown as Record<string, unknown>;
    const input = isRecord(raw.tool_input) ? raw.tool_input : {};
    const anchor = toolUseId ?? str(raw.tool_use_id) ?? newId("request");
    const toolName = str(raw.tool_name) ?? "";
    const isSpawn = SUBAGENT_TOOL_NAMES.has(toolName);

    // A policy-routed spawn needs structured classification that native Agent /
    // Task inputs do not provide. Deny before legacy fail-open routing and before
    // local/native allow decisions; an observed spawn notification is too late.
    if (isSpawn && this.deps.disableNativeSubagents) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "Custom Mode disables native subagents. Use delegate_task with task kind and difficulty so the crew policy can route the work.",
        },
      };
    }

    /**
     * [review] The SDK's own hook signal *and* this turn's cancellation.
     *
     * The session-level controller was wrong twice over: it survives an
     * interrupt, so a local ask could still be waiting after the user pressed
     * Stop and then authorize a call into a turn that had already ended; and
     * when there was no turn at all it minted a fresh live controller, which
     * can never abort. With no turn the signal starts aborted, because there is
     * nothing left for an approval to be for.
     */
    const cancellation = new AbortController();
    const cancel = (): void => {
      if (!cancellation.signal.aborted) cancellation.abort();
    };
    if (!turn || turn.settled) cancel();
    else turn.cancellations.add(cancel);
    const hookSignal = options?.signal;
    if (hookSignal?.aborted) cancel();
    else hookSignal?.addEventListener("abort", cancel, { once: true });

    try {
      /**
       * The routing decision is taken **before** authorization, so the
       * authorizer sees the input that will actually run — model rewrite
       * included — and nothing transforms it afterwards. Routing a spawn the
       * policy then refuses is impossible: the refusal below is a hook deny.
       */
      let candidate = input;
      let routed: { model: string; backend?: Backend } | null = null;
      if (isSpawn) {
        if (turn) {
          const asked = str(input.model);
          this.upsertSubagent(turn, anchor, {
            name: str(input.subagent_type) ?? (toolName || "sub-agent"),
            description: str(input.description) ?? "",
            ...(asked ? { model: asked } : {}),
            status: "spawned",
          });
        }
        // R12 fails open: a routing failure means "spawn on the inherited
        // model", which deliberately does not extend to the policy check.
        try {
          const route = this.deps.routeSubagent?.({
            sessionId: this.session?.sessionId ?? "",
            agentId: this.agent?.agentId ?? "",
            toolName: toolName || "Agent",
            toolUseId,
            description: str(input.description) ?? "",
            subagentType: str(input.subagent_type),
            input,
          });
          if (route?.model) {
            routed = { model: route.model, ...(route.backend ? { backend: route.backend } : {}) };
            candidate = { ...input, model: route.model };
          }
        } catch (err) {
          this.log.warn("[claude] sub-agent routing policy failed; failing open", err);
        }
      }

      const verdict = await authorizeLocally(
        this.deps.authorizeLocal,
        {
          boundary: "claude-pre-tool",
          toolName: toolName || "unknown",
          input: candidate,
          cwd: this.session?.projectPath ?? process.cwd(),
          signal: cancellation.signal,
          // The hook runs *before* Claude's own permission machinery, which is
          // the only place a restriction can reach a tool a native allow rule
          // or `bypassPermissions` would wave through.
          stage: "pre",
          callId: anchor,
        },
        { allowInputReplacement: true, requireObject: true },
      );
      if (!verdict.allowed) {
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: verdict.message,
          },
        };
      }
      // `requireObject` already refused anything unusable, so there is no
      // fallback to the unapproved original.
      const approved = verdict.input as Record<string, unknown>;

      if (routed) {
        // The decision is recorded on the block, not only applied: `delegated`
        // is false because the Claude CLI still spawns this sub-agent itself —
        // capygen only rewrote which model it runs on (SPEC R12).
        if (turn) {
          this.upsertSubagent(turn, anchor, {
            model: routed.model,
            backend: routed.backend ?? this.backend,
            delegated: false,
          });
        }
        // `updatedInput` is exactly the value the authorizer approved, never a
        // later edit of it — and it now ships *without* a native allow, so the
        // rewrite no longer rides on overriding the user's own rules.
        const decision = this.deps.routingPermissionDecision ?? "neutral";
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            ...(decision === "allow" ? { permissionDecision: "allow" as const } : {}),
            updatedInput: approved,
          },
        };
      }

      // Only an *actual* replacement is passed on: sending `updatedInput` that
      // equals the original would claim an edit nobody made.
      const before = jsonSnapshot(candidate);
      const after = jsonSnapshot(approved);
      const replaced = !before.ok || !after.ok || before.canonical !== after.canonical;
      return replaced
        ? { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: approved } }
        : {};
    } finally {
      turn?.cancellations.delete(cancel);
      hookSignal?.removeEventListener("abort", cancel);
    }
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
    // Including a pre-tool hook waiting on a local authorization: `settle()`
    // only runs once the SDK stream actually ends, and until then an approval
    // arriving late would authorize a call into a turn the user has stopped.
    this.cancelTurnWork(turn);

    try {
      await this.query?.interrupt();
    } catch (err) {
      this.log.warn("[claude] interrupt() was refused", err);
    }
    // The SDK normally answers with a `result`; if it does not, end the turn
    // anyway rather than leaving the UI spinning.
    turn.interruptTimer = setTimeout(() => {
      if (!turn.settled) this.settle(turn, "interrupted");
    }, this.deps.interruptGraceMs ?? DEFAULT_INTERRUPT_GRACE_MS);
    turn.interruptTimer.unref?.();
    return true;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // Anything still building a session is now building it for nobody.
    this.generation += 1;
    this.cancelPending("closed");
    const turn = this.active;
    if (turn && !turn.settled) this.settle(turn, "interrupted");
    this.queryInput?.close();
    this.queryInput = null;

    // Aborting is what actually ends the SDK's stream: it kills the child, the
    // generator returns and `runPump` falls out on its own. `return()` is the
    // polite ask on top of that. Neither is awaited — a backend that ignores
    // both must not be able to hang the app's shutdown.
    const query = this.query;
    this.query = null;
    this.pump = null;
    try {
      this.abort?.abort();
    } catch {
      /* the controller may already be aborted */
    }
    try {
      void query?.return?.(undefined);
    } catch {
      /* generators that are mid-yield reject the request; nothing to do */
    }
    await Promise.resolve();
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  /**
   * Release everything blocked on the user: a permission is denied (R27 — an
   * unanswered request is never an approval) and a question is **cancelled**,
   * which is not the same as answered with nothing.
   */
  private cancelPending(why: string): void {
    for (const [requestId, entry] of [...this.pending]) {
      this.pending.delete(requestId);
      if (entry.kind === "permission") entry.resolve({ behavior: "deny", message: why });
      else entry.resolve(null);
    }
  }

  private emit(event: EngineEvent): void {
    this.active?.out.push(event);
  }

  private emitBlock(key: string, patch: BlockPatch): void {
    if (patch.kind === "tool_call") {
      if (patch.toolUseId) {
        this.toolNames.set(patch.toolUseId, patch.name);
        if (patch.input !== null && patch.input !== undefined) {
          if (!this.toolInputs.has(patch.toolUseId)) {
            this.toolInputs.set(patch.toolUseId, patch.input);
          }
        }
      }
    }
    this.active?.out.push({ type: "block", key, patch });
  }

  private upsertSubagent(
    turn: ActiveTurn,
    toolUseId: string,
    patch: {
      name?: string;
      description?: string;
      model?: string | null;
      status?: "spawned" | "running" | "done" | "error";
      /** [B1] Where the routing policy sent it (SPEC R12); the harness's own
       *  backend unless a future route says otherwise. */
      backend?: Backend;
      /** [B1] True only when capygen ran the sub-agent itself
       *  (`delegate_task`); a hook-routed native spawn stays false. */
      delegated?: boolean;
    },
  ): void {
    const prev = turn.subagents.get(toolUseId) ?? {
      name: "sub-agent",
      description: "",
      model: null,
      backend: this.backend,
      delegated: false,
    };
    const next = {
      name: patch.name ?? prev.name,
      description: patch.description ?? prev.description,
      model: patch.model !== undefined ? patch.model : prev.model,
      backend: patch.backend ?? prev.backend,
      delegated: patch.delegated ?? prev.delegated,
    };
    turn.subagents.set(toolUseId, next);
    this.emitBlock(`subagent:${toolUseId}`, {
      kind: "subagent",
      agentId: null,
      parentAgentId: this.agent?.agentId ?? null,
      name: next.name,
      backend: next.backend,
      model: next.model,
      description: next.description,
      status: patch.status ?? "spawned",
      delegated: next.delegated,
    });
  }

  /**
   * SPEC R25: keep the whole output in the row, show a stub when it is huge.
   *
   * `output` is the stub the transcript renders; `fullOutput` carries the
   * original value so the row still holds it whole (SPEC §Edge Cases) and the
   * stub can be expanded. Both are only set when the value actually overflows.
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

  /** Release everything bound to this turn's lifetime; safe to call twice. */
  private cancelTurnWork(turn: ActiveTurn): void {
    for (const cancel of [...turn.cancellations]) {
      try {
        cancel();
      } catch {
        /* a cancellation that throws must not stop the turn from ending */
      }
    }
    turn.cancellations.clear();
  }

  private settle(turn: ActiveTurn, status: "done" | "error" | "interrupted", error?: string): void {
    if (turn.settled) return;
    turn.settled = true;
    this.cancelTurnWork(turn);
    if (turn.interruptTimer) clearTimeout(turn.interruptTimer);
    // `toolNames`/`toolInputs` only exist to rebuild a tool_call block while its
    // turn is live. A harness outlives every turn in a session (R15), so keeping
    // them would grow without bound over a long-running conversation.
    for (const toolUseId of turn.toolKeys.keys()) {
      this.toolNames.delete(toolUseId);
      this.toolInputs.delete(toolUseId);
    }
    turn.out.push({ type: "turn", status, ...(error ? { error } : {}) });
    turn.out.close();
    if (this.active === turn) this.active = null;
  }
}

// ---------------------------------------------------------------------------
// loose shapes for the parts of the stream we read
// ---------------------------------------------------------------------------

/**
 * The SDK's own `.d.ts` types the payloads through `@anthropic-ai/sdk`, which is
 * a peer dependency capygen does not install, so those members degrade to `any`.
 * These local shapes state exactly what this file reads instead of pretending to
 * a precision the installed types cannot give.
 */
interface SdkMessageLike {
  type?: string;
  subtype?: string;
  session_id?: unknown;
  parent_tool_use_id?: unknown;
  message?: unknown;
  event?: unknown;
  error?: unknown;
  model?: unknown;
  tool_use_result?: unknown;
  modelUsage?: unknown;
  usage?: unknown;
  total_cost_usd?: unknown;
  is_error?: unknown;
  errors?: unknown;
  result?: unknown;
  task_id?: unknown;
  tool_use_id?: unknown;
  description?: unknown;
  subagent_type?: unknown;
  summary?: unknown;
  status?: unknown;
  patch?: unknown;
  slash_commands?: unknown;
  skills?: unknown;
  plugins?: unknown;
  /** `init.tools` / `init.mcp_servers` / `init.permissionMode` — read only by
   *  `readInitSnapshot` for `agents.describe` (SPEC R13). */
  tools?: unknown;
  mcp_servers?: unknown;
  permissionMode?: unknown;
}

interface StreamEventLike {
  type?: string;
  index?: number;
  message?: { id?: unknown };
  delta?: { type?: string; text?: unknown; thinking?: unknown };
}

interface AssistantMessageLike {
  id?: unknown;
  content?: {
    type?: string;
    text?: unknown;
    thinking?: unknown;
    signature?: unknown;
    id?: unknown;
    name?: unknown;
    input?: unknown;
  }[];
}

interface ToolResultLike {
  type?: string;
  tool_use_id?: unknown;
  content?: unknown;
  is_error?: unknown;
}

type PermissionResultLike =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

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

function subagentStatus(raw: string): "spawned" | "running" | "done" | "error" {
  if (raw === "completed" || raw === "done") return "done";
  if (raw === "failed" || raw === "error" || raw === "killed") return "error";
  if (raw === "running" || raw === "in_progress") return "running";
  return "spawned";
}

/** `AskUserQuestionInput.questions` → the domain shape (spike §4). */
export function parseQuestions(input: unknown): Question[] {
  const raw = isRecord(input) && Array.isArray(input.questions) ? input.questions : [];
  const questions: Question[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const question = str(item.question);
    if (!question) continue;
    const options: { label: string; description?: string }[] = [];
    if (Array.isArray(item.options)) {
      for (const option of item.options) {
        if (!isRecord(option)) continue;
        const label = str(option.label);
        if (!label) continue;
        const description = str(option.description);
        options.push({ label, ...(description ? { description } : {}) });
      }
    }
    const header = str(item.header);
    questions.push({
      question,
      ...(header ? { header } : {}),
      multiSelect: item.multiSelect === true,
      options,
    });
  }
  return questions;
}

/**
 * `system/init` → the slash menu (R14). Plugin-qualified names (`cockpit:pilot`)
 * and the skills listing are what make plugin commands appear at all — the CLI
 * has no separate command API (spike §8.1).
 */
export function buildCommands(message: {
  slash_commands?: unknown;
  skills?: unknown;
  plugins?: unknown;
}): SlashCommand[] {
  const names = Array.isArray(message.slash_commands)
    ? message.slash_commands.filter((n): n is string => typeof n === "string")
    : [];
  const skills = new Set(
    Array.isArray(message.skills)
      ? message.skills.filter((n): n is string => typeof n === "string")
      : [],
  );
  const plugins = new Set(
    Array.isArray(message.plugins)
      ? message.plugins
          .map((p) => (isRecord(p) ? str(p.name) : undefined))
          .filter((n): n is string => Boolean(n))
      : [],
  );
  return names.map((name) => {
    const pluginName = name.includes(":") ? name.split(":")[0] : undefined;
    const source: SlashCommand["source"] =
      pluginName && plugins.has(pluginName)
        ? "plugin"
        : skills.has(name)
          ? "skill"
          : "backend";
    return { name: `/${name}`, description: "", source };
  });
}

/**
 * `system/init` → the fields `agents.describe` reads (SPEC R13). Every key is
 * the raw JSON name, verified against `docs/spikes/claude.raw.json`'s `init`
 * message; anything the SDK stops sending simply degrades that line of the
 * card rather than throwing, which is why nothing here is schema-validated.
 */
export function readInitSnapshot(
  message: SdkMessageLike,
  fallbackModel: string,
): ClaudeInitSnapshot {
  return {
    model: str(message.model) ?? fallbackModel,
    permissionMode: str(message.permissionMode) ?? "default",
    tools: Array.isArray(message.tools)
      ? message.tools.filter((t): t is string => typeof t === "string")
      : [],
    mcpServers: Array.isArray(message.mcp_servers)
      ? message.mcp_servers
          .filter(isRecord)
          .map((server) => ({
            name: str(server.name) ?? "",
            status: str(server.status) ?? "unknown",
          }))
          .filter((server) => server.name.length > 0)
      : [],
    skills: Array.isArray(message.skills)
      ? message.skills.filter((s): s is string => typeof s === "string")
      : [],
    plugins: Array.isArray(message.plugins)
      ? message.plugins
          .filter(isRecord)
          .map((plugin) => {
            const version = str(plugin.version);
            return { name: str(plugin.name) ?? "", ...(version ? { version } : {}) };
          })
          .filter((plugin) => plugin.name.length > 0)
      : [],
  };
}

/** One entry of `Query.supportedCommands()` / `system/commands_changed`. */
export interface SdkSlashCommandDetail {
  name: string;
  description: string;
  argumentHint: string;
  aliases: string[];
}

/** `SlashCommand[]` off the wire → the fields `enrichCommands` reads. */
export function readCommandDetails(raw: unknown): SdkSlashCommandDetail[] {
  if (!Array.isArray(raw)) return [];
  const out: SdkSlashCommandDetail[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const name = str(item.name);
    if (!name) continue;
    out.push({
      name,
      description: typeof item.description === "string" ? item.description : "",
      argumentHint: typeof item.argumentHint === "string" ? item.argumentHint : "",
      aliases: Array.isArray(item.aliases)
        ? item.aliases.filter((a): a is string => typeof a === "string")
        : [],
    });
  }
  return out;
}

/**
 * Fold the descriptions and argument hints from `supportedCommands()` onto the
 * names `system/init` reported. `init` is what classifies a command as a
 * plugin/skill/backend one (the detail list says nothing about origin), so the
 * base list stays authoritative for `source` and only the human-facing fields
 * are taken from the details — matched by name or by any of its aliases
 * (`/cost` and `/stats` both resolve to `usage`, spike §8.1).
 */
export function enrichCommands(
  base: SlashCommand[],
  details: readonly SdkSlashCommandDetail[],
): SlashCommand[] {
  if (details.length === 0) return base;
  const byName = new Map<string, SdkSlashCommandDetail>();
  for (const detail of details) {
    byName.set(`/${detail.name}`, detail);
    for (const alias of detail.aliases) if (!byName.has(`/${alias}`)) byName.set(`/${alias}`, detail);
  }
  return base.map((command) => {
    const detail = byName.get(command.name);
    if (!detail) return command;
    return {
      ...command,
      description: detail.description || command.description,
      ...(detail.argumentHint ? { argumentHint: detail.argumentHint } : {}),
    };
  });
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** `result.modelUsage` → per-model totals in capygen's units. */
export function readModelUsage(raw: unknown): Record<string, UsageTotals> {
  if (!isRecord(raw)) return {};
  const out: Record<string, UsageTotals> = {};
  for (const [model, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    const reportedCost = finiteNonnegative(value.costUSD);
    out[model] = {
      inputTokens: num(value.inputTokens),
      outputTokens: num(value.outputTokens),
      cacheReadTokens: num(value.cacheReadInputTokens),
      cacheCreationTokens: num(value.cacheCreationInputTokens),
      costUsd: reportedCost ?? 0,
      costKnown: reportedCost !== undefined,
    };
  }
  return out;
}

/**
 * `modelUsage` accumulates over a streaming session ("read the latest result
 * rather than summing", `sdk.d.ts:5036-5039`), so one turn's usage is the
 * difference against the previous result. Clamped at zero: a fresh backend
 * process resets the counters.
 */
export function deltaUsage(
  previous: Record<string, UsageTotals>,
  current: Record<string, UsageTotals>,
): Record<string, UsageTotals> {
  const out: Record<string, UsageTotals> = {};
  for (const [model, now] of Object.entries(current)) {
    const before = previous[model] ?? EMPTY_USAGE;
    const diff: UsageTotals = {
      inputTokens: Math.max(0, now.inputTokens - before.inputTokens),
      outputTokens: Math.max(0, now.outputTokens - before.outputTokens),
      cacheReadTokens: Math.max(0, now.cacheReadTokens - before.cacheReadTokens),
      cacheCreationTokens: Math.max(
        0,
        now.cacheCreationTokens - before.cacheCreationTokens,
      ),
      costUsd: Math.max(0, now.costUsd - before.costUsd),
      costKnown: now.costKnown ?? now.costUsd > 0,
    };
    out[model] = diff;
  }
  return out;
}

export function sumUsage(byModel: Record<string, UsageTotals>): UsageTotals {
  const entries = Object.values(byModel);
  let total: UsageTotals = { ...EMPTY_USAGE };
  for (const usage of entries) {
    total = {
      inputTokens: total.inputTokens + usage.inputTokens,
      outputTokens: total.outputTokens + usage.outputTokens,
      cacheReadTokens: total.cacheReadTokens + usage.cacheReadTokens,
      cacheCreationTokens: total.cacheCreationTokens + usage.cacheCreationTokens,
      costUsd: total.costUsd + usage.costUsd,
    };
  }
  if (entries.length > 0) {
    total.costKnown = entries.every((usage) => usage.costKnown ?? usage.costUsd > 0);
  }
  return total;
}

/** Fallback for results with no `modelUsage` (local slash commands). */
function readResultUsage(message: SdkMessageLike): UsageTotals {
  const usage = isRecord(message.usage) ? message.usage : {};
  const reportedCost = finiteNonnegative(message.total_cost_usd);
  return {
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    cacheCreationTokens: num(usage.cache_creation_input_tokens),
    costUsd: reportedCost ?? 0,
    costKnown: reportedCost !== undefined,
  };
}

function finiteNonnegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

interface ClaudeAgentConfig {
  permissionMode?: ClaudeOptions["permissionMode"];
  effort?: ClaudeOptions["effort"];
  settingSources?: ("user" | "project" | "local")[];
  strictMcpConfig?: boolean;
  allowedTools?: string[];
  skills?: string[];
}

/**
 * The effort levels the *installed* SDK accepts (`Options.effort`, sdk.d.ts
 * `EffortLevel`). Enumerated here because the shared `ClaudeAgentConfig`
 * schema types `effort` as a free-form string — "no fixed vocabulary yet" —
 * so an unknown value is reachable from a stored config and must be dropped
 * rather than sent. `satisfies` ties the list to the SDK union: if a level is
 * renamed or removed upstream, this stops compiling instead of silently
 * sending a value the CLI rejects.
 */
export const CLAUDE_SUPPORTED_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly NonNullable<ClaudeOptions["effort"]>[];

/** Reads the optional `agent.config.claude` block, ignoring anything unknown. */
export function readClaudeConfig(config: unknown): ClaudeAgentConfig {
  const root = isRecord(config) && isRecord(config.claude) ? config.claude : {};
  const out: ClaudeAgentConfig = {};
  const mode = str(root.permissionMode);
  if (
    mode === "default" ||
    mode === "acceptEdits" ||
    mode === "bypassPermissions" ||
    mode === "plan"
  ) {
    out.permissionMode = mode;
  }
  if (Array.isArray(root.settingSources)) {
    const sources = root.settingSources.filter(
      (s): s is "user" | "project" | "local" =>
        s === "user" || s === "project" || s === "local",
    );
    out.settingSources = sources;
  }
  // Exact match only: `"LOW"` and `" low "` are dropped, the same way an
  // unknown `permissionMode` is, so a typo degrades to the model's own default
  // instead of failing the session.
  const effort = str(root.effort);
  if (effort !== undefined && (CLAUDE_SUPPORTED_EFFORTS as readonly string[]).includes(effort)) {
    out.effort = effort as NonNullable<ClaudeOptions["effort"]>;
  }
  if (typeof root.strictMcpConfig === "boolean") out.strictMcpConfig = root.strictMcpConfig;
  if (Array.isArray(root.allowedTools)) {
    out.allowedTools = root.allowedTools.filter((t): t is string => typeof t === "string");
  }
  if (Array.isArray(root.skills)) {
    out.skills = root.skills.filter((s): s is string => typeof s === "string");
  }
  return out;
}

/** `McpServerStatus.status` (`sdk.d.ts:1117`) → the shared vocabulary. */
function claudeServerState(raw: unknown): CatalogueServerState {
  switch (raw) {
    case "connected":
      return "connected";
    case "failed":
      return "failed";
    case "needs-auth":
      return "needsAuth";
    case "pending":
      return "pending";
    case "disabled":
      return "disabled";
    default:
      return "unknown";
  }
}
