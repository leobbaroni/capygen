/**
 * `GlobalSettings` (Phase 6, SPEC R30) for every settings section that reads
 * or patches it: fetch once via `settings.getAll`, re-render on every
 * `settings.changed` broadcast (so a patch from one section — or another
 * window — is reflected everywhere without a manual refetch), patch via
 * `settings.patch` (deep-merged section-by-section server-side —
 * `mergeGlobalSettingsPatch`'s own doc comment), reset a section via
 * `settings.reset`.
 *
 * Deliberately outside `appStore` (Task B2's file ownership is
 * `apps/renderer/src/pages/settings/**`, `components/settings/**` and
 * `lib/theme.ts` — not `store/appStore.ts`): `ProvidersSection.tsx` already
 * established the pattern of a settings page talking to `ipc()` directly
 * rather than routing every read through the shared store.
 */
import { useCallback, useEffect, useState } from "react";
import type {
  GlobalSettings,
  GlobalSettingsPatch,
  GlobalSettingsSection,
} from "@capygen/shared";
import { ipc } from "@/lib/ipc";

export interface UseGlobalSettingsResult {
  settings: GlobalSettings | null;
  error: string | null;
  patch: (patch: GlobalSettingsPatch) => Promise<GlobalSettings>;
  reset: (section: GlobalSettingsSection) => Promise<GlobalSettings>;
}

export function useGlobalSettings(): UseGlobalSettingsResult {
  const [settings, setSettings] = useState<GlobalSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const client = ipc();
    void client
      .invoke("settings.getAll", {})
      .then((s) => {
        if (!cancelled) setSettings(s);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    const off = client.on("settings.changed", ({ settings: next }) => {
      if (!cancelled) setSettings(next);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const patch = useCallback(async (p: GlobalSettingsPatch) => {
    const next = await ipc().invoke("settings.patch", { patch: p });
    setSettings(next);
    setError(null);
    return next;
  }, []);

  const reset = useCallback(async (section: GlobalSettingsSection) => {
    const next = await ipc().invoke("settings.reset", { section });
    setSettings(next);
    setError(null);
    return next;
  }, []);

  return { settings, error, patch, reset };
}
