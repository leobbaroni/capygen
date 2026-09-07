/**
 * The production import-parser worker, as a real child process.
 *
 * The bundle under test is the one `scripts/build.ts` produces — built here with
 * the same esbuild settings so the test cannot pass against source that never
 * bundles. It is launched with `child_process.fork`, which exercises the plain
 * Node half of the transport adapter; the Electron utility half differs only in
 * how a message is unwrapped.
 *
 * Everything the child may touch is created by this test: a job root with the
 * owned homes `buildWorkerEnv` names, an inert project directory, and copies of
 * the engine's synthetic fixtures. The child's environment is the allowlist
 * builder's output, so nothing of the real machine's is inherited — no personal
 * home is read, statted or listed here, and no backend process or model request
 * happens at any point.
 */
import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { buildWorkerEnv, workerJobDirs } from "../src/imports/workerEnv.js";
import {
  IMPORT_WORKER_PROTOCOL_VERSION,
  type ImportWorkerResponse,
} from "../src/imports/workerProtocol.js";

const APP_DIR = fileURLToPath(new URL("..", import.meta.url));
const ENGINE_FIXTURES = fileURLToPath(
  new URL("../../../packages/engine/test/fixtures/imports/", import.meta.url),
);

let workerPath: string;
let buildDir: string;
let artifactName: string;
const temps: string[] = [];

beforeAll(async () => {
  // Built into the app's own (gitignored) `dist`, which is where the shipped
  // worker lives: the Claude SDK stays external, so the bundle has to sit
  // inside the app to resolve it from `apps/desktop/node_modules` — exactly as
  // it does in production. A temp directory elsewhere could only resolve it by
  // handing the child a `NODE_PATH`, which the environment allowlist
  // deliberately omits.
  buildDir = path.join(APP_DIR, "dist");
  fs.mkdirSync(buildDir, { recursive: true });
  // Unique per run: two vitest processes (or a watch rebuild) must not race on
  // the same artifact inside the shared `dist`.
  artifactName = `importWorker.testbuild.${process.pid}.${randomBytes(4).toString("hex")}`;
  workerPath = path.join(buildDir, `${artifactName}.cjs`);
  // The same settings `scripts/build.ts` uses for this entry.
  await build({
    entryPoints: { [artifactName]: path.join(APP_DIR, "src", "imports", "workerEntry.ts") },
    outdir: buildDir,
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron", "@anthropic-ai/claude-agent-sdk", "node-pty"],
    logLevel: "silent",
    logOverride: { "empty-import-meta": "silent" },
  });
  expect(fs.existsSync(workerPath)).toBe(true);
}, 120_000);

afterAll(() => {
  // Leave `dist` exactly as this test found it, minus its own artifact.
  for (const suffix of ["", ".map"]) fs.rmSync(`${workerPath}${suffix}`, { force: true });
});

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface Job {
  root: string;
  jobRoot: string;
  fixtures: string;
  inertDir: string;
  resultPath: string;
  env: Record<string, string>;
}

/** A job root with every owned directory created, exactly as main must. */
function makeJob(): Job {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-worker-job-"));
  temps.push(root);
  const jobRoot = path.join(root, "job");
  const fixtures = path.join(root, "fixtures");
  fs.mkdirSync(fixtures, { recursive: true });
  const dirs = workerJobDirs(jobRoot);
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  for (const name of ["claude-chain.jsonl", "codex-rollout.jsonl"]) {
    fs.copyFileSync(path.join(ENGINE_FIXTURES, name), path.join(fixtures, name));
  }
  return {
    root,
    jobRoot,
    fixtures,
    inertDir: dirs.inertDir,
    resultPath: path.join(jobRoot, "result.json"),
    env: buildWorkerEnv({ jobRoot, base: process.env }),
  };
}

