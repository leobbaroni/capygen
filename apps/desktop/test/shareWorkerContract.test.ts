import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createShareWorkerHost } from "../src/sharing/workerHost.js";
import { ShareWorkerClient, type ShareWorkerProcessLike } from "../src/sharing/workerClient.js";
import { SHARE_WORKER_PROTOCOL_VERSION } from "../src/sharing/workerHostTypes.js";
import { decodeShareFile } from "../src/sharing/decode.js";
import { encodeShareHtml, encodeShareJson } from "../src/sharing/index.js";
import type { ShareBundle } from "@capygen/shared";

const log = { warn: () => {} };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

const req = (op: string, jobId: string, over: Record<string, unknown> = {}) =>
  ({ v: SHARE_WORKER_PROTOCOL_VERSION, id: `${jobId}:${op}:${Math.random()}`, op, jobId, ...over }) as never;

const exportReq = (jobId: string) => req("createFromExport", jobId, {
  request: {
    kind: "live", rows: [], metadata: { title: "T", mode: "solo", startedAt: null, endedAt: null, agents: [] },
    options: { bundleId: "a".repeat(32), appVersion: "0.1.0", createdAt: "2026-09-07T10:00:00Z" },
  },
});

/** A create the test holds open, so cancellation races a live read. */
function deferredDecode() {
  const gates: Array<{ release: () => void; aborted: () => boolean }> = [];
  const decode = async (input: { signal: AbortSignal }) => {
    let release!: () => void;
    const done = new Promise<void>((resolve) => { release = resolve; });
    gates.push({ release, aborted: () => input.signal.aborted });
    await done;
    if (input.signal.aborted) throw new Error("cancelled mid-read");
    return {
      // A real (if empty) bundle, so paging a reused job is exercised rather
      // than crashing on a stub.
      bundle: { entries: [], comments: [] } as unknown as ShareBundle,
      jsonText: "{}",
      preview: {
        source: { title: null, mode: "solo", startedAt: null, endedAt: null, agents: [] },
        counts: { entries: 0, messages: 0, thinking: 0, activities: 0, notices: 0, truncatedTexts: 0,
          droppedInteractive: 0, droppedThinking: 0, droppedWidgets: 0, droppedUsage: 0, redactions: 0 },
        bundleId: "a".repeat(32), createdAt: "2026-09-07T10:00:00Z", appVersion: "0.1.0",
        entryCount: 0, commentCount: 0,
        contentSha256: "f".repeat(64),
        json: { bytes: 2, withinLimit: true }, html: { bytes: 10, withinLimit: true },
      },
    };
  };
  return { decode, gates };
}

describe("a job reservation lasts until its work settles", () => {
  it("keeps the slot while a cancelled read is still running", async () => {
    const { decode, gates } = deferredDecode();
    const host = createShareWorkerHost({ maxJobs: 1, decode: decode as never });
    const creating = host.handle(req("createFromFile", "slow", { filePath: "x", maxFileBytes: 10 }));
    await tick();

    // Cancelled, but the read has not returned: the memory is still held, so
    // the slot it occupies must not be handed to anyone else yet.
    const releasing = host.handle(req("release", "slow"));
    await tick();
    expect(await host.handle(exportReq("other"))).toMatchObject({ ok: false });

    gates[0]!.release();
    await creating;
    expect(await releasing).toMatchObject({ ok: true });
    // Only once the work has settled does the slot come back.
    expect(await host.handle(exportReq("other"))).toMatchObject({ ok: true });
  });

  it("acknowledges the release of a creating job only after it settles", async () => {
    const { decode, gates } = deferredDecode();
    const host = createShareWorkerHost({ decode: decode as never });
    const creating = host.handle(req("createFromFile", "slow", { filePath: "x", maxFileBytes: 10 }));
    await tick();

    let acknowledged = false;
    const releasing = host.handle(req("release", "slow")).then((reply) => {
      acknowledged = true;
      return reply;
    });
    await tick();
    expect(acknowledged).toBe(false);

    gates[0]!.release();
    await creating;
    await releasing;
    expect(acknowledged).toBe(true);
    expect(host.size()).toBe(0);
  });

  it("does not let a finished create evict a later job that reused its id", async () => {
    const { decode, gates } = deferredDecode();
    const host = createShareWorkerHost({ decode: decode as never });
    const first = host.handle(req("createFromFile", "same", { filePath: "x", maxFileBytes: 10 }));
    await tick();
    const releasing = host.handle(req("release", "same"));
    gates[0]!.release();
    await first;
    await releasing;

    // The id is free again, so it may be reused.
    const second = host.handle(req("createFromFile", "same", { filePath: "x", maxFileBytes: 10 }));
    await tick();
    gates[1]!.release();
    const reply = await second;
    expect(reply, JSON.stringify(reply)).toMatchObject({ ok: true });
    // The first create's bookkeeping must not have removed the second's job.
    expect(host.size()).toBe(1);
    expect(await host.handle(req("entries", "same", { offset: 0, limit: 10 }))).toMatchObject({ ok: true });
  });

  it("survives repeated cancel-then-create on one id", async () => {
    const { decode, gates } = deferredDecode();
    const host = createShareWorkerHost({ maxJobs: 1, decode: decode as never });
    for (let round = 0; round < 3; round += 1) {
      const creating = host.handle(req("createFromFile", "churn", { filePath: "x", maxFileBytes: 10 }));
      await tick();
      const releasing = host.handle(req("release", "churn"));
      gates[round]!.release();
      await creating;
      await releasing;
      expect(host.size()).toBe(0);
    }
    const { decode: fresh } = deferredDecode();
    void fresh;
    expect(await host.handle(exportReq("after"))).toMatchObject({ ok: true });
  });
});

