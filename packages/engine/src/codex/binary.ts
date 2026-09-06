/**
 * Finding the `codex` executable that will host `codex app-server`.
 *
 * The Phase 1 spike settled which binary capygen drives
 * (`docs/spikes/codex-shapes.md` §0): the **bundled** `@openai/codex` 0.153.4
 * that ships inside `@openai/codex-sdk`, not whatever the user installed
 * (0.139.0 here). One protocol version, shipped with the app, and the same
 * binary the SDK itself would spawn. The installed CLI stays available as a
 * fallback and as an explicit opt-in.
 *
 * Resolution order (first hit wins):
 *   1. `options.binaryPath`            — the desktop app may pin one.
 *   2. `CAPYGEN_CODEX_BIN`             — env seam, documented in docs/RUN.md.
 *   3. the bundled `@openai/codex-win32-x64` vendor binary, walked exactly the
 *      way `@openai/codex-sdk`'s own `findCodexPath` walks it
 *      (`dist/index.js:393-483`): `@openai/codex-sdk` → `@openai/codex` →
 *      `@openai/codex-<platform>` → `vendor/<triple>/bin/codex(.exe)`.
 *   4. the per-user install (`%LOCALAPPDATA%\Programs\OpenAI\Codex\bin`).
 *   5. bare `codex` / `codex.exe`, left for PATH to resolve.
 *
 * Step 3 only works where `@openai/codex-sdk` is resolvable from this module —
 * true under tsx/vitest and in a dev Electron run from the workspace, not
 * inside the packaged `main.cjs` (the engine is inlined there and the package
 * is not a dependency of `apps/desktop`). That is why steps 1, 2, 4 and 5
 * exist; `resolveCodexBinary().source` says which one answered.
 */
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type CodexBinarySource = "option" | "env" | "bundled" | "installed" | "path";

export interface CodexBinary {
  /** Executable to spawn. May be a bare command name when `source` is `path`. */
  exe: string;
  /**
   * Directories to prepend to `PATH` for the child. The bundled layout keeps
   * `rg.exe` in `vendor/<triple>/codex-path`, which the SDK also prepends
   * (`dist/index.js:470,485-496`); without it Codex's search tools are missing.
   */
  pathDirs: string[];
  source: CodexBinarySource;
}

export interface ResolveCodexBinaryOptions {
  /** Explicit path; wins over everything. */
  binaryPath?: string;
  /** Environment to read `CAPYGEN_CODEX_BIN` / `LOCALAPPDATA` from. */
  env?: Record<string, string | undefined>;
  /** `"bundled"` (default) prefers the vendored 0.153.4; `"installed"` flips 3 and 4. */
  prefer?: "bundled" | "installed";
}

const EXE = process.platform === "win32" ? "codex.exe" : "codex";

/**
 * The vendor triple for this platform, as `@openai/codex` names its per-platform
 * packages. Only the Windows entry is exercised on this machine; the rest keep
 * the resolver honest on a developer's other box rather than claiming support.
 */
function platformPackage(): { pkg: string; triple: string } | null {
  if (process.platform === "win32" && process.arch === "x64") {
    return { pkg: "@openai/codex-win32-x64", triple: "x86_64-pc-windows-msvc" };
  }
  if (process.platform === "darwin") {
    return process.arch === "arm64"
      ? { pkg: "@openai/codex-darwin-arm64", triple: "aarch64-apple-darwin" }
      : { pkg: "@openai/codex-darwin-x64", triple: "x86_64-apple-darwin" };
  }
  if (process.platform === "linux") {
    return process.arch === "arm64"
      ? { pkg: "@openai/codex-linux-arm64", triple: "aarch64-unknown-linux-musl" }
      : { pkg: "@openai/codex-linux-x64", triple: "x86_64-unknown-linux-musl" };
  }
  return null;
}

