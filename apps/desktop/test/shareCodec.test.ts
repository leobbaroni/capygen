import { describe, expect, it } from "vitest";
import { ShareBundleSchema, type Block, type TurnRole } from "@capygen/shared";
import {
  SHARE_HTML_MAX_BYTES,
  SHARE_JSON_MAX_BYTES,
  ShareCodecError,
  decodeShareHtml,
  decodeShareJson,
  encodeShareHtml,
  clipUtf8,
  encodeShareJson,
  preflightShare,
  projectShareBundle,
  senderClaimedOmissions,
  shareFileName,
  type ShareProjectionInput,
} from "../src/sharing/index.js";

const base = (index: number, kind: string, over: Record<string, unknown> = {}) => ({
  id: `blk_${index}`, turnId: "trn_1", sessionId: "ses_1", index,
  createdAt: 1_757_000_000_000 + index, updatedAt: 1_757_000_000_000 + index,
  kind, ...over,
}) as unknown as Block;

const OPTIONS = { bundleId: "a".repeat(32), appVersion: "0.1.0", createdAt: "2026-09-07T10:00:00Z" };

function input(over: Partial<ShareProjectionInput> = {}): ShareProjectionInput {
  return {
    blocks: [{ block: base(0, "text", { text: "Hello there" }), turnRole: "user" as TurnRole }],
    metadata: { title: "Session title", mode: "solo", startedAt: null, endedAt: null,
      agents: [{ label: "Assistant", backend: "claude", model: "claude-opus-5" }] },
    comments: [],
    options: OPTIONS,
    ...over,
  };
}

const everyKind = (): ShareProjectionInput["blocks"] => [
  { block: base(0, "text", { text: "Plain answer" }), turnRole: "agent" },
  { block: base(1, "thinking", { text: "secret reasoning", signature: "sig" }), turnRole: "agent" },
  { block: base(2, "tool_call", { name: "Bash", status: "success", toolUseId: "toolu_9",
      input: { command: "cat C:\\Users\\Tuga\\.env" }, output: "ANTHROPIC_API_KEY=sk-ant-abc123def456ghi789jkl",
      fullOutput: "more", family: "bash" }), turnRole: "agent" },
  { block: base(3, "diff", { path: "C:\\Users\\Tuga\\app\\src\\secret.ts", patch: "-old\n+new" }), turnRole: "agent" },
  { block: base(4, "permission", { request: { toolName: "Bash", input: { command: "rm -rf /" } },
      decision: { outcome: "allow", rememberScope: "session" } }), turnRole: "agent" },
  { block: base(5, "question", { question: { header: "Pick", options: [] }, answers: { pick: "yes" } }), turnRole: "agent" },
  { block: base(6, "elicitation", { requestId: "req_1", schema: {}, answers: { token: "sk-ant-zzz" },
      status: "accepted" }), turnRole: "agent" },
  { block: base(7, "widget", { toolCallId: "toolu_9", serverName: "docs", toolName: "render",
      resourceUri: "ui://docs/x", html: "<script>alert('widget')</script>", htmlStatus: "ready",
      toolInput: {}, toolResult: null, meta: null }), turnRole: "agent" },
  { block: base(8, "usage", { totals: { input: 10, output: 20, cached: 0, costUsd: 0.01 } }), turnRole: "agent" },
  { block: base(9, "error", { message: "Failed to read C:\\Users\\Tuga\\notes.txt", detail: "stack" }), turnRole: "agent" },
  { block: base(10, "subagent", { agentId: "agt_1", name: "Reviewer", backend: "codex", model: "gpt",
      description: "d", status: "done" }), turnRole: "agent" },
];

