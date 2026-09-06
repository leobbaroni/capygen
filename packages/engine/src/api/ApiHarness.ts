/**
 * The API-model harness (SPEC R9): capygen's own agent loop over a raw provider
 * API, with capygen's own tool runtime and the same cards every other backend
 * produces.
 *
 * The Claude and Codex harnesses *adapt* a backend that already has an agent
 * loop. This one **is** the agent loop, so four things it does are not
 * translation but policy:
 *
 *  - **One system prompt per session** (R24). `buildSystemPrompt` runs once, in
 *    `start()`, and the string is reused byte-for-byte on every request. The
 *    tool array is built once too, in the same stable order. Anthropic's cache
 *    keys on that exact prefix; a prompt that carried the date or the turn
 *    number would miss on every turn and pay full price for ~2 k tokens each
 *    time. This is why nothing per-turn may leak into `prompt.ts`.
 *  - **The permission gate is ours** (R27). `gateFor(mode, class)` decides
 *    allow / ask / deny from the tool's declared permission class, and an
 *    `ask` becomes exactly the `permission` event a Claude `canUseTool` call
 *    would have produced — so the UI cards, the IPC round-trip and the stored
 *    decision are identical across backends.
 *  - **MCP tools are listed lazily** (R26): on the first turn that needs a tool
 *    list, once, then cached for the session. A session that never calls a
 *    server never starts it.
 *  - **Conversation state is ours.** There is no backend session id to resume;
 *    the history is the transcript, replayed through `deps.loadHistory` (the
 *    desktop reads it from SQLite — the harness never touches the database).
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
import { McpClientPool, type McpPoolLogger } from "../mcp/client/McpClientPool.js";
import { loadMcpServers } from "../mcp/client/config.js";
import { widgetResourceUri, type McpServerConfig } from "../mcp/client/types.js";
import { mcpToolDefinitions } from "../tools/mcpTools.js";
import {
  builtinTools,
  gateDenialMessage,
  gateFor,
  toolMap,
  type BuiltinToolDeps,
} from "../tools/registry.js";
import {
  ToolInputError,
  describeError,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from "../tools/types.js";
import { resolveApiKey, type KeyProvider } from "./keys.js";
import { estimateCost } from "./pricing.js";
import { buildSystemPrompt } from "./prompt.js";
import {
  createProvider as defaultCreateProvider,
  type CreateProviderOptions,
} from "./providers/index.js";
import {
  ZERO_USAGE,
  addRawUsage,
  type ChatContent,
  type ChatMessage,
  type Provider,
  type ProviderRequest,
  type RawUsage,
  type StopReason,
  type ThinkingConfig,
  type ToolSchema,
} from "./providers/types.js";

export interface HarnessLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

const NO_LOG: HarnessLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** A pool borrowed from a shared registry; `release` is the harness giving it back. */
export interface AcquiredPool {
  pool: McpClientPool;
  release: () => Promise<void> | void;
}

export const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 64 * 1024;
export const DEFAULT_MAX_TOKENS = 8_192;
/**
 * Provider round-trips allowed inside one user turn. A loop that never returns
 * to the user is the API backend's failure mode (there is no CLI to stop it),
 * so the cap is hard and the turn ends with a visible error block rather than
 * quietly stopping.
 */
export const DEFAULT_MAX_ITERATIONS = 24;

