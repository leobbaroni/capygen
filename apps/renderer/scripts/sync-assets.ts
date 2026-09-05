/**
 * Stage the shared brand assets into the renderer's `public/` folder.
 *
 * `assets/` at the repo root is the single source of truth for the mascot and
 * the wordmark font; Vite can only serve files under its own `publicDir`. Rather
 * than keeping a second committed copy that silently drifts (the mascot has
 * already been regenerated once), this copies them on every `dev` and `build`,
 * and `apps/renderer/public/` is gitignored.
 *
 * Idempotent and cheap: it skips files whose size and mtime already match.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MASCOT_STATES } from "@capygen/shared";

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererDir = path.resolve(here, "..");
const repoRoot = path.resolve(rendererDir, "..", "..");
const publicDir = path.join(rendererDir, "public");

interface CopyJob {
  from: string;
  to: string;
}

const jobs: CopyJob[] = [
  ...MASCOT_STATES.map((state) => ({
    from: path.join(repoRoot, "assets", "mascot", "states", `${state}.png`),
    to: path.join(publicDir, "mascot", `${state}.png`),
  })),
  {
    from: path.join(repoRoot, "assets", "fonts", "CheGuevaraBarry-Brown.ttf"),
    to: path.join(publicDir, "fonts", "CheGuevaraBarry-Brown.ttf"),
  },
  // The page icon referenced by index.html; the window/tray icons are copied
  // separately into the desktop bundle by apps/desktop/scripts/build.ts.
  {
    from: path.join(repoRoot, "assets", "icons", "favicon.ico"),
    to: path.join(publicDir, "favicon.ico"),
  },
];

let copied = 0;
for (const job of jobs) {
  if (!fs.existsSync(job.from)) {
    throw new Error(`sync-assets: missing source asset ${job.from}`);
  }
  const src = fs.statSync(job.from);
  let dst: fs.Stats | null = null;
  try {
    dst = fs.statSync(job.to);
  } catch {
    dst = null;
  }
  if (dst && dst.size === src.size && dst.mtimeMs >= src.mtimeMs) continue;
  fs.mkdirSync(path.dirname(job.to), { recursive: true });
  fs.copyFileSync(job.from, job.to);
  copied += 1;
}

console.log(
  `[assets] ${copied} of ${jobs.length} file(s) refreshed into ${path.relative(repoRoot, publicDir)}`,
);
