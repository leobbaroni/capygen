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
import { Link } from "react-router-dom";
import { ArrivesLaterNote, SectionIntro } from "@/components/settings/primitives";

export function UpdatesSection() {
  return (
    <div data-testid="settings-updates">
      <SectionIntro title="Updates" description="Automatic / at-launch / manual / never, from GitHub Releases (R4)." />
      <ArrivesLaterNote phase="Phase 12" what="Packaging and self-update" />
    </div>
  );
}

export function AccountSection() {
  return (
    <div data-testid="settings-account">
      <SectionIntro title="Account" description="capygen has no cloud account — everything runs and stays on this machine." />
      <div className="rounded-lg border border-dashed border-border bg-card/50 px-3.5 py-3 text-sm text-muted-foreground">
        There is nothing to sign in to. Sign-in for a backend (Claude Code, Codex) lives under{" "}
        <Link to="/settings/harnesses" className="text-foreground underline underline-offset-2">
          Harnesses
        </Link>
        ; API keys live under{" "}
        <Link to="/settings/api-keys" className="text-foreground underline underline-offset-2">
          Providers &amp; API keys
        </Link>
        .
      </div>
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