describe("live block projection", () => {
  it("discloses omitted image contents without sharing attachment identifiers or names", () => {
    const bundle = projectShareBundle(input({ blocks: [{ turnRole: "user", block: base(0, "image", {
      attachmentId: "att_private", name: "private-screenshot.png", mediaType: "image/png", size: 200,
    }) }] }));
    expect(bundle.entries[0]).toMatchObject({ kind: "notice", text: expect.stringContaining("Image contents are not included") });
    const json = encodeShareJson(bundle).text;
    expect(json).not.toContain("att_private");
    expect(json).not.toContain("private-screenshot.png");
    expect(() => ShareBundleSchema.parse(bundle)).not.toThrow();
  });

  it("produces a schema-valid bundle of messages and safe activity labels only", () => {
    const bundle = projectShareBundle(input({ blocks: everyKind() }));
    expect(() => ShareBundleSchema.parse(bundle)).not.toThrow();
    expect(bundle.entries.map((e) => e.kind)).toEqual([
      "message", "activity", "activity", "notice", "notice",
    ]);
    const activity = bundle.entries[1]!;
    expect(activity).toMatchObject({ kind: "activity", name: "Bash", text: "" });
  });

  it("carries no raw tool input, result, diff, answer, widget html, config or native id", () => {
    const json = encodeShareJson(projectShareBundle(input({ blocks: everyKind() }))).text;
    for (const forbidden of [
      "cat C:", "sk-ant-", "ANTHROPIC_API_KEY", "-old", "+new", "rm -rf",
      "alert('widget')", "ui://docs/x", "toolu_9", "blk_0", "trn_1", "ses_1", "agt_1",
      "req_1", "sig", "costUsd", "rememberScope", "Users",
    ]) {
      expect(json).not.toContain(forbidden);
    }
  });

  it("counts every withheld block against the tally that describes it", () => {
    const bundle = projectShareBundle(input({ blocks: everyKind() }));
    expect(bundle.counts).toMatchObject({
      messages: 1, activities: 2, notices: 2, thinking: 0,
      droppedThinking: 1, droppedInteractive: 3, droppedWidgets: 1, droppedUsage: 1,
    });
    expect(bundle.counts.entries).toBe(bundle.entries.length);
  });

  it("includes reasoning only when explicitly opted in", () => {
    const on = projectShareBundle(input({ blocks: everyKind(),
      options: { ...OPTIONS, includeReasoning: true } }));
    expect(on.counts).toMatchObject({ thinking: 1, droppedThinking: 0 });
    expect(on.entries.some((e) => e.kind === "thinking")).toBe(true);
    expect(JSON.stringify(on)).not.toContain("sig");
  });

  it("labels omissions as the sender's claim, never as a verified fact", () => {
    const claims = senderClaimedOmissions(projectShareBundle(input({ blocks: everyKind() })));
    expect(claims.every((c) => c.claimed === true)).toBe(true);
    expect(claims.find((c) => c.kind === "thinking")).toMatchObject({ count: 1 });
    for (const claim of claims) expect(claim.description).toMatch(/sender/i);
  });
});

describe("redaction and byte limits", () => {
  it("redacts credentials before clipping, so a clipped secret cannot leak a prefix", () => {
    const secret = "sk-ant-api03-DEADBEEFdeadbeef0123456789";
    // Straddle the boundary: the clip must land inside the secret, so that
    // clipping first would leave a usable prefix behind.
    // The trailing text is separated: a greedy token match would otherwise
    // swallow it into the same redacted span and there would be nothing left
    // to clip.
    const raw = `${"a".repeat(65_480)} ${secret} ${"b".repeat(4000)}`;
    expect(clipUtf8(raw, 65_536).text).toContain("sk-ant-api03");
    const bundle = projectShareBundle(input({ blocks: [
      { block: base(0, "text", { text: raw }), turnRole: "agent" }] }));
    const text = (bundle.entries[0] as { text: string }).text;
    expect(text).not.toContain("sk-ant-api03");
    expect(text).not.toContain(secret.slice(0, 20));
    expect(bundle.counts.redactions).toBeGreaterThan(0);
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(65_536);
    expect(bundle.entries[0]!.truncated).toBe(true);
    expect(bundle.counts.truncatedTexts).toBe(1);
  });

  it("redacts absolute paths and common credential shapes", () => {
    const samples = [
      "token ghp_0123456789abcdef0123456789abcdef0123",
      "aws AKIAIOSFODNN7EXAMPLE",
      "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      "see C:\\Users\\Tuga\\Desktop\\keys.txt",
      "and /home/tuga/.ssh/id_rsa",
      "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrst",
    ];
    const bundle = projectShareBundle(input({ blocks: samples.map((text, i) =>
      ({ block: base(i, "text", { text }), turnRole: "agent" as TurnRole })) }));
    const all = JSON.stringify(bundle.entries);
    for (const leak of ["ghp_0123", "AKIAIOSFODNN7EXAMPLE", "eyJhbGciOi", "C:\\\\Users",
      "/home/tuga", "sk-proj-"]) {
      expect(all).not.toContain(leak);
    }
    expect(bundle.counts.redactions).toBeGreaterThanOrEqual(samples.length);
  });

  it("redacts and bounds display metadata and comments too", () => {
    const bundle = projectShareBundle(input({
      metadata: { title: "Key sk-ant-api03-SECRETSECRETSECRET1234", mode: "custom",
        startedAt: null, endedAt: null,
        agents: [{ label: "😀".repeat(60), backend: null, model: "m".repeat(400) }] },
      comments: [{ id: "b".repeat(32), entryIndex: 0, author: "😀".repeat(60),
        body: `note ghp_0123456789abcdef0123456789abcdef0123 ${"c".repeat(20_000)}`,
        createdAt: "2026-09-07T11:00:00Z", replyToId: null, resolved: false }],
    }));
    expect(() => ShareBundleSchema.parse(bundle)).not.toThrow();
    const bytes = (v: string) => new TextEncoder().encode(v).byteLength;
    expect(bundle.source.title).not.toContain("sk-ant");
    expect(bytes(bundle.source.title!)).toBeLessThanOrEqual(120);
    expect(bytes(bundle.source.agents[0]!.label)).toBeLessThanOrEqual(120);
    expect(bytes(bundle.source.agents[0]!.model!)).toBeLessThanOrEqual(120);
    expect(bytes(bundle.comments[0]!.author)).toBeLessThanOrEqual(120);
    expect(bytes(bundle.comments[0]!.body)).toBeLessThanOrEqual(16_384);
    expect(bundle.comments[0]!.body).not.toContain("ghp_0123");
    expect(bundle.source.mode).toBe("custom");
  });
});