export interface ApiHarnessDeps {
  /** Injected by the desktop; the engine never reads a key from disk (R21). */
  keys?: KeyProvider;
  env?: EnvRecord;
  log?: HarnessLogger;
  /** Test seam — the real one loads the provider SDK lazily. */
  createProvider?: (options: CreateProviderOptions) => Promise<Provider>;
  /**
   * The conversation so far, replayed on `start()`. The desktop supplies it
   * from the session's stored turns; the harness has no database access.
   */
  loadHistory?: (
    session: HarnessSession,
    agent: HarnessAgent,
  ) => Promise<ChatMessage[]> | ChatMessage[];
  /** Explicit MCP server list; otherwise `loadMcpServers` reads the CLIs' files. */
  mcpServers?: readonly McpServerConfig[];
  /** Test seam: a pool with a fake SDK. */
  mcpPool?: McpClientPool;
  /**
   * Hand back a pool for these servers instead of building one, and take it
   * back on `dispose()`. The desktop passes a refcounted registry that the MCP
   * Apps widget host uses too (`apps/desktop/src/ipc/mcpPools.ts`): without it
   * an `api` session with a widget-capable server spawned that server twice
   * and listed its tools twice — once for the agent's tool loop, once for
   * widget resolution — which is precisely the duplication R26 exists to stop.
   */
  acquirePool?: (servers: readonly McpServerConfig[]) => Promise<AcquiredPool> | AcquiredPool;
  /** Set false to run with the built-in tools only. */
  useMcp?: boolean;
  tools?: BuiltinToolDeps;
  /**
   * [B1] Tools capygen supplies on top of the built-ins and the MCP ones —
   * today only `delegate_task` (SPEC R12), and only for an agent whose
   * sub-agents are routed to another backend.
   *
   * Appended **after** the built-ins so the stable prefix of the tool array
   * that a provider caches on does not move (R24), and resolved once inside
   * `ensureTools()` like every other entry.
   */
  extraTools?: readonly ToolDefinition[];
  maxToolOutputChars?: number;
  maxTokens?: number;
  maxIterations?: number;
}

interface ActiveTurn {
  turnId: string;
  out: AsyncQueue<EngineEvent>;
  abort: AbortController;
  settled: boolean;
  interrupted: boolean;
  usage: RawUsage;
  /** Model → its own totals; an API agent only ever uses one, but the event
   * shape is shared with Claude's sub-agent breakdown. */
  byModel: Map<string, RawUsage>;
}

type Pending =
  | { kind: "permission"; resolve: (a: PermissionAnswer) => void }
  | { kind: "question"; resolve: (a: Record<string, string>) => void };

interface ResolvedConfig {
  provider: CreateProviderOptions["provider"];
  model: string;
  baseUrl?: string | undefined;
  maxTokens: number;
  thinking?: ThinkingConfig | undefined;
  reasoningEffort?: string | undefined;
  permissionMode: NonNullable<HarnessAgent["permissionMode"]>;
}

export class ApiHarness implements Harness {
  readonly backend: Backend = "api";

  private readonly deps: ApiHarnessDeps;
  private readonly log: HarnessLogger;

  private session: HarnessSession | null = null;
  private agent: HarnessAgent | null = null;
  private config: ResolvedConfig | null = null;
  /** Built once in `start()` and never rebuilt (R24). */
  private system = "";
  private messages: ChatMessage[] = [];

  private provider: Provider | null = null;
  private pool: McpClientPool | null = null;
  /** Set when `pool` came from `deps.acquirePool` and must be given back. */
  private borrowedPool: AcquiredPool | null = null;
  private tools: ToolDefinition[] | null = null;
  private toolSchemas: ToolSchema[] = [];

  private active: ActiveTurn | null = null;
  private readonly pending = new Map<string, Pending>();
  private messageCounter = 0;
  /** Accumulated text per streamed block key, so a delta only carries the tail. */
  private readonly deltas = new Map<string, string>();
  private disposed = false;

