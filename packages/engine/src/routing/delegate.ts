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
import {
  newId,
  type Backend,
  type PermissionMode,
  type TurnStatus,
  type UsageTotals,
} from "@capygen/shared";
import type { ModelCatalogue } from "../config/layering.js";
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
  /**
   * The calling tool's own cancellation signal (`ToolContext.signal`).
   *
   * `onHarness` already lets the desktop stop a delegated child when the *user*
   * presses Stop. This is the other direction: the tool call itself was
   * cancelled — a Codex `item/tool/call` abandoned by an interrupt, an `api`
   * turn that ended — and the child must not keep running (and billing) for a
   * caller that is no longer listening. Aborting one call's signal never
   * touches another call's child.
   */
  signal?: AbortSignal | undefined;
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
  /** Build (not start) a harness for the routed backend. Handed the **same**
   *  resolved agent that `start()` will receive — see `resolveChild`. */
  makeHarness: (target: { backend: Backend; model: string }, agent: HarnessAgent) => Harness;
  /**
   * [7-P1] The target backend's effective configuration and permission mode:
   * that backend's canonical global default with the parent's explicit
   * `config.<targetBackend>` section on top.
   *
   * The parent's section for the target is a deliberate override — a Claude
   * lead that sets `codex.reasoningEffort` means it — and must survive. The
   * parent's **permission mode** is not among the things carried across: it is
   * the mode granted to the parent on the parent's backend, and copying a
   * `bypassPermissions` onto an `api` child hands a different backend an
   * authority nobody granted it there. The resolver answers the target's own.
   *
   * Absent (tests, older callers) means: no global layer, and the parent's own
   * section for that backend, with no permission mode carried at all.
   */
  resolveTarget?: (backend: Backend) => {
    config: Record<string, unknown>;
    permissionMode?: PermissionMode;
    /**
     * That backend's **canonical** default model, when it has one. Consulted
     * only after the tool's own request and the routing rule, so an explicit
     * choice still wins; it exists because a route that names a backend and no
     * model used to skip the global default entirely and go straight to the
     * catalogue — so a configured `backends.codex.model` was ignored for
     * exactly the sub-agents it was meant to configure.
     */
    model?: string | null;
    /** Refuses a resolved model that certainly belongs to another backend. */
    validate?: (model: string) => { ok: boolean; reason?: string };
  };
  /** That backend's own catalogue default, when the route names no model. */
  catalogue?: ModelCatalogue;
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
  /**
   * How long an aborted child is given to end its own turn after `interrupt()`
   * before it is disposed anyway. A backend that ignores the interrupt must not
   * be able to keep the call — or the billing — alive.
   */
  abortGraceMs?: number;
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
/** Grace between interrupting an aborted child and disposing it regardless. */
export const DEFAULT_DELEGATE_ABORT_GRACE_MS = 2_000;

/** Raced against a child's startup and its stream; unique, so nothing matches. */
const STOPPED: unique symbol = Symbol("capygen.delegateStopped");

/** Resolves with `fn`'s value, or simply resolves when the deadline passes. */
async function withDeadline(work: Promise<unknown>, ms: number): Promise<void> {
  await Promise.race([
    work,
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    }),
  ]);
}