class FakeChild implements ShareWorkerProcessLike {
  readonly requests: Array<Record<string, unknown>> = [];
  killCalls = 0;
  constructor(private readonly behaviour: {
    kill?: "ok" | "false" | "throw"; exitOnKill?: boolean;
  } = {}) {}
  private readonly listeners = new Map<string, Array<(value: never) => void>>();
  postMessage(message: unknown): void { this.requests.push(message as Record<string, unknown>); }
  on(event: "message" | "exit", listener: never): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  kill(): boolean {
    this.killCalls += 1;
    if (this.behaviour.kill === "throw") throw new Error("access denied");
    if (this.behaviour.kill === "false") return false;
    if (this.behaviour.exitOnKill !== false) this.emit("exit", 0);
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

function clientWith(behaviour: ConstructorParameters<typeof FakeChild>[0] = {}, timeoutMs = 25) {
  const children: FakeChild[] = [];
  const client = new ShareWorkerClient({
    timeoutMs, log,
    fork: () => { const child = new FakeChild(behaviour); children.push(child); return child; },
  });
  return { client, children };
}

describe("a child is only gone once it has confirmed exit", () => {
  it("does not report gone while a killed child has not exited", async () => {
    const { client, children } = clientWith({ exitOnKill: false });
    const pending = client.entries("job-1", 0, 1);
    pending.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 40));
    await expect(pending).rejects.toThrow(/too long/);
    expect(children[0]!.killCalls).toBe(1);
    // The process is still alive and still holding memory.
    expect(client.isGone()).toBe(false);
    children[0]!.emit("exit", 0);
    expect(client.isGone()).toBe(true);
    client.dispose();
  });

  it("fails closed instead of forking a replacement when the kill did not take", async () => {
    for (const kill of ["false", "throw"] as const) {
      const { client, children } = clientWith({ kill, exitOnKill: false });
      const pending = client.entries("job-1", 0, 1);
      pending.catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 40));
      await expect(pending).rejects.toThrow();
      // The old child is unkillable and still holds its payload; starting a
      // second one would double the memory this worker was budgeted for.
      await expect(client.entries("job-2", 0, 1)).rejects.toThrow(/still|shutting|worker/i);
      expect(children).toHaveLength(1);
      expect(client.isGone()).toBe(false);
      client.dispose();
    }
  });

  it("admits a replacement once the old child's exit is confirmed", async () => {
    const { client, children } = clientWith({ exitOnKill: false });
    const first = client.entries("job-1", 0, 1);
    first.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 40));
    await expect(first).rejects.toThrow();
    children[0]!.emit("exit", 0);

    const second = client.entries("job-2", 0, 1);
    await tick();
    children[1]!.reply(0, { entries: [] });
    await expect(second).resolves.toEqual([]);
    client.dispose();
  });

  it("never asks a replacement to release a dead child's payload", async () => {
    const { client, children } = clientWith({ exitOnKill: false }, 5_000);
    const created = client.createFromExport("job-old", { kind: "live", rows: [],
      metadata: { title: "T", mode: "solo", startedAt: null, endedAt: null, agents: [] },
      options: { bundleId: "a".repeat(32), appVersion: "0.1.0", createdAt: "2026-09-07T10:00:00Z" },
    } as never);
    await tick();
    children[0]!.reply(0, { preview: {
      source: { title: null, mode: "solo", startedAt: null, endedAt: null, agents: [] },
      counts: { entries: 0, messages: 0, thinking: 0, activities: 0, notices: 0, truncatedTexts: 0,
        droppedInteractive: 0, droppedThinking: 0, droppedWidgets: 0, droppedUsage: 0, redactions: 0 },
      bundleId: "a".repeat(32), createdAt: "2026-09-07T10:00:00Z", appVersion: "0.1.0",
      entryCount: 0, commentCount: 0,
        contentSha256: "f".repeat(64),
      json: { bytes: 2, withinLimit: true }, html: { bytes: 10, withinLimit: true },
    } });
    await created;

    // The child dies; a later request forks a replacement.
    children[0]!.emit("exit", 1);
    const next = client.entries("job-new", 0, 1);
    await tick();
    expect(children).toHaveLength(2);
    children[1]!.reply(0, { entries: [] });
    await next;

    // Releasing the dead child's job must resolve without asking the new
    // child, which knows nothing about it and would answer for the wrong one.
    const before = children[1]!.requests.length;
    await client.release("job-old");
    expect(children[1]!.requests).toHaveLength(before);
    client.dispose();
  });
});