  constructor(deps: ApiHarnessDeps = {}) {
    this.deps = deps;
    this.log = deps.log ?? NO_LOG;
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  async start(session: HarnessSession, agent: HarnessAgent): Promise<void> {
    this.session = session;
    this.agent = agent;
    this.config = resolveConfig(agent, this.deps);
    this.system = buildSystemPrompt({
      cwd: session.projectPath,
      platform: process.platform,
      agentName: agent.name,
      // [B1] The round table's session-stable addition (ADR-0002). `start()`
      // runs once per session, so this obeys R24 exactly as the rest of the
      // prompt does — nothing per-turn reaches `buildSystemPrompt`.
      ...(agent.promptAddition ? { extra: agent.promptAddition } : {}),
    });
    const history = await this.deps.loadHistory?.(session, agent);
    this.messages = Array.isArray(history) ? [...history] : [];
    this.log.info(
      `[api] agent ${agent.agentId} → ${this.config.provider}/${this.config.model}` +
        ` (${this.messages.length} replayed message(s))`,
    );
  }

  capabilities(): HarnessCapabilities {
    return {
      streamingDeltas: true,
      permissions: true,
      questions: true,
      // [B1] Still no native Task tool — but an agent whose sub-agents are
      // routed to another backend is handed `delegate_task` (SPEC R12), and
      // that does fill the agent tree in. Claiming `true` without one would
      // put a tree in the UI that never fills, so it keys on the actual list.
      subagents: (this.deps.extraTools?.length ?? 0) > 0,
      // Not a backend resume: the transcript is replayed through `loadHistory`.
      resume: true,
      interrupt: true,
      // The API has no command list of its own; the composer's built-ins (R14)
      // are added by the renderer, not by a harness.
      slashCommands: false,
    };
  }

  listCommands(): SlashCommand[] {
    return [];
  }

  /** There is no backend session to resume — the transcript is the state. */
  backendSessionId(): string | null {
    return null;
  }

  // -------------------------------------------------------------------------
  // one turn
  // -------------------------------------------------------------------------

  send(input: TurnInput, ctx: TurnContext = {}): AsyncIterable<EngineEvent> {
    const out = new AsyncQueue<EngineEvent>();
    if (this.disposed) {
      out.push({ type: "turn", status: "error", error: "harness disposed" });
      out.close();
      return out;
    }
    if (this.active && !this.active.settled) {
      out.push({ type: "turn", status: "error", error: "this agent is already running a turn" });
      out.close();
      return out;
    }

    const turn: ActiveTurn = {
      turnId: input.turnId,
      out,
      abort: new AbortController(),
      settled: false,
      interrupted: false,
      usage: { ...ZERO_USAGE },
      byModel: new Map(),
    };
    this.active = turn;

    if (ctx.signal) {
      const onAbort = (): void => void this.interrupt();
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener("abort", onAbort, { once: true });
    }

    void this.runTurn(turn, input.text).catch((err: unknown) => {
      if (turn.interrupted) {
        this.settle(turn, "interrupted");
        return;
      }
      const message = describeError(err);
      this.emitBlock(`error:${turn.turnId}`, { kind: "error", message });
      this.settle(turn, "error", message);
    });

    return out;
  }

  private async runTurn(turn: ActiveTurn, text: string): Promise<void> {
    const config = this.config;
    if (!config) throw new Error("ApiHarness.start() was never called");

    this.messages.push({ role: "user", content: [{ type: "text", text }] });

    const provider = await this.ensureProvider(config);
    const tools = await this.ensureTools();
    const byName = toolMap(tools);
    const maxIterations = this.deps.maxIterations ?? DEFAULT_MAX_ITERATIONS;

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      if (turn.interrupted) break;

      const request: ProviderRequest = {
        model: config.model,
        system: this.system,
        tools: this.toolSchemas,
        messages: this.messages,
        maxTokens: config.maxTokens,
        thinking: config.thinking,
        reasoningEffort: config.reasoningEffort,
        signal: turn.abort.signal,
      };

      const { blocks, stop } = await this.streamOnce(turn, provider, request);
      if (turn.interrupted) break;

      if (blocks.length > 0) {
        this.messages.push({ role: "assistant", content: blocks });
      }
      const calls = blocks.filter(
        (block): block is Extract<ChatContent, { type: "tool_use" }> =>
          block.type === "tool_use",
      );
      if (calls.length === 0) {
        this.finishTurn(turn, stop);
        return;
      }

      const results: ChatContent[] = [];
      for (const call of calls) {
        if (turn.interrupted) break;
        results.push(await this.runToolCall(turn, config, byName, call));
      }
      if (turn.interrupted) break;
      this.messages.push({ role: "user", content: results });
    }

    if (turn.interrupted) {
      this.settle(turn, "interrupted");
      return;
    }
    // Fell out of the loop with tool calls still pending.
    this.emitBlock(`error:${turn.turnId}`, {
      kind: "error",
      message: `The agent made ${maxIterations} tool rounds without finishing.`,
      detail: "The turn was stopped to avoid an unbounded loop. Ask it to continue if that is wrong.",
    });
    this.emitUsage(turn);
    this.settle(turn, "error", "tool-call limit reached");
  }

