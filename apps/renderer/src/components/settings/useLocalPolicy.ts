/**
 * The renderer's side of the local policy management channels (ADR-0007,
 * P16/P17).
 *
 * Three things live here so neither page re-invents them:
 *
 *  1. **Refusal codes.** `apps/desktop/src/ipc/localPolicies.ts` answers a
 *     refused request with a code and nothing else — deliberately, since a
 *     message that interpolated the caller's pattern, label or tool name would
 *     put a tool call's own text back on screen. Electron wraps that rejection
 *     in its own prefix, so the code is recovered by looking for it rather than
 *     by parsing a shape, and the sentence a person reads is written *here*.
 *  2. **An honest unavailable state.** Outside the Electron shell, and whenever
 *     main answers `unavailable`, the page says the service could not be
 *     reached and offers Retry. It never renders an empty list as though the
 *     answer were "nothing configured" — those are different facts.
 *  3. **A tiny query helper.** Every read is load → data | error, re-run on
 *     demand, with stale answers dropped.
 *
 * No policy logic: no matcher, no precedence, no scope resolution. Attribution
 * comes from `policy.rules.preview`, which runs the main-process evaluator, so
 * a preview cannot drift from what an actual tool call would decide.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { EventPayload, LocalPolicyIpcErrorCode } from "@capygen/shared";
import { hasBridge, ipc } from "@/lib/ipc";

const CODES: readonly LocalPolicyIpcErrorCode[] = [
  "invalid-request",
  "unknown-session",
  "unknown-project",
  "unknown-member",
  "unknown-rule",
  "member-assigned",
  "session-busy",
  "read-only-artifact",
  "not-permitted",
  "unavailable",
];

/**
 * The refusal code inside an IPC rejection, or null.
 *
 * Substring, not equality: `ipcMain.handle` re-throws with its own
 * `Error invoking remote method …` prefix, so the handler's message arrives
 * embedded. The marker is matched first so an unrelated error that happens to
 * contain the word "unavailable" is not read as a refusal.
 */
export function policyErrorCode(error: unknown): LocalPolicyIpcErrorCode | null {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const marker = "local policy request refused:";
  const at = message.indexOf(marker);
  if (at < 0) return null;
  const tail = message.slice(at + marker.length);
  // Longest first, so `unknown-session` is not shadowed by a shorter prefix.
  return [...CODES].sort((a, b) => b.length - a.length).find((code) => tail.includes(code)) ?? null;
}

/**
 * What a person reads for a refusal.
 *
 * Every string is authored here. An unrecognised failure gets a generic
 * sentence rather than `error.message`: a SQLite error, a transport failure or
 * a contract mismatch can carry a file path, a channel's internals or a
 * fragment of the payload, and none of that belongs on screen for a surface
 * whose payloads describe tool calls.
 */
export function policyErrorMessage(error: unknown): string {
  switch (policyErrorCode(error)) {
    case "invalid-request":
      return "That request was not valid. Check the fields and try again.";
    case "unknown-session":
      return "That session no longer exists.";
    case "unknown-project":
      return "That project no longer exists.";
    case "unknown-member":
      return "That execution profile no longer exists.";
    case "unknown-rule":
      return "That restriction no longer exists.";
    case "member-assigned":
      return "This profile is still assigned to one or more sessions. Reassign them first.";
    case "session-busy":
      return "Finish or stop the current turn before changing this session's execution profile.";
    case "read-only-artifact":
      return "This is a read-only imported artifact; it cannot run turns, so it takes no profile.";
    case "not-permitted":
      return "This machine's operator profile cannot make that change.";
    case "unavailable":
      return "The local policy service is unavailable. Try again.";
    default:
      return "Something went wrong reading the local policy service. Try again.";
  }
}

/** True when the failure means "could not reach the service", not "refused". */
export function isPolicyUnavailable(error: unknown): boolean {
  if (policyErrorCode(error) === "unavailable") return true;
  return error instanceof Error && error.message.includes("preload bridge is missing");
}

export interface PolicyQuery<T> {
  data: T | null;
  loading: boolean;
  /** A refusal, already turned into a sentence. */
  error: string | null;
  /** The service could not be reached at all — offer Retry, never an empty list. */
  unavailable: boolean;
  /** Re-read the *same* scope. Keeps what is on screen while it runs. */
  reload: () => Promise<void>;
}

/**
 * Identity of the scope a read belongs to.
 *
 * Primitives only, by contract: the deps of a policy read are ids and enum
 * values, and stringifying an object would either be expensive or unstable.
 */
function scopeKey(deps: readonly unknown[]): string {
  return deps.map((value) => (value === null || value === undefined ? "" : String(value))).join("\u0000");
}

/**
 * Read once per scope, re-read on demand.
 *
 * Two things this has to keep apart, because they look the same from inside:
 *
 *  - **a switch** (the session or agent changed) must blank what is on screen.
 *    Keeping the previous scope's answer visible under the new scope's label is
 *    how one session's profile, or one agent's enforcement points, get read as
 *    another's;
 *  - **a refresh** (same scope, after a write) must not blank it, or every
 *    successful edit flashes the whole panel back to a spinner.
 *
 * Stale completions are dropped by ticket, and unmounting takes a ticket too,
 * so an answer that arrives after the panel is gone updates nothing.
 */
