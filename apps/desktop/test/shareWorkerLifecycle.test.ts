import { describe, expect, it, vi } from "vitest";
import { ShareWorkerClient, type ShareWorkerProcessLike } from "../src/sharing/workerClient.js";
import { createShareWorkerHost } from "../src/sharing/workerHost.js";
import { ShareStagingService } from "../src/sharing/staging.js";
import { SHARE_WORKER_PROTOCOL_VERSION } from "../src/sharing/workerHostTypes.js";

const log = { info: () => {}, warn: () => {} };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A child main can drive by hand: it records requests and replays events. */
class FakeChild implements ShareWorkerProcessLike {
  readonly requests: Array<Record<string, unknown>> = [];
  killed = false;
  private readonly listeners = new Map<string, Array<(value: never) => void>>();

  postMessage(message: unknown): void {
    this.requests.push(message as Record<string, unknown>);
  }
  on(event: "message" | "exit", listener: never): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  kill(): boolean {
    this.killed = true;
    // A real child exits when killed. The tests below then deliver a *second*,
    // later exit to prove a retired child's late paperwork changes nothing.
    this.emit("exit", 0);
    return true;
  }
  emit(event: "message" | "exit", value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) (listener as (v: unknown) => void)(value);
  }
  reply(index: number, body: Record<string, unknown>): void {
    const request = this.requests[index]!;
    this.emit("message", {
      v: SHARE_WORKER_PROTOCOL_VERSION, id: request.id, op: request.op, ok: true, ...body,
    });
  }
}

function clientWith(options: { timeoutMs?: number } = {}) {
  const children: FakeChild[] = [];
  const client = new ShareWorkerClient({
    timeoutMs: options.timeoutMs ?? 25,
    log,
    fork: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
  });
  return { client, children };
}

