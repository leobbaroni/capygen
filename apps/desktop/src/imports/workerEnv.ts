/**
 * The environment one import-parser child runs under.
 *
 * This is an **allowlist**, not a filtered copy of `process.env`. A spread with
 * deletions is the wrong shape for this job: every variable someone adds later
 * — a proxy, a credential helper, a `NODE_OPTIONS` that loads a module — would
 * arrive in the child by default and have to be remembered about. Here the
 * child gets four kinds of thing and nothing else:
 *
 *   - `SystemRoot` / `windir`, taken from the supplied base env, because
 *     Windows' own loader needs them;
 *   - a `PATH` of exactly `System32` (the child never runs a program; this is
 *     what Windows APIs fall back to reading, not a way to find a CLI);
 *   - `PYTHONUTF8=1`, the repo's Windows-first rule;
 *   - every home-ish variable, pointed *beneath the job root* — so a backend
 *     library that reaches for `~/.claude`, `%APPDATA%` or `%TEMP%` lands
 *     inside the directory this job owns and nowhere near the real one.
 *
 * No provider keys, no `NODE_OPTIONS`, no nested-session markers, no personal
 * home: none of them are on the list, so none of them can appear. The caller
 * creates the directories before forking; this module only composes names.
 */
import path from "node:path";

/** The job-owned directories the environment points at. */
export interface WorkerJobDirs {
  home: string;
  appData: string;
  localAppData: string;
  temp: string;
  claudeHome: string;
  claudeSecureStorage: string;
  codexHome: string;
  /** The inert project directory handed to `getSessionMessages`. */
  inertDir: string;
}

export interface BuildWorkerEnvOptions {
  /** Absolute directory that owns this job. Everything below lives inside it. */
  jobRoot: string;
  /**
   * Where `SystemRoot`/`windir` are read from — normally `process.env`. Only
   * those two names are ever consulted.
   */
  base?: Record<string, string | undefined>;
}

/** Every directory the caller must create before forking the child. */
export function workerJobDirs(jobRoot: string): WorkerJobDirs {
  const at = (...parts: string[]): string => path.join(jobRoot, ...parts);
  return {
    home: at("home"),
    appData: at("home", "appdata"),
    localAppData: at("home", "localappdata"),
    temp: at("temp"),
    claudeHome: at("home", "claude"),
    claudeSecureStorage: at("home", "claude-secure"),
    codexHome: at("home", "codex"),
    inertDir: at("inert-project"),
  };
}

/**
 * The environment variables whose values must be job-owned directories. The
 * entry checks exactly this list before it lets any backend library load.
 */
export const OWNED_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  "CODEX_HOME",
] as const;

/**
 * `HOMEDRIVE` + `HOMEPATH` are the drive-relative halves of `USERPROFILE`.
 * They are set as a consistent pair on purpose: a mismatched drive and path is
 * exactly how a library rebuilds the *real* home out of two half-owned values.
 */
function homeDrivePair(home: string): Record<string, string> {
  const root = path.parse(home).root;
  if (!root) return { HOMEDRIVE: "", HOMEPATH: home };
  // "C:\\" → drive "C:", and the rest keeps its leading separator.
  return { HOMEDRIVE: root.replace(/[\\/]+$/, ""), HOMEPATH: home.slice(root.length - 1) };
}

export function buildWorkerEnv(options: BuildWorkerEnvOptions): Record<string, string> {
  const { jobRoot, base = {} } = options;
  if (!path.isAbsolute(jobRoot)) {
    throw new Error("capygen: the import worker's job root must be an absolute path");
  }
  const dirs = workerJobDirs(jobRoot);
  const env: Record<string, string> = {
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    ...homeDrivePair(dirs.home),
    APPDATA: dirs.appData,
    LOCALAPPDATA: dirs.localAppData,
    TEMP: dirs.temp,
    TMP: dirs.temp,
    CLAUDE_CONFIG_DIR: dirs.claudeHome,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: dirs.claudeSecureStorage,
    CODEX_HOME: dirs.codexHome,
  };

  // Windows' loader reads these; they are the only values taken from outside.
  const systemRoot = base.SystemRoot ?? base.windir;
  if (systemRoot && path.isAbsolute(systemRoot)) {
    env.SystemRoot = systemRoot;
    env.windir = systemRoot;
    env.PATH = path.join(systemRoot, "System32");
  } else {
    // A POSIX fixture run: the child launches no program, so an empty PATH is
    // the honest value rather than a borrowed one.
    env.PATH = "";
  }
  return env;
}
