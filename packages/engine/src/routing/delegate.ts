/**
 * `delegate_task` — cross-backend sub-agents (SPEC R12).
 *
 * Claude's `PreToolUse` hook can move a sub-agent onto a different *model*
 * (docs/spikes/engine.md §2 row 7). It cannot move one onto a different
 * *backend*: a Claude CLI has no way to open a Codex thread, and handing it a
 * Codex model id in `updatedInput.model` would fail the spawn instead of
 * redirecting it. So when the routing policy crosses backends, capygen runs the
 * sub-agent itself and lends the parent a tool to ask for it.
 *
 * The tool is one call, and everything about it is deliberately small:
 *
 *  - it takes a `description` (the label the transcript shows) and a `prompt`
 *    (everything the sub-agent needs — it does **not** see the conversation);
 *  - it runs one turn on a short-lived harness for the routed backend/model, in
 *    the same project directory, through the same registry every other agent
 *    uses;
 *  - it streams that turn's blocks into the parent's turn under a `delegate:`
 *    key prefix, wrapped in a `subagent` block with `delegated: true`, so the
 *    agent tree (R13) shows it and R23 bills its tokens to the right model;
 *  - it returns the sub-agent's final text to the caller, as a tool result —
 *    **clamped**, because that text lands in the delegating model's context as
 *    a `tool_result` and is re-sent with every later turn of that
 *    conversation, exactly like a Bash or MCP result (SPEC R23/R25);
 *  - it hands the delegated harness to `onHarness` for the duration of the
 *    call, so the desktop's Stop can interrupt a sub-agent that is still
 *    running rather than leaving it to the 10-minute timeout.
 *
 * And it fails open like the rest of R12: no route, an unusable route, a
 * backend that will not start — the tool answers with a sentence saying so and
 * telling the caller to do the work itself, rather than throwing and losing the
 * parent's turn.
 *
 * Permission and `AskUserQuestion` requests raised *inside* a delegated turn are
 * forwarded verbatim through `onEvent`, so the desktop shows the same cards for
 * a delegated sub-agent as for any other turn and the answer reaches the
 * delegated harness. Nothing is auto-approved (R27).
 */
import { newId, type Backend, type TurnStatus, type UsageTotals } from "@capygen/shared";
import { EMPTY_USAGE, addUsage, type BlockPatch, type EngineEvent, type Harness, type HarnessAgent, type HarnessSession } from "../harness.js";
import { clampText, type JsonSchemaObject, type ToolDefinition } from "../tools/types.js";

export const DELEGATE_TASK_TOOL = "delegate_task";

export const DELEGATE_TASK_DESCRIPTION =
  "Run one task on another model through capygen and return its answer. Use this instead of your " +
  "own sub-agent tool when capygen's routing policy sends sub-agents to a different backend — your " +
  "own tool cannot reach it. The sub-agent runs in this same project directory but does NOT see " +
  "this conversation, so the prompt must contain everything it needs. It returns its final text.";

export const DELEGATE_TASK_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: {
    description: {
      type: "string",
      description: "A short label for this sub-task, shown in the transcript (3-8 words).",
    },
    prompt: {
      type: "string",
      description:
        "The full, self-contained instruction for the sub-agent. It cannot see this conversation.",
    },
    model: {
      type: "string",
      description:
        "Optional model override. Leave this out unless the user asked for a specific model — " +
        "capygen's routing policy already chose one.",
    },
  },
  required: ["description", "prompt"],
  additionalProperties: false,
};

export interface DelegateRequest {
  description: string;
  prompt: string;
  /** Overrides the routed model; the routed backend is never overridable. */
  model?: string | undefined;
}

export interface DelegateResult {
  ok: boolean;
  /** The sub-agent's final text, or the reason there is none. */
  text: string;
  backend?: Backend;
  model?: string;
  status?: TurnStatus;
  usage?: UsageTotals;
}

export interface DelegationLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface DelegateRunnerDeps {
  session: HarnessSession;
  /** The agent whose tool call this is. */
  parent: HarnessAgent;
  /** Where sub-agents run; `null` ⇒ nothing to delegate, answer fail-open. */
  target: () => { backend: Backend; model: string } | null;
  /** Build (not start) a harness for the routed backend. */
  makeHarness: (target: { backend: Backend; model: string }) => Harness;
  /**
   * Every event the delegated turn produced, block keys already prefixed.
   * `turn` events are **not** forwarded: the sub-agent finishing does not end
   * the parent's turn. The desktop feeds these into the parent turn's own
   * event handling, which is how the cards and the usage rows appear.
   */
  onEvent?: (event: EngineEvent, harness: Harness) => void;
  /**
   * Called with the delegated harness as soon as it exists, and the function
   * it returns is called once that harness has been disposed.
   *
   * Without it a delegated sub-agent is unstoppable: the child harness is
   * created inside this closure, so nothing the desktop's `interrupt()` can
   * see holds a reference to it, and pressing Stop left a cross-backend
   * sub-agent running (and billing) until `timeoutMs` — with its output
   * dropped, because the parent's turn was gone by then. The desktop registers
   * it next to the parent's `ActiveTurn` and interrupts both.
   */
  onHarness?: (harness: Harness) => (() => void) | void;
  log?: DelegationLogger;
  /** Hard ceiling on one delegated turn; the harness is disposed after it. */
  timeoutMs?: number;
  /** Characters of the sub-agent's final text handed back to the caller. */
  maxResultChars?: number;
}

