/**
 * Settings ▸ Plugins (Task B2 item 2, SPEC R28-R29). Claude: installed list
 * with enable/disable/uninstall, plus registered marketplaces with a small
 * browse + install form. Codex: `plugin/list` is read-only from capygen
 * (COMPAT.md — capygen writes no Codex config behind the user's back for
 * plugins any more than it does for the round-table's routing rule), so the
 * panel is a list with a note instead of controls. `api` has no plugin
 * concept at all (no CLI, no marketplace) and is not offered as a tab.
 */
import { useState } from "react";
import type { Backend } from "@capygen/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  SectionError,
  SectionIntro,
  SectionLoading,
  SettingInput,
  SettingSelect,
  SettingsCard,
} from "@/components/settings/primitives";
import { useIntegrations } from "@/components/settings/useIntegrations";
import { BACKEND_LABEL } from "@/lib/agentDisplay";
import { ipc } from "@/lib/ipc";

const BACKENDS: Backend[] = ["claude", "codex"];

export function PluginsSection() {
  const [tab, setTab] = useState<Backend>("claude");
  return (
    <div data-testid="settings-plugins">
      <SectionIntro title="Plugins" description="Bundles of skills and commands installed from a marketplace." />
      <div className="mb-4 flex gap-1 border-b border-border-weak" role="tablist" aria-label="Backend">
        {BACKENDS.map((b) => (
          <button
            key={b}
            type="button"
            role="tab"
            aria-selected={tab === b}
            data-testid={`plugins-tab-${b}`}
            onClick={() => setTab(b)}
            className={`px-3 py-2 text-sm ${tab === b ? "border-b-2 border-primary font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            {BACKEND_LABEL[b]}
          </button>
        ))}
      </div>
      {tab === "claude" ? <ClaudePluginsPanel /> : <CodexPluginsPanel />}
    </div>
  );
}

function ClaudePluginsPanel() {
  const { data, loading, error, reload } = useIntegrations("claude");
  const [marketplaces, setMarketplaces] = useState<{ name: string; source: string }[]>([]);
  const [installName, setInstallName] = useState("");
  const [installMarketplace, setInstallMarketplace] = useState("");
  const [installBusy, setInstallBusy] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  async function loadMarketplaces(): Promise<void> {
    const list = await ipc().invoke("integrations.plugin.marketplaces", { backend: "claude" });
    setMarketplaces(list);
    if (list.length > 0 && installMarketplace === "") setInstallMarketplace(list[0]!.name);
  }

  async function toggle(name: string, enabled: boolean): Promise<void> {
    await ipc().invoke("integrations.plugin.setEnabled", { backend: "claude", name, enabled });
    await reload();
  }

  async function uninstall(name: string): Promise<void> {
    await ipc().invoke("integrations.plugin.uninstall", { backend: "claude", name });
    await reload();
  }

  async function install(): Promise<void> {
    if (installName.trim() === "" || installMarketplace.trim() === "") return;
    setInstallBusy(true);
    setInstallError(null);
    try {
      await ipc().invoke("integrations.plugin.install", {
        backend: "claude",
        marketplace: installMarketplace,
        name: installName.trim(),
      });
      setInstallName("");
      await reload();
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstallBusy(false);
    }
  }

  if (error) return <SectionError message={error} />;
  if (loading && !data) return <SectionLoading />;

  const plugins = data?.plugins ?? [];

  return (
    <div data-testid="plugins-panel-claude" className="flex flex-col gap-4">
      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Installed</p>
        {plugins.length === 0 ? (
          <p className="text-sm text-muted-foreground">No plugins installed.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {plugins.map((p) => (
              <SettingsCard
                key={p.name}
                testId={`plugin-row-${p.name}`}
                title={p.name}
                subtitle={[p.version, p.marketplace].filter(Boolean).join(" · ") || undefined}
                action={
                  <div className="flex items-center gap-2">
                    {!p.installed ? <Badge variant="warning">not installed</Badge> : null}
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid={`plugin-toggle-${p.name}`}
                      onClick={() => void toggle(p.name, !p.enabled)}
                    >
                      {p.enabled ? "Disable" : "Enable"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid={`plugin-uninstall-${p.name}`}
                      onClick={() => void uninstall(p.name)}
                    >
                      Uninstall
                    </Button>
                  </div>
                }
              >
                {p.commands.length > 0 || p.skills.length > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {p.commands.length} command{p.commands.length === 1 ? "" : "s"} · {p.skills.length} skill
                    {p.skills.length === 1 ? "" : "s"}
                  </p>
                ) : null}
              </SettingsCard>
            ))}
          </div>
        )}
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Marketplaces</p>
          <Button size="sm" variant="outline" data-testid="marketplaces-browse" onClick={() => void loadMarketplaces()}>
            Browse
          </Button>
        </div>
        {marketplaces.length === 0 ? (
          <p className="text-sm text-muted-foreground">Browse to list registered marketplaces.</p>
        ) : (
          <div className="flex flex-col gap-3">
            <ul className="flex flex-col gap-1">
              {marketplaces.map((m) => (
                <li key={m.name} data-testid={`marketplace-row-${m.name}`} className="text-sm text-foreground">
                  {m.name}{" "}
                  <span className="text-xs text-muted-foreground">({m.source})</span>
                </li>
              ))}
            </ul>
            <div className="flex items-end gap-2">
              <label className="flex flex-1 flex-col gap-1">
                <span className="text-xs text-muted-foreground">Plugin name</span>
                <SettingInput
                  value={installName}
                  onChange={setInstallName}
                  placeholder="plugin-name"
                  data-testid="plugin-install-name"
                  aria-label="Plugin name to install"
                />
              </label>
              <label className="flex w-40 flex-col gap-1">
                <span className="text-xs text-muted-foreground">Marketplace</span>
                <SettingSelect
                  value={installMarketplace}
                  onChange={setInstallMarketplace}
                  options={marketplaces.map((m) => ({ value: m.name, label: m.name }))}
                  data-testid="plugin-install-marketplace"
                  aria-label="Marketplace"
                />
              </label>
              <Button
                size="sm"
                disabled={installBusy || installName.trim() === ""}
                data-testid="plugin-install-button"
                onClick={() => void install()}
              >
                {installBusy ? "Installing…" : "Install"}
              </Button>
            </div>
            {installError ? (
              <p role="alert" data-testid="plugin-install-error" className="text-xs text-destructive">
                {installError}
              </p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function CodexPluginsPanel() {
  const { data, loading, error } = useIntegrations("codex");

  if (error) return <SectionError message={error} />;
  if (loading && !data) return <SectionLoading />;

  const plugins = data?.plugins ?? [];

  return (
    <div data-testid="plugins-panel-codex" className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Codex plugins are read-only here — install or remove them with the <code className="font-mono">codex</code>{" "}
        CLI; capygen only reflects what it reports.
      </p>
      {plugins.length === 0 ? (
        <p className="text-sm text-muted-foreground">No plugins reported.</p>
      ) : (
        plugins.map((p) => (
          <SettingsCard
            key={p.name}
            testId={`plugin-row-${p.name}`}
            title={p.name}
            subtitle={p.version}
            action={<Badge variant={p.enabled ? "success" : "default"}>{p.enabled ? "enabled" : "disabled"}</Badge>}
          />
        ))
      )}
    </div>
  );
}