describe("JSON codec", () => {
  it("is canonical and deterministic", () => {
    const first = encodeShareJson(projectShareBundle(input()));
    const second = encodeShareJson(projectShareBundle(input()));
    expect(first.text).toBe(second.text);
    expect(first.bytes).toBe(new TextEncoder().encode(first.text).byteLength);
    // Canonical: object keys are sorted, so `appVersion` precedes `bundleId`.
    expect(first.text.indexOf('"appVersion"')).toBeLessThan(first.text.indexOf('"bundleId"'));
    expect(decodeShareJson(first.text)).toEqual(projectShareBundle(input()));
  });

  it("parses strictly and refuses anything that is not this contract", () => {
    const good = encodeShareJson(projectShareBundle(input())).text;
    const mutate = (patch: Record<string, unknown>) =>
      JSON.stringify({ ...JSON.parse(good), ...patch });
    expect(() => decodeShareJson("{not json")).toThrow(ShareCodecError);
    expect(() => decodeShareJson(mutate({ version: 2 }))).toThrow(ShareCodecError);
    expect(() => decodeShareJson(mutate({ kind: "capygen.other" }))).toThrow(ShareCodecError);
    expect(() => decodeShareJson(mutate({ sessionId: "ses_1" }))).toThrow(ShareCodecError);
    expect(() => decodeShareJson(mutate({ counts: { entries: 99 } }))).toThrow(ShareCodecError);
    expect(() => decodeShareJson("[]")).toThrow(ShareCodecError);
  });
});