  /** One provider response, mapped to blocks and events. */
  private async streamOnce(
    turn: ActiveTurn,
    provider: Provider,
    request: ProviderRequest,
  ): Promise<{ blocks: ChatContent[]; stop: StopReason }> {
    const messageKey = `a${(this.messageCounter += 1)}`;
    const blocks: ChatContent[] = [];
    let stop: StopReason = "other";

    for await (const event of provider.stream(request)) {
      switch (event.type) {
        case "text_delta":
          this.emitBlock(`msg:${messageKey}:${event.index}`, {
            kind: "text",
            text: this.appendDelta(messageKey, event.index, event.text),
          });
          break;
        case "thinking_delta":
          this.emitBlock(`msg:${messageKey}:${event.index}`, {
            kind: "thinking",
            text: this.appendDelta(messageKey, event.index, event.text),
          });
          break;
        case "content": {
          blocks.push(event.block);
          this.emitSettledBlock(messageKey, event.index, event.block);
          break;
        }
        case "usage": {
          turn.usage = addRawUsage(turn.usage, event.usage);
          const previous = turn.byModel.get(event.model) ?? { ...ZERO_USAGE };
          turn.byModel.set(event.model, addRawUsage(previous, event.usage));
          break;
        }
        case "stop":
          stop = event.reason;
          break;
        case "error":
          this.emitBlock(`error:${turn.turnId}:${messageKey}`, {
            kind: "error",
            message: event.message,
          });
          break;
      }
    }
    return { blocks, stop };
  }

  private appendDelta(messageKey: string, index: number, text: string): string {
    const key = `${messageKey}:${index}`;
    const next = (this.deltas.get(key) ?? "") + text;
    this.deltas.set(key, next);
    return next;
  }

  private emitSettledBlock(messageKey: string, index: number, block: ChatContent): void {
    const key = `msg:${messageKey}:${index}`;
    if (block.type === "text") {
      this.deltas.set(`${messageKey}:${index}`, block.text);
      this.emitBlock(key, { kind: "text", text: block.text });
      return;
    }
    if (block.type === "thinking") {
      this.deltas.set(`${messageKey}:${index}`, block.thinking);
      this.emitBlock(key, {
        kind: "thinking",
        text: block.thinking,
        ...(block.signature ? { signature: block.signature } : {}),
      });
      return;
    }
    if (block.type === "tool_use") {
      // `ask_user_question`'s card *is* its rendering: a tool_call block next to
      // the question card would show the same thing twice (the Claude harness
      // drops `AskUserQuestion` frames for the same reason).
      if (block.name === "ask_user_question") return;
      this.emitBlock(`tool:${block.id}`, {
        kind: "tool_call",
        name: block.name,
        input: block.input ?? null,
        status: "running",
        toolUseId: block.id,
        ...toolBlockOrigin(this.tools, block.name),
      });
    }
  }

  // -------------------------------------------------------------------------
  // running one tool call
  // -------------------------------------------------------------------------

  private async runToolCall(
    turn: ActiveTurn,
    config: ResolvedConfig,
    byName: Map<string, ToolDefinition>,
    call: Extract<ChatContent, { type: "tool_use" }>,
  ): Promise<ChatContent> {
    const tool = byName.get(call.name);
    if (!tool) {
      const message = `No tool named ${call.name} is available.`;
      this.emitBlock(`tool:${call.id}`, {
        kind: "tool_call",
        name: call.name,
        input: call.input ?? null,
        output: message,
        status: "error",
        toolUseId: call.id,
      });
      return { type: "tool_result", toolUseId: call.id, content: message, isError: true };
    }

    let input = asRecord(call.input);

    const gate = gateFor(config.permissionMode, tool.permissionClass);
    if (gate === "deny") {
      return this.denied(call, tool, gateDenialMessage(config.permissionMode, tool));
    }
    if (gate === "ask") {
      const answer = await this.askPermission(call, tool, input);
      if (answer.behavior !== "allow") {
        return this.denied(call, tool, answer.message ?? "The user denied this tool call.");
      }
      if (isRecord(answer.updatedInput)) input = answer.updatedInput;
    }

    const ctx: ToolContext = {
      cwd: this.session?.projectPath ?? process.cwd(),
      signal: turn.abort.signal,
      env: cleanEnv(this.deps.env),
      log: this.log,
      maxOutputChars: this.deps.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS,
      ask: (questions, allowOther) => this.askQuestion(call.id, questions, allowOther),
    };

    let result: ToolResult;
    try {
      result = await tool.run(input, ctx);
    } catch (err) {
      // A bad argument is the model's mistake and it can fix it; anything else
      // is ours, and the model still needs to be told the call failed.
      const message =
        err instanceof ToolInputError
          ? `${tool.name}: ${err.message}`
          : `${tool.name} failed: ${describeError(err)}`;
      result = { content: message, isError: true };
    }

    const status: ToolCallStatus = result.isError ? "error" : "success";
    if (tool.name !== "ask_user_question") {
      this.emitBlock(`tool:${call.id}`, {
        kind: "tool_call",
        name: tool.name,
        input,
        output: result.content,
        status,
        toolUseId: call.id,
        family: tool.family,
        ...(tool.mcp ? { serverName: tool.mcp.serverName } : {}),
        ...(result.truncated
          ? { truncated: true, fullOutput: result.fullOutput ?? result.content }
          : {}),
      });
      this.maybeEmitWidget(tool, call, input, result);
    }

    return {
      type: "tool_result",
      toolUseId: call.id,
      content: result.content,
      ...(result.isError ? { isError: true } : {}),
    };
  }

