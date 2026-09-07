import { describe, expect, it } from "vitest";
import type { Block, ShareBundle, TurnRole } from "@capygen/shared";
import {
  SHARE_HTML_MAX_BYTES,
  SHARE_JSON_MAX_BYTES,
  ShareCodecError,
  decodeShareHtml,
  decodeShareJson,
  encodeShareHtml,
  encodeShareJson,
  projectShareBundle,
  redactText,
} from "../src/sharing/index.js";

const SECRET = "sk-ant-api03-DEADBEEFdeadbeef0123456789";

const block = (over: Record<string, unknown>): Block => ({
  id: "blk_0", turnId: "trn_1", sessionId: "ses_1", index: 0,
  createdAt: 1_757_000_000_000, updatedAt: 1_757_000_000_000, ...over,
}) as unknown as Block;

const good = (): ShareBundle => projectShareBundle({
  blocks: [{ block: block({ kind: "text", text: "Hello" }), turnRole: "agent" as TurnRole }],
  metadata: { title: "T", mode: "solo", startedAt: null, endedAt: null, agents: [] },
  comments: [],
  options: { bundleId: "a".repeat(32), appVersion: "0.1.0", createdAt: "2026-09-07T10:00:00Z" },
});

/** A value that satisfies the compiler but not the contract. */
const forged = (patch: Record<string, unknown>): ShareBundle =>
  ({ ...good(), ...patch }) as unknown as ShareBundle;

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof ShareCodecError) return error.code;
    return `unexpected: ${String(error)}`;
  }
  return "no-throw";
};

describe("encoders do not trust their argument's type", () => {
  it("refuses a forged bundle instead of rendering it", () => {
    // `counts.entries` is interpolated into the HTML header. A cast is all it
    // takes to make it a string, so the encoder must validate, not assume.
    const scripted = forged({ counts: { ...good().counts, entries: "1<script>alert(1)</script>" } });
    expect(codeOf(() => encodeShareHtml(scripted))).toBe("schema");
    expect(codeOf(() => encodeShareJson(scripted))).toBe("schema");

    for (const bad of [
      forged({ version: 2 }),
      forged({ kind: "capygen.other" }),
      forged({ sessionId: "ses_1" }),
      forged({ counts: { ...good().counts, entries: 99 } }),
      forged({ bundleId: "nope" }),
    ]) {
      expect(codeOf(() => encodeShareHtml(bad))).toBe("schema");
      expect(codeOf(() => encodeShareJson(bad))).toBe("schema");
    }
    expect(encodeShareJson(good()).ok).toBe(true);
    expect(encodeShareHtml(good()).ok).toBe(true);
  });

  it("never emits an unescaped forged count into the document", () => {
    const scripted = forged({ counts: { ...good().counts, entries: "1<script>alert(1)</script>" } });
    let html = "";
    try {
      html = encodeShareHtml(scripted).text;
    } catch {
      html = "";
    }
    expect(html).not.toContain("<script>");
  });
});

describe("decode bounds the input before it parses it", () => {
  it("refuses oversize raw bytes before JSON.parse, whitespace included", () => {
    const json = encodeShareJson(good()).text;
    // Canonically tiny, raw enormous: the cap must be on what was received.
    const padded = `${" ".repeat(4096)}${json}`;
    expect(new TextEncoder().encode(json).byteLength).toBeLessThan(4096);
    expect(codeOf(() => decodeShareJson(padded, { maxBytes: 2048 }))).toBe("too-large");
    // Oversize *and* malformed still refuses on size, i.e. before parsing.
    expect(codeOf(() => decodeShareJson(`${" ".repeat(4096)}{not json`, { maxBytes: 2048 })))
      .toBe("too-large");
    expect(decodeShareJson(padded)).toEqual(good());
  });

  it("keeps runtime caps tighten-only on both decoders", () => {
    const json = encodeShareJson(good()).text;
    const html = encodeShareHtml(good()).text;
    expect(codeOf(() => decodeShareJson(json, { maxBytes: SHARE_JSON_MAX_BYTES + 1 }))).toBe("invalid-option");
    expect(codeOf(() => decodeShareHtml(html, { maxBytes: SHARE_HTML_MAX_BYTES + 1 }))).toBe("invalid-option");
    expect(codeOf(() => decodeShareJson(json, { maxBytes: 0 }))).toBe("invalid-option");
  });

  it("refuses a carrier whose bytes are not valid UTF-8", () => {
    const html = encodeShareHtml(good()).text;
    const carrier = /<template id="capygen-share" data-schema="1">([A-Za-z0-9+/=]*)<\/template>/;
    const encoded = carrier.exec(html)![1]!;
    const invalid = Buffer.from([0x7b, 0xff, 0xfe, 0xfd, 0x7d]).toString("base64");
    expect(codeOf(() => decodeShareHtml(html.replace(encoded, invalid)))).toBe("carrier-malformed");
    // A lenient decoder would have produced U+FFFD and failed later, or worse,
    // parsed something the sender did not write.
    expect(() => decodeShareHtml(html.replace(encoded, invalid))).toThrow(/not readable|UTF-8/i);
  });
});

