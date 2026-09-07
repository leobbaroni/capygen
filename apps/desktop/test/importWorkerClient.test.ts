import { EventEmitter } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ImportWorkerClient,
  ImportWorkerClientError,
  type UtilityProcessLike,
} from "../src/imports/utilityWorker.js";
import { IMPORT_WORKER_PROTOCOL_VERSION, type ImportWorkerRequest } from "../src/imports/workerProtocol.js";

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `capygen-worker-client-${tag}-`));
  created.push(dir);
  return dir;
}

const summary = {
  backend: "claude",
  format: "claude-jsonl/v1",
  nativeId: "session-1",
  title: "Fixture",
  cwd: "C:/recorded-only",
  startedAt: null,
  endedAt: null,
  sourceBytes: 12,
  sourceSha256: "a".repeat(64),
  counts: { records: 1, entries: 1, messages: 1, thinking: 0, activities: 0, notices: 0, droppedConfiguration: 0, unknownRecords: 0, echoedEvents: 0, truncatedTexts: 0, normalizedBytes: 10 },
  warnings: [],
  unknownTypes: [],
  complete: true,
} as const;

class FakeProcess extends EventEmitter implements UtilityProcessLike {
  stdout: PassThrough | null = new PassThrough();
  stderr: PassThrough | null = new PassThrough();
  pid: number | undefined = 123;
  request: ImportWorkerRequest | null = null;
  killed = false;
  postMessage(value: unknown): void { this.request = value as ImportWorkerRequest; }
  kill(): boolean { this.killed = true; return true; }
  finish(code = 0): void { this.pid = undefined; this.emit("exit", code); }
}

class ThrowingPostProcess extends FakeProcess {
  override postMessage(): void { throw new Error("channel closed"); }
}

function workerSnapshot(sourcePath: string): string {
  return JSON.stringify({ ...summary, sourcePath, entries: [{ kind: "message", index: 0, at: null, label: "user", truncated: false, speaker: "user", text: "hello" }] });
}

