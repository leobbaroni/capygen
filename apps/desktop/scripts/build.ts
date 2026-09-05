/**
 * Bundle the Electron main + preload with esbuild into apps/desktop/dist, and
 * copy the two runtime assets they load by path: the SQL migrations and the tray
 * icon. CommonJS output on purpose — Electron's preload is loaded as CJS, and a
 * single format for both keeps `__dirname` meaning the same thing in each.
 *
 * `electron` is external (provided by the runtime); `node:*` builtins are
 * external automatically for platform "node", which is what keeps `node:sqlite`
 * working with no native build (docs/adr/0003-sqlite-driver.md).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const repoRoot = path.resolve(appDir, "..", "..");
const outDir = path.join(appDir, "dist");

const watch = process.argv.includes("--watch");

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: {
    main: path.join(appDir, "src", "main.ts"),
    preload: path.join(appDir, "src", "preload.ts"),
  },
  outdir: outDir,
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: true,
  minify: false,
  // `electron` is provided by the runtime. The Claude Agent SDK stays external
  // on purpose: it locates its bundled `claude.exe` through
  // `createRequire(import.meta.url).resolve(...)`, which an inlined copy inside
  // main.cjs could not resolve. It is ESM-only, and `require()` of an ESM
  // package works on Electron 44's Node — verified with
  // `node -e "require('@anthropic-ai/claude-agent-sdk')"`.
  external: ["electron", "@anthropic-ai/claude-agent-sdk"],
  logLevel: "info",
  // `packagedMigrationsDir()` in @capygen/db reads `import.meta.url` when it
  // runs under ESM and falls back to `__dirname` here; esbuild's warning about
  // the emptied `import.meta` is that handled case, not a defect.
  logOverride: { "empty-import-meta": "silent" },
  define: { "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production") },
});

// Migrations are read from disk at runtime (see @capygen/db) — put them next to
// main.cjs so the packaged app finds them without a bundler plugin.
const migrationsSrc = path.join(repoRoot, "packages", "db", "migrations");
const migrationsOut = path.join(outDir, "migrations");
fs.mkdirSync(migrationsOut, { recursive: true });
for (const file of fs.readdirSync(migrationsSrc)) {
  if (file.endsWith(".sql")) {
    fs.copyFileSync(path.join(migrationsSrc, file), path.join(migrationsOut, file));
  }
}

// Tray icon: the idle mascot, which Electron downsizes to 16px at runtime.
const assetsOut = path.join(outDir, "assets");
fs.mkdirSync(assetsOut, { recursive: true });
fs.copyFileSync(
  path.join(repoRoot, "assets", "mascot", "states", "idle.png"),
  path.join(assetsOut, "tray.png"),
);

console.log(`[build] desktop bundle written to ${outDir}${watch ? " (watch not implemented)" : ""}`);