const NO_LOG: DelegationLogger = { info: () => {}, warn: () => {}, error: () => {} };
export const DEFAULT_DELEGATE_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * Same 64 KB the tool runtime clamps every other tool result to
 * (`DEFAULT_MAX_TOOL_OUTPUT_CHARS`, duplicated rather than imported so this
 * module does not depend on a harness). A delegated answer is a tool result
 * like any other: unbounded, it would be replayed into the delegating model's
 * context on every later turn of that conversation.
 */
export const DEFAULT_DELEGATE_RESULT_CHARS = 64 * 1024;

/**
 * A backend that can pick its own model when capygen has not named one.
 * Codex's `thread/start` omits `model` and takes the user's `config.toml`
 * default; Claude and the `api` loop both need an explicit id (spike §6.4:
 * never leave the model to a default we cannot see), so a route that names
 * only `backend: "claude"` is not actionable and fails open.
 */
function canRunWithoutModel(backend: Backend): boolean {
  return backend === "codex";
}

export function createDelegateRunner(
  deps: DelegateRunnerDeps,
): (req: DelegateRequest) => Promise<DelegateResult> {
  const log = deps.log ?? NO_LOG;
  let counter = 0;

  return async function delegate(req: DelegateRequest): Promise<DelegateResult> {
    const routed = safely(() => deps.target(), log);
    if (!routed) {
      return {
        ok: false,
        text:
          "capygen has no sub-agent routing rule for this agent, so there is nothing to delegate " +
          "to. Do the work yourself, or use your own sub-agent tool.",
      };
    }
    const model = req.model ?? routed.model;
    if (!model && !canRunWithoutModel(routed.backend)) {
      log.warn(
        `[delegate] routing names ${routed.backend} but no model; failing open`,
      );
      return {
        ok: false,
        text:
          `capygen's routing rule names the ${routed.backend} backend but no model, so the ` +
          "sub-agent cannot be started. Do the work yourself.",
      };
    }

    const index = (counter += 1);
    const key = `delegate:${deps.parent.agentId}:${index}`;
    /**
     * Stamped on every block the sub-agent streams into the parent's turn.
     * Two consumers, neither of which can recover it later: the transcript
     * (a delegated answer must not render as the lead's own words) and
     * `RoundTable.textOfTurn`, which would otherwise fold the whole
     * sub-agent output into the reply it hands the next hop.
     */
    const delegatedFrom =
      req.description.trim() || `${routed.backend} sub-agent`;
    const emit = (event: EngineEvent, harness: Harness): void => {
      try {
        deps.onEvent?.(event, harness);
      } catch (err) {
        log.warn("[delegate] a forwarded event was refused", err);
      }
    };

    let harness: Harness;
    try {
      harness = deps.makeHarness({ backend: routed.backend, model });
    } catch (err) {
      const message = describe(err);
      log.warn(`[delegate] could not build a ${routed.backend} harness: ${message}`);
      return { ok: false, text: `capygen could not start a ${routed.backend} sub-agent: ${message}` };
    }

    const subagentBlock = (
      status: "spawned" | "running" | "done" | "error",
      costUsd?: number,
    ): EngineEvent => ({
      type: "block",
      key: `${key}:subagent`,
      patch: {
        kind: "subagent",
        agentId: null,
        parentAgentId: deps.parent.agentId,
        name: req.description || DELEGATE_TASK_TOOL,
        backend: routed.backend,
        model: model || null,
        description: req.description,
        status,
        delegated: true,
        ...(costUsd !== undefined ? { costUsd } : {}),
      },
    });

    // Registered before the first `await`: an interrupt that lands while the
    // child is still starting must still reach it.
    const release = deps.onHarness?.(harness);

    emit(subagentBlock("running"), harness);

    const agent: HarnessAgent = {
      agentId: `${deps.parent.agentId}#sub${index}`,
      name: req.description || "sub-agent",
      backend: routed.backend,
      model,
      ...(deps.parent.permissionMode ? { permissionMode: deps.parent.permissionMode } : {}),
      resumeSessionId: null,
      config: deps.parent.config,
    };

    const texts = new Map<string, string>();
    let usage: UsageTotals = { ...EMPTY_USAGE };
    let status: TurnStatus = "done";
    let error: string | null = null;

    try {
      await harness.start(deps.session, agent);
      const turnId = newId("turn");
      const timer = setTimeout(() => {
        void harness.interrupt().catch(() => undefined);
      }, deps.timeoutMs ?? DEFAULT_DELEGATE_TIMEOUT_MS);
      timer.unref?.();
      try {
        for await (const event of harness.send({ turnId, text: req.prompt })) {
          switch (event.type) {
            case "block": {
              // Text is what the caller gets back; every block is also
              // forwarded so the transcript shows the sub-agent working.
              if (event.patch.kind === "text") texts.set(event.key, event.patch.text);
              // The spread of a union of patches cannot be narrowed back to
              // the union by the compiler; the field is on every block kind
              // (`blockBase`) and the store re-parses with zod on the way in.
              const patch = { ...event.patch, delegatedFrom } as BlockPatch;
              emit({ ...event, key: `${key}:${event.key}`, patch }, harness);
              break;
            }
            case "turn": {
              status = event.status;
              error = event.error ?? null;
              break;
            }
            case "usage": {
              usage = addUsage(usage, event.usage);
              emit(event, harness);
              break;
            }
            case "session":
              // A delegated harness's backend session id belongs to nobody:
              // the sub-agent is disposed at the end of this call and is never
              // resumed, so storing it would make the *parent* resume it.
              break;
            default:
              // permission / question / elicitation: forwarded so the user
              // answers a delegated sub-agent exactly as any other turn (R27 —
              // nothing here is auto-approved).
              emit({ ...event, key: `${key}:${event.key}` }, harness);
              break;
          }
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      status = "error";
      error = describe(err);
    } finally {
      await harness.dispose().catch(() => undefined);
      release?.();
    }

    // Bounded here rather than at the two call sites, so the Claude in-process
    // MCP server and the `api` tool definition cannot disagree about it: the
    // sub-agent's answer becomes a `tool_result` in the *delegating* model's
    // context and is re-sent with every later turn of that conversation, so an
    // unbounded one compounds turn after turn (SPEC R23/R25).
    const raw = [...texts.values()].map((t) => t.trim()).filter(Boolean).join("\n\n");
    const clamped = clampText(raw, deps.maxResultChars ?? DEFAULT_DELEGATE_RESULT_CHARS);
    const text = clamped.content;
    emit(subagentBlock(status === "done" ? "done" : "error", usage.costUsd), harness);
    log.info(
      `[delegate] ${routed.backend}/${model || "default"} ${status}` +
        ` (${raw.length} chars${clamped.truncated ? ", truncated" : ""},` +
        ` $${usage.costUsd.toFixed(4)})`,
    );

    if (status !== "done") {
      return {
        ok: false,
        text: `The delegated ${routed.backend} sub-agent ${status}${error ? `: ${error}` : "."}`,
        backend: routed.backend,
        model,
        status,
        usage,
      };
    }
    return {
      ok: true,
      text: text || "The delegated sub-agent produced no text.",
      backend: routed.backend,
      model,
      status,
      usage,
    };
  };
}

/**
 * The `api` backend's view of the same tool: an ordinary `ToolDefinition` for
 * `packages/engine/src/tools/registry.ts`'s list.
 *
 * `permissionClass: "execute"` on purpose — a delegated turn can run commands
 * through *its* own gate, but the decision to spend another model's tokens is
 * the user's, and the class is what R27's gate keys on.
 */
export function delegateTaskTool(
  run: (req: DelegateRequest) => Promise<DelegateResult>,
): ToolDefinition {
  return {
    name: DELEGATE_TASK_TOOL,
    description: DELEGATE_TASK_DESCRIPTION,
    permissionClass: "execute",
    family: "task",
    parameters: DELEGATE_TASK_SCHEMA,
    async run(input, ctx) {
      const description = typeof input.description === "string" ? input.description : "";
      const prompt = typeof input.prompt === "string" ? input.prompt : "";
      if (!prompt) {
        return { content: "delegate_task needs a non-empty prompt.", isError: true };
      }
      const result = await run({
        description,
        prompt,
        ...(typeof input.model === "string" && input.model ? { model: input.model } : {}),
      });
      // `createDelegateRunner` already clamps to its own ceiling; this honours
      // the *caller's* budget as every other tool in `tools/` does, so a
      // harness configured with a smaller `maxToolOutputChars` gets it.
      const clamped = clampText(result.text, ctx.maxOutputChars);
      return { ...clamped, ...(result.ok ? {} : { isError: true }) };
    },
  };
}

function safely<T>(fn: () => T, log: DelegationLogger): T | null {
  try {
    return fn();
  } catch (err) {
    log.warn("[delegate] routing lookup failed; failing open", err);
    return null;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