/**
 * A `file:` URL for this module under ESM, or for the bundle under CommonJS.
 * Same two-runtime dance as `packagedMigrationsDir()` in `@capygen/db`: esbuild
 * empties `import.meta` in the CJS desktop bundle, where `__filename` is real.
 */
function moduleUrl(): string | null {
  const url = (import.meta as ImportMeta | undefined)?.url;
  if (typeof url === "string") return url;
  if (typeof __filename === "string") return pathToFileURL(__filename).href;
  return null;
}

/**
 * `@openai/codex-sdk`'s own `package.json`, as a real path.
 *
 * Node's resolver is **not** used for this step. The package's `exports` map is
 * `{".":{"import":"./dist/index.js","types":…}}` — no `./package.json` entry and
 * no `require` condition — so `createRequire(...).resolve("@openai/codex-sdk")`
 * throws `No "exports" main defined`. That is exactly how this resolver
 * silently fell through to the machine's *installed* Codex 0.139.0 on the first
 * live run, spawning a different protocol version from the 0.153.4 COMPAT.md
 * pins. `import.meta.resolve` works under plain ESM (the Phase 1 spike used it,
 * `scripts/spike-codex.ts:48`) but is absent under vitest's module runner and
 * under esbuild's CJS output, so the primary path here is a plain walk up the
 * directory tree looking for `node_modules/@openai/codex-sdk/package.json` —
 * the one lookup that behaves identically in every runtime this code runs in.
 */
function findSdkPackageJson(base: string): string | null {
  let dir = path.dirname(fileURLToPath(base));
  for (;;) {
    const candidate = path.join(dir, "node_modules", "@openai", "codex-sdk", "package.json");
    if (existsSync(candidate)) return realpathSync(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The bundled binary, walked the way the SDK walks it. `null` when absent. */
export function resolveBundledCodex(): CodexBinary | null {
  const plat = platformPackage();
  const base = moduleUrl();
  if (!plat || !base) return null;
  try {
    const sdkEntry = findSdkPackageJson(base);
    if (!sdkEntry) return null;
    const codexPkg = realpathSync(
      createRequire(sdkEntry).resolve("@openai/codex/package.json"),
    );
    const platPkg = realpathSync(
      createRequire(codexPkg).resolve(`${plat.pkg}/package.json`),
    );
    const root = path.join(path.dirname(platPkg), "vendor", plat.triple);
    const exe = path.join(root, "bin", EXE);
    if (!existsSync(exe)) return null;
    const pathDir = path.join(root, "codex-path");
    return {
      exe,
      pathDirs: existsSync(pathDir) ? [pathDir] : [],
      source: "bundled",
    };
  } catch {
    return null;
  }
}

/** The per-user install the Codex setup writes. */
export function resolveInstalledCodex(
  env: Record<string, string | undefined> = process.env,
): CodexBinary | null {
  const local = env.LOCALAPPDATA;
  if (!local) return null;
  const exe = path.join(local, "Programs", "OpenAI", "Codex", "bin", EXE);
  return existsSync(exe) ? { exe, pathDirs: [], source: "installed" } : null;
}

export function resolveCodexBinary(
  options: ResolveCodexBinaryOptions = {},
): CodexBinary {
  const env = options.env ?? process.env;
  if (options.binaryPath) {
    return { exe: options.binaryPath, pathDirs: [], source: "option" };
  }
  const fromEnv = env.CAPYGEN_CODEX_BIN;
  if (fromEnv) return { exe: fromEnv, pathDirs: [], source: "env" };

  const bundled = (): CodexBinary | null => resolveBundledCodex();
  const installed = (): CodexBinary | null => resolveInstalledCodex(env);
  const order = options.prefer === "installed" ? [installed, bundled] : [bundled, installed];
  for (const step of order) {
    const found = step();
    if (found) return found;
  }
  // Last resort: let the OS resolve it, so the failure the user sees is
  // "codex is not on PATH" rather than a guess at where it should have been.
  return { exe: EXE, pathDirs: [], source: "path" };
}
