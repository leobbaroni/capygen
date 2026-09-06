/**
 * Where each backend keeps its configuration, and how capygen is told to look
 * somewhere else.
 *
 * Both CLIs take an environment variable that relocates their *whole* home, and
 * every test in this package uses it rather than touching the machine's real
 * configuration (the hard rule in this repo's task briefs):
 *
 *   - **Claude**: `CLAUDE_CONFIG_DIR`. Verified by reading the installed SDK
 *     bundle (`sdk.mjs`: `process.env.CLAUDE_CONFIG_DIR ?? join(homedir(),
 *     ".claude")`) and live on 2026-09-06 — `CLAUDE_CONFIG_DIR=<tmp> claude mcp
 *     add --scope user probe-server -- node probe.js` wrote
 *     `<tmp>/.claude.json` and touched nothing under `~/.claude`. Note the
 *     consequence: with the variable set, **`.claude.json` moves inside it**
 *     (the SDK's own helper is `join(CLAUDE_CONFIG_DIR || homedir(),
 *     ".claude.json")`), so an isolated home is genuinely isolated.
 *   - **Codex**: `CODEX_HOME`, default `~/.codex`.
 *
 * Nothing here reads a file; it only says where one would be. That keeps the
 * path rules testable on a machine where neither CLI is installed.
 */
import os from "node:os";
import path from "node:path";

export type EnvLike = Record<string, string | undefined>;

export interface BackendHomes {
  /** `CLAUDE_CONFIG_DIR` or `~/.claude`. */
  claude: string;
  /** `CODEX_HOME` or `~/.codex`. */
  codex: string;
  /** The home directory the two defaults were derived from. */
  home: string;
}

export function resolveBackendHomes(
  env: EnvLike = process.env,
  home: string = os.homedir(),
): BackendHomes {
  const claude = env.CLAUDE_CONFIG_DIR?.trim();
  const codex = env.CODEX_HOME?.trim();
  return {
    claude: claude && claude.length > 0 ? claude : path.join(home, ".claude"),
    codex: codex && codex.length > 0 ? codex : path.join(home, ".codex"),
    home,
  };
}

/** Every Claude Code file capygen reads or writes, for one project. */
export interface ClaudePaths {
  /** `~/.claude` (or `CLAUDE_CONFIG_DIR`). */
  configDir: string;
  /** User settings — `permissions`, `skillOverrides`, `enabledPlugins`, hooks. */
  userSettings: string;
  /** User settings the CLI treats as "local, not shared". */
  userLocalSettings: string;
  /**
   * `.claude.json` — user-scope `mcpServers` **and** `projects[<cwd>]`, which
   * is where a `--scope local` MCP server lands. It sits *inside*
   * `CLAUDE_CONFIG_DIR` when that is set, and in the home directory otherwise.
   */
  globalConfig: string;
  /** `<configDir>/skills/<name>/SKILL.md`. */
  userSkillsDir: string;
  /** `<configDir>/commands/*.md`. */
  userCommandsDir: string;
  /** `<configDir>/plugins/installed_plugins.json`. */
  installedPlugins: string;
  /** `<configDir>/plugins/known_marketplaces.json`. */
  knownMarketplaces: string;
  /** Project-scope settings, checked into the repo. */
  projectSettings: string | null;
  /** Project-scope settings that are not. */
  projectLocalSettings: string | null;
  /** `<project>/.mcp.json` — the project-scope MCP servers. */
  projectMcpJson: string | null;
  projectSkillsDir: string | null;
  projectCommandsDir: string | null;
}

export function claudePaths(options: {
  configDir: string;
  home: string;
  env?: EnvLike;
  projectPath?: string | null;
}): ClaudePaths {
  const { configDir, projectPath } = options;
  const env = options.env ?? {};
  const explicitConfigDir = (env.CLAUDE_CONFIG_DIR ?? "").trim().length > 0;
  const project = projectPath && projectPath.length > 0 ? projectPath : null;
  return {
    configDir,
    userSettings: path.join(configDir, "settings.json"),
    userLocalSettings: path.join(configDir, "settings.local.json"),
    globalConfig: path.join(explicitConfigDir ? configDir : options.home, ".claude.json"),
    userSkillsDir: path.join(configDir, "skills"),
    userCommandsDir: path.join(configDir, "commands"),
    installedPlugins: path.join(configDir, "plugins", "installed_plugins.json"),
    knownMarketplaces: path.join(configDir, "plugins", "known_marketplaces.json"),
    projectSettings: project ? path.join(project, ".claude", "settings.json") : null,
    projectLocalSettings: project ? path.join(project, ".claude", "settings.local.json") : null,
    projectMcpJson: project ? path.join(project, ".mcp.json") : null,
    projectSkillsDir: project ? path.join(project, ".claude", "skills") : null,
    projectCommandsDir: project ? path.join(project, ".claude", "commands") : null,
  };
}

export interface CodexPaths {
  /** `~/.codex` (or `CODEX_HOME`). */
  configDir: string;
  /** `<configDir>/config.toml`. */
  configToml: string;
  /** `<configDir>/skills/<name>/SKILL.md`. */
  userSkillsDir: string;
  /** `<configDir>/plugins/cache` — where an installed plugin is materialised. */
  pluginsCacheDir: string;
  /** `<project>/.codex/skills`, when the session has a project. */
  projectSkillsDir: string | null;
}

export function codexPaths(options: {
  configDir: string;
  projectPath?: string | null;
}): CodexPaths {
  const project = options.projectPath && options.projectPath.length > 0 ? options.projectPath : null;
  return {
    configDir: options.configDir,
    configToml: path.join(options.configDir, "config.toml"),
    userSkillsDir: path.join(options.configDir, "skills"),
    pluginsCacheDir: path.join(options.configDir, "plugins", "cache"),
    projectSkillsDir: project ? path.join(project, ".codex", "skills") : null,
  };
}

/**
 * `.claude.json`'s `projects` map is keyed by the **forward-slashed** absolute
 * path, even on Windows (verified live: `claude mcp add --scope local` under a
 * `C:\…\cfgproj` cwd wrote the key `C:/Users/…/cfgproj`). Matching by raw
 * string would therefore never find a project the app knows as a backslashed
 * path.
 */
export function claudeProjectKey(projectPath: string): string {
  return projectPath.replace(/\\/g, "/");
}

/** True when the two paths name the same place, ignoring slash direction/case. */
export function samePath(a: string, b: string): boolean {
  return normalizeForCompare(a) === normalizeForCompare(b);
}

function normalizeForCompare(value: string): string {
  return path.resolve(value).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** The set of files a watcher must cover for one backend (SPEC R29). */
export function claudeWatchTargets(paths: ClaudePaths): string[] {
  return [
    paths.userSettings,
    paths.userLocalSettings,
    paths.globalConfig,
    paths.installedPlugins,
    paths.knownMarketplaces,
    paths.userSkillsDir,
    ...(paths.projectSettings ? [paths.projectSettings] : []),
    ...(paths.projectLocalSettings ? [paths.projectLocalSettings] : []),
    ...(paths.projectMcpJson ? [paths.projectMcpJson] : []),
    ...(paths.projectSkillsDir ? [paths.projectSkillsDir] : []),
  ];
}

export function codexWatchTargets(paths: CodexPaths): string[] {
  return [
    paths.configToml,
    paths.userSkillsDir,
    ...(paths.projectSkillsDir ? [paths.projectSkillsDir] : []),
  ];
}