describe("HTML carrier", () => {
  const hostile = () => projectShareBundle(input({
    blocks: [{ block: base(0, "text", { text:
      "</template><script>alert(1)</script><img src=x onerror=alert(2)>\u2028done" }), turnRole: "user" }],
    metadata: { title: "</title><script>bad()</script>", mode: "solo", startedAt: null, endedAt: null,
      agents: [{ label: "<b>A</b>", backend: null, model: null }] },
  }));

  it("emits an offline, inert document with no scripts, handlers or external assets", () => {
    const html = encodeShareHtml(hostile()).text;
    expect(html).not.toMatch(/<script[\s>]/i);
    // No *element* carries a handler. The hostile text still reads
    // " onerror=" as escaped prose, which is content, not markup.
    expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
    expect(html).toContain("&lt;img src=x onerror=alert(2)&gt;");
    expect(html).not.toMatch(/<iframe|<object|<embed|<form|srcdoc/i);
    expect(html).not.toMatch(/(?:href|src)\s*=\s*["']?(?:https?:)?\/\//i);
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("\u2028");
  });

  it("round-trips the exact bundle through the base64 carrier", () => {
    const bundle = hostile();
    const html = encodeShareHtml(bundle).text;
    expect(decodeShareHtml(html)).toEqual(bundle);
    expect(encodeShareHtml(bundle).text).toBe(html);
  });

  it("parses only the exact bounded carrier and never the document", () => {
    const bundle = projectShareBundle(input());
    const html = encodeShareHtml(bundle).text;
    const carrier = /<template id="capygen-share" data-schema="1">([A-Za-z0-9+/=]*)<\/template>/;
    const encoded = carrier.exec(html)![1]!;

    expect(() => decodeShareHtml(html.replace(carrier, ""))).toThrow(/carrier/i);
    expect(() => decodeShareHtml(html + html)).toThrow(/more than one|duplicate/i);
    expect(() => decodeShareHtml(html.replace(encoded, "!!!not base64!!!"))).toThrow(ShareCodecError);
    expect(() => decodeShareHtml(html.replace(encoded,
      Buffer.from("{\"kind\":\"capygen.share\"}").toString("base64")))).toThrow(ShareCodecError);
    expect(() => decodeShareHtml(html.replace('data-schema="1"', 'data-schema="2"'))).toThrow(/identity|schema/i);
    // A script planted in the body is never read as content.
    const tampered = html.replace("</body>", "<script>alert(1)</script></body>");
    expect(decodeShareHtml(tampered)).toEqual(bundle);
  });
});

describe("size preflight", () => {
  it("reports the exact encoded byte size of both formats independently", () => {
    const bundle = projectShareBundle(input());
    const flight = preflightShare(bundle);
    expect(flight.json.bytes).toBe(encodeShareJson(bundle).bytes);
    expect(flight.html.bytes).toBe(encodeShareHtml(bundle).bytes);
    expect(flight.html.bytes).toBeGreaterThan(flight.json.bytes);
    expect(flight.json.withinLimit).toBe(true);
    expect(flight.html.withinLimit).toBe(true);
    expect(SHARE_JSON_MAX_BYTES).toBe(32 * 1024 * 1024);
    expect(SHARE_HTML_MAX_BYTES).toBe(96 * 1024 * 1024);
  });

  it("offers the already-reviewed JSON when the HTML carrier cannot fit", () => {
    const bundle = projectShareBundle(input());
    const tight = preflightShare(bundle, { maxHtmlBytes: 256, maxJsonBytes: SHARE_JSON_MAX_BYTES });
    expect(tight.html.withinLimit).toBe(false);
    expect(tight.json.withinLimit).toBe(true);

    const result = encodeShareHtml(bundle, { maxBytes: 256 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result).toMatchObject({ reason: "too-large", limit: 256,
      fallback: { format: "json", withinLimit: true } });
    expect(result.bytes).toBeGreaterThan(256);
    // Refused before producing a file, and the reviewed JSON still encodes.
    expect(encodeShareJson(bundle, { maxBytes: result.fallback.bytes }).ok).toBe(true);
  });

  it("refuses a limit above the shipped cap rather than silently widening it", () => {
    const bundle = projectShareBundle(input());
    expect(() => encodeShareJson(bundle, { maxBytes: SHARE_JSON_MAX_BYTES + 1 })).toThrow();
    expect(() => encodeShareHtml(bundle, { maxBytes: SHARE_HTML_MAX_BYTES + 1 })).toThrow();
  });
});

describe("file names", () => {
  it("builds a safe name from untrusted display text", () => {
    expect(shareFileName({ title: "Session title", createdAt: "2026-09-07T10:00:00Z", format: "html" }))
      .toBe("capygen-share-session-title-20260907.capyshare.html");
    for (const title of ["../../etc/passwd", "C:\\Windows\\system32", "CON", "  ", "😀😀",
      "a".repeat(300), "name\u0000with\nnull"]) {
      const name = shareFileName({ title, createdAt: "2026-09-07T10:00:00Z", format: "json" });
      expect(name).toMatch(/^capygen-share-[a-z0-9-]{1,40}-\d{8}\.capyshare\.json$/);
      expect(name).not.toMatch(/\.\.|[\\/:*?"<>|]/);
      expect(name.length).toBeLessThan(100);
    }
    expect(shareFileName({ title: "CON", createdAt: "2026-09-07T10:00:00Z", format: "json" }))
      .not.toMatch(/^capygen-share-con-/);
  });
});
