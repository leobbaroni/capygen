/**
 * The local policy seam (Phase 9, `docs/adr/0007-local-policy-enforcement.md`).
 *
 * capygen enforces its own restrictions *in addition to* each backend's native
 * permission rules, at the few places a backend actually lets a client stand in
 * the execution path. This file is the contract between those places and
 * whatever evaluates the rules — which lives in the desktop process, so the
 * engine takes a callback rather than a service.
 *
 * Three properties the whole design rests on:
 *
 *  - **A local verdict never speaks for a backend.** A local *allow* is only
 *    the absence of a capygen restriction; it is never converted into an
 *    unconditional native allow, because that would silently widen the user's
 *    own Claude or Codex configuration. Native hard denials still win.
 *  - **Fail closed.** A callback that throws, hangs past its caller's abort, or
 *    answers with a shape this file does not recognise refuses the call. ADR
 *    R12's routing fail-*open* deliberately does not apply here: a routing
 *    preference that cannot be applied is a worse answer, but a *restriction*
 *    that cannot be evaluated is a restriction that must hold.
 *  - **Only the approved input executes.** The verdict carries the exact value
 *    to run, because an operator may have edited it while it was waiting. The
 *    caller must never fall back to the object it already had.
 *
 * Names here mirror `@capygen/shared`'s `PolicyBoundary` deliberately, but the
 * types are engine-local: the engine must not depend on the desktop's policy
 * service, and a harness that is handed no callback simply has no local policy.
 */

/**
 * Where a restriction is actually enforced.
 *
 * Each value is a real interception point in a pinned protocol, not a category
 * of tool: a rule names the boundary it can be enforced at, and a boundary that
 * this agent's captured configuration cannot offer refuses rather than pretends
 * (see `PolicyBoundarySupport`).
 */
export type PolicyBoundary =
  | "api-tool"
  | "claude-pre-tool"
  | "codex-dynamic-tool"
  | "codex-command-approval"
  | "codex-file-approval"
  | "codex-permissions-approval";

export type PolicyBoundaryUnavailableReason =
  | "unsupported-backend"
  | "native-approval-disabled"
  | "capability-unproven"
  | "harness-unavailable";

/**
 * One boundary's availability for **this** agent and **this** captured
 * lifecycle. Never union one agent's boundaries into another's: a Codex thread
 * started with `approvalPolicy: "never"` cannot enforce an approval-category
 * rule however the neighbouring agent is configured.
 */
export interface PolicyBoundarySupport {
  boundary: PolicyBoundary;
  available: boolean;
  /** Always set when unavailable, always null when available. */
  reason: PolicyBoundaryUnavailableReason | null;
}

export interface LocalAuthorizationRequest {
  boundary: PolicyBoundary;
  /** The tool's own name, exactly as the backend named it. */
  toolName: string;
  /** The complete input that would execute — never a summary or a subset. */
  input: unknown;
  /** The directory the call would execute in; part of a grant's identity. */
  cwd: string;
  /** Aborted when the turn, the call or the harness goes away. */
  signal: AbortSignal;
  /**
   * Where in one call's life this check sits.
   *
   * `"pre"` runs before the backend's own permission machinery — it is the only
   * place a restriction can reach a tool the native rules would auto-allow.
   * `"final"` runs immediately before execution, on the input that will
   * actually run, after any native approval and operator edit.
   *
   * Both may fire for a single call. An authorizer that prompts should bind its
   * answer to `callId` and treat a `"final"` check for the same call and the
   * same input as the resolution of what it already asked, rather than asking
   * twice — never by widening a grant beyond that one pending call.
   */
  stage: "pre" | "final";
  /** Stable across every check of the same call; the backend's tool-use id. */
  callId: string;
}

export interface LocalAuthorization {
  allowed: boolean;
  /**
   * The exact input to execute. **Required when `allowed` is true** — an
   * approval that does not say what it approved is a contract violation and is
   * treated as a refusal, because the alternative is executing an object the
   * authorizer never saw.
   */
  approvedInput?: unknown;
  /** Shown to the model and the user. Never a raw evaluation error. */
  message?: string | null;
}

/** The desktop supplies this; the engine only ever calls it. */
export type LocalAuthorize = (
  request: LocalAuthorizationRequest,
) => Promise<LocalAuthorization> | LocalAuthorization;

/** What a caller acts on: run `input`, or refuse with `message`. */
export type LocalVerdict =
  | { allowed: true; input: unknown }
  | { allowed: false; message: string };