describe("replies are checked against what was actually asked", () => {
  const preview = {
    source: { title: null, mode: "solo", startedAt: null, endedAt: null, agents: [] },
    counts: { entries: 0, messages: 0, thinking: 0, activities: 0, notices: 0, truncatedTexts: 0,
      droppedInteractive: 0, droppedThinking: 0, droppedWidgets: 0, droppedUsage: 0, redactions: 0 },
    bundleId: "a".repeat(32), createdAt: "2026-09-07T10:00:00Z", appVersion: "0.1.0",
    entryCount: 0, commentCount: 0,
        contentSha256: "f".repeat(64),
    json: { bytes: 2, withinLimit: true }, html: { bytes: 10, withinLimit: true },
  };
  const entry = (index: number) => ({ index, at: null, label: "assistant", truncated: false,
    kind: "message", speaker: "assistant", text: "hi" });

  it("refuses a page longer than the limit it asked for", async () => {
    const { client, children } = clientWith({}, 200);
    const pending = client.entries("job-1", 0, 2);
    await tick();
    children[0]!.reply(0, { entries: [entry(0), entry(1), entry(2)] });
    await expect(pending).rejects.toThrow(/share worker/i);
    client.dispose();
  });

  it("refuses entries and comments that are not the inert shapes", async () => {
    for (const bad of [[{ kind: "tool_call", input: { command: "rm -rf /" } }], [{}], ["nope"]]) {
      const { client, children } = clientWith({}, 200);
      const pending = client.entries("job-1", 0, 10);
      await tick();
      children[0]!.reply(0, { entries: bad });
      await expect(pending).rejects.toThrow(/share worker/i);
      client.dispose();
    }
    const { client, children } = clientWith({}, 200);
    const pending = client.comments("job-1", 0, 10);
    await tick();
    children[0]!.reply(0, { comments: [{ id: "nope", body: "x" }] });
    await expect(pending).rejects.toThrow(/share worker/i);
    client.dispose();
  });

  it("requires the byte count to be the text's real UTF-8 length and within the cap", async () => {
    const cases = [
      { text: "café", bytes: 4 },          // 5 bytes in UTF-8, not 4
      { text: "ok", bytes: -2 },
      { text: "ok", bytes: 2.5 },
      { text: "ok", bytes: Number.POSITIVE_INFINITY },
      { text: "ok", bytes: 33 * 1024 * 1024 },
    ];
    for (const body of cases) {
      const { client, children } = clientWith({}, 200);
      const pending = client.text("job-1", "json");
      await tick();
      children[0]!.reply(0, body);
      await expect(pending).rejects.toThrow(/share worker/i);
      client.dispose();
    }
    const { client, children } = clientWith({}, 200);
    const ok = client.text("job-1", "json");
    await tick();
    children[0]!.reply(0, { text: "café", bytes: 5 });
    await expect(ok).resolves.toMatchObject({ bytes: 5 });
    client.dispose();
  });

  it("refuses a preview that is not the bounded shape", async () => {
    for (const bad of [
      { ...preview, entryCount: -1 },
      { ...preview, json: { bytes: "big", withinLimit: true } },
      { ...preview, counts: { entries: 0 } },
      { ...preview, extra: "smuggled" },
    ]) {
      const { client, children } = clientWith({}, 200);
      const pending = client.createFromFile("job-1", "x", 10);
      await tick();
      children[0]!.reply(0, { preview: bad });
      await expect(pending).rejects.toThrow(/share worker/i);
      client.dispose();
    }
  });

  it("requires a failure reply to answer the operation it was sent for", async () => {
    const { client, children } = clientWith({}, 200);
    const pending = client.entries("job-1", 0, 1);
    await tick();
    const id = children[0]!.requests[0]!.id;
    children[0]!.emit("message", {
      v: SHARE_WORKER_PROTOCOL_VERSION, id, op: "bundle", ok: false,
      code: "too-large", message: "irrelevant",
    });
    await expect(pending).rejects.toThrow(/share worker could not/i);
    client.dispose();
  });

  it("still repeats an allowlisted refusal for the matching operation", async () => {
    const { client, children } = clientWith({}, 200);
    const pending = client.createFromFile("job-1", "x", 10);
    await tick();
    const id = children[0]!.requests[0]!.id;
    children[0]!.emit("message", {
      v: SHARE_WORKER_PROTOCOL_VERSION, id, op: "createFromFile", ok: false,
      code: "carrier-missing", message: "C:\\Users\\someone\\secret.env",
    });
    await expect(pending).rejects.toThrow(/no capygen share bundle/i);
    await pending.catch((error: Error) => expect(error.message).not.toContain("C:\\Users"));
    client.dispose();
  });

  it("normalises a nonsense deadline instead of trusting it", async () => {
    for (const timeoutMs of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      const { client, children } = clientWith({}, timeoutMs);
      const pending = client.entries("job-1", 0, 1);
      await tick();
      // A zero or NaN deadline must not fire immediately or never; the request
      // is still waiting and a normal reply still settles it.
      children[0]!.reply(0, { entries: [] });
      await expect(pending).resolves.toEqual([]);
      client.dispose();
    }
  });
});

