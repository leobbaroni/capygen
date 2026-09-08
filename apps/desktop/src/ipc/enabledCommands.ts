import type { PluginEntry, SkillEntry, SlashCommand } from "@capygen/shared";

/** The runtime reports availability; canonical files can revoke that availability. */
export function enabledCommands(commands: SlashCommand[], snapshot: { skills: SkillEntry[]; plugins: PluginEntry[] }): SlashCommand[] {
  const disabledPlugins = new Set(snapshot.plugins.filter((plugin) => !plugin.enabled).map((plugin) => plugin.name.split("@")[0]!.toLowerCase()));
  const disabledSkills = new Set<string>();
  const availableSkills = new Set<string>();
  for (const skill of snapshot.skills) {
    const plugin = skill.pluginName?.split("@")[0]!.toLowerCase();
    const names = [skill.name.replace(/^\//, "").toLowerCase()];
    if (plugin) names.push(`${plugin}:${names[0]}`);
    const target = skill.enabled && (!plugin || !disabledPlugins.has(plugin)) ? availableSkills : disabledSkills;
    for (const name of names) target.add(name);
  }
  // Runtime availability wins when another canonical scope supplies the same name.
  for (const name of availableSkills) disabledSkills.delete(name);
  return commands.filter((command) => {
    if (command.source === "builtin") return true;
    const name = command.name.replace(/^\//, "").toLowerCase();
    return !disabledSkills.has(name) && !(name.includes(":") && disabledPlugins.has(name.split(":")[0]!));
  });
}
