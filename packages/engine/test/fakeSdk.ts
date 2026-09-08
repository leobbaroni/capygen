/**
 * A fake Claude Agent SDK: enough of `query()` for the harness tests to drive a
 * whole turn without a model, a process or a network call.
 *
 * The message builders below reproduce the frames recorded in
 * `docs/spikes/claude-sdk-shapes.md` §8 — the same field names, in the same
 * order the real stream produced them. Each is cast once to `SDKMessage`: the
 * real union carries a further ~20 fields per member (`betas`, `analytics_disabled`,
 * `memory_paths`, …) that the harness deliberately ignores, and spelling them
 * out here would test the builder rather than the mapping.
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { AsyncQueue } from "../src/asyncQueue.js";
import type { ClaudeOptions, ClaudeQuery, ClaudeQueryFn, SDKUserMessage } from "../src/claude/sdk.js";

export const SESSION_ID = "aa8b29f7-0000-4000-8000-000000000001";

export interface FakeSdk {
  query: ClaudeQueryFn;
  /** One entry per `query()` call — the cache test counts these. */
  calls: { options: ClaudeOptions }[];
  /** Prompt texts the harness pushed into the streaming input. */
  prompts: string[];
  /** The same messages unflattened — what an image-carrying turn is read from. */
  messages: SDKUserMessage[];
  /** Messages pushed here are delivered to the harness in order. */
  out: AsyncQueue<SDKMessage>;
  interrupts: number;
  /**
   * What `Query.supportedCommands()` answers — the only place the CLI
   * publishes a command's description and `argumentHint` (sdk.d.ts:2747).
   * `null` stands in for a backend that does not implement the control
   * request at all.
   */
  supportedCommands: unknown[] | null;
  /** How many times the harness asked for that list. */
  supportedCommandCalls: number;
  options(): ClaudeOptions;
  /** End the backend stream (process exit). */
  end(): void;
}

export function makeFakeSdk(): FakeSdk {
  const fake: FakeSdk = {
    calls: [],
    prompts: [],
    messages: [],
    out: new AsyncQueue<SDKMessage>(),
    interrupts: 0,
    supportedCommands: null,
    supportedCommandCalls: 0,
    options: () => {
      const last = fake.calls.at(-1);
      if (!last) throw new Error("query() has not been called yet");
      return last.options;
    },
    end: () => fake.out.close(),
    query: ({ prompt, options }) => {
      fake.calls.push({ options: options as ClaudeOptions });
      void (async () => {
        if (typeof prompt === "string") {
          fake.prompts.push(prompt);
          return;
        }
        for await (const message of prompt) {
          fake.messages.push(message);
          fake.prompts.push(userText(message));
        }
      })();
      const stream = fake.out;
      const generator = (async function* () {
        yield* stream;
      })();
      return Object.assign(generator, {
        interrupt: async (): Promise<undefined> => {
          fake.interrupts += 1;
          return undefined;
        },
        ...(fake.supportedCommands === null
          ? {}
          : {
              supportedCommands: async (): Promise<unknown[]> => {
                fake.supportedCommandCalls += 1;
                return fake.supportedCommands ?? [];
              },
            }),
      }) as unknown as ClaudeQuery;
    },
  };
  return fake;
}

function userText(message: SDKUserMessage): string {
  const content = message.message.content as unknown;
  if (typeof content === "string") return content;
  return JSON.stringify(content);
}

// ---------------------------------------------------------------------------
// message builders (shapes: docs/spikes/claude-sdk-shapes.md §8)
// ---------------------------------------------------------------------------

export function initMessage(over: Record<string, unknown> = {}): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    session_id: SESSION_ID,
    uuid: "896a7c4e-0000-4000-8000-000000000001",
    cwd: "C:\\project",
    model: "claude-sonnet-5",
    permissionMode: "default",
    claude_code_version: "2.1.261",
    apiKeySource: "none",
    output_style: "Concise",
    tools: ["Bash", "Read", "Task"],
    mcp_servers: [],
    agents: ["general-purpose"],
    slash_commands: ["context", "compact", "dataviz", "cockpit:pilot"],
    skills: ["dataviz", "cockpit:pilot"],
    plugins: [{ name: "cockpit", path: "C:\\plugins\\cockpit", version: "3.0.0" }],
    ...over,
  } as unknown as SDKMessage;
}

