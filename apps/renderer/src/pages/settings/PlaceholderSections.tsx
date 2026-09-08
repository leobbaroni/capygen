/**
 * Settings sections that port Omnigent's reference layout but have no
 * capygen backend yet (Task B2 item 1): "render the reference layout with a
 * clear 'arrives with …' note and no dead controls." Grouped into one file —
 * each is a couple of static rows, not worth its own module.
 *
 *  - Updates: named by Task B2's phase map (Phase 12). Import sessions,
 *    Members, Policies and Sharing have since been built for real and live in
 *    their own modules.
 *  - Account: Omnigent's is a cloud login profile; capygen is local-only by
 *    scope (SPEC "Out of Scope: Multi-tenant cloud server mode"), so there is
 *    no phase where a real login page arrives — the note says that instead.
 *  - Integrations (the legacy Omnigent id — cloud sandbox connections, not
 *    capygen's own MCP/plugin/skill management): redirects to the sections
 *    that actually cover R28 in capygen, rather than describing a feature
 *    (Databricks/Arca-managed sandboxes) parked entirely (SPEC §Out of
 *    Scope).
 *  - Local CLI: Omnigent's is its own bundled-CLI daemon status; the nearest
 *    capygen equivalent is Prerequisites (R3) — redirects there.
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { SectionIntro } from "@/components/settings/primitives";
import { ipc } from "@/lib/ipc";
import { useAppStore } from "@/store/appStore";
export { UpdatesSection } from "./UpdatesSection";

export function AccountSection() {
  const harnesses = useAppStore((s) => s.harnesses);
  const [pending, setPending] = useState<string | null>(null); const [error, setError] = useState<string | null>(null);
  const alive = useRef(true); const refreshSeq = useRef(0);
  const refresh = async () => { const seq = ++refreshSeq.current; try { const next = await ipc().invoke("harness.list", {}); if (alive.current && seq === refreshSeq.current) { useAppStore.setState({ harnesses: next }); setError(null); } } catch (e) { if (alive.current && seq === refreshSeq.current) setError(e instanceof Error ? e.message : "Could not refresh harness status."); } };
  useEffect(() => { alive.current = true; void refresh(); const onFocus = () => void refresh(); window.addEventListener("focus", onFocus); return () => { alive.current = false; window.removeEventListener("focus", onFocus); }; }, []);
  const run = async (backend: "claude" | "codex") => { setPending(backend); setError(null); try { const result = await ipc().invoke("prereqs.run", { stepId: `${backend}-login` }); if (!alive.current) return; if (!result.ok || !result.started) { setError(`${backend === "claude" ? "Claude Code" : "Codex"} sign-in did not start. It may have been cancelled or a prerequisite is missing.`); return; } await refresh(); } catch (e) { setError(e instanceof Error ? e.message : "Sign-in could not be started."); } finally { if (alive.current) setPending(null); } };
  return (
    <div data-testid="settings-account">
      <SectionIntro title="Account" description="Local backend sign-in status. capygen has no cloud account." />
      {error ? <p role="alert" className="mb-3 text-sm text-destructive">{error}</p> : null}
      <div className="mb-2 flex justify-end"><button disabled={pending !== null} onClick={() => void refresh()}>Refresh status</button></div><div className="space-y-2 rounded-lg border border-border bg-card p-3 text-sm">{(["claude", "codex"] as const).map((backend) => { const info = harnesses.find((h) => h.backend === backend); return <div key={backend} className="flex items-center justify-between gap-3"><span>{backend === "claude" ? "Claude Code" : "Codex"}: {info?.available ? "Available" : info?.reason ?? "Unavailable"}</span><button disabled={pending !== null} onClick={() => void run(backend)}>{pending === backend ? "Starting…" : "Sign in / reconnect"}</button></div>; })}</div>
      <div className="mt-3 text-sm text-muted-foreground">Detailed backend settings live under <Link to="/settings/harnesses" className="text-foreground underline">Harnesses</Link>; API keys live under{" "}
        <Link to="/settings/api-keys" className="text-foreground underline underline-offset-2">
          Providers &amp; API keys
        </Link>
        .</div>
    </div>
  );
}

export function LegacyIntegrationsSection() {
  return (
    <div data-testid="settings-integrations">
      <SectionIntro
        title="Integrations"
        description="Omnigent's cloud sandbox connections have no capygen equivalent (local-only app, SPEC §Out of Scope)."
      />
      <div className="rounded-lg border border-dashed border-border bg-card/50 px-3.5 py-3 text-sm text-muted-foreground">
        capygen's own integrations (MCP servers, plugins, skills, tool policies — SPEC R28) live in
        their own sections:{" "}
        <Link to="/settings/mcp" className="text-foreground underline underline-offset-2">
          MCP servers
        </Link>
        ,{" "}
        <Link to="/settings/skills" className="text-foreground underline underline-offset-2">
          Skills
        </Link>
        ,{" "}
        <Link to="/settings/plugins" className="text-foreground underline underline-offset-2">
          Plugins
        </Link>
        , and{" "}
        <Link to="/settings/tools" className="text-foreground underline underline-offset-2">
          Tools
        </Link>
        .
      </div>
    </div>
  );
}

export function LocalCliSection() {
  return (
    <div data-testid="settings-cli">
      <SectionIntro title="Local CLI" description="capygen has no separate bundled-CLI daemon — it drives claude.exe/codex.exe directly." />
      <div className="rounded-lg border border-dashed border-border bg-card/50 px-3.5 py-3 text-sm text-muted-foreground">
        CLI detection and install steps live under{" "}
        <Link to="/settings/prereqs" className="text-foreground underline underline-offset-2">
          Prerequisites
        </Link>
        ; per-backend status lives under{" "}
        <Link to="/settings/harnesses" className="text-foreground underline underline-offset-2">
          Harnesses
        </Link>
        .
      </div>
    </div>
  );
}