export interface AuthorizeLocallyOptions {
  /**
   * Whether this boundary can actually apply an edited input.
   *
   * False for Codex's command and file approval categories: the protocol
   * accepts a decision, not a rewritten command, so an authorizer that returns
   * a *different* input is refused rather than allowed with the original. A
   * boundary that cannot apply an edit must not claim it did.
   */
  allowInputReplacement: boolean;
  /**
   * Whether the approved value must be a plain object.
   *
   * True wherever the boundary executes a *tool input*: a string or a number
   * cannot be handed to `tool.run`, and falling back to the caller's original
   * would execute something the authorizer never approved.
   */
  requireObject: boolean;
}

const REFUSED_BY_DEFAULT =
  "capygen's local policy could not authorize this call, so it was refused.";

/** Bounds on a snapshot, so a hostile input cannot make identity expensive. */
export const MAX_SNAPSHOT_DEPTH = 64;
export const MAX_SNAPSHOT_BYTES = 256 * 1024;
export const MAX_SNAPSHOT_ENTRIES = 10_000;

export type JsonSnapshot =
  | { ok: true; canonical: string }
  | { ok: false; reason: string };

/**
 * A strict, bounded, total canonical form.
 *
 * [review] The previous `canonicalJson` built its output with
 * `out = {}; out[key] = …`, which for the key `__proto__` sets the prototype
 * instead of creating a property — so that pair vanished and two different
 * inputs collapsed to one identity. It also inherited `JSON.stringify`'s habit
 * of *eliding* `undefined` and functions, coercing `NaN` and `Infinity` to
 * `null`, invoking getters, and throwing on a cycle.
 *
 * None of that is acceptable for something a decision is made against, so this
 * emits text directly — sorted own enumerable string keys, no intermediate
 * object — and **refuses** anything it cannot represent exactly rather than
 * quietly changing it. It never throws: the guard is the return value.
 *
 * This is capygen's *engine-side* equality only. It deliberately does not
 * reimplement the desktop's grant-signature snapshot: authority over grants
 * stays in one place (ADR-0007), and a second implementation would be a second
 * definition of identity.
 */
export function jsonSnapshot(value: unknown): JsonSnapshot {
  const out: string[] = [];
  let budget = MAX_SNAPSHOT_BYTES;
  let entries = 0;
  const seen = new Set<object>();

  const fail = (reason: string): JsonSnapshot => ({ ok: false, reason });

  const emit = (text: string): string | null => {
    budget -= text.length;
    if (budget < 0) return "size";
    out.push(text);
    return null;
  };

  /** Returns a failure reason, or null when the value was written. */
  const walk = (node: unknown, depth: number): string | null => {
    if (depth > MAX_SNAPSHOT_DEPTH) return "depth";
    if (node === null) return emit("null");
    switch (typeof node) {
      case "boolean":
        return emit(node ? "true" : "false");
      case "number":
        // `JSON.stringify` turns both into `null`, silently making two very
        // different inputs identical.
        if (!Number.isFinite(node)) return "non-finite-number";
        return emit(String(node));
      case "string":
        return emit(JSON.stringify(node));
      case "undefined":
        return "undefined";
      case "bigint":
        return "bigint";
      case "function":
        return "function";
      case "symbol":
        return "symbol";
      default:
        break;
    }
    const object = node as object;
    if (seen.has(object)) return "cycle";
    seen.add(object);
    try {
      if (Array.isArray(object)) {
        const failure = emit("[");
        if (failure) return failure;
        for (let index = 0; index < object.length; index += 1) {
          if (++entries > MAX_SNAPSHOT_ENTRIES) return "entries";
          // A hole is not `undefined`; `JSON.stringify` prints `null` for both.
          if (!Object.prototype.hasOwnProperty.call(object, index)) return "array-hole";
          const descriptor = Object.getOwnPropertyDescriptor(object, index);
          if (descriptor && !("value" in descriptor)) return "accessor";
          if (index > 0) {
            const sep = emit(",");
            if (sep) return sep;
          }
          const inner = walk((object as unknown[])[index], depth + 1);
          if (inner) return inner;
        }
        return emit("]");
      }
      // Only plain data. A Date, Map, class instance or boxed primitive would
      // serialise to something that does not round-trip.
      const proto = Object.getPrototypeOf(object);
      if (proto !== Object.prototype && proto !== null) return "not-plain-object";
      if (Object.getOwnPropertySymbols(object).length > 0) return "symbol-key";
      const keys = Object.keys(object).sort();
      const opened = emit("{");
      if (opened) return opened;
      let first = true;
      for (const key of keys) {
        if (++entries > MAX_SNAPSHOT_ENTRIES) return "entries";
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        // Never invoked: reading it is a side effect and its answer can change
        // between the check and the execution it is supposed to authorize.
        if (!descriptor || !("value" in descriptor)) return "accessor";
        if (!first) {
          const sep = emit(",");
          if (sep) return sep;
        }
        first = false;
        const written = emit(`${JSON.stringify(key)}:`);
        if (written) return written;
        const inner = walk(descriptor.value, depth + 1);
        if (inner) return inner;
      }
      return emit("}");
    } finally {
      seen.delete(object);
    }
  };

  const reason = walk(value, 0);
  return reason === null ? { ok: true, canonical: out.join("") } : fail(reason);
}

