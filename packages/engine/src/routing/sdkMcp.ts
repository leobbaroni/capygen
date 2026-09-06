/**
 * `delegate_task` as an in-process MCP server for the Claude backend (SPEC R12).
 *
 * The Claude Agent SDK's `createSdkMcpServer` runs a server inside capygen's own
 * process: no child process, no socket, no config file the user has to keep in
 * sync — the tool's handler is a closure over the harness registry. That is the
 * only mechanism by which the Claude CLI can be handed a tool capygen
 * implements, which is what cross-backend delegation needs.
 *
 * The SDK is imported **lazily**, exactly like `loadClaudeQuery`:
 *
 *  - the unit tests never touch the real package (they inject `loadSdk`),
 *  - and the Electron main bundle keeps `@anthropic-ai/claude-agent-sdk`
 *    external, because the SDK resolves its own bundled `claude.exe` through
 *    `import.meta.url` (see `claude/sdk.ts` for the full story).
 *
 * A failure to load is not fatal: the caller gets `null`, the Claude session
 * starts without the extra server, and R12's fail-open promise holds — the
 * agent simply spawns its sub-agent natively instead.
 */
import { z } from "zod";
import type {
  DelegateRequest,
  DelegateResult,
} from "./delegate.js";
import { DELEGATE_TASK_DESCRIPTION, DELEGATE_TASK_TOOL } from "./delegate.js";

/** The MCP server name; the model sees `mcp__capygen__delegate_task`. */
export const CAPYGEN_MCP_SERVER = "capygen";

/**
 * The two SDK exports this needs, narrowed to what is actually called. Typed
 * structurally rather than imported as types so a fake in a test is a plain
 * object literal.
 */
export interface ClaudeSdkMcpApi {
  createSdkMcpServer: (options: {
    name: string;
    version?: string;
    instructions?: string;
    tools?: unknown[];
  }) => unknown;
  tool: (
    name: string,
    description: string,
    inputSchema: Record<string, unknown>,
    handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>,
  ) => unknown;
}

let cached: Promise<ClaudeSdkMcpApi> | null = null;

/** Resolve `createSdkMcpServer` + `tool` from the real SDK, once per process. */
export async function loadClaudeSdkMcpApi(): Promise<ClaudeSdkMcpApi> {
  cached ??= (async (): Promise<ClaudeSdkMcpApi> => {
    const mod: unknown = await import("@anthropic-ai/claude-agent-sdk");
    const api = mod as Partial<ClaudeSdkMcpApi>;
    if (typeof api.createSdkMcpServer !== "function" || typeof api.tool !== "function") {
      throw new Error(
        "@anthropic-ai/claude-agent-sdk exports no createSdkMcpServer()/tool(); " +
          "cross-backend delegation is unavailable",
      );
    }
    return { createSdkMcpServer: api.createSdkMcpServer, tool: api.tool };
  })().catch((err: unknown) => {
    cached = null;
    throw err;
  });
  return cached;
}

export interface DelegateMcpServerDeps {
  run: (req: DelegateRequest) => Promise<DelegateResult>;
  loadSdk?: () => Promise<ClaudeSdkMcpApi>;
  log?: { warn: (...args: unknown[]) => void };
}

/**
 * The `mcpServers` entry to hand `query()`, or `null` when the SDK cannot
 * provide one. Shaped as `{ capygen: <server> }` so a caller can spread it.
 */
export async function createDelegateMcpServer(
  deps: DelegateMcpServerDeps,
): Promise<Record<string, unknown> | null> {
  try {
    const sdk = await (deps.loadSdk ?? loadClaudeSdkMcpApi)();
    const delegateTool = sdk.tool(
      DELEGATE_TASK_TOOL,
      DELEGATE_TASK_DESCRIPTION,
      {
        description: z
          .string()
          .describe("A short label for this sub-task, shown in the transcript (3-8 words)."),
        prompt: z
          .string()
          .describe(
            "The full, self-contained instruction for the sub-agent. It cannot see this conversation.",
          ),
        model: z
          .string()
          .optional()
          .describe("Optional model override; capygen's routing policy already chose one."),
      } as unknown as Record<string, unknown>,
      async (args: Record<string, unknown>) => {
        const result = await deps.run({
          description: typeof args.description === "string" ? args.description : "",
          prompt: typeof args.prompt === "string" ? args.prompt : "",
          ...(typeof args.model === "string" && args.model ? { model: args.model } : {}),
        });
        return {
          content: [{ type: "text", text: result.text }],
          ...(result.ok ? {} : { isError: true }),
        };
      },
    );
    const server = sdk.createSdkMcpServer({
      name: CAPYGEN_MCP_SERVER,
      version: "1.0.0",
      instructions:
        "capygen's own tools. delegate_task runs one task on the backend/model capygen's " +
        "sub-agent routing policy chose for this agent.",
      tools: [delegateTool],
    });
    return { [CAPYGEN_MCP_SERVER]: server };
  } catch (err) {
    // R12 fails open: no delegation tool is strictly worse than one, but it is
    // not a reason to refuse to start the session.
    deps.log?.warn("[delegate] the in-process MCP server could not be built", err);
    return null;
  }
}
