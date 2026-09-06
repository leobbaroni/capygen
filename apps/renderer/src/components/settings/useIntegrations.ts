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