  private denied(
    call: Extract<ChatContent, { type: "tool_use" }>,
    tool: ToolDefinition,
    message: string,
  ): ChatContent {
    this.emitBlock(`tool:${call.id}`, {
      kind: "tool_call",
      name: tool.name,
      input: call.input ?? null,
      output: message,
      status: "denied",
      toolUseId: call.id,
      family: tool.family,
      ...(tool.mcp ? { serverName: tool.mcp.serverName } : {}),
    });
    return { type: "tool_result", toolUseId: call.id, content: message, isError: true };
  }

  /**
   * SPEC R31: a tool that declares a `ui://` resource — on the tool itself or on
   * the result's `_meta` — gets a widget block alongside its tool card. The
   * HTML is not fetched here: `htmlStatus: "pending"` is the widget host's cue
   * to read the resource and fill it in.
   */
  private maybeEmitWidget(
    tool: ToolDefinition,
    call: Extract<ChatContent, { type: "tool_use" }>,
    input: Record<string, unknown>,
    result: ToolResult,
  ): void {
    if (!tool.mcp) return;
    const raw = isRecord(result.raw) ? result.raw : undefined;
    const uri = tool.mcp.resourceUri ?? widgetResourceUri(raw?._meta);
    if (!uri) return;
    this.emitBlock(`widget:${call.id}`, {
      kind: "widget",
      toolCallId: call.id,
      serverName: tool.mcp.serverName,
      toolName: tool.mcp.toolName,
      resourceUri: uri,
      html: null,
      htmlStatus: "pending",
      toolInput: input,
      toolResult: raw
        ? {
            content: Array.isArray(raw.content) ? raw.content : [],
            ...(raw.structuredContent !== undefined
              ? { structuredContent: raw.structuredContent }
              : {}),
            ...(raw.isError === true ? { isError: true } : {}),
          }
        : null,
      meta: raw?._meta ?? null,
    });
  }

  // -------------------------------------------------------------------------
  // permission / question round-trip (identical cards to every other backend)
  // -------------------------------------------------------------------------

  private async askPermission(
    call: Extract<ChatContent, { type: "tool_use" }>,
    tool: ToolDefinition,
    input: Record<string, unknown>,
  ): Promise<PermissionAnswer> {
    const requestId = newId("request");
    const request: PermissionRequest = {
      requestId,
      toolName: tool.name,
      input,
      reason: `${tool.name} needs ${tool.permissionClass} access.`,
      suggestions: [],
    };
    const key = `permission:${call.id}`;
    this.emitBlock(key, {
      kind: "permission",
      request,
      decision: null,
      displayName: tool.name,
      description: tool.description,
    });
    this.emit({ type: "permission", requestId, key, request });

    const answer = await new Promise<PermissionAnswer>((resolve) => {
      this.pending.set(requestId, { kind: "permission", resolve });
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
      displayName: tool.name,
      description: tool.description,
    });
    return answer;
  }

