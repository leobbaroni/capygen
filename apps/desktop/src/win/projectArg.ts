/**
 * "Open capygen on this folder" — the launch-time project.
 *
 * A desktop app that always demands a folder picker before the first message is
 * hostile to scripting and to the e2e harness, and defaulting to the user's home
 * would silently point an agent at their whole profile. So the folder is only
 * pre-selected when the user says so explicitly, one of two ways:
 *
 *   capygen.exe --project=C:\src\thing
 *   CAPYGEN_PROJECT_DIR=C:\src\thing capygen.exe
 *
 * Anything else — a missing path, a file, a flag with no value — resolves to
 * null and the landing page shows "Choose a folder", which opens the native
 * picker. Nothing is ever opened implicitly.
 *
 * The answer is always the **long** form of the path. Windows 8.3 short names
 * (`C:\Users\TUGAPL~1\...`, which is what `os.tmpdir()` hands back on this
 * machine) are valid everywhere except inside Codex's Windows sandbox, which
 * rejects them: during the Phase 3 Codex live run an *approved* command still
 * failed with "Access to the path 'C:\Users\TUGAPL~1\...' is denied". The
 * folder picker returns long paths already; this is the other way in.
 */
import fs from "node:fs";
import path from "node:path";

export const PROJECT_DIR_ENV = "CAPYGEN_PROJECT_DIR";
export const PROJECT_ARG = "--project";

export interface ResolveProjectDeps {
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  isDirectory?: (candidate: string) => boolean;
  /** Overridable in tests; the default expands 8.3 short names. */
  realPath?: (candidate: string) => string;
}

/** Never throws: a path that cannot be expanded is returned as it came. */
export function longPath(candidate: string): string {
  try {
    return fs.realpathSync.native(candidate);
  } catch {
    return candidate;
  }
}

function defaultIsDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The folder to pre-select, or null. Command line wins over the environment so
 * a shortcut's argument beats an inherited variable.
 */
export function resolveInitialProjectDir(deps: ResolveProjectDeps = {}): string | null {
  const argv = deps.argv ?? process.argv;
  const env = deps.env ?? process.env;
  const isDirectory = deps.isDirectory ?? defaultIsDirectory;
  const realPath = deps.realPath ?? longPath;

  const candidates: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith(`${PROJECT_ARG}=`)) {
      candidates.push(arg.slice(PROJECT_ARG.length + 1));
    } else if (arg === PROJECT_ARG && i + 1 < argv.length) {
      candidates.push(argv[i + 1]!);
    }
  }
  const fromEnv = env[PROJECT_DIR_ENV];
  if (fromEnv) candidates.push(fromEnv);

  for (const raw of candidates) {
    const trimmed = raw.trim().replace(/^"|"$/g, "");
    if (trimmed === "") continue;
    const resolved = path.resolve(trimmed);
    if (isDirectory(resolved)) return realPath(resolved);
  }
  return null;
}