/** What a cancelled delegation answers, whatever stage it was cut at. */
const CANCELLED_TEXT = "capygen cancelled this delegated task before the sub-agent produced an answer.";

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
    /**
     * [7-P1] The child's model, resolved the same way any other agent's is:
     * the tool's own request, then the route, then **that backend's own**
     * catalogue default. Never the app-wide alias, and never empty — a Codex
     * `thread/start` with no model silently takes a `config.toml` default
     * capygen cannot see, which is not a model anyone chose.
     *
     * A child that cannot be given a model is a **structured failed tool
     * result**, not a dispatch. The neighbouring "no routing rule at all" case
     * above keeps its R12 fail-open answer unchanged; this guard is only about
     * a route that exists and names nothing runnable.
     */
    const target = deps.resolveTarget?.(routed.backend);
    const model =
      (req.model ?? "").trim() ||
      (routed.model ?? "").trim() ||
      (target?.model ?? "").trim() ||
      (deps.catalogue?.(routed.backend) ?? "").trim();
    if (!model) {
      log.warn(`[delegate] routing names ${routed.backend} but no model can be resolved`);
      return {
        ok: false,
        text:
          `capygen's routing rule names the ${routed.backend} backend, but no model is ` +
          "configured for it and it offers no default to fall back on, so no sub-agent was " +
          "started. Pick a model for that backend in Settings, or do the work yourself.",
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

    /**
     * [7-P1] **One** child agent, built once and used twice.
     *
     * This used to be two independently constructed objects: `SessionRunner`
     * built one for `makeHarness` and this file built another for `start()` —
     * both from the parent, and the second one silently superseded the first
     * for everything the harness actually runs on. A test that asserted the
     * factory input therefore proved nothing about the child.
     */
    // A resolved model that certainly belongs to another backend is a failed
    // tool result too, not a spawn: the child would fail with the backend's own
    // error, inside a turn the user is watching, with nothing to act on.
    const verdict = target?.validate?.(model);
    if (verdict && !verdict.ok) {
      log.warn(`[delegate] refusing ${routed.backend}/${model}: ${verdict.reason ?? "invalid"}`);
      return {
        ok: false,
        text:
          `capygen did not start a ${routed.backend} sub-agent: ${verdict.reason ?? ""} ` +
          "Fix the routing rule or that backend's default model in Settings, or do the work " +
          "yourself.",
      };
    }

    const childConfig = target
      ? target.config
      : ((deps.parent.config as Record<string, Record<string, unknown>> | null | undefined)?.[
          routed.backend
        ] ?? {});
    const childAgent: HarnessAgent = {
      agentId: `${deps.parent.agentId}#sub${index}`,
      name: req.description || "sub-agent",
      backend: routed.backend,
      model,
      // Never `deps.parent.permissionMode`: that is the parent's grant on the
      // parent's backend. The target's own resolved mode, or nothing.
      ...(target?.permissionMode ? { permissionMode: target.permissionMode } : {}),
      resumeSessionId: null,
      config: { [routed.backend]: childConfig } as HarnessAgent["config"],
    };

    // Cancelled before anything was built: constructing a child here would
    // spawn a process (or lease a pool) for a caller that has already gone, and
    // the only thing left to do with it would be to tear it down again.
    if (req.signal?.aborted) {
      log.info("[delegate] the caller had already cancelled; no sub-agent was built");
      return { ok: false, text: CANCELLED_TEXT, backend: routed.backend, model, status: "interrupted" };
    }

    let harness: Harness;
    try {
      harness = deps.makeHarness({ backend: routed.backend, model }, childAgent);
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

    const grace = deps.abortGraceMs ?? DEFAULT_DELEGATE_ABORT_GRACE_MS;
    let aborted = false;
    let abortTimer: ReturnType<typeof setTimeout> | null = null;
    let stopTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed: Promise<void> | null = null;
    const disposeOnce = (): Promise<void> => {
      disposed ??= harness.dispose().catch(() => undefined);
      return disposed;
    };
    /** Resolves once this call has given up waiting for the child, whatever
     *  the child is doing. Never resolves while the call is running normally. */
    let resolveStop: (value: typeof STOPPED) => void = () => {};
    const stopped = new Promise<typeof STOPPED>((resolve) => {
      resolveStop = resolve;
    });

    /**
     * Every escalation this call can perform, in order and on a clock.
     *
     * `interrupt()` is a request, `dispose()` is a request, and an
     * `AsyncIterator` that never yields is not obliged to notice either. So
     * each step has a deadline and the last one does not depend on the child at
     * all: after `grace * 2` this call stops reading and answers, and the
     * caller — a Codex `item/tool/call`, an `api` tool result — is unblocked
     * whatever the child has decided to do.
     */
    const beginStop = (): void => {
      if (aborted) return;
      aborted = true;
      void harness.interrupt().catch(() => undefined);
      abortTimer = setTimeout(() => void disposeOnce(), grace);
      abortTimer.unref?.();
      stopTimer = setTimeout(() => resolveStop(STOPPED), grace * 2);
      stopTimer.unref?.();
    };
    const onAbort = (): void => beginStop();
    if (req.signal) {
      if (req.signal.aborted) onAbort();
      else req.signal.addEventListener("abort", onAbort, { once: true });
    }

    emit(subagentBlock("running"), harness);

    const agent = childAgent;

    const texts = new Map<string, string>();
    let usage: UsageTotals = { ...EMPTY_USAGE };
    let status: TurnStatus = "done";
    let error: string | null = null;

    try {
      /**
       * Startup is raced, not merely awaited.
       *
       * `start()` is where a backend takes hold of something real — a child
       * process, an SDK session, a pool lease — and it can be slow or, for a
       * backend that is wedged, endless. Awaiting it plainly meant an abort
       * that landed here was noticed only *after* it returned, and the loop
       * below then sent a turn the user had already stopped.
       */
      const startedOk = await Promise.race([
        harness.start(deps.session, agent).then(
          () => "started" as const,
          (err: unknown) => ({ failed: err }),
        ),
        stopped,
      ]);
      if (startedOk === STOPPED || req.signal?.aborted) {
        status = "interrupted";
        error = "the caller cancelled this delegated task";
        throw new CancelledDelegation();
      }
      if (typeof startedOk === "object") throw startedOk.failed;

      const turnId = newId("turn");
      // The existing hard ceiling on one delegated turn, now with the teardown
      // its own doc comment promised: interrupt, then dispose, then stop
      // reading. Before this it only ever asked, and a backend that ignored the
      // request kept the call open for good.
      const timer = setTimeout(() => beginStop(), deps.timeoutMs ?? DEFAULT_DELEGATE_TIMEOUT_MS);
      timer.unref?.();
      // Driven by hand rather than by `for await`, because `for await` offers
      // no way to stop waiting on a `next()` that never settles.
      const iterator = harness.send({ turnId, text: req.prompt })[Symbol.asyncIterator]();
      try {
        for (;;) {
          const step = await Promise.race([
            iterator.next().then(
              (result) => ({ result }),
              (err: unknown) => ({ failed: err }),
            ),
            stopped,
          ]);
          // Given up on: nothing this child produces from here is emitted, and
          // the abandoned `next()` above already has both handlers attached, so
          // a late rejection cannot go unhandled.
          if (step === STOPPED) {
            status = status === "done" ? "interrupted" : status;
            error ??= "the delegated sub-agent stopped responding and was abandoned";
            break;
          }
          if ("failed" in step) throw step.failed;
          if (step.result.done === true) break;
          const event = step.result.value;
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
        // Asked for, never waited on: a generator's own cleanup can hang too.
        void Promise.resolve(iterator.return?.()).catch(() => undefined);
      }
    } catch (err) {
      // A cancellation is not a failure to report as one: `status`/`error` are
      // already set, and the teardown below still runs.
      if (!(err instanceof CancelledDelegation)) {
        status = "error";
        error = describe(err);
      }
    } finally {
      if (abortTimer) clearTimeout(abortTimer);
      if (stopTimer) clearTimeout(stopTimer);
      // Removed on every path, including the ordinary one. The caller's signal
      // belongs to a whole parent turn and outlives many delegated calls; a
      // listener left on it per call is a leak that grows with the session.
      req.signal?.removeEventListener("abort", onAbort);
      try {
        // Bounded: a `dispose()` that hangs must not hold the caller.
        await withDeadline(disposeOnce(), grace);
      } finally {
        // Its own `finally`, so a wedged teardown cannot keep this child in the
        // desktop's interrupt registry for the rest of the session.
        release?.();
      }
    }

    // A child torn down mid-flight has not completed, whatever its stream did
    // or did not say on the way out: a backend that ignores `interrupt()` emits
    // no `turn` event at all, and reporting that as a successful empty answer
    // would tell the caller its cancelled sub-task had simply found nothing.
    if (aborted && status === "done") {
      status = "interrupted";
      error ??= "the caller cancelled this delegated task";
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
        // The caller's cancellation travels with the request: a tool call that
        // is abandoned must not leave a sub-agent running behind it.
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      // `createDelegateRunner` already clamps to its own ceiling; this honours
      // the *caller's* budget as every other tool in `tools/` does, so a
      // harness configured with a smaller `maxToolOutputChars` gets it.
      const clamped = clampText(result.text, ctx.maxOutputChars);
      return { ...clamped, ...(result.ok ? {} : { isError: true }) };
    },
  };
}

/** Thrown only to leave the try block; never surfaces to a caller. */
class CancelledDelegation extends Error {}

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
