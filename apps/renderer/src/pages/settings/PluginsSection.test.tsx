import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginEntry } from "@capygen/shared";
import { PluginsSection } from "./PluginsSection";

const invoke = vi.fn();
vi.mock("@/lib/ipc", () => ({
  ipc: () => ({ invoke, on: () => () => {} }),
  hasBridge: () => true,
}));

const CLAUDE_PLUGINS: PluginEntry[] = [
  {
    backend: "claude",
    name: "cockpit",
    version: "1.4.0",
    marketplace: "anthropic-experimental",
    enabled: true,
    installed: true,
    commands: ["pilot", "grilling"],
    skills: ["domain-modeling"],
    source: "installed_plugins.json",
  },
];

const CODEX_PLUGINS: PluginEntry[] = [
  {
    backend: "codex",
    name: "codex-review",
    enabled: true,
    installed: true,
    commands: [],
    skills: [],
    source: "plugin/list",
  },
];

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((channel: string, args: { backend?: string }) => {
    if (channel === "integrations.list") {
      return Promise.resolve({
        mcpServers: [],
        plugins: args.backend === "claude" ? CLAUDE_PLUGINS : CODEX_PLUGINS,
        skills: [],
        tools: [],
        lastSync: null,
      });
    }
    if (channel === "integrations.plugin.marketplaces") {
      return Promise.resolve([{ name: "anthropic-experimental", source: "claude plugin marketplace list" }]);
    }
    if (channel === "integrations.plugin.install") {
      return Promise.resolve({ ...CLAUDE_PLUGINS[0], name: "new-plugin" });
    }
    if (channel === "integrations.plugin.setEnabled") {
      return Promise.resolve({ ...CLAUDE_PLUGINS[0], enabled: false });
    }
    return Promise.resolve({ ok: true });
  });
});

describe("PluginsSection", () => {
  it("lists claude's installed plugins with command/skill counts", async () => {
    render(<PluginsSection />);
    const row = await screen.findByTestId("plugin-row-cockpit");
    expect(row).toHaveTextContent("2 commands");
    expect(row).toHaveTextContent("1 skill");
  });

  it("Disable calls integrations.plugin.setEnabled(false)", async () => {
    const user = userEvent.setup();
    render(<PluginsSection />);
    await screen.findByTestId("plugin-row-cockpit");

    await user.click(screen.getByTestId("plugin-toggle-cockpit"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("integrations.plugin.setEnabled", {
        backend: "claude",
        name: "cockpit",
        enabled: false,
      }),
    );
  });

  it("Uninstall calls integrations.plugin.uninstall", async () => {
    const user = userEvent.setup();
    render(<PluginsSection />);
    await screen.findByTestId("plugin-row-cockpit");

    await user.click(screen.getByTestId("plugin-uninstall-cockpit"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("integrations.plugin.uninstall", { backend: "claude", name: "cockpit" }),
    );
  });

  it("Browse lists marketplaces, then Install submits name+marketplace", async () => {
    const user = userEvent.setup();
    render(<PluginsSection />);
    await screen.findByTestId("plugin-row-cockpit");

    await user.click(screen.getByTestId("marketplaces-browse"));
    expect(await screen.findByTestId("marketplace-row-anthropic-experimental")).toBeInTheDocument();

    await user.type(screen.getByTestId("plugin-install-name"), "new-plugin");
    await user.click(screen.getByTestId("plugin-install-button"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("integrations.plugin.install", {
        backend: "claude",
        marketplace: "anthropic-experimental",
        name: "new-plugin",
      }),
    );
  });

  it("Codex tab is read-only: no toggle/uninstall buttons, and shows the read-only note", async () => {
    const user = userEvent.setup();
    render(<PluginsSection />);
    await screen.findByTestId("plugin-row-cockpit");

    await user.click(screen.getByTestId("plugins-tab-codex"));

    const panel = await screen.findByTestId("plugins-panel-codex");
    expect(panel).toHaveTextContent(/read-only/i);
    expect(screen.getByTestId("plugin-row-codex-review")).toBeInTheDocument();
    expect(screen.queryByTestId("plugin-toggle-codex-review")).not.toBeInTheDocument();
    expect(screen.queryByTestId("plugin-uninstall-codex-review")).not.toBeInTheDocument();
  });
});