/** Launch the built worker, send one message, and take the first answer. */
async function runWorker(
  message: Record<string, unknown>,
  job: Job,
  options: { extra?: Record<string, unknown>; preload?: string } = {},
): Promise<ImportWorkerResponse> {
  const child: ChildProcess = fork(workerPath, [], {
    env: job.env,
    // No inherited hooks. One test explicitly injects its owned short-write fixture.
    execArgv: options.preload ? ["--require", options.preload] : [],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  try {
    const answer = await new Promise<ImportWorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("worker timed out")), 30_000);
      child.once("message", (value) => {
        clearTimeout(timer);
        resolve(value as ImportWorkerResponse);
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`worker exited early with ${String(code)}`));
      });
      child.send(message);
      if (options.extra !== undefined) child.send(options.extra);
    });
    return answer;
  } finally {
    child.removeAllListeners();
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
  }
}

function request(job: Job, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: IMPORT_WORKER_PROTOCOL_VERSION,
    jobId: "job_1",
    jobRoot: job.jobRoot,
    sourcePath: path.join(job.fixtures, "claude-chain.jsonl"),
    resultPath: job.resultPath,
    inertDir: job.inertDir,
    ...over,
  };
}

/** Every file under `dir`, relative and sorted — the owned-boundary snapshot. */
function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(current, entry.name), rel);
      else out.push(rel);
    }
  };
  walk(dir, "");
  return out.sort();
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

describe("the worker's bundle carries nothing it does not need", () => {
  it("contains the parser but no harness, MCP client or native runtime", () => {
    const bundle = fs.readFileSync(workerPath, "utf8");

    // The parser is in there — this is the thing under test, not an empty file.
    expect(bundle).toContain("codex-rollout/rust-v0.153.4");
    expect(bundle).toContain("claude-jsonl/v1");

    // Nothing that runs a backend is. These are identifier and string markers
    // unique to modules the `@capygen/engine` barrel would have dragged in.
    for (const marker of [
      "class ClaudeHarness",
      "class CodexHarness",
      "class ApiHarness",
      "CodexAppServerClient",
      "@modelcontextprotocol/sdk",
      "node-pty",
      "createHarnessForBackend",
      "AsyncQueue",
    ]) {
      expect(bundle).not.toContain(marker);
    }
    // A parser-only bundle is small; the barrel build was ~940 KB.
    expect(fs.statSync(workerPath).size).toBeLessThan(300 * 1024);
  });
});

describe("the built worker parses one selected file", () => {
  it("returns Claude metadata only, and writes the snapshot to its own file", async () => {
    const job = makeJob();
    const source = path.join(job.fixtures, "claude-chain.jsonl");
    const before = tree(job.root);

    const answer = await runWorker(request(job), job);

    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.jobId).toBe("job_1");
    expect(answer.summary.backend).toBe("claude");
    expect(answer.summary.nativeId).toBe("11111111-1111-4111-8111-111111111111");
    // The hash is over the bytes the worker actually read.
    expect(answer.summary.sourceSha256).toBe(sha256(source));
    expect(answer.summary.sourceBytes).toBe(fs.statSync(source).size);
    // A Claude chain needs the SDK, and it was loaded inside the job's homes.
    expect(answer.sdkLoaded).toBe(true);

    // Metadata only: the transcript itself never crosses the channel, and
    // neither does the source path main already knows.
    expect("entries" in answer).toBe(false);
    expect("sourcePath" in answer).toBe(false);
    const wire = JSON.stringify(answer);
    expect(wire).not.toContain(source);
    expect(wire).not.toContain("Hello ünïcode");
    expect(wire).not.toContain("loader.ts");
    expect(Buffer.byteLength(wire, "utf8")).toBeLessThanOrEqual(64 * 1024);

    // The snapshot itself is on disk, owner-only, and the byte count is exact.
    expect(answer.resultBytes).toBe(fs.statSync(job.resultPath).size);
    if (process.platform !== "win32") {
      expect(fs.statSync(job.resultPath).mode & 0o777).toBe(0o600);
    }
    const written = fs.readFileSync(job.resultPath, "utf8");
    const snapshot = JSON.parse(written) as { entries: { kind: string }[] };
    expect(snapshot.entries.length).toBeGreaterThan(0);
    // The chunked writer produces exactly what one big `JSON.stringify` would.
    expect(written).toBe(JSON.stringify(snapshot));
    expect(answer.resultBytes).toBe(Buffer.byteLength(written, "utf8"));
    // Inert: the tool-use id from the fixture reaches neither file nor message.
    expect(fs.readFileSync(job.resultPath, "utf8")).not.toContain("toolu_1");

    // Nothing was created outside the job's own result file.
    expect(tree(job.root)).toEqual([...before, "job/result.json"].sort());
  }, 60_000);

  it("parses a Codex rollout without ever loading the Claude SDK", async () => {
    const job = makeJob();
    const source = path.join(job.fixtures, "codex-rollout.jsonl");

    const answer = await runWorker(request(job, { sourcePath: source, jobId: "job_codex" }), job);

    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.summary.backend).toBe("codex");
    expect(answer.summary.sourceSha256).toBe(sha256(source));
    // The reconstruction boundary is lazy: a rollout never reaches it.
    expect(answer.sdkLoaded).toBe(false);
    expect(answer.resultBytes).toBe(fs.statSync(job.resultPath).size);
  }, 60_000);

  it("honours a tightened limit and answers with the parser's own code", async () => {
    const job = makeJob();
    const answer = await runWorker(
      request(job, {
        sourcePath: path.join(job.fixtures, "codex-rollout.jsonl"),
        limits: { maxRecords: 2 },
      }),
      job,
    );

    expect(answer).toMatchObject({ ok: false, code: "too-many-records" });
    expect(fs.existsSync(job.resultPath)).toBe(false);
  }, 60_000);
});

