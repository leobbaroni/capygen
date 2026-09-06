/**
 * One backend's whole integrations snapshot (Phase 6, SPEC R28-R29) — the
 * MCP servers / plugins / skills / tool-policy sections all read the same
 * `integrations.list` result and re-fetch it after any write, since the
 * contract's write channels each return only the one row that changed
 * (`McpServerEntry`, `PluginEntry`, `SkillEntry`, `ToolPolicyEntry`), not the
 * whole list.
 */
import { useCallback, useEffect, useState } from "react";
import type { Backend, InvokeResult } from "@capygen/shared";
import { ipc } from "@/lib/ipc";

export type IntegrationsSnapshot = InvokeResult<"integrations.list">;

export interface UseIntegrationsResult {
  data: IntegrationsSnapshot | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  refreshFromBackend: () => Promise<void>;
}

export function useIntegrations(backend: Backend): UseIntegrationsResult {
  const [data, setData] = useState<IntegrationsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const result = await ipc().invoke("integrations.list", { backend });
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [backend]);

  const refreshFromBackend = useCallback(async () => {
    try {
      await ipc().invoke("integrations.refresh", { backend });
    } finally {
      await reload();
    }
  }, [backend, reload]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const off = ipc().on("integrations.changed", (payload) => {
      if (payload.backend === backend) void reload();
    });
    return off;
  }, [backend, reload]);

  return { data, loading, error, reload, refreshFromBackend };
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