/**
 * Which `policy.changed` areas a read depends on.
 *
 * Main emits metadata only — an area and an optional session — so a view can
 * re-read exactly what moved without anything about the change entering model
 * context. A read that declares no areas is never invalidated by an event.
 */
export type PolicyArea = EventPayload<"policy.changed">["area"];

export interface PolicyQueryOptions {
  /** Areas whose change should re-read this query. */
  invalidateOn?: readonly PolicyArea[];
  /**
   * The session this read is about, when it is about one.
   *
   * An event carrying a session id only invalidates reads for that session;
   * an event with `sessionId: null` is global and invalidates every read in
   * its areas. A session-scoped read must not be left stale by a global
   * change, so the null case is the broad one on purpose.
   */
  sessionId?: string | null;
}

export function usePolicyQuery<T>(
  load: () => Promise<T>,
  deps: readonly unknown[],
  options: PolicyQueryOptions = {},
): PolicyQuery<T> {
  const key = scopeKey(deps);
  const [state, setState] = useState<{
    key: string;
    data: T | null;
    loading: boolean;
    error: string | null;
    unavailable: boolean;
  }>({ key, data: null, loading: true, error: null, unavailable: false });

  const ticket = useRef(0);
  const run = useRef(load);
  run.current = load;
  // The scope the component is on *now*, as opposed to the one a given
  // in-flight read was issued for.
  const currentKey = useRef(key);
  currentKey.current = key;

  const read = useCallback(async (forKey: string, mode: "switch" | "refresh") => {
    const mine = (ticket.current += 1);
    setState((prev) =>
      mode === "switch"
        ? { key: forKey, data: null, loading: true, error: null, unavailable: false }
        : { ...prev, key: forKey, loading: true },
    );
    const settle = (next: { data?: T | null; error?: string | null; unavailable?: boolean }): void => {
      // Three guards, all needed: a newer read has started, the component moved
      // to another scope, or the component is gone (unmount takes a ticket).
      if (ticket.current !== mine || currentKey.current !== forKey) return;
      setState((prev) =>
        prev.key !== forKey ? prev : { ...prev, loading: false, ...next },
      );
    };
    if (!hasBridge()) {
      settle({ unavailable: true, error: null });
      return;
    }
    try {
      settle({ data: await run.current(), error: null, unavailable: false });
    } catch (err) {
      // An unreachable service is not an empty result. On a refresh the last
      // known answer stays and the page says it may be out of date; on a switch
      // there is nothing to keep, and `data` is already null.
      if (isPolicyUnavailable(err)) settle({ unavailable: true, error: null });
      else settle({ error: policyErrorMessage(err), unavailable: false });
    }
  }, []);

  useEffect(() => {
    void read(key, "switch");
  }, [key, read]);

  useEffect(
    () => () => {
      // Take a ticket on the way out so a late answer cannot set state.
      ticket.current += 1;
    },
    [],
  );

  const reload = useCallback(() => read(currentKey.current, "refresh"), [read]);

  // Another window (or main itself) changed something this read depends on.
  // Re-read rather than patch: the event is metadata, and the authority for
  // what the answer now is stays in main.
  const areas = options.invalidateOn;
  const scopeSessionId = options.sessionId ?? null;
  const areaKey = areas === undefined ? "" : [...areas].join(",");
  useEffect(() => {
    if (areaKey === "" || !hasBridge()) return;
    const watched = new Set(areaKey.split(","));
    return ipc().on("policy.changed", (event) => {
      if (!watched.has(event.area)) return;
      // A global change (no session) touches every read in its areas; a
      // session-scoped change touches only reads about that session.
      if (event.sessionId !== null && scopeSessionId !== null && event.sessionId !== scopeSessionId) {
        return;
      }
      void read(currentKey.current, "refresh");
    });
  }, [areaKey, scopeSessionId, read]);

  return {
    // Never hand back another scope's answer, even for the render between the
    // key changing and the effect running.
    data: state.key === key ? state.data : null,
    loading: state.key === key ? state.loading : true,
    error: state.key === key ? state.error : null,
    unavailable: state.key === key ? state.unavailable : false,
    reload,
  };
}

/**
 * Wrap a row action so a refusal reaches `useRowActions` already in words.
 *
 * `useRowActions` stores `err.message` verbatim — correct for the integrations
 * sections, whose stores throw sentences, and wrong here: a policy handler
 * throws a *code* wrapped in Electron's own prefix, so without this the row
 * would show `Error invoking remote method … local policy request refused:
 * member-assigned` instead of what to do about it.
 */
export function withPolicyMessage<T>(action: () => Promise<T>): () => Promise<T> {
  return async () => {
    try {
      return await action();
    } catch (error) {
      throw new Error(policyErrorMessage(error));
    }
  };
}