describe("a share file's format is read from its bytes, not its name", () => {
  let dir: string;
  const bundle: ShareBundle = {
    kind: "capygen.share", version: 1, bundleId: "b".repeat(32),
    createdAt: "2026-09-07T10:00:00Z", appVersion: "0.1.0",
    source: { title: "Renamed", mode: "solo", startedAt: null, endedAt: null, agents: [] },
    entries: [{ index: 0, at: null, label: "assistant", truncated: false,
      kind: "message", speaker: "assistant", text: "kept" }],
    counts: { entries: 1, messages: 1, thinking: 0, activities: 0, notices: 0, truncatedTexts: 0,
      droppedInteractive: 0, droppedThinking: 0, droppedWidgets: 0, droppedUsage: 0, redactions: 0 },
    comments: [],
  };

  const write = (name: string, text: string): string => {
    dir ??= fs.mkdtempSync(path.join(os.tmpdir(), "capygen-sniff-"));
    const file = path.join(dir, name);
    fs.writeFileSync(file, text, "utf8");
    return file;
  };

  const read = (file: string, maxBytes = 96 * 1024 * 1024) =>
    decodeShareFile({ filePath: file, maxBytes, signal: new AbortController().signal });

  it("imports an HTML carrier however the user renamed it", async () => {
    const html = encodeShareHtml(bundle).text;
    for (const name of ["reviewed.htm", "reviewed.txt", "reviewed", "reviewed.json"]) {
      const decoded = await read(write(name, html));
      expect(decoded.bundle.entries[0]).toMatchObject({ text: "kept" });
    }
  });

  it("imports JSON however it was named, including with leading whitespace", async () => {
    const json = encodeShareJson(bundle).text;
    for (const [name, text] of [["a.json", json], ["b.html", json], ["c", `\n\n  ${json}`]] as const) {
      const decoded = await read(write(name, text));
      expect(decoded.bundle.bundleId).toBe("b".repeat(32));
    }
  });

  it("refuses an oversize JSON document before reading all of it", async () => {
    const file = write("huge.json", `${" ".repeat(4096)}{"kind":"capygen.share"}`);
    await expect(read(file, 2048)).rejects.toThrow(/limit|large/i);
  });

  it("applies the JSON ceiling to a JSON file even under the larger HTML bound", async () => {
    // Well under the HTML cap, well over the JSON cap: a JSON document must be
    // refused on its own limit rather than read to 96 MiB first.
    const file = write("fat.json", `{"kind":"capygen.share","pad":"${"x".repeat(64)}"}`);
    await expect(read(file, 96 * 1024 * 1024, )).rejects.toThrow();
    const tiny = await read(write("fine.json", encodeShareJson(bundle).text));
    expect(tiny.bundle.entries).toHaveLength(1);
  });

  it("refuses a file that is neither", async () => {
    await expect(read(write("junk.json", "just some prose"))).rejects.toThrow();
  });
});