describe("ImportWorkerClient", () => {
  it("forks with an isolated environment and adopts a validated result only after exit", async () => {
    const root = tempDir("success");
    const child = new FakeProcess();
    const forks: unknown[][] = [];
    const client = new ImportWorkerClient({
      workerPath: path.join(root, "importWorker.cjs"),
      jobsDirectory: path.join(root, "jobs"),
      fork: (...args) => { forks.push(args); return child; },
      newJobId: () => "job_1",
      timeoutMs: 5_000,
    });
    await client.initialize();
    const sourcePath = path.join(root, "selected.jsonl");
    const destinationPath = path.join(root, "staged.json");
    fs.writeFileSync(sourcePath, "fixture");

    const pending = client.parseToFile(sourcePath, destinationPath);
    await vi.waitFor(() => expect(child.request).not.toBeNull());
    const request = child.request!;
    const body = workerSnapshot(sourcePath);
    fs.writeFileSync(request.resultPath, body);
    child.emit("message", { v: IMPORT_WORKER_PROTOCOL_VERSION, jobId: "job_1", ok: true, resultBytes: Buffer.byteLength(body), sdkLoaded: true, summary });
    expect(fs.existsSync(destinationPath)).toBe(false);
    child.finish(0);

    const result = await pending;
    expect(result.summary).toEqual(summary);
    expect(fs.readFileSync(destinationPath, "utf8")).toBe(body);
    expect(forks[0]?.[0]).toBe(path.join(root, "importWorker.cjs"));
    expect(forks[0]?.[2]).toMatchObject({ cwd: request.inertDir, stdio: ["ignore", "pipe", "pipe"] });
    const env = (forks[0]?.[2] as { env: Record<string, string> }).env;
    expect(env.HOME!.startsWith(request.jobRoot)).toBe(true);
    expect(env.CODEX_HOME!.startsWith(request.jobRoot)).toBe(true);
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(fs.existsSync(request.jobRoot)).toBe(false);
    expect(client.active()).toBe(0);
  });

  it("caps active workers at two until each child has exited", async () => {
    const root = tempDir("cap");
    const children = [new FakeProcess(), new FakeProcess(), new FakeProcess()];
    let index = 0;
    let jobSeq = 0;
    const client = new ImportWorkerClient({ workerPath: path.join(root, "worker.cjs"), jobsDirectory: path.join(root, "jobs"), fork: () => children[index++]!, newJobId: () => `job_${jobSeq++}` });
    await client.initialize();
    const first = client.parseToFile(path.join(root, "a"), path.join(root, "a.json"));
    const second = client.parseToFile(path.join(root, "b"), path.join(root, "b.json"));
    await vi.waitFor(() => {
      expect(client.active()).toBe(2);
      expect(children[0]!.request).not.toBeNull();
      expect(children[1]!.request).not.toBeNull();
    });
    await expect(client.parseToFile(path.join(root, "c"), path.join(root, "c.json"))).rejects.toMatchObject({ code: "too-many-workers" });
    for (const child of children.slice(0, 2)) { child.kill(); child.finish(1); }
    await Promise.allSettled([first, second]);
    expect(index).toBe(2);
  });

  it("kills cancellation and waits for exit before removing the job", async () => {
    const root = tempDir("cancel");
    const child = new FakeProcess();
    const client = new ImportWorkerClient({ workerPath: path.join(root, "worker.cjs"), jobsDirectory: path.join(root, "jobs"), fork: () => child, newJobId: () => "job_cancel" });
    await client.initialize();
    const controller = new AbortController();
    const pending = client.parseToFile(path.join(root, "source"), path.join(root, "staged.json"), { signal: controller.signal });
    await vi.waitFor(() => expect(child.request).not.toBeNull());
    const jobRoot = child.request!.jobRoot;
    controller.abort();
    await vi.waitFor(() => expect(child.killed).toBe(true));
    expect(fs.existsSync(jobRoot)).toBe(true);
    child.finish(1);
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(fs.existsSync(jobRoot)).toBe(false);
  });

  it("refuses oversized output and retains failed cleanup ownership", async () => {
    const root = tempDir("output");
    const child = new FakeProcess();
    const remove = vi.fn(async () => { throw Object.assign(new Error("private path"), { code: "EPERM" }); });
    const client = new ImportWorkerClient({ workerPath: path.join(root, "worker.cjs"), jobsDirectory: path.join(root, "jobs"), fork: () => child, newJobId: () => "job_output", maxOutputBytes: 8, fs: { remove } });
    await client.initialize();
    const pending = client.parseToFile(path.join(root, "source"), path.join(root, "staged.json"));
    await vi.waitFor(() => expect(child.request).not.toBeNull());
    child.stderr!.write("123456789");
    await vi.waitFor(() => expect(child.killed).toBe(true));
    child.finish(1);
    await expect(pending).rejects.toBeInstanceOf(ImportWorkerClientError);
    expect(client.orphaned()).toBe(1);
    expect(client.active()).toBe(0);
    expect(remove).toHaveBeenCalled();
    await expect(client.parseToFile(path.join(root, "next"), path.join(root, "next.json"))).rejects.toMatchObject({ code: "cleanup-pending" });
  });

  it("never cleans a colliding job directory it did not create", async () => {
    const root = tempDir("collision");
    const jobs = path.join(root, "jobs");
    const existing = path.join(jobs, "job-collision");
    fs.mkdirSync(existing, { recursive: true });
    fs.writeFileSync(path.join(existing, "sentinel.txt"), "owned elsewhere");
    const client = new ImportWorkerClient({
      workerPath: path.join(root, "worker.cjs"), jobsDirectory: jobs,
      fork: () => new FakeProcess(), newJobId: () => "collision",
    });
    await client.initialize();
    fs.mkdirSync(existing, { recursive: true });
    fs.writeFileSync(path.join(existing, "sentinel.txt"), "owned elsewhere");

    await expect(client.parseToFile(path.join(root, "source"), path.join(root, "stage.json"))).rejects.toBeDefined();
    expect(fs.readFileSync(path.join(existing, "sentinel.txt"), "utf8")).toBe("owned elsewhere");
    expect(client.orphaned()).toBe(0);
  });

  it("kills and awaits exit when posting the request throws", async () => {
    const root = tempDir("post-throw");
    const child = new ThrowingPostProcess();
    const client = new ImportWorkerClient({
      workerPath: path.join(root, "worker.cjs"), jobsDirectory: path.join(root, "jobs"),
      fork: () => child, newJobId: () => "post_throw",
    });
    await client.initialize();
    let settled = false;
    const pending = client.parseToFile(path.join(root, "source"), path.join(root, "stage.json"));
    pending.finally(() => { settled = true; }).catch(() => undefined);
    await vi.waitFor(() => expect(child.killed).toBe(true));
    expect(settled).toBe(false);
    expect(fs.existsSync(path.join(root, "jobs", "job-post_throw"))).toBe(true);
    child.finish(1);
    await expect(pending).rejects.toMatchObject({ code: "worker-failed" });
    expect(fs.existsSync(path.join(root, "jobs", "job-post_throw"))).toBe(false);
  });

  it("startup removes only abandoned owned job directories and never follows symlinks", async () => {
    const root = tempDir("startup");
    const jobs = path.join(root, "jobs");
    const abandoned = path.join(jobs, "job-abandoned");
    const unrelated = path.join(jobs, "project-cache");
    const target = path.join(root, "outside-target");
    fs.mkdirSync(abandoned, { recursive: true });
    fs.mkdirSync(unrelated, { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "sentinel"), "keep");
    const link = path.join(jobs, "job-linked");
    try { fs.symlinkSync(target, link, "junction"); } catch { /* unavailable on this host */ }
    const client = new ImportWorkerClient({ workerPath: path.join(root, "worker.cjs"), jobsDirectory: jobs, fork: () => new FakeProcess() });

    expect(await client.initialize()).toBe(1);
    expect(fs.existsSync(abandoned)).toBe(false);
    expect(fs.existsSync(unrelated)).toBe(true);
    expect(fs.readFileSync(path.join(target, "sentinel"), "utf8")).toBe("keep");
    if (fs.existsSync(link)) expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("dispose cancels active workers and waits for exit before cleanup", async () => {
    const root = tempDir("dispose");
    const child = new FakeProcess();
    const client = new ImportWorkerClient({ workerPath: path.join(root, "worker.cjs"), jobsDirectory: path.join(root, "jobs"), fork: () => child, newJobId: () => "dispose" });
    await client.initialize();
    const pending = client.parseToFile(path.join(root, "source"), path.join(root, "stage.json"));
    await vi.waitFor(() => expect(child.request).not.toBeNull());
    let disposed = false;
    const disposal = client.dispose().then(() => { disposed = true; });
    await vi.waitFor(() => expect(child.killed).toBe(true));
    expect(disposed).toBe(false);
    child.finish(1);
    await disposal;
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(client.active()).toBe(0);
  });

  it("kills a timed-out worker and keeps its job until exit", async () => {
    const root = tempDir("timeout");
    const child = new FakeProcess();
    const client = new ImportWorkerClient({ workerPath: path.join(root, "worker.cjs"), jobsDirectory: path.join(root, "jobs"), fork: () => child, newJobId: () => "timeout", timeoutMs: 10 });
    await client.initialize();
    const pending = client.parseToFile(path.join(root, "source"), path.join(root, "stage.json"));
    await vi.waitFor(() => expect(child.killed).toBe(true));
    expect(fs.existsSync(path.join(root, "jobs", "job-timeout"))).toBe(true);
    child.finish(1);
    await expect(pending).rejects.toMatchObject({ code: "timed-out" });
    expect(fs.existsSync(path.join(root, "jobs", "job-timeout"))).toBe(false);
  });

  it("refuses forged entry counts before adopting the result", async () => {
    const root = tempDir("forged-counts");
    const child = new FakeProcess();
    const client = new ImportWorkerClient({ workerPath: path.join(root, "worker.cjs"), jobsDirectory: path.join(root, "jobs"), fork: () => child, newJobId: () => "forged" });
    await client.initialize();
    const sourcePath = path.join(root, "source");
    const destination = path.join(root, "stage.json");
    const pending = client.parseToFile(sourcePath, destination);
    await vi.waitFor(() => expect(child.request).not.toBeNull());
    const forged = { ...summary, counts: { ...summary.counts, messages: 0 } };
    const body = JSON.stringify({ ...forged, sourcePath, entries: [{ kind: "message", index: 0, at: null, label: "user", truncated: false, speaker: "user", text: "hello" }] });
    fs.writeFileSync(child.request!.resultPath, body);
    child.emit("message", { v: IMPORT_WORKER_PROTOCOL_VERSION, jobId: "forged", ok: true, resultBytes: Buffer.byteLength(body), sdkLoaded: false, summary: forged });
    child.finish(0);

    await expect(pending).rejects.toMatchObject({ code: "invalid-result" });
    expect(fs.existsSync(destination)).toBe(false);
  });

  it("refuses a trailing comma in the worker result", async () => {
    const root = tempDir("trailing-comma");
    const child = new FakeProcess();
    const client = new ImportWorkerClient({ workerPath: path.join(root, "worker.cjs"), jobsDirectory: path.join(root, "jobs"), fork: () => child, newJobId: () => "comma" });
    await client.initialize();
    const sourcePath = path.join(root, "source");
    const destination = path.join(root, "stage.json");
    const pending = client.parseToFile(sourcePath, destination);
    await vi.waitFor(() => expect(child.request).not.toBeNull());
    const entry = JSON.stringify({ kind: "message", index: 0, at: null, label: "user", truncated: false, speaker: "user", text: "hello" });
    const body = `${JSON.stringify({ ...summary, sourcePath }).slice(0, -1)},"entries":[${entry},]}`;
    fs.writeFileSync(child.request!.resultPath, body);
    child.emit("message", { v: IMPORT_WORKER_PROTOCOL_VERSION, jobId: "comma", ok: true, resultBytes: Buffer.byteLength(body), sdkLoaded: false, summary });
    child.finish(0);
    await expect(pending).rejects.toMatchObject({ code: "invalid-result" });
    expect(fs.existsSync(destination)).toBe(false);
  });

  it("accepts a 64 KiB text field at its worst JSON escaping size", async () => {
    const root = tempDir("escaped-entry");
    const child = new FakeProcess();
    const client = new ImportWorkerClient({ workerPath: path.join(root, "worker.cjs"), jobsDirectory: path.join(root, "jobs"), fork: () => child, newJobId: () => "escaped" });
    await client.initialize();
    const sourcePath = path.join(root, "source");
    const destination = path.join(root, "stage.json");
    const pending = client.parseToFile(sourcePath, destination);
    await vi.waitFor(() => expect(child.request).not.toBeNull());
    const body = JSON.stringify({ ...summary, sourcePath, entries: [{ kind: "message", index: 0, at: null, label: "user", truncated: false, speaker: "user", text: "\u0000".repeat(65_536) }] });
    expect(Buffer.byteLength(body)).toBeGreaterThan(256 * 1024);
    fs.writeFileSync(child.request!.resultPath, body);
    child.emit("message", { v: IMPORT_WORKER_PROTOCOL_VERSION, jobId: "escaped", ok: true, resultBytes: Buffer.byteLength(body), sdkLoaded: false, summary });
    child.finish(0);
    await expect(pending).resolves.toMatchObject({ resultBytes: Buffer.byteLength(body) });
    expect(fs.existsSync(destination)).toBe(true);
  });

  it("cancellation during streamed validation prevents adoption", async () => {
    const root = tempDir("validation-cancel");
    const child = new FakeProcess();
    const controller = new AbortController();
    const client = new ImportWorkerClient({
      workerPath: path.join(root, "worker.cjs"), jobsDirectory: path.join(root, "jobs"),
      fork: () => child, newJobId: () => "validation_cancel",
      fs: { open: async (file, flags) => {
        const handle = await fsp.open(file, flags);
        return {
          read: async (...args: Parameters<typeof handle.read>) => {
            controller.abort();
            return handle.read(...args);
          },
          close: () => handle.close(),
        };
      } },
    });
    await client.initialize();
    const sourcePath = path.join(root, "source");
    const destination = path.join(root, "stage.json");
    const pending = client.parseToFile(sourcePath, destination, { signal: controller.signal });
    await vi.waitFor(() => expect(child.request).not.toBeNull());
    const body = workerSnapshot(sourcePath);
    fs.writeFileSync(child.request!.resultPath, body);
    child.emit("message", { v: IMPORT_WORKER_PROTOCOL_VERSION, jobId: "validation_cancel", ok: true, resultBytes: Buffer.byteLength(body), sdkLoaded: false, summary });
    child.finish(0);
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(fs.existsSync(destination)).toBe(false);
  });

  it("cancellation while the hard link is pending removes the unadopted file", async () => {
    const root = tempDir("adoption-cancel");
    const child = new FakeProcess();
    const controller = new AbortController();
    let release!: () => void;
    let entered!: () => void;
    const linkEntered = new Promise<void>((resolve) => { entered = resolve; });
    const linkRelease = new Promise<void>((resolve) => { release = resolve; });
    const client = new ImportWorkerClient({
      workerPath: path.join(root, "worker.cjs"), jobsDirectory: path.join(root, "jobs"),
      fork: () => child, newJobId: () => "adoption_cancel",
      fs: { link: async (existing, destination) => {
        entered();
        await linkRelease;
        await fsp.link(existing, destination);
      } },
    });
    await client.initialize();
    const sourcePath = path.join(root, "source");
    const destination = path.join(root, "stage.json");
    const pending = client.parseToFile(sourcePath, destination, { signal: controller.signal });
    await vi.waitFor(() => expect(child.request).not.toBeNull());
    const body = workerSnapshot(sourcePath);
    fs.writeFileSync(child.request!.resultPath, body);
    child.emit("message", { v: IMPORT_WORKER_PROTOCOL_VERSION, jobId: "adoption_cancel", ok: true, resultBytes: Buffer.byteLength(body), sdkLoaded: false, summary });
    child.finish(0);
    await linkEntered;
    controller.abort();
    release();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(fs.existsSync(destination)).toBe(false);
  });
});