  private async askQuestion(
    toolUseId: string,
    questions: Question[],
    allowOther: boolean,
  ): Promise<Record<string, string>> {
    const requestId = newId("request");
    const key = `question:${toolUseId}`;
    this.emitBlock(key, { kind: "question", requestId, questions, answers: null, allowOther });
    this.emit({ type: "question", requestId, key, questions });

    const answers = await new Promise<Record<string, string>>((resolve) => {
      this.pending.set(requestId, { kind: "question", resolve });
    });
    this.emitBlock(key, { kind: "question", requestId, questions, answers, allowOther });
    return answers;
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

  // -------------------------------------------------------------------------
  // interrupt / dispose
  // -------------------------------------------------------------------------

  async interrupt(): Promise<boolean> {
    const turn = this.active;
    if (!turn || turn.settled) return false;
    turn.interrupted = true;
    this.releasePending("interrupted");
    // Aborts the in-flight HTTP request *and* whatever tool is running: both
    // are given the same signal.
    try {
      turn.abort.abort();
    } catch {
      /* an already-aborted controller is exactly what we wanted */
    }
    this.settle(turn, "interrupted");
    return true;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.releasePending("closed");
    const turn = this.active;
    if (turn && !turn.settled) {
      try {
        turn.abort.abort();
      } catch {
        /* as above */
      }
      this.settle(turn, "interrupted");
    }
    const pool = this.pool;
    const borrowed = this.borrowedPool;
    this.pool = null;
    this.borrowedPool = null;
    // A borrowed pool is the registry's to close, not ours: the widget host may
    // still be serving a widget from the same connection.
    if (borrowed) await borrowed.release();
    else await pool?.close();
  }

  private releasePending(reason: string): void {
    for (const [requestId, entry] of [...this.pending]) {
      this.pending.delete(requestId);
      if (entry.kind === "permission") entry.resolve({ behavior: "deny", message: reason });
      else entry.resolve({});
    }
  }

  // -------------------------------------------------------------------------
  // lazily-built session state
  // -------------------------------------------------------------------------

  private async ensureProvider(config: ResolvedConfig): Promise<Provider> {
    if (this.provider) return this.provider;
    const apiKey = await resolveApiKey(config.provider, {
      ...(this.deps.keys ? { keys: this.deps.keys } : {}),
      ...(this.deps.env ? { env: this.deps.env } : {}),
    });
    if (!apiKey) {
      throw new Error(
        `No API key for ${config.provider}. Add one in Settings ▸ API keys, ` +
          "or set the provider's environment variable.",
      );
    }
    const create = this.deps.createProvider ?? defaultCreateProvider;
    this.provider = await create({
      provider: config.provider,
      apiKey,
      baseUrl: config.baseUrl,
    });
    return this.provider;
  }

  /**
   * Built once per session (R24/R26): the built-in tools, then whatever the MCP
   * servers advertise. The order is stable so the cached request prefix stays
   * byte-identical between turns.
   */
  private async ensureTools(): Promise<ToolDefinition[]> {
    if (this.tools) return this.tools;
    const tools = builtinTools(this.deps.tools ?? {});
    if (this.deps.extraTools?.length) tools.push(...this.deps.extraTools);

    if (this.deps.useMcp !== false) {
      try {
        const pool = await this.ensurePool();
        if (pool) tools.push(...(await mcpToolDefinitions(pool)));
      } catch (err) {
        // A broken MCP config must not cost the agent its built-in tools.
        this.log.warn("[api] MCP tools are unavailable for this session", err);
      }
    }

    this.tools = tools;
    this.toolSchemas = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as unknown as Record<string, unknown>,
    }));
    return tools;
  }

  private async ensurePool(): Promise<McpClientPool | null> {
    if (this.pool) return this.pool;
    if (this.deps.mcpPool) {
      this.pool = this.deps.mcpPool;
      return this.pool;
    }
    const servers =
      this.deps.mcpServers ??
      (await loadMcpServers({
        ...(this.session?.projectPath ? { projectPath: this.session.projectPath } : {}),
        ...(this.agent?.config !== undefined ? { agentConfig: this.agent.config } : {}),
        log: this.log,
      }));
    if (servers.length === 0) return null;
    if (this.deps.acquirePool) {
      const borrowed = await this.deps.acquirePool(servers);
      this.borrowedPool = borrowed;
      this.pool = borrowed.pool;
      return this.pool;
    }
    this.pool = new McpClientPool({
      servers,
      log: this.log as McpPoolLogger,
      env: cleanEnv(this.deps.env),
    });
    return this.pool;
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  private finishTurn(turn: ActiveTurn, stop: StopReason): void {
    if (stop === "max_tokens") {
      this.emitBlock(`error:${turn.turnId}:truncated`, {
        kind: "error",
        message: "The model hit its output-token limit before finishing.",
        detail: "Raise maxTokens in the agent's config, or ask it to continue.",
      });
    }
    this.emitUsage(turn);
    this.settle(turn, "done");
  }

  private emitUsage(turn: ActiveTurn): void {
    const model = this.config?.model ?? this.agent?.model ?? "";
    const byModel: Record<string, UsageTotals> = {};
    for (const [id, raw] of turn.byModel) byModel[id] = withCost(id, raw);
    const usage = withCost(model, turn.usage);
    if (usage.inputTokens + usage.outputTokens + usage.cacheReadTokens === 0) return;
    this.emit({ type: "usage", backend: this.backend, model, usage, byModel });
    this.emitBlock(`usage:${turn.turnId}`, { kind: "usage", model, usage });
  }

  private emit(event: EngineEvent): void {
    this.active?.out.push(event);
  }

  private emitBlock(key: string, patch: BlockPatch): void {
    this.active?.out.push({ type: "block", key, patch });
  }

  private settle(
    turn: ActiveTurn,
    status: "done" | "error" | "interrupted",
    error?: string,
  ): void {
    if (turn.settled) return;
    turn.settled = true;
    this.deltas.clear();
    turn.out.push({ type: "turn", status, ...(error ? { error } : {}) });
    turn.out.close();
    if (this.active === turn) this.active = null;
  }
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

/** `agent.config.api` + the agent's own fields → everything the loop needs. */
export function resolveConfig(agent: HarnessAgent, deps: ApiHarnessDeps): ResolvedConfig {
  const config = isRecord(agent.config) && isRecord(agent.config.api) ? agent.config.api : {};
  const provider = readProvider(config.provider);
  const model = typeof config.model === "string" && config.model.length > 0
    ? config.model
    : agent.model;
  const thinking = readThinking(config.thinking);
  const effort = typeof config.reasoningEffort === "string" ? config.reasoningEffort : undefined;
  return {
    provider,
    model,
    baseUrl: typeof config.baseUrl === "string" ? config.baseUrl : undefined,
    maxTokens:
      typeof config.maxTokens === "number" && config.maxTokens > 0
        ? config.maxTokens
        : (deps.maxTokens ?? DEFAULT_MAX_TOKENS),
    thinking,
    reasoningEffort: effort,
    permissionMode:
      agent.permissionMode ??
      (isPermissionMode(config.permissionMode) ? config.permissionMode : "default"),
  };
}

function readProvider(value: unknown): CreateProviderOptions["provider"] {
  if (value === "anthropic" || value === "openai" || value === "openrouter") return value;
  return "anthropic";
}

function isPermissionMode(value: unknown): value is ResolvedConfig["permissionMode"] {
  return (
    value === "default" ||
    value === "acceptEdits" ||
    value === "bypassPermissions" ||
    value === "plan"
  );
}

/**
 * `config.thinking` is `z.unknown()` in the domain schema because each provider
 * spells it differently. Anthropic's is the one this harness sends, so a number
 * (a budget) or `{budgetTokens}`/`{budget_tokens}` all mean the same thing.
 */
export function readThinking(value: unknown): ThinkingConfig | undefined {
  if (typeof value === "number" && value > 0) {
    return { type: "enabled", budgetTokens: Math.floor(value) };
  }
  if (!isRecord(value)) return undefined;
  if (value.type === "disabled" || value.enabled === false) return undefined;
  const budget = value.budgetTokens ?? value.budget_tokens;
  if (typeof budget === "number" && budget > 0) {
    return { type: "enabled", budgetTokens: Math.floor(budget) };
  }
  return undefined;
}

function withCost(model: string, raw: RawUsage): UsageTotals {
  const { costUsd } = estimateCost(model, raw);
  return {
    inputTokens: raw.inputTokens,
    outputTokens: raw.outputTokens,
    cacheReadTokens: raw.cacheReadTokens,
    cacheCreationTokens: raw.cacheCreationTokens,
    costUsd,
  };
}

/** `family` / `serverName` for a tool_call block, looked up by tool name. */
function toolBlockOrigin(
  tools: ToolDefinition[] | null,
  name: string,
): { family?: ToolDefinition["family"]; serverName?: string } {
  const tool = tools?.find((candidate) => candidate.name === name);
  if (!tool) return {};
  return { family: tool.family, ...(tool.mcp ? { serverName: tool.mcp.serverName } : {}) };
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
