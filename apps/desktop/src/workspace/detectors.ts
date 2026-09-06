/**
 * Dev-server detection (SPEC R18, G6: "A project with a `dev` script is
 * auto-detected; one click starts it ... No prompt, no agent tokens spent").
 *
 * Four detectors, in the order the pane lists them:
 *
 *   1. `.claude/launch.json` — Claude Code's own format, and the only one that
 *      is a *declaration* rather than a guess, so it wins on ordering;
 *   2. `package.json` scripts named dev / start / serve / preview;
 *   3. Python: `manage.py` (Django), then FastAPI/uvicorn or Flask inferred
 *      from `pyproject.toml` / `requirements.txt`;
 *   4. `docker-compose.yml` services that publish a host port.
 *
 * Every detected server carries a **deterministic id** derived from the
 * project, the source and a per-detector key, so re-running detection updates
 * the same `dev_servers` row instead of duplicating it (`DevServersRepo.upsert`
 * exists for exactly this) — and so a port or URL discovered by a previous
 * *start* can be merged back onto the same row (`mergeDetected`).
 *
 * A detector never invents a port it cannot justify. `portFromScript` reads an
 * explicit flag or `PORT=` assignment; `DEFAULT_TOOL_PORTS` adds the
 * documented default of a handful of dev servers whose name appears in the
 * script. Both are only a *starting guess*: `DevServerService` prefers a URL
 * printed on stdout over anything guessed here, and rewrites the row when the
 * two disagree.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DevServerSchema, type DevServer, type DevServerSource } from "@capygen/shared";

/** Package scripts worth offering as a dev server, in listing order. */
export const SCRIPT_NAMES = ["dev", "start", "serve", "preview"] as const;

/**
 * Documented default ports of dev servers we can recognise by name in the
 * script body. Only consulted when the script states no port of its own.
 * [assumed 2026-09-06: each tool's documented default; wrong only costs the
 * port probe, since a URL printed on stdout always wins.]
 */
export const DEFAULT_TOOL_PORTS: ReadonlyArray<readonly [RegExp, number]> = [
  [/\bvite\b/, 5173],
  [/\bnext\b/, 3000],
  [/\bnuxt\b/, 3000],
  [/\bremix\b/, 3000],
  [/\bastro\b/, 4321],
  [/\bng\s+serve\b/, 4200],
  [/\breact-scripts\b/, 3000],
  [/\bwebpack(-dev-server)?\s+serve\b/, 8080],
  [/\bdocusaurus\b/, 3000],
  [/\bstorybook\b/, 6006],
];

/** A stable id for a detected server: same project + source + key = same row. */
export function detectedId(projectId: string, source: DevServerSource, key: string): string {
  const digest = createHash("sha256").update(`${projectId}|${source}|${key}`).digest("hex");
  return `srv_${digest.slice(0, 32)}`;
}

export interface DetectContext {
  projectId: string;
  root: string;
  now: number;
}

/** Everything the four detectors found, in listing order. */
export function detectDevServers(ctx: DetectContext): DevServer[] {
  return [
    ...detectLaunchJson(ctx),
    ...detectPackageJson(ctx),
    ...detectPython(ctx),
    ...detectCompose(ctx),
  ];
}

// ---------------------------------------------------------------------------
// 1. .claude/launch.json
// ---------------------------------------------------------------------------

/**
 * The format capygen's own brief pins (SPEC R18):
 * `{"version":"0.0.1","configurations":[{name, runtimeExecutable,
 * runtimeArgs, port, url?}]}`. A malformed file is a warning-shaped no-op, not
 * a failed detection run — the other three detectors still answer.
 */
