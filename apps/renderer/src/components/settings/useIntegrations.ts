/**
 * One backend's whole integrations snapshot (Phase 6, SPEC R28-R29) — the
 * MCP servers / plugins / skills / tool-policy sections all read the same
 * `integrations.list` result and re-fetch it after any write, since the
 * contract's write channels each return only the one row that changed
 * (`McpServerEntry`, `PluginEntry`, `SkillEntry`, `ToolPolicyEntry`), not the
 * whole list.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Backend, InvokeResult } from "@capygen/shared";
import { ipc } from "@/lib/ipc";
import { useAppStore } from "@/store/appStore";

export type IntegrationsSnapshot = InvokeResult<"integrations.list">;

export interface UseIntegrationsResult {
  data: IntegrationsSnapshot | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  refreshFromBackend: () => Promise<void>;
  /**
   * The project this window is scoped to, or `null` for global-only. Every
   * write a section makes must send it (Phase 7-P0: an integrations operation
   * has no implicit project, and a project/local write is refused without one).
   */
  projectId: string | null;
  /** Spread into an `integrations.*` payload: `{}` when nothing is selected,
   *  since the contract's field is optional and `undefined` is not `null`. */
  scopeArgs: { projectId?: string };
}

/**
 * One backend's integrations snapshot **for this window's selected project**.
 *
 * The scope is `appStore.selectedProjectId`, sent explicitly on every call: the
 * main process resolves nothing by recency, so a second window on another
 * project cannot change what this one reads.
 *
 * Stale answers are dropped rather than rendered. Switching backend or project
 * while a read is in flight used to let the slower answer land last and replace
 * the current one — the page then showed another backend's or another
 * project's servers under this tab's heading. Each read carries the request
 * number it was issued with, and only the newest one is allowed to `setData`.
 */
export function useIntegrations(backend: Backend): UseIntegrationsResult {
  const projectId = useAppStore((s) => s.selectedProjectId);
  const [data, setData] = useState<IntegrationsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const scope = scopeKey(backend, projectId);
  /** The scope the page is on **now**, as opposed to the one a given closure
   *  was created for. See `reload`. */
  const currentScope = useRef(scope);
  const scopeArgs = projectId === null ? {} : { projectId };

  // Before the reload effect below (effects run in declaration order), so a
  // reload triggered by a scope change already sees the new scope.
  useEffect(() => {
    currentScope.current = scope;
  }, [scope]);

  const reload = useCallback(async () => {
    const mine = scopeKey(backend, projectId);
    // [review] The ticket alone was not enough. A mutation or a
    // `refreshFromBackend` started before the switch resolves *after* it and
    // then calls the `reload` closure it captured — the **old** scope's one.
    // That call took the newest ticket and so was allowed to write the old
    // project's snapshot over the new project's. A closure whose scope is no
    // longer the page's scope must not read, take a ticket, or set anything.
    if (currentScope.current !== mine) return;
    const ticket = (request.current += 1);
    setLoading(true);
    try {
      const result = await ipc().invoke("integrations.list", {
        backend,
        ...(projectId === null ? {} : { projectId }),
      });
      if (request.current !== ticket || currentScope.current !== mine) return;
      setData(result);
      setError(null);
    } catch (err) {
      if (request.current !== ticket || currentScope.current !== mine) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (request.current === ticket && currentScope.current === mine) setLoading(false);
    }
  }, [backend, projectId]);

  const refreshFromBackend = useCallback(async () => {
    try {
      await ipc().invoke("integrations.refresh", {
        backend,
        ...(projectId === null ? {} : { projectId }),
      });
    } finally {
      await reload();
    }
  }, [backend, projectId, reload]);

  useEffect(() => {
    // The previous scope's rows are not merely out of date, they are about a
    // different project: dropping them keeps a row (and any dialog opened from
    // one) from staying on screen and actionable under the new scope.
    setData(null);
    setError(null);
    setLoading(true);
    void reload();
  }, [reload]);

  useEffect(() => {
    const off = ipc().on("integrations.changed", (payload) => {
      // A refresh in another scope is not news for this page: a project's
      // `.mcp.json` changing must not re-render the window that is on the
      // globals, or on a different project. A **global** change is news for
      // every scope, since every project read layers on top of it.
      if (payload.backend !== backend) return;
      if (payload.projectId !== null && payload.projectId !== projectId) return;
      void reload();
    });
    return off;
  }, [backend, projectId, reload]);

  return { data, loading, error, reload, refreshFromBackend, projectId, scopeArgs };
}

/** Identity of one (backend, project) pair — what "the page's current scope"
 *  means for the guards above. */
function scopeKey(backend: Backend, projectId: string | null): string {
  return `${backend}\u0000${projectId ?? ""}`;
}

export interface UseRowActionsResult {
  /** The last failure for this row's action, or null. */
  errorFor: (key: string) => string | null;
  /** Whether this row's action is still in flight. */
  busy: (key: string) => boolean;
  /** Run one row action, keeping its failure next to the row that asked. */
  run: (key: string, action: () => Promise<unknown>) => Promise<void>;
}

/**
 * [review] Inline row actions used to be fired as `void doIt(entry)` — a
 * rejected IPC call then produced an unhandled rejection, an unchanged row and
 * no message at all, which is exactly what a store refusing a write looks like
 * from the user's side (a plugin-scope MCP server, an `api` row inherited from
 * Claude, a Codex project scope). This keeps the failure attached to the key
 * the caller chose, so it renders on the row rather than replacing the page.
 */
export function useRowActions(): UseRowActionsResult {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busyKeys, setBusyKeys] = useState<Record<string, true>>({});

  const run = useCallback(async (key: string, action: () => Promise<unknown>) => {
    setBusyKeys((prev) => ({ ...prev, [key]: true }));
    setErrors((prev) => {
      if (prev[key] === undefined) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    try {
      await action();
    } catch (err) {
      setErrors((prev) => ({ ...prev, [key]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusyKeys((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  }, []);

  return {
    errorFor: (key) => errors[key] ?? null,
    busy: (key) => busyKeys[key] === true,
    run,
  };
}
