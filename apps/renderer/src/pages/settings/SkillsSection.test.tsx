import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillEntry } from "@capygen/shared";
import { SkillsSection } from "./SkillsSection";

const invoke = vi.fn();
vi.mock("@/lib/ipc", () => ({
  ipc: () => ({ invoke, on: () => () => {} }),
  hasBridge: () => true,
}));

const CLAUDE_SKILLS: SkillEntry[] = [
  {
    backend: "claude",
    name: "graphify",
    scope: "user",
    path: "C:/Users/tuga/.claude/skills/graphify/SKILL.md",
    enabled: true,
    description: "Build a knowledge graph of a repo.",
  },
  {
    backend: "claude",
    name: "pilot",
    scope: "plugin",
    path: "C:/plugins/cockpit/skills/pilot/SKILL.md",
    pluginName: "cockpit",
    enabled: false,
  },
];

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((channel: string, args: { backend?: string }) => {
    if (channel === "integrations.list") {
      return Promise.resolve({
        mcpServers: [],
        plugins: [],
        skills: args.backend === "claude" ? CLAUDE_SKILLS : [],
        tools: [],
        lastSync: null,
      });
    }
    if (channel === "integrations.skill.setEnabled") {
      return Promise.resolve({ ...CLAUDE_SKILLS[0], enabled: true });
    }
    if (channel === "integrations.skill.create") {
      return Promise.resolve({ ...CLAUDE_SKILLS[0], name: "new-skill" });
    }
    return Promise.resolve({ ok: true });
  });
});

describe("SkillsSection", () => {
  it("lists skills with scope and plugin badges", async () => {
    render(<SkillsSection />);
    const graphify = await screen.findByTestId("skill-row-graphify");
    expect(within(graphify).getByText("user")).toBeInTheDocument();

    const pilot = screen.getByTestId("skill-row-pilot");
    expect(within(pilot).getByText("plugin")).toBeInTheDocument();
    expect(within(pilot).getByText("cockpit")).toBeInTheDocument();
  });

  it("toggles a skill's enabled state via integrations.skill.setEnabled", async () => {
    const user = userEvent.setup();
    render(<SkillsSection />);
    await screen.findByTestId("skill-row-graphify");

    await user.click(screen.getByTestId("skill-toggle-graphify"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("integrations.skill.setEnabled", {
        backend: "claude",
        name: "graphify",
        enabled: false,
        scope: "user",
      }),
    );
  });

  it("Open calls integrations.skill.open with the skill's path", async () => {
    const user = userEvent.setup();
    render(<SkillsSection />);
    await screen.findByTestId("skill-row-graphify");

    await user.click(screen.getByTestId("skill-open-graphify"));

    expect(invoke).toHaveBeenCalledWith("integrations.skill.open", {
      path: "C:/Users/tuga/.claude/skills/graphify/SKILL.md",
    });
  });

  it("Create skill dialog requires a name and submits name + markdown", async () => {
    const user = userEvent.setup();
    render(<SkillsSection />);
    await screen.findByTestId("skill-row-graphify");

    await user.click(screen.getByTestId("skill-create-button"));
    const dialog = await screen.findByTestId("skill-create-dialog");
    expect(within(dialog).getByTestId("skill-dialog-save")).toBeDisabled();

    await user.type(within(dialog).getByTestId("skill-input-name"), "my-new-skill");
    expect(within(dialog).getByTestId("skill-dialog-save")).toBeEnabled();

    await user.click(within(dialog).getByTestId("skill-dialog-save"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "integrations.skill.create",
        expect.objectContaining({ backend: "claude", scope: "user", name: "my-new-skill" }),
      ),
    );
  });

  it("switching to a backend with no skills shows the empty state", async () => {
    const user = userEvent.setup();
    render(<SkillsSection />);
    await screen.findByTestId("skill-row-graphify");

    await user.click(screen.getByTestId("skills-tab-api"));

    expect(await screen.findByTestId("skills-panel-api")).toHaveTextContent(/no skills/i);
  });
});
