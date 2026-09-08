/**
 * One agent's MCP server/tool catalogue, for the composer's informational menu.
 *
 * Strictly **informational**. The catalogue names servers and tools so a person
 * can see what an agent has available; it is never a way to pick or run one, it
 * never reaches a prompt, and nothing here is added to model context. That is
 * why it sits beside the slash-command list rather than in it: a slash command
 * is something the user invokes, an MCP tool is something the agent calls.
 *
 * Reading it can be expensive - `initialize: true` asks the backend to start
 * servers it has not started - so the read here is always `initialize: false`.
 * An explicit refresh is the only thing that may initialize, and that is the
 * caller's decision rather than a side effect of opening a menu.
 *
 * Lifecycle rules this hook exists to hold:
 *
 *  - a query belongs to one (session, agent) pair; switching agent must not
 *    show the previous agent's servers under the new agent's name;
 *  - a late answer is dropped rather than applied, including after unmount;
 *  - `unsupported`, `notStarted`, `error`, `cancelled` and `stale` stay
 *    distinct. Collapsing them into "no tools" makes a backend that cannot
 *    report look identical to one that has nothing, and `cancelled` in
 *    particular does not mean the user cancelled: an earlier query for this
 *    agent may still be outstanding in the backend.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentToolCatalogue } from "@capygen/shared";
import { hasBridge, ipc } from "@/lib/ipc";

export interface AgentCatalogueQuery {
  catalogue: AgentToolCatalogue | null;
  loading: boolean;
  /** Ask again. `initialize` starts servers, so it is never automatic. */
  refresh: (options?: { initialize?: boolean }) => Promise<void>;
}

export function useAgentCatalogue(
  sessionId: string | null,
  agentId: string | null,
): AgentCatalogueQuery {
  /**
   * Catalogue *and* loading, keyed together.
   *
   * They were two states, and the read returned early for a key with no
   * session — before invalidating anything — so switching to a session-less
   * key while a request was in flight left `loading` true forever: the
   * outstanding read's own cleanup was skipped because the key had moved on,
   * and nothing else was going to clear it. Keeping the flag beside the key it
   * belongs to means a key that is not being read simply is not loading.
   */
  const [state, setState] = useState<{
    key: string;
    catalogue: AgentToolCatalogue | null;
    loading: boolean;
  }>({ key: "", catalogue: null, loading: false });
  const request = useRef(0);
  const key = `${sessionId ?? ""}\u0000${agentId ?? ""}`;
  const currentKey = useRef(key);
  currentKey.current = key;

  const read = useCallback(async (forKey: string, initialize: boolean) => {
    // The ticket is taken first, unconditionally: even a key with nothing to
    // ask must invalidate whatever was in flight, or an older answer could
    // still land after it.
    const mine = (request.current += 1);
    const [forSession, forAgent] = forKey.split("\u0000");
    if (forSession === undefined || forSession === "" || !hasBridge()) {
      // Nothing to ask about. Settle the key rather than leaving the previous
      // one's `loading` standing.
      setState({ key: forKey, catalogue: null, loading: false });
      return;
    }
    setState((prev) =>
      // A refresh of the same key keeps what is on screen; a switch blanks it,
      // so one agent's servers never appear under another agent's name.
      prev.key === forKey
        ? { ...prev, loading: true }
        : { key: forKey, catalogue: null, loading: true });
    try {
      const catalogue = await ipc().invoke("agents.catalogue", {
        sessionId: forSession,
        agentId: forAgent === undefined || forAgent === "" ? null : forAgent,
        initialize,
      });
      // Three guards: a newer read started, the component moved to another
      // agent, or it unmounted (which takes a ticket).
      if (request.current !== mine || currentKey.current !== forKey) return;
      setState({ key: forKey, catalogue, loading: false });
    } catch {
      if (request.current !== mine || currentKey.current !== forKey) return;
      // A failed read is a real state, distinct from "no tools": the menu must
      // be able to say the catalogue could not be read.
      setState({ key: forKey, catalogue: { kind: "error" }, loading: false });
    }
  }, []);

  useEffect(() => {
    // Never `initialize` on its own: opening a menu must not start servers.
    void read(key, false);
  }, [key, read]);

  useEffect(() => () => { request.current += 1; }, []);

  const refresh = useCallback(
    (options: { initialize?: boolean } = {}) =>
      read(currentKey.current, options.initialize ?? false),
    [read],
  );

  return {
    // Never hand back another agent's answer, or another agent's progress,
    // including in the render between the key changing and the effect running.
    catalogue: state.key === key ? state.catalogue : null,
    loading: state.key === key && state.loading,
    refresh,
  };
}

/** The flat tool rows the menu shows; none for a catalogue that is not `ok`. */
export function catalogueToolRows(
  catalogue: AgentToolCatalogue | null,
): { serverName: string; name: string }[] {
  if (catalogue === null || catalogue.kind !== "ok") return [];
  return catalogue.servers.flatMap((server) =>
    server.tools.map((name) => ({ serverName: server.name, name })),
  );
}

/**
 * What to say when there are no rows to show.
 *
 * Null means there is nothing to explain: either the catalogue listed tools, or
 * there is no agent to ask about. Everything else is a state a person should be
 * able to tell apart from an empty list.
 */
export function catalogueStatusText(catalogue: AgentToolCatalogue | null): string | null {
  if (catalogue === null) return null;
  switch (catalogue.kind) {
    case "ok":
      return catalogue.servers.length === 0
        ? "No MCP servers are configured for this agent."
        : null;
    case "unsupported":
      return "This backend does not report its MCP tools.";
    case "notStarted":
      return "This agent has not started yet, so its tools are not known.";
    case "error":
      return "The tool catalogue could not be read.";
    case "cancelled":
      return "The catalogue query did not finish. Try again.";
    case "stale":
      return "This catalogue is out of date. Refresh to read it again.";
    default:
      return null;
  }
}
