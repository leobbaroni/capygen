import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";

/**
 * Proof that the share worker really forks.
 *
 * Everything else about the worker is exercised through an in-process host, so
 * the one thing those tests cannot show is the thing that matters here: that
 * `utilityProcess.fork` starts this bundle, that its message transport works in
 * both directions, and that killing it actually ends the process. Bundling the
 * entry proves none of that.
 *
 * A real Electron main process is spawned with an owned `userData` directory
 * and owned backend homes, so nothing touches `~/.claude`, `~/.codex` or any
 * real profile. It opens no window, forks the worker, drives one export through
 * create → page → encode → release → kill, and writes what happened to a file.
 */
const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const SHARING = path.join(REPO, "apps", "desktop", "src", "sharing");
const ELECTRON = path.join(
  REPO, "node_modules", ".pnpm", "electron@44.2.0", "node_modules", "electron", "dist", "electron.exe",
);

const available = fs.existsSync(ELECTRON);
let dir: string;
let result: Record<string, unknown> | null = null;
let stderr = "";

/** The Electron main process for this proof: no window, one forked worker. */
const PROBE = `
import path from "node:path";
import fs from "node:fs";
import { app, utilityProcess } from "electron";
import { ShareWorkerClient } from "./workerClient.js";

const workerPath = process.env.PROBE_WORKER!;
const outFile = process.env.PROBE_OUT!;
const userData = process.env.PROBE_USER_DATA!;

const steps: Record<string, unknown> = {};
let exited = false;

async function main() {
  app.setPath("userData", userData);
  await app.whenReady();

  const client = new ShareWorkerClient({
    timeoutMs: 30_000,
    fork: () => {
      const child = utilityProcess.fork(workerPath, [], { serviceName: "capygen-share-probe" });
      child.on("exit", () => { exited = true; });
      return child as never;
    },
  });

  const preview = await client.createFromExport("probe-job", {
    kind: "live",
    rows: [
      { kind: "text", turnRole: "user", createdAt: 1757000000000,
        text: "question from the probe", textLength: 23, name: null, status: null },
      { kind: "text", turnRole: "agent", createdAt: 1757000000001,
        text: "answer with a key sk-ant-api03-SHOULDNOTSURVIVE1234", textLength: 51,
        name: null, status: null },
      { kind: "tool_call", turnRole: "agent", createdAt: 1757000000002,
        text: null, textLength: 0, name: "Bash", status: "success" },
    ],
    metadata: { title: "Fork probe", mode: "solo", startedAt: null, endedAt: null, agents: [] },
    options: { bundleId: "a".repeat(32), appVersion: "0.0.0-probe",
      createdAt: "2026-09-07T10:00:00Z" },
  } as never);
  steps.preview = {
    entryCount: preview.entryCount,
    messages: preview.counts.messages,
    activities: preview.counts.activities,
    redactions: preview.counts.redactions,
    jsonBytes: preview.json.bytes,
    htmlBytes: preview.html.bytes,
  };

  const firstPage = await client.entries("probe-job", 0, 2);
  const secondPage = await client.entries("probe-job", 2, 2);
  steps.paging = {
    first: firstPage.map((entry: { kind: string }) => entry.kind),
    second: secondPage.map((entry: { kind: string }) => entry.kind),
  };

  const encoded = await client.text("probe-job", "json");
  steps.encoded = {
    bytes: encoded.bytes,
    matchesPreview: encoded.bytes === preview.json.bytes,
    leaksSecret: encoded.text.includes("sk-ant-api03-SHOULDNOTSURVIVE"),
  };

  await client.release("probe-job");
  steps.afterRelease = await client.entries("probe-job", 0, 2)
    .then(() => "served-anyway")
    .catch(() => "refused");

  client.dispose();
  // Poll rather than sleep a fixed span: process teardown is slower on a loaded
  // machine, and a fixed wait makes this proof flaky under a full test run.
  const deadline = Date.now() + 15_000;
  while (!exited && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  steps.workerExited = exited;
  steps.clientReportsGone = client.isGone();
}

main().then(
  () => { fs.writeFileSync(outFile, JSON.stringify({ ok: true, steps })); },
  (error) => { fs.writeFileSync(outFile, JSON.stringify({ ok: false, error: String(error) })); },
).finally(() => { app.exit(0); });
`;

beforeAll(async () => {
  if (!available) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-fork-"));
  const workerOut = path.join(dir, "shareWorker.cjs");
  const probeOut = path.join(dir, "probeMain.cjs");
  const shared: Parameters<typeof build>[0] = {
    bundle: true, platform: "node", format: "cjs", target: "node22",
    external: ["electron"], logLevel: "silent",
  };

  await build({ ...shared, entryPoints: [path.join(SHARING, "workerEntry.ts")], outfile: workerOut });
  await build({
    ...shared,
    stdin: { contents: PROBE, resolveDir: SHARING, sourcefile: "probeMain.ts", loader: "ts" },
    outfile: probeOut,
  });

  const userData = path.join(dir, "user-data");
  const run = spawnSync(ELECTRON, [probeOut], {
    encoding: "utf8",
    timeout: 90_000,
    windowsHide: true,
    env: {
      ...process.env,
      PROBE_WORKER: workerOut,
      PROBE_OUT: path.join(dir, "result.json"),
      PROBE_USER_DATA: userData,
      // Owned homes: this proof never reads or writes a real profile.
      CAPYGEN_CLAUDE_CONFIG_DIR: path.join(dir, "claude-home"),
      CAPYGEN_CODEX_HOME: path.join(dir, "codex-home"),
      ELECTRON_ENABLE_LOGGING: "1",
    },
  });
  stderr = run.stderr ?? "";
  const resultFile = path.join(dir, "result.json");
  if (fs.existsSync(resultFile)) {
    result = JSON.parse(fs.readFileSync(resultFile, "utf8")) as Record<string, unknown>;
  }
}, 120_000);

afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

type Steps = Record<string, Record<string, number | boolean | string[]> | undefined>
  & { afterRelease?: string; workerExited?: boolean; clientReportsGone?: boolean };
const steps = (): Steps => (result as unknown as { steps: Steps }).steps;

describe.skipIf(!available)("the share worker runs in a real utility process", () => {
  it("forks, creates a job and reports a preview", () => {
    expect(result, `electron produced no result. stderr:\n${stderr}`).not.toBeNull();
    expect(result).toMatchObject({ ok: true });
    const preview = steps().preview!;
    expect(preview).toMatchObject({ entryCount: 3, messages: 2, activities: 1 });
    // The projection really ran in the child: the planted key is redacted.
    expect(preview.redactions).toBeGreaterThan(0);
    expect(preview.jsonBytes).toBeGreaterThan(0);
    expect(preview.htmlBytes).toBeGreaterThan(Number(preview.jsonBytes));
  });

  it("serves paged entries and encoded bytes across the process boundary", () => {
    expect(steps().paging).toEqual({ first: ["message", "message"], second: ["activity"] });
    expect(steps().encoded).toMatchObject({ matchesPreview: true, leaksSecret: false });
    expect(steps().encoded!.bytes).toBe(steps().preview!.jsonBytes);
  });

  it("drops the payload on release and ends the process on dispose", () => {
    expect(steps().afterRelease).toBe("refused");
    expect(steps().workerExited).toBe(true);
    expect(steps().clientReportsGone).toBe(true);
  });
});