export function messageStart(id: string): SDKMessage {
  return {
    type: "stream_event",
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid: `evt_${id}_start`,
    event: {
      type: "message_start",
      message: { id, model: "claude-sonnet-5", role: "assistant", content: [] },
    },
  } as unknown as SDKMessage;
}

export function textDelta(index: number, text: string): SDKMessage {
  return {
    type: "stream_event",
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid: `evt_${index}_${text}`,
    event: {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text },
    },
  } as unknown as SDKMessage;
}

export function thinkingDelta(index: number, thinking: string): SDKMessage {
  return {
    type: "stream_event",
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid: `evt_think_${index}`,
    event: {
      type: "content_block_delta",
      index,
      delta: { type: "thinking_delta", thinking },
    },
  } as unknown as SDKMessage;
}

export function assistantMessage(
  id: string,
  content: Record<string, unknown>[],
  over: Record<string, unknown> = {},
): SDKMessage {
  return {
    type: "assistant",
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid: `msg_${id}`,
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5",
      stop_reason: null,
      content,
      usage: { input_tokens: 2, output_tokens: 4 },
    },
    ...over,
  } as unknown as SDKMessage;
}

export function toolResultMessage(
  toolUseId: string,
  content: unknown,
  over: { isError?: boolean; structured?: unknown } = {},
): SDKMessage {
  return {
    type: "user",
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid: `res_${toolUseId}`,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content,
          ...(over.isError ? { is_error: true } : {}),
        },
      ],
    },
    ...(over.structured !== undefined ? { tool_use_result: over.structured } : {}),
  } as unknown as SDKMessage;
}

export function taskStarted(taskId: string, toolUseId: string): SDKMessage {
  return {
    type: "system",
    subtype: "task_started",
    session_id: SESSION_ID,
    uuid: `task_${taskId}`,
    task_id: taskId,
    tool_use_id: toolUseId,
    description: "Count .md files",
    subagent_type: "general-purpose",
    is_backgrounded: false,
    spawn_depth: 1,
  } as unknown as SDKMessage;
}

export function taskNotification(taskId: string, summary: string): SDKMessage {
  return {
    type: "system",
    subtype: "task_notification",
    session_id: SESSION_ID,
    uuid: `taskn_${taskId}`,
    task_id: taskId,
    status: "completed",
    summary,
  } as unknown as SDKMessage;
}

export interface ResultUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreation?: number;
  cost?: number;
}

/**
 * `modelUsage` is cumulative across a streaming session (`sdk.d.ts:5036-5039`),
 * so tests pass the running totals, exactly as the CLI reports them.
 */
export function resultMessage(
  text: string,
  modelUsage: Record<string, ResultUsage> = { "claude-sonnet-5": {} },
  over: Record<string, unknown> = {},
): SDKMessage {
  const models: Record<string, unknown> = {};
  let cost = 0;
  for (const [model, usage] of Object.entries(modelUsage)) {
    models[model] = {
      inputTokens: usage.input ?? 0,
      outputTokens: usage.output ?? 0,
      cacheReadInputTokens: usage.cacheRead ?? 0,
      cacheCreationInputTokens: usage.cacheCreation ?? 0,
      webSearchRequests: 0,
      costUSD: usage.cost ?? 0,
      contextWindow: 1_000_000,
      maxOutputTokens: 64_000,
    };
    cost += usage.cost ?? 0;
  }
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 1,
    result: text,
    stop_reason: "end_turn",
    duration_ms: 3596,
    duration_api_ms: 1506,
    session_id: SESSION_ID,
    uuid: "res_1",
    total_cost_usd: cost,
    usage: {
      input_tokens: 2,
      output_tokens: 4,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    modelUsage: models,
    permission_denials: [],
    ...over,
  } as unknown as SDKMessage;
}

export function errorResult(subtype: string, errors: string[]): SDKMessage {
  return {
    type: "result",
    subtype,
    is_error: true,
    num_turns: 1,
    errors,
    duration_ms: 10,
    duration_api_ms: 5,
    session_id: SESSION_ID,
    uuid: "res_err",
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    permission_denials: [],
  } as unknown as SDKMessage;
}
