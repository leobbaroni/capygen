import { expect, it } from "vitest";
import { PluginEntrySchema, SkillEntrySchema, type SlashCommand } from "@capygen/shared";
import { enabledCommands } from "../src/ipc/enabledCommands.js";
it("revokes disabled canonical skills/plugins while retaining available runtime commands", () => {
  const commands: SlashCommand[] = [
    { name: "/help", source: "builtin", description: "Help" },
    { name: "/disabled", source: "skill", description: "Disabled" },
    { name: "/plugin:command", source: "plugin", description: "Disabled plugin" },
    { name: "/available", source: "backend", description: "Available" },
  ];
  const snapshot = {
    skills: [SkillEntrySchema.parse({ backend: "claude", name: "disabled", enabled: false, scope: "user", path: "/fixture/SKILL.md" })],
    plugins: [PluginEntrySchema.parse({ backend: "claude", name: "plugin", enabled: false, source: "fixture" })],
  };
  expect(enabledCommands(commands, snapshot).map((command) => command.name)).toEqual(["/help", "/available"]);
});

it("keeps a runtime skill supplied by an enabled scope despite a disabled namesake", () => {
  const commands: SlashCommand[] = [{ name: "/review", source: "skill", description: "Review" }];
  const skills = [false, true].map((enabled, index) => SkillEntrySchema.parse({
    backend: "codex", name: "review", enabled, scope: index ? "project" : "user", path: `/fixture/${index}/SKILL.md`,
  }));
  expect(enabledCommands(commands, { skills, plugins: [] })).toEqual(commands);
});