/**
 * Ask the local authorizer, and turn anything it does — including nothing —
 * into a verdict a caller can act on without further judgement.
 *
 * No callback means no local policy is wired, which is not the same as a policy
 * that refuses: the harness behaves exactly as it did before this seam existed.
 * Every other path is closed.
 */
export async function authorizeLocally(
  authorize: LocalAuthorize | undefined,
  request: LocalAuthorizationRequest,
  options: AuthorizeLocallyOptions,
): Promise<LocalVerdict> {
  // Checked first, and regardless of whether an authorizer is wired: a
  // cancelled call is not something "no local policy" should wave through.
  if (request.signal.aborted) {
    return { allowed: false, message: "This call was cancelled before it was authorized." };
  }
  if (!authorize) return { allowed: true, input: request.input };

  /**
   * [review] Raced, not merely re-checked afterwards. `await authorize(...)` on
   * a callback that never settles waits for ever whatever the signal says, so
   * an aborted turn could leave a call pending indefinitely — and a callback
   * that answered *after* the abort could still be read as an approval.
   */
  const aborted = Symbol("aborted");
  let onAbort: (() => void) | undefined;
  const cancellation = new Promise<typeof aborted>((resolve) => {
    onAbort = () => resolve(aborted);
    request.signal.addEventListener("abort", onAbort, { once: true });
  });

  let answer: LocalAuthorization | null | typeof aborted;
  try {
    answer = await Promise.race([
      // Both handlers attached, so an abandoned rejection is never unhandled
      // and a late answer resolves nothing.
      (async (): Promise<LocalAuthorization | null> => authorize(request))().then(
        (value) => value,
        () => null,
      ),
      cancellation,
    ]);
  } finally {
    if (onAbort) request.signal.removeEventListener("abort", onAbort);
  }

  if (answer === aborted || request.signal.aborted) {
    return { allowed: false, message: "This call was cancelled while it was being authorized." };
  }
  if (!answer || typeof answer !== "object") return { allowed: false, message: REFUSED_BY_DEFAULT };
  const message =
    typeof answer.message === "string" && answer.message.length > 0
      ? answer.message
      : REFUSED_BY_DEFAULT;
  if (answer.allowed !== true) return { allowed: false, message };
  // An approval that does not name what it approved cannot be executed: there
  // would be nothing to distinguish "unchanged" from "the authorizer never got
  // as far as looking at the input". An inherited property is not an answer.
  if (!Object.prototype.hasOwnProperty.call(answer, "approvedInput")) {
    return { allowed: false, message: REFUSED_BY_DEFAULT };
  }
  const approved = answer.approvedInput;
  if (options.requireObject && !isPlainObject(approved)) {
    return {
      allowed: false,
      message:
        "The approved input was not a tool input object, so the call was refused rather " +
        "than run with an input nobody approved.",
    };
  }
  const snapshot = jsonSnapshot(approved);
  if (!snapshot.ok) {
    return {
      allowed: false,
      message:
        `The approved input cannot be represented exactly (${snapshot.reason}), so the call ` +
        "was refused.",
    };
  }
  if (!options.allowInputReplacement) {
    const original = jsonSnapshot(request.input);
    if (!original.ok || original.canonical !== snapshot.canonical) {
      return {
        allowed: false,
        message:
          "This request was approved with a modified input, which this backend boundary " +
          "cannot apply, so it was refused rather than run unchanged.",
      };
    }
  }
  return { allowed: true, input: approved };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