export function detectLaunchJson(ctx: DetectContext): DevServer[] {
  const file = path.join(ctx.root, ".claude", "launch.json");
  const parsed = readJson(file);
  if (!isRecord(parsed)) return [];
  const configurations = parsed.configurations;
  if (!Array.isArray(configurations)) return [];
  const out: DevServer[] = [];
  for (const raw of configurations) {
    if (!isRecord(raw)) continue;
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    const command = typeof raw.runtimeExecutable === "string" ? raw.runtimeExecutable.trim() : "";
    if (name === "" || command === "") continue;
    const args = Array.isArray(raw.runtimeArgs)
      ? raw.runtimeArgs.filter((a): a is string => typeof a === "string")
      : [];
    const port = typeof raw.port === "number" && raw.port > 0 ? Math.trunc(raw.port) : undefined;
    const url = typeof raw.url === "string" && raw.url.trim() !== "" ? raw.url.trim() : undefined;
    out.push(
      make(ctx, {
        source: "launch.json",
        key: name,
        name,
        command,
        args,
        cwd: ctx.root,
        ...(port !== undefined ? { port } : {}),
        ...(url !== undefined ? { url } : {}),
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. package.json scripts
// ---------------------------------------------------------------------------

/**
 * The **root** `package.json` only. A pnpm/yarn workspace has one per package
 * and offering forty "build" scripts is not a Servers pane — a workspace's own
 * dev server is normally a root script anyway, and anything else is a
 * `servers.saveCustom` away.
 */
export function detectPackageJson(ctx: DetectContext): DevServer[] {
  const manifest = readJson(path.join(ctx.root, "package.json"));
  if (!isRecord(manifest) || !isRecord(manifest.scripts)) return [];
  const runner = packageRunner(ctx.root);
  const out: DevServer[] = [];
  for (const script of SCRIPT_NAMES) {
    const body = manifest.scripts[script];
    if (typeof body !== "string" || body.trim() === "") continue;
    const port = portFromScript(body);
    out.push(
      make(ctx, {
        source: "package.json",
        key: script,
        name: `${runner.label} ${script}`,
        command: runner.command,
        args: [...runner.args, script],
        cwd: ctx.root,
        ...(port !== undefined ? { port } : {}),
      }),
    );
  }
  return out;
}

/**
 * Which package manager runs the script, from the lockfile that is actually
 * present. `corepack pnpm` rather than a bare `pnpm` for the same reason
 * CLAUDE.md gives: corepack is what pins the version on this machine.
 */
export function packageRunner(root: string): { label: string; command: string; args: string[] } {
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) {
    return { label: "pnpm", command: "corepack", args: ["pnpm", "run"] };
  }
  if (fs.existsSync(path.join(root, "yarn.lock"))) {
    return { label: "yarn", command: "yarn", args: ["run"] };
  }
  if (
    fs.existsSync(path.join(root, "bun.lockb")) ||
    fs.existsSync(path.join(root, "bun.lock"))
  ) {
    return { label: "bun", command: "bun", args: ["run"] };
  }
  return { label: "npm", command: "npm", args: ["run"] };
}

/**
 * An explicit port in a script body, else the documented default of a tool
 * named in it, else nothing. Never a made-up number: "nothing" is what makes
 * `DevServerService` wait for a URL on stdout instead of probing a port the
 * server was never going to bind.
 */
export function portFromScript(script: string): number | undefined {
  const explicit =
    /(?:^|\s)--port(?:[=\s]+)(\d{2,5})\b/.exec(script) ??
    /(?:^|\s)-p\s+(\d{2,5})\b/.exec(script) ??
    /(?:^|\s)PORT=(\d{2,5})\b/.exec(script) ??
    /--listen(?:[=\s]+)(?:[\w.]+:)?(\d{2,5})\b/.exec(script);
  if (explicit?.[1]) {
    const port = Number(explicit[1]);
    if (port > 0 && port < 65_536) return port;
  }
  for (const [pattern, port] of DEFAULT_TOOL_PORTS) {
    if (pattern.test(script)) return port;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 3. Python
// ---------------------------------------------------------------------------

/**
 * Django first (`manage.py` is unambiguous), then FastAPI/uvicorn and Flask —
 * both only when a dependency file names the framework *and* an entry module
 * actually exists on disk. A guessed `uvicorn main:app` against a project with
 * no `main.py` would fail on click, which is worse than not offering it.
 */
export function detectPython(ctx: DetectContext): DevServer[] {
  const out: DevServer[] = [];
  if (fs.existsSync(path.join(ctx.root, "manage.py"))) {
    out.push(
      make(ctx, {
        source: "python",
        key: "django",
        name: "django runserver",
        command: "python",
        args: ["manage.py", "runserver", "8000"],
        cwd: ctx.root,
        port: 8000,
      }),
    );
  }

  const deps = pythonDependencyText(ctx.root);
  if (deps === null) return out;

  if (/\b(fastapi|uvicorn)\b/i.test(deps)) {
    const module = findPythonModule(ctx.root, ["main.py", "app.py", "src/main.py", "app/main.py"]);
    if (module) {
      out.push(
        make(ctx, {
          source: "python",
          key: "uvicorn",
          name: `uvicorn ${module}:app`,
          command: "python",
          args: ["-m", "uvicorn", `${module}:app`, "--reload", "--port", "8000"],
          cwd: ctx.root,
          port: 8000,
        }),
      );
    }
  }

  if (/\bflask\b/i.test(deps) && fs.existsSync(path.join(ctx.root, "app.py"))) {
    out.push(
      make(ctx, {
        source: "python",
        key: "flask",
        name: "flask run",
        command: "python",
        args: ["-m", "flask", "run", "--port", "5000"],
        cwd: ctx.root,
        port: 5000,
        env: { FLASK_APP: "app.py" },
      }),
    );
  }
  return out;
}

/** `pyproject.toml` + `requirements.txt`, concatenated; `null` when neither
 *  exists (i.e. not a Python project we can say anything about). */
function pythonDependencyText(root: string): string | null {
  const parts: string[] = [];
  for (const file of ["pyproject.toml", "requirements.txt"]) {
    const text = readText(path.join(root, file));
    if (text !== null) parts.push(text);
  }
  return parts.length === 0 ? null : parts.join("\n");
}

/** `src/main.py` becomes the import path `src.main`. */
function findPythonModule(root: string, candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (!fs.existsSync(path.join(root, candidate))) continue;
    return candidate.replace(/\.py$/, "").split("/").join(".");
  }
  return null;
}

// ---------------------------------------------------------------------------
// 4. docker-compose
// ---------------------------------------------------------------------------

export const COMPOSE_FILES = [
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
] as const;

export function detectCompose(ctx: DetectContext): DevServer[] {
  for (const file of COMPOSE_FILES) {
    const text = readText(path.join(ctx.root, file));
    if (text === null) continue;
    return parseComposeServices(text).map((service) =>
      make(ctx, {
        source: "docker-compose",
        key: service.name,
        name: `docker compose up ${service.name}`,
        command: "docker",
        args: ["compose", "-f", file, "up", service.name],
        cwd: ctx.root,
        ...(service.port !== undefined ? { port: service.port } : {}),
      }),
    );
  }
  return [];
}

/**
 * A deliberately small YAML reader: compose files are indentation-regular and
 * capygen needs exactly two facts from one — the service names under
 * `services:` and the first *published* host port of each. Adding a YAML
 * dependency to read two keys would buy nothing and cost a parser in the main
 * process.
 *
 * Only services that publish a host port are returned: a database with no
 * `ports:` is not something the Browser pane could open, and R18's contract is
 * "services with published ports".
 */
export function parseComposeServices(text: string): { name: string; port?: number }[] {
  const lines = text.split(/\r?\n/);
  const out: { name: string; port?: number }[] = [];
  let inServices = false;
  let servicesIndent = -1;
  let serviceIndent = -1;
  let current: { name: string; port?: number } | null = null;
  let inPorts = false;
  let portsIndent = -1;

  const flush = (): void => {
    if (current && current.port !== undefined) out.push(current);
    current = null;
    inPorts = false;
  };

  for (const raw of lines) {
    const line = raw.replace(/\t/g, "  ");
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (!inServices) {
      if (/^services\s*:/.test(trimmed)) {
        inServices = true;
        servicesIndent = indent;
      }
      continue;
    }
    // A top-level key at or below `services:` ends the block.
    if (indent <= servicesIndent) {
      flush();
      inServices = false;
      continue;
    }
    if (serviceIndent === -1) serviceIndent = indent;

    if (indent === serviceIndent && /^[A-Za-z0-9._-]+\s*:/.test(trimmed)) {
      flush();
      current = { name: trimmed.slice(0, trimmed.indexOf(":")).trim() };
      continue;
    }
    if (!current) continue;

    if (indent > serviceIndent && /^ports\s*:/.test(trimmed)) {
      // `ports: ["3000:3000"]` — a flow sequence on the same line is as valid
      // as the block form below, and used to be dropped entirely (no port
      // meant `flush()` discarded the whole service).
      const inline = /^ports\s*:\s*\[(.*)\]\s*$/.exec(trimmed);
      if (inline) {
        for (const item of inline[1]!.split(",")) {
          const port = publishedHostPort(item.trim());
          if (port !== undefined && current.port === undefined) current.port = port;
        }
        inPorts = false;
        continue;
      }
      inPorts = true;
      portsIndent = indent;
      continue;
    }
    if (inPorts) {
      if (indent <= portsIndent && !trimmed.startsWith("-")) {
        inPorts = false;
      } else if (trimmed.startsWith("-")) {
        const port = publishedHostPort(trimmed.slice(1).trim());
        if (port !== undefined && current.port === undefined) current.port = port;
        continue;
      }
    }
    if (indent > serviceIndent && /^[A-Za-z0-9._-]+\s*:/.test(trimmed)) inPorts = false;
  }
  flush();
  return out;
}

/**
 * `"3000:3000"`, `3000:3000`, `"127.0.0.1:8080:80"`, `"3000-3005:3000"`,
 * `"8080:80/tcp"` → the host port. A bare `"3000"` publishes nothing (compose
 * assigns a random host port), so it yields `undefined`.
 */
export function publishedHostPort(entry: string): number | undefined {
  const cleaned = entry.replace(/^["']|["']$/g, "").split("/")[0]?.trim() ?? "";
  if (cleaned === "") return undefined;
  const parts = cleaned.split(":");
  if (parts.length < 2) return undefined;
  const host = parts[parts.length - 2] ?? "";
  const first = host.split("-")[0] ?? "";
  const port = Number(first);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : undefined;
}

// ---------------------------------------------------------------------------
// merge + helpers
// ---------------------------------------------------------------------------

/**
 * What a re-detection writes back. The detector owns the *definition* (name,
 * command, args, cwd) — the file on disk is the truth for those — but a
 * `port`/`url` learned by actually starting the server is knowledge the file
 * does not have, so it survives unless the detector now states one itself.
 * `createdAt` is kept so the pane's ordering does not shuffle on every scan.
 */
export function mergeDetected(existing: DevServer | null, detected: DevServer): DevServer {
  if (!existing) return detected;
  return DevServerSchema.parse({
    ...detected,
    createdAt: existing.createdAt,
    port: detected.port ?? existing.port,
    url: detected.url ?? existing.url,
    env: detected.env ?? existing.env,
  });
}

function make(
  ctx: DetectContext,
  input: {
    source: DevServerSource;
    key: string;
    name: string;
    command: string;
    args: string[];
    cwd: string;
    port?: number;
    url?: string;
    env?: Record<string, string>;
  },
): DevServer {
  return DevServerSchema.parse({
    id: detectedId(ctx.projectId, input.source, input.key),
    projectId: ctx.projectId,
    name: input.name,
    source: input.source,
    command: input.command,
    args: input.args,
    cwd: input.cwd,
    ...(input.port !== undefined ? { port: input.port } : {}),
    ...(input.url !== undefined ? { url: input.url } : {}),
    ...(input.env !== undefined ? { env: input.env } : {}),
    createdAt: ctx.now,
    updatedAt: ctx.now,
  });
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function readJson(file: string): unknown {
  const text = readText(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