describe("a dead child cannot disturb its replacement", () => {
  it("keeps a replacement request alive when the old child's exit arrives late", async () => {
    // Astra's probe, in shape: the first child is killed by a deadline, a
    // replacement takes the next request, and only then does a further exit
    // event from the dead child land.
    const { client, children } = clientWith({ timeoutMs: 25 });
    await client.entries("job-first", 0, 1).catch(() => {});
    const pending = client.entries("job-second", 0, 1);

    children[0]!.emit("exit", 1);
    expect(children).toHaveLength(2);
    children[1]!.reply(0, { entries: [] });

    await expect(pending).resolves.toEqual([]);
    client.dispose();
  });

  it("ignores a stale child's messages after it has been replaced", async () => {
    const { client, children } = clientWith({ timeoutMs: 25 });
    await client.entries("job-first", 0, 1).catch(() => {});
    const pending = client.entries("job-second", 0, 1);
    const id = children[1]!.requests[0]!.id;

    // The old child answers with the *new* child's correlation id.
    children[0]!.emit("message", {
      v: SHARE_WORKER_PROTOCOL_VERSION, id, op: "entries", ok: true, entries: [{ poisoned: true }],
    });
    await tick();
    children[1]!.reply(0, { entries: [] });

    await expect(pending).resolves.toEqual([]);
    client.dispose();
  });

  it("kills only the child that missed its own deadline", async () => {
    vi.useFakeTimers();
    try {
      const { client, children } = clientWith({ timeoutMs: 1000 });
      const first = client.entries("job-first", 0, 1);
      first.catch(() => {});
      // The first child hangs; its deadline expires and it is killed.
      await vi.advanceTimersByTimeAsync(1001);
      await expect(first).rejects.toThrow(/too long/);
      expect(children[0]!.killed).toBe(true);

      const second = client.entries("job-second", 0, 1);
      children[1]!.reply(0, { entries: [] });
      await expect(second).resolves.toEqual([]);
      expect(children[1]!.killed).toBe(false);
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("worker replies are correlated and validated", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["a wrong protocol version", { v: 99, op: "entries", ok: true, entries: [] }],
    ["the wrong operation's payload", { v: SHARE_WORKER_PROTOCOL_VERSION, op: "bundle", ok: true, bundle: {} }],
    ["a result of the wrong shape", { v: SHARE_WORKER_PROTOCOL_VERSION, op: "entries", ok: true, entries: "nope" }],
    ["no recognisable result at all", { v: SHARE_WORKER_PROTOCOL_VERSION, op: "entries", ok: true }],
  ];

  for (const [name, body] of cases) {
    it(`refuses ${name} with a generic message`, async () => {
      const { client, children } = clientWith({ timeoutMs: 50 });
      const pending = client.entries("job-1", 0, 1);
      const id = children[0]!.requests[0]!.id;
      children[0]!.emit("message", { id, ...body });
      await expect(pending).rejects.toThrow(/share worker/i);
      client.dispose();
    });
  }

  it("ignores a reply to an id it is not waiting on", async () => {
    const { client, children } = clientWith({ timeoutMs: 200 });
    const pending = client.entries("job-1", 0, 1);
    children[0]!.emit("message", {
      v: SHARE_WORKER_PROTOCOL_VERSION, id: "999", op: "entries", ok: true, entries: [{ poisoned: true }],
    });
    await tick();
    children[0]!.reply(0, { entries: [] });
    await expect(pending).resolves.toEqual([]);
    client.dispose();
  });

  it("never forwards an arbitrary failure message from the child", async () => {
    const { client, children } = clientWith({ timeoutMs: 50 });
    const pending = client.entries("job-1", 0, 1);
    const id = children[0]!.requests[0]!.id;
    children[0]!.emit("message", {
      v: SHARE_WORKER_PROTOCOL_VERSION, id, ok: false,
      code: "totally-made-up", message: "C:\\Users\\someone\\.env sk-ant-api03-SECRETVALUE",
    });
    await expect(pending).rejects.toThrow();
    await pending.catch((error: Error) => {
      expect(error.message).not.toContain("sk-ant");
      expect(error.message).not.toContain("C:\\Users");
    });
    client.dispose();
  });
});

describe("the worker reserves a job before it builds it", () => {
  const request = (op: string, jobId: string, over: Record<string, unknown> = {}) =>
    ({ v: SHARE_WORKER_PROTOCOL_VERSION, id: `${jobId}-${op}`, op, jobId, ...over }) as never;

  const exportRequest = (jobId: string) => request("createFromExport", jobId, {
    request: {
      kind: "live", rows: [], metadata: { title: "T", mode: "solo", startedAt: null, endedAt: null, agents: [] },
      options: { bundleId: "a".repeat(32), appVersion: "0.1.0", createdAt: "2026-09-07T10:00:00Z" },
    },
  });

  it("counts jobs that are still being created against its own ceiling", async () => {
    const host = createShareWorkerHost({ maxJobs: 2 });
    // Two file reads that never finish: nothing has landed in `jobs` yet.
    const slow = [1, 2].map((n) =>
      host.handle(request("createFromFile", `slow-${n}`, {
        filePath: `\\\\?\\C:\\nonexistent\\pending-${n}.capyshare.json`, maxFileBytes: 1024,
      })));
    const third = await host.handle(exportRequest("third"));
    expect(third).toMatchObject({ ok: false });
    await Promise.all(slow);
  });

  it("refuses a duplicate job id instead of overwriting the first payload", async () => {
    const host = createShareWorkerHost();
    const first = await host.handle(exportRequest("dup"));
    expect(first).toMatchObject({ ok: true });
    const second = await host.handle(exportRequest("dup"));
    expect(second).toMatchObject({ ok: false });
    expect(host.size()).toBe(1);
  });

  it("refuses a second create for a job id that is still being created", async () => {
    const host = createShareWorkerHost();
    const slow = host.handle(request("createFromFile", "racer", {
      filePath: "\\\\?\\C:\\nonexistent\\racer.capyshare.json", maxFileBytes: 1024,
    }));
    const overlapping = await host.handle(exportRequest("racer"));
    expect(overlapping).toMatchObject({ ok: false });
    await slow;
  });

  it("frees a reservation when its work fails, so the slot is reusable", async () => {
    const host = createShareWorkerHost({ maxJobs: 1 });
    const failed = await host.handle(request("createFromFile", "gone", {
      filePath: "\\\\?\\C:\\nonexistent\\gone.capyshare.json", maxFileBytes: 1024,
    }));
    expect(failed).toMatchObject({ ok: false });
    expect(await host.handle(exportRequest("after"))).toMatchObject({ ok: true });
  });
});

describe("staging holds its budget until the payload is really gone", () => {
  function service(options: { release?: (jobId: string) => Promise<void> } = {}) {
    const released: string[] = [];
    let gone = false;
    const staging = new ShareStagingService<{ note: string }>({
      log,
      releaseJob: options.release ?? (async (jobId) => { released.push(jobId); }),
      isWorkerGone: () => gone,
      now: () => 1_000_000,
      ttlMs: 10_000,
      maxConcurrent: 1,
      provisionalBytes: 1_000,
      maxStagedBytes: 1_000,
    });
    return { staging, released, kill: () => { gone = true; } };
  }

  const stage = (staging: ShareStagingService<{ note: string }>, ownerId: number) =>
    staging.stage({ ownerId, kind: "export",
      produce: async () => ({ bytes: 500, meta: { note: "x" } }) });

  it("keeps the reservation charged until the worker acknowledges the release", async () => {
    let acknowledge: (() => void) | null = null;
    const { staging } = service({
      release: () => new Promise<void>((resolve) => { acknowledge = () => resolve(); }),
    });
    const staged = await stage(staging, 1);
    const settling = staging.cancel(staged.handle, 1);
    await tick();

    // The worker still holds the payload, so the budget is still spent and no
    // replacement may be admitted into the slot it occupies.
    expect(staging.reserved()).toBe(500);
    await expect(stage(staging, 2)).rejects.toThrow(/not enough room|too many/);

    acknowledge!();
    await settling;
    expect(staging.reserved()).toBe(0);
    await expect(stage(staging, 2)).resolves.toBeDefined();
  });

  it("joins concurrent settles onto one completion instead of returning early", async () => {
    let calls = 0;
    let acknowledge: (() => void) | null = null;
    const { staging } = service({
      release: () => {
        calls += 1;
        return new Promise<void>((resolve) => { acknowledge = () => resolve(); });
      },
    });
    const staged = await stage(staging, 1);
    const first = staging.cancel(staged.handle, 1);
    const second = staging.releaseWindow(1);
    await tick();
    expect(staging.reserved()).toBe(500);

    acknowledge!();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(staging.reserved()).toBe(0);
  });

  it("releases the budget when the worker process has exited instead", async () => {
    const { staging, kill } = service({
      release: () => Promise.reject(new Error("the child is gone")),
    });
    const staged = await stage(staging, 1);
    kill();
    await staging.cancel(staged.handle, 1);
    expect(staging.reserved()).toBe(0);
    await expect(stage(staging, 2)).resolves.toBeDefined();
  });

  it("retries a release that failed while the worker is still alive", async () => {
    let attempts = 0;
    const { staging } = service({
      release: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("send failed");
      },
    });
    const staged = await stage(staging, 1);
    await staging.cancel(staged.handle, 1);
    // Still charged: the payload was never confirmed gone.
    expect(staging.reserved()).toBe(500);
    await staging.sweepNow();
    expect(attempts).toBe(2);
    expect(staging.reserved()).toBe(0);
  });
});