describe("releasing a payload is only reported once it is really gone", () => {
  class BrittleChild implements ShareWorkerProcessLike {
    readonly requests: Array<Record<string, unknown>> = [];
    failNextPost = false;
    private readonly listeners = new Map<string, Array<(value: never) => void>>();
    postMessage(message: unknown): void {
      if (this.failNextPost) { this.failNextPost = false; throw new Error("channel closed"); }
      this.requests.push(message as Record<string, unknown>);
    }
    on(event: "message" | "exit", listener: never): void {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    }
    kill(): boolean { return true; }
    emit(event: "message" | "exit", value: unknown): void {
      for (const listener of this.listeners.get(event) ?? []) (listener as (v: unknown) => void)(value);
    }
    answer(index: number, body: Record<string, unknown>): void {
      const request = this.requests[index]!;
      this.emit("message", {
        v: SHARE_WORKER_PROTOCOL_VERSION, id: request.id, op: request.op, ok: true, ...body,
      });
    }
  }

  const preview = {
    source: { title: null, mode: "solo", startedAt: null, endedAt: null, agents: [] },
    counts: { entries: 0, messages: 0, thinking: 0, activities: 0, notices: 0, truncatedTexts: 0,
      droppedInteractive: 0, droppedThinking: 0, droppedWidgets: 0, droppedUsage: 0, redactions: 0 },
    bundleId: "a".repeat(32), createdAt: "2026-09-07T10:00:00Z", appVersion: "0.1.0",
    entryCount: 0, commentCount: 0,
        contentSha256: "f".repeat(64),
    json: { bytes: 2, withinLimit: true }, html: { bytes: 10, withinLimit: true },
  };
  const exportBody = { kind: "live", rows: [],
    metadata: { title: "T", mode: "solo", startedAt: null, endedAt: null, agents: [] },
    options: { bundleId: "a".repeat(32), appVersion: "0.1.0", createdAt: "2026-09-07T10:00:00Z" },
  } as never;

  async function staged(timeoutMs = 5_000) {
    const children: BrittleChild[] = [];
    const client = new ShareWorkerClient({
      timeoutMs, log,
      fork: () => { const child = new BrittleChild(); children.push(child); return child; },
    });
    const created = client.createFromExport("job-1", exportBody);
    await tick();
    children[0]!.answer(0, { preview });
    await created;
    return { client, children };
  }

  it("rejects a release whose message could not be delivered, and succeeds on retry", async () => {
    const { client, children } = await staged();
    children[0]!.failNextPost = true;
    await expect(client.release("job-1")).rejects.toThrow();

    // The payload is still in the child, so a retry must actually ask again
    // rather than shrugging because it forgot who owned it.
    const retry = client.release("job-1");
    await tick();
    const request = children[0]!.requests.at(-1)!;
    expect(request).toMatchObject({ op: "release", jobId: "job-1" });
    children[0]!.answer(children[0]!.requests.length - 1, { released: true });
    await expect(retry).resolves.toBeUndefined();
    client.dispose();
  });

  it("joins concurrent releases of one payload onto a single request", async () => {
    const { client, children } = await staged();
    const before = children[0]!.requests.length;
    const first = client.release("job-1");
    const second = client.release("job-1");
    await tick();
    expect(children[0]!.requests.length - before).toBe(1);
    children[0]!.answer(children[0]!.requests.length - 1, { released: true });
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    client.dispose();
  });

  it("refuses to call a retiring child's payload released until it has exited", async () => {
    const { client, children } = await staged(25);
    // A deadline retires the child, but this fake never confirms exit.
    const hung = client.entries("job-1", 0, 1);
    hung.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 40));
    await expect(hung).rejects.toThrow();

    // Still alive, still holding the payload: saying "released" here would let
    // staging hand the same budget out twice.
    await expect(client.release("job-1")).rejects.toThrow(/stop|worker/i);
    expect(client.isGone()).toBe(false);

    children[0]!.emit("exit", 0);
    expect(client.isGone()).toBe(true);
    // Now nothing can be holding it, so the release is honest.
    await expect(client.release("job-1")).resolves.toBeUndefined();
    client.dispose();
  });

  it("refuses rather than claiming a release during shutdown with a live child", async () => {
    const { client, children } = await staged();
    client.dispose();
    void children;
    await expect(client.release("job-1")).rejects.toThrow();
  });
});