describe("errors never echo what they refused", () => {
  it("keeps attacker text out of parse and schema messages", () => {
    const cases = [
      `{"kind":"capygen.share","version":1,"appVersion":${SECRET}}`,
      `{"${SECRET}":1,"kind":"capygen.share","version":1}`,
      JSON.stringify({ ...good(), [SECRET]: "x" }),
      JSON.stringify({ ...good(), appVersion: SECRET.repeat(4) }),
      JSON.stringify({ ...good(), bundleId: SECRET }),
    ];
    for (const text of cases) {
      let message = "";
      let code = "";
      try {
        decodeShareJson(text);
      } catch (error) {
        message = (error as Error).message;
        code = (error as ShareCodecError).code;
      }
      expect(code).not.toBe("");
      expect(message).not.toContain("sk-ant");
      expect(message).not.toContain("DEADBEEF");
      // Still useful: a stable code and a bounded, schema-owned location.
      expect(message.length).toBeLessThan(300);
    }
  });

  it("reports safe field paths only", () => {
    let message = "";
    try {
      decodeShareJson(JSON.stringify({ ...good(), source: { ...good().source, title: 5 } }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("source.title");
    expect(message).not.toContain("5");
  });
});

describe("oversize HTML hands back the reviewed JSON it already encoded", () => {
  it("carries the exact encoded bytes rather than recomputing them", () => {
    const bundle = good();
    const result = encodeShareHtml(bundle, { maxBytes: 256 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    const json = encodeShareJson(bundle);
    expect(result.fallback.text).toBe(json.text);
    expect(result.fallback.bytes).toBe(json.bytes);
    expect(result.fallback.withinLimit).toBe(true);
    expect(decodeShareJson(result.fallback.text)).toEqual(bundle);
  });
});

describe("redaction covers URL credentials and lowercase assignments", () => {
  it("removes user:password from URLs", () => {
    for (const sample of [
      "https://user:password@example.com/repo.git",
      "http://admin:hunter2@10.0.0.1:8080/api",
      "postgres://dbuser:s3cr3tpw@db.internal:5432/app",
    ]) {
      const result = redactText(sample);
      expect(result.redactions).toBeGreaterThan(0);
      expect(result.text).not.toContain("password");
      expect(result.text).not.toContain("hunter2");
      expect(result.text).not.toContain("s3cr3tpw");
      expect(result.text).not.toContain("dbuser");
    }
    // An ordinary URL keeps working.
    expect(redactText("see https://example.com/docs").redactions).toBe(0);
  });

  it("removes lowercase and mixed-case credential assignments", () => {
    for (const sample of [
      "api_key=abcdefgh12345678",
      "password: hunter2hunter2hunter2",
      'client_secret: "abcdefghijklmnop"',
      "Api-Token = abcdefghijklmnopqrst",
    ]) {
      const result = redactText(sample);
      expect(result.redactions).toBeGreaterThan(0);
      for (const leak of ["abcdefgh12345678", "hunter2hunter2", "abcdefghijklmnop", "abcdefghijklmnopqrst"]) {
        expect(result.text).not.toContain(leak);
      }
    }
  });
});

describe("the standalone document uses the app's own tokens", () => {
  it("styles from the reference palette rather than an invented one", () => {
    const html = encodeShareHtml(good()).text;
    for (const token of ["#ffffff", "#27272a", "#71717a", "#e4e4e7", "#0e1013", "#92a4b3"]) {
      expect(html).toContain(token);
    }
  });
});