describe("the worker refuses what it cannot trust", () => {
  it("rejects malformed requests before touching the disk", async () => {
    const job = makeJob();
    const bad: Array<[string, Record<string, unknown>]> = [
      ["a relative source", { sourcePath: "claude-chain.jsonl" }],
      ["a traversal", { resultPath: path.join(job.jobRoot, "..", "escape.json") }],
      ["a result outside the job", { resultPath: path.join(job.root, "outside.json") }],
      ["an inert dir outside the job", { inertDir: job.root }],
      ["a bad job id", { jobId: "../../etc" }],
      ["a raised limit", { limits: { maxRecords: Number.MAX_SAFE_INTEGER } }],
      ["an unknown limit", { limits: { maxWhatever: 1 } }],
      ["a wrong version", { v: 99 }],
    ];

    for (const [, over] of bad) {
      const answer = await runWorker(request(job, over), job);
      expect(answer.ok).toBe(false);
      if (answer.ok) continue;
      expect(["invalid-request", "invalid-environment"]).toContain(answer.code);
      // A refusal names no path, no field value and no message text.
      expect(Object.keys(answer).sort()).toEqual(["code", "jobId", "ok", "v"]);
    }
    expect(fs.existsSync(job.resultPath)).toBe(false);
    expect(fs.existsSync(path.join(job.root, "outside.json"))).toBe(false);
  }, 120_000);

  it("refuses a request larger than the message cap, before reading a field", async () => {
    const job = makeJob();
    const answer = await runWorker(request(job, { padding: "p".repeat(70 * 1024) }), job);

    expect(answer).toMatchObject({ ok: false, code: "invalid-request" });
    expect(fs.existsSync(job.resultPath)).toBe(false);
  }, 60_000);

  it("accepts native absolute path shapes, including a Windows long path", async () => {
    const job = makeJob();
    // Not a valid *file*, but a valid *path*: the refusal must come from
    // opening it, not from the shape check.
    const longPath = `\\\\?\\C:\\${"segment\\".repeat(40)}transcript.jsonl`;
    const answer = await runWorker(request(job, { sourcePath: longPath }), job);

    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.code).toBe("not-a-file");
  }, 60_000);

  it("refuses when a generated job directory is missing or the home pair disagrees", async () => {
    const job = makeJob();
    const dirs = workerJobDirs(job.jobRoot);

    // A drive/path pair that reassembles into something else.
    const mismatched = await runWorker(request(job), {
      ...job,
      env: { ...job.env, HOMEPATH: `${job.env.HOMEPATH}-elsewhere` },
    });
    expect(mismatched).toMatchObject({ ok: false, code: "invalid-environment" });

    // Every generated directory is checked, not just the two backend homes.
    fs.rmSync(dirs.temp, { recursive: true, force: true });
    const missing = await runWorker(request(job), job);
    expect(missing).toMatchObject({ ok: false, code: "invalid-environment" });
    expect(fs.existsSync(job.resultPath)).toBe(false);
  }, 60_000);

  it("refuses to run when the environment is not the job's own", async () => {
    const job = makeJob();
    const strayRoot = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-worker-stray-"));
    temps.push(strayRoot);
    const answer = await runWorker(request(job), {
      ...job,
      // A home pointing outside the job root is exactly what must not run.
      env: { ...job.env, CLAUDE_CONFIG_DIR: strayRoot },
    });

    expect(answer).toMatchObject({ ok: false, code: "invalid-environment" });
    expect(fs.existsSync(job.resultPath)).toBe(false);
    expect(tree(strayRoot)).toEqual([]);
  }, 60_000);

  it("leaves an existing result file exactly as it was", async () => {
    const job = makeJob();
    const squatter = Buffer.from("someone else's snapshot", "utf8");
    fs.writeFileSync(job.resultPath, squatter);

    const answer = await runWorker(request(job), job);

    expect(answer).toMatchObject({ ok: false, code: "result-exists" });
    expect(fs.readFileSync(job.resultPath).equals(squatter)).toBe(true);
  }, 60_000);

  it("sanitizes a parse failure to a code and a line", async () => {
    const job = makeJob();
    const broken = path.join(job.fixtures, "broken.jsonl");
    fs.writeFileSync(
      broken,
      '{"type":"user","uuid":"u-1","sessionId":"11111111-1111-4111-8111-111111111111","message":{"role":"user","content":"hi"}}\n{"type":"user",\n',
      "utf8",
    );

    const answer = await runWorker(request(job, { sourcePath: broken }), job);

    expect(answer).toMatchObject({ ok: false, code: "invalid-json", line: 2 });
    if (answer.ok) return;
    const wire = JSON.stringify(answer);
    expect(wire).not.toContain(broken);
    expect(wire).not.toContain("hi");
    expect(wire).not.toContain("JSON");
    expect(fs.existsSync(job.resultPath)).toBe(false);
  }, 60_000);

  it("answers one start message and ignores a second", async () => {
    const job = makeJob();
    const child = fork(workerPath, [], {
      env: job.env,
      execArgv: [],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const answers: ImportWorkerResponse[] = [];
    child.on("message", (value) => void answers.push(value as ImportWorkerResponse));
    try {
      child.send(request(job));
      child.send(request(job, { jobId: "job_2" }));
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    } finally {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }

    expect(answers).toHaveLength(1);
    expect(answers[0]?.jobId).toBe("job_1");
  }, 60_000);
});


describe("worker result writes", () => {
  it("completes short filesystem writes without losing bytes", async () => {
    const job = makeJob();
    const preload = path.join(job.fixtures, "short-writes.cjs");
    fs.writeFileSync(preload, `
      const fs = require("node:fs");
      const original = fs.writeSync;
      fs.writeSync = (fd, data, ...args) => {
        if (typeof data === "string") {
          const body = Buffer.from(data, typeof args[1] === "string" ? args[1] : "utf8");
          return original(fd, body, 0, Math.min(body.length, 7), args[0] ?? null);
        }
        const [offset = 0, length = data.byteLength - offset, position = null] = args;
        return original(fd, data, offset, Math.min(length, 7), position);
      };
    `);
    const sourcePath = path.join(job.fixtures, "codex-rollout.jsonl");
    const answer = await runWorker(request(job, { sourcePath }), job, { preload });
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    const body = fs.readFileSync(job.resultPath);
    expect(body.byteLength).toBe(answer.resultBytes);
    const parsed = JSON.parse(body.toString("utf8"));
    expect(parsed.entries.length).toBeGreaterThan(0);
    expect(parsed.sourceSha256).toBe(sha256(sourcePath));
    expect(parsed.counts.normalizedBytes).toBe(body.byteLength);
  }, 60_000);
});