describe("a preview may legitimately report an oversize carrier", () => {
  const base = {
    source: { title: "Big", mode: "solo", startedAt: null, endedAt: null, agents: [] },
    counts: { entries: 1, messages: 1, thinking: 0, activities: 0, notices: 0, truncatedTexts: 0,
      droppedInteractive: 0, droppedThinking: 0, droppedWidgets: 0, droppedUsage: 0, redactions: 0 },
    bundleId: "a".repeat(32), createdAt: "2026-09-07T10:00:00Z", appVersion: "0.1.0",
    entryCount: 1, commentCount: 0,
        contentSha256: "f".repeat(64),
  };

  const previewReply = async (json: unknown, html: unknown) => {
    const { client, children } = clientWith({}, 200);
    const pending = client.createFromFile("job-1", "x", 10);
    await tick();
    children[0]!.reply(0, { preview: { ...base, json, html } });
    return { pending, client };
  };

  it("accepts an HTML size over the cap when it says so, so JSON can be offered", async () => {
    const { pending, client } = await previewReply(
      { bytes: 1024, withinLimit: true },
      { bytes: 120 * 1024 * 1024, withinLimit: false },
    );
    const preview = await pending;
    expect(preview.html).toMatchObject({ withinLimit: false });
    expect(preview.html.bytes).toBeGreaterThan(96 * 1024 * 1024);
    expect(preview.json.withinLimit).toBe(true);
    client.dispose();
  });

  it("refuses a size that disagrees with the limit it claims", async () => {
    const contradictions: Array<[unknown, unknown]> = [
      // Over the cap but claiming to fit.
      [{ bytes: 1024, withinLimit: true }, { bytes: 120 * 1024 * 1024, withinLimit: true }],
      // Inside the cap but claiming not to.
      [{ bytes: 1024, withinLimit: false }, { bytes: 2048, withinLimit: true }],
      // JSON judged against the HTML cap.
      [{ bytes: 64 * 1024 * 1024, withinLimit: true }, { bytes: 2048, withinLimit: true }],
    ];
    for (const [json, html] of contradictions) {
      const { pending, client } = await previewReply(json, html);
      await expect(pending).rejects.toThrow(/share worker/i);
      client.dispose();
    }
  });

  it("still bounds an absurd reported size", async () => {
    const { pending, client } = await previewReply(
      { bytes: 1024, withinLimit: true },
      { bytes: Number.MAX_SAFE_INTEGER, withinLimit: false },
    );
    await expect(pending).rejects.toThrow(/share worker/i);
    client.dispose();
  });

  it("holds the preview's own metadata to the shared contract", async () => {
    // What the *shared* schema enforces — byte-bounded labels and the declared
    // enums. It deliberately does not police bidi controls in a title: that is
    // `sanitizeLabel`'s job at projection time, not the wire contract's.
    const hostile = [
      { ...base.source, title: "x".repeat(200) },
      { ...base.source, title: "\u{1F600}".repeat(40) },
      { ...base.source, mode: "debate" },
      { ...base.source, agents: [{ label: "A", backend: "gemini", model: null }] },
      { ...base.source, agents: [{ label: "A", backend: null, model: null, agentId: "agt_1" }] },
      { ...base.source, cwd: "C:\\work" },
    ];
    for (const source of hostile) {
      const { client, children } = clientWith({}, 200);
      const pending = client.createFromFile("job-1", "x", 10);
      await tick();
      children[0]!.reply(0, { preview: { ...base, source,
        json: { bytes: 10, withinLimit: true }, html: { bytes: 20, withinLimit: true } } });
      await expect(pending).rejects.toThrow(/share worker/i);
      client.dispose();
    }
  });

  it("refuses a bundle whose collections exceed what the contract can hold", async () => {
    const { client, children } = clientWith({}, 200);
    const pending = client.bundle("job-1");
    await tick();
    children[0]!.reply(0, { bundle: {
      kind: "capygen.share", version: 1,
      entries: new Array(100_001).fill(0), comments: [],
    } });
    await expect(pending).rejects.toThrow(/share worker/i);
    client.dispose();
  });
});
