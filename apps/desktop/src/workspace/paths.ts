/**
 * Project-root resolution and the containment rule every workspace service
 * obeys.
 *
 * A pane channel arrives with a `projectId` and a *relative* path typed by the
 * renderer (or clicked in the tree). Two things must be true before anything
 * touches the disk:
 *
 *   1. the project exists — an unknown id is a loud error, never an empty list;
 *   2. the resolved path is still **inside** the project root. `..` segments,
 *      an absolute path from another drive and a symlink pointing out of the
 *      tree are all the same attack, and the Files/Editor panes are reachable
 *      from anything that can talk to the renderer.
 *
 * Paths cross IPC in project-relative POSIX form (`src/main.ts`), never as
 * `C:\...`: it keeps the renderer's tree keys stable, keeps a Windows path out
 * of a JSON string where a backslash is an escape, and means a stray path can
 * never name a file outside the project by construction.
 */
import fs from "node:fs";
import path from "node:path";
import type { CapygenStore } from "@capygen/db";

export interface ProjectRoot {
  projectId: string;
  /** Absolute, long-form (8.3 short names expanded) project directory. */
  root: string;
}

/** Throws with the id when the project row is gone (SPEC: fail loudly). */
export function projectRoot(store: CapygenStore, projectId: string): ProjectRoot {
  const project = store.projects.get(projectId);
  if (!project) throw new Error(`unknown project: ${projectId}`);
  return { projectId, root: path.resolve(project.path) };
}

/** `src/main.ts` — always forward slashes, never a leading `./` or `/`. */
export function toRelPosix(root: string, absolute: string): string {
  const rel = path.relative(root, absolute);
  return rel.split(path.sep).join("/");
}

/**
 * Resolve a caller-supplied path against the project root and refuse anything
 * that escapes it. Accepts `""` (the root itself), a relative POSIX or Windows
 * path, and an absolute path that is already inside the root.
 */
export function resolveInside(root: string, candidate: string): string {
  const trimmed = candidate.trim().replace(/^[/\\]+/, "");
  const resolved = path.resolve(root, trimmed);
  if (!isInside(root, resolved)) {
    throw new Error(`path escapes the project: ${candidate}`);
  }
  return resolved;
}

/** True when `candidate` is `root` itself or below it (case-insensitive on
 *  Windows, where `C:\Src` and `c:\src` are the same directory). */
export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false;
  return !rel.startsWith(`..${path.sep}`) && rel !== "..";
}

/**
 * The real (symlink-resolved) location of a path, when it exists. A junction
 * or symlink inside the project that points outside it would otherwise let a
 * read walk out of the tree while `resolveInside` still said yes.
 */
export function realIfExists(candidate: string): string {
  try {
    return fs.realpathSync.native(candidate);
  } catch {
    return candidate;
  }
}

/** `resolveInside` + the symlink check, for anything that will be opened. */
export function resolveExistingInside(root: string, candidate: string): string {
  const resolved = resolveInside(root, candidate);
  const real = realIfExists(resolved);
  const realRoot = realIfExists(root);
  if (!isInside(realRoot, real)) {
    throw new Error(`path escapes the project through a link: ${candidate}`);
  }
  return resolved;
}
