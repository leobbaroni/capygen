/**
 * What the Files pane, the search and the watcher never walk into (SPEC
 * R23-R26: "file watchers bounded (ignore node_modules/.git/dist, depth/size
 * caps)").
 *
 * These are directory *names*, matched at any depth, not globs: chokidar 5
 * dropped glob support from `ignored` in favour of a predicate, and a
 * predicate is both faster and unambiguous about what it matches. A repo with
 * a real `dist/` it wants to see is the price; the alternative — walking
 * `node_modules` on a chokidar watcher — costs tens of thousands of handles on
 * a Node project and is what makes a file watcher an app-freezing feature.
 */
import path from "node:path";

export const IGNORED_DIR_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".turbo",
  ".cache",
  ".pnpm-store",
  "target",
  ".gradle",
  ".idea",
  ".vs",
  "coverage",
  "release",
]);

/** True for a directory capygen never descends into. */
export function isIgnoredDirName(name: string): boolean {
  return IGNORED_DIR_NAMES.has(name);
}

/**
 * True when any segment of `relative` (a project-relative path, either
 * separator) names an ignored directory. Used by the watcher predicate, where
 * chokidar hands whole paths rather than one segment at a time.
 */
export function isIgnoredPath(relative: string): boolean {
  if (relative === "") return false;
  for (const segment of relative.split(/[\\/]+/)) {
    if (segment !== "" && isIgnoredDirName(segment)) return true;
  }
  return false;
}

/** The chokidar 5 `ignored` predicate for one project root. */
export function ignoredUnder(root: string): (candidate: string) => boolean {
  return (candidate: string): boolean => {
    const rel = path.relative(root, candidate);
    // `path.relative` gives "" for the root and an absolute-ish "../…" for
    // anything outside it; neither is ours to ignore.
    if (rel === "" || rel.startsWith("..")) return false;
    return isIgnoredPath(rel);
  };
}
