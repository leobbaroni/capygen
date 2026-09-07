/**
 * Phase 7 transcript import parsers (`src/imports/**`).
 *
 * Everything here runs on synthetic fixtures under `test/fixtures/imports/`
 * and on files written into a temp directory. No test reads a personal backend
 * home, spawns a CLI or calls a model — the Claude chain reconstructor is
 * injected, exactly as the shipping parser requires.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  IMPORT_LIMITS,
  ImportError,
  TRUNCATION_MARKER,
  resolveLimits,
  clampUtf8,
  createReadOnlySessionStore,
  parseTranscriptFile,
  scanJsonlFile,
  type ClaudeChainReconstructor,
  type ClaudeStoreEntry,
  type ImportedTranscript,
} from "../src/imports/index.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/imports/", import.meta.url));
const fixture = (name: string): string => path.join(FIXTURES, name);

const temps: string[] = [];

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-imports-"));
  temps.push(dir);
  return dir;
}

function writeTemp(name: string, contents: string | Buffer): string {
  const file = path.join(tempDir(), name);
  fs.writeFileSync(file, contents);
  return file;
}

/**
 * Stands in for the SDK: the same canonical walk `getSessionMessages` performs
 * (root-first through `parentUuid`), verified against the real SDK in
 * `imports.sdk.test.ts`. Records what it was handed so a test can prove the
 * projection that reaches it is sanitized.
 */
function fakeReconstructor(): ClaudeChainReconstructor & { seen: ClaudeStoreEntry[] } {
  const seen: ClaudeStoreEntry[] = [];
  const reconstruct = (async ({ entries }) => {
    seen.push(...entries);
    const byParent = new Map<string | null, ClaudeStoreEntry[]>();
    for (const entry of entries) {
      const parent = (entry.parentUuid ?? null) as string | null;
      const bucket = byParent.get(parent);
      if (bucket) bucket.push(entry);
      else byParent.set(parent, [entry]);
    }
    const ordered: ClaudeStoreEntry[] = [];
    const walk = (parent: string | null): void => {
      for (const entry of byParent.get(parent) ?? []) {
        ordered.push(entry);
        walk(entry.uuid ?? null);
      }
    };
    walk(null);
    return ordered.map((entry) => ({
      type: entry.type as "user" | "assistant" | "system",
      uuid: entry.uuid ?? "",
      session_id: entry.sessionId ?? "",
      message: entry.message,
      parent_tool_use_id: null,
      parent_agent_id: null,
    }));
  }) as ClaudeChainReconstructor & { seen: ClaudeStoreEntry[] };
  reconstruct.seen = seen;
  return reconstruct;
}

function texts(result: ImportedTranscript): string[] {
  return result.entries.map((entry) => `${entry.kind}:${entry.text}`);
}

describe("scanJsonlFile — bounds and encoding", () => {
  it("hashes the bytes it actually read and counts records", async () => {
    const body = '{"a":1}\n\n{"b":2}\n';
    const file = writeTemp("plain.jsonl", body);
    const seen: unknown[] = [];
    const result = await scanJsonlFile(file, { onRecord: (record) => void seen.push(record.value) });

    expect(seen).toEqual([{ a: 1 }, { b: 2 }]);
    expect(result.records).toBe(2);
    expect(result.bytes).toBe(Buffer.byteLength(body));
    expect(result.sha256).toBe(createHash("sha256").update(Buffer.from(body)).digest("hex"));
  });

  it("reads CRLF, a leading BOM and a final line with no newline", async () => {
    const file = writeTemp("crlf.jsonl", Buffer.from("\uFEFF{\"a\":1}\r\n{\"b\":2}", "utf8"));
    const seen: unknown[] = [];
    await scanJsonlFile(file, { onRecord: (record) => void seen.push(record.value) });
    expect(seen).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("refuses a file that is not there, not absolute, or empty", async () => {
    await expect(scanJsonlFile("relative.jsonl", { onRecord: () => {} })).rejects.toMatchObject({
      code: "not-a-file",
    });
    await expect(
      scanJsonlFile(path.join(tempDir(), "missing.jsonl"), { onRecord: () => {} }),
    ).rejects.toMatchObject({ code: "not-a-file" });
    await expect(
      scanJsonlFile(writeTemp("empty.jsonl", ""), { onRecord: () => {} }),
    ).rejects.toMatchObject({ code: "empty" });
    await expect(
      scanJsonlFile(writeTemp("blank.jsonl", "\n\n\n"), { onRecord: () => {} }),
    ).rejects.toMatchObject({ code: "empty" });
  });

  it("refuses a directory rather than reading anything in it", async () => {
    await expect(scanJsonlFile(tempDir(), { onRecord: () => {} })).rejects.toMatchObject({
      code: "not-a-file",
    });
  });

  it("refuses a compressed file instead of parsing binary as text", async () => {
    const gzip = Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0x00]), Buffer.alloc(64, 0x41)]);
    await expect(
      scanJsonlFile(writeTemp("rollout.jsonl", gzip), { onRecord: () => {} }),
    ).rejects.toMatchObject({ code: "compressed" });
  });

  it("enforces the byte, line and record caps", async () => {
    const file = writeTemp("caps.jsonl", '{"a":1}\n{"b":2}\n{"c":3}\n');
    await expect(
      scanJsonlFile(file, { onRecord: () => {}, limits: { maxSourceBytes: 8 } }),
    ).rejects.toMatchObject({ code: "too-large" });
    await expect(
      scanJsonlFile(file, { onRecord: () => {}, limits: { maxLineBytes: 4 } }),
    ).rejects.toMatchObject({ code: "line-too-long" });
    await expect(
      scanJsonlFile(file, { onRecord: () => {}, limits: { maxRecords: 2 } }),
    ).rejects.toMatchObject({ code: "too-many-records" });
  });

  it("refuses invalid UTF-8 rather than storing replacement characters", async () => {
    // 0xC3 starts a two-byte sequence that never arrives.
    const bytes = Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xc3]), Buffer.from('"}\n')]);
    await expect(
      scanJsonlFile(writeTemp("bad-utf8.jsonl", bytes), { onRecord: () => {} }),
    ).rejects.toMatchObject({ code: "invalid-utf8" });
  });

  it("refuses invalid JSON, naming the line", async () => {
    const file = writeTemp("bad-json.jsonl", '{"a":1}\n{"b":\n');
    await expect(scanJsonlFile(file, { onRecord: () => {} })).rejects.toMatchObject({
      code: "invalid-json",
      line: 2,
    });
  });
});

describe("parseTranscriptFile — Claude", () => {
  it("returns the canonical chain in order, inert, from an out-of-order file", async () => {
    const reconstruct = fakeReconstructor();
    const result = await parseTranscriptFile(fixture("claude-chain.jsonl"), { reconstruct });

    expect(result.backend).toBe("claude");
    expect(result.format).toBe("claude-jsonl/v1");
    expect(result.nativeId).toBe("11111111-1111-4111-8111-111111111111");
    expect(result.title).toBe("Refactor the loader");
    // A sidechain record and a dropped image are both omissions, so the
    // snapshot does not claim to be the whole conversation.
    expect(result.complete).toBe(false);

    // a-2 appears before u-2 in the file; the chain still reads in order.
    expect(texts(result)).toEqual([
      "message:Hello ünïcode ✨ — please read the loader",
      "thinking:The loader is in src/loader.ts",
      "message:Reading it now.",
      'activity:{\n  "file_path": "C:/work/src/loader.ts"\n}',
      "activity-result:export const loader = 1;",
      "message:Done — the loader is fine.",
    ]);
    expect(result.entries.map((entry) => entry.kind)).toEqual([
      "message",
      "thinking",
      "message",
      "activity",
      "activity-result",
      "message",
    ]);
    expect(result.entries[0]?.at).toBe("2026-01-01T00:00:01.000Z");
  });

  it("hands the reconstructor only allowlisted fields", async () => {
    const reconstruct = fakeReconstructor();
    await parseTranscriptFile(fixture("claude-chain.jsonl"), { reconstruct });

    const keys = new Set(reconstruct.seen.flatMap((entry) => Object.keys(entry)));
    expect([...keys].sort()).toEqual([
      "isMeta",
      "isSidechain",
      "message",
      "parentUuid",
      "sessionId",
      "timestamp",
      "type",
      "uuid",
    ]);
    const serialized = JSON.stringify(reconstruct.seen);
    for (const dropped of ["cwd", "gitBranch", "userType", "version", "toolUseResult"]) {
      expect(serialized).not.toContain(dropped);
    }

    // The message itself is projected *before* the hand-off: only allowlisted
    // block shapes, no tool-use id, no image, no unknown payload.
    const blockKeys = new Set(
      reconstruct.seen.flatMap((entry) => (entry.message?.content ?? []).flatMap(Object.keys)),
    );
    expect([...blockKeys].sort()).toEqual([
      "content",
      "input",
      "is_error",
      "name",
      "text",
      "thinking",
      // Truncation provenance travels with the block, so the final entry can
      // report it even though the text is already bounded.
      "truncated",
      "type",
    ]);
    for (const dropped of ["toolu_1", "tool_use_id", "\"image\"", "AAAA", "signature"]) {
      expect(serialized).not.toContain(dropped);
    }
  });

  it("keeps no configuration value, no tool-use id and no raw unknown payload", async () => {
    const reconstruct = fakeReconstructor();
    const result = await parseTranscriptFile(fixture("claude-chain.jsonl"), { reconstruct });
    const serialized = JSON.stringify(result);

    for (const forbidden of [
      "apiKeyHelper", // a configuration record's own field name
      "PreToolUse hook ran", // a system record's value
      "Users\\\\person\\\\secret", // the recorded cwd
      "WHOLE FILE BLOB", // the toolUseResult blob
      "toolu_1", // the tool-use id: nothing can be correlated or replayed
      "anything", // the unknown record's payload
      "at all",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    // The unknown record survives only as a bounded label and a count.
    expect(result.unknownTypes).toEqual([{ type: "x-capygen-unknown", count: 1 }]);
    expect(result.counts.unknownRecords).toBe(1);
    // The summary record and the system record are counted, not kept.
    expect(result.counts.droppedConfiguration).toBe(2);
  });

  it("warns about sub-agent records and dropped attachments instead of inventing them", async () => {
    const reconstruct = fakeReconstructor();
    const result = await parseTranscriptFile(fixture("claude-chain.jsonl"), { reconstruct });
    const codes = result.warnings.map((warning) => warning.code).sort();
    expect(codes).toEqual(["claude.attachment-dropped", "claude.sidechain-dropped"]);
    expect(result.complete).toBe(false);
    expect(result.warnings.find((w) => w.code === "claude.sidechain-dropped")?.count).toBe(1);
    expect(JSON.stringify(result)).not.toContain("sub-agent prompt");
  });

  it("refuses a file whose records disagree about the session id", async () => {
    await expect(
      parseTranscriptFile(fixture("claude-conflicting-identity.jsonl"), {
        reconstruct: fakeReconstructor(),
      }),
    ).rejects.toMatchObject({ code: "conflicting-identity", line: 2 });
  });

  it("refuses a Claude file when no chain reconstructor was injected", async () => {
    await expect(parseTranscriptFile(fixture("claude-chain.jsonl"))).rejects.toMatchObject({
      code: "unsupported-structure",
    });
  });
});

describe("createReadOnlySessionStore", () => {
  it("loads the supplied entries and refuses every other method", async () => {
    const entries: ClaudeStoreEntry[] = [{ type: "user", uuid: "u-1" }];
    const store = createReadOnlySessionStore(entries);

    await expect(store.load({ projectKey: "p", sessionId: "s" })).resolves.toEqual(entries);
    await expect(store.append({ projectKey: "p", sessionId: "s" }, entries)).rejects.toBeInstanceOf(
      ImportError,
    );
    await expect(store.delete?.({ projectKey: "p", sessionId: "s" })).rejects.toBeInstanceOf(
      ImportError,
    );
    await expect(store.listSessions?.("p")).rejects.toBeInstanceOf(ImportError);
    await expect(
      store.listSubkeys?.({ projectKey: "p", sessionId: "s" }),
    ).rejects.toBeInstanceOf(ImportError);
  });
});

describe("parseTranscriptFile — Codex", () => {
  it("prefers canonical response items and counts the event echoes", async () => {
    const result = await parseTranscriptFile(fixture("codex-rollout.jsonl"));

    expect(result.backend).toBe("codex");
    expect(result.format).toBe("codex-rollout/rust-v0.153.4");
    expect(result.nativeId).toBe("33333333-3333-4333-8333-333333333333");
    expect(result.cwd).toBe("C:\\work\\repo");
    expect(result.title).toBe("Refatorar o carregador ✨");
    // The trailing image-only message is content this snapshot does not carry.
    expect(result.complete).toBe(false);
    expect(result.warnings.map((warning) => warning.code)).toEqual(["codex.multimodal-dropped"]);

    expect(texts(result)).toEqual([
      "message:Refatorar o carregador ✨",
      "thinking:Plan the change",
      "message:I'll patch it.",
      'activity:{"command":["ls","-la"]}',
      "activity-result:loader.ts\nindex.ts",
    ]);
    // The two echoes are counted, not duplicated into the transcript.
    expect(result.counts.echoedEvents).toBe(2);
    expect(texts(result).filter((text) => text.includes("Refatorar"))).toHaveLength(1);
    expect(texts(result).filter((text) => text.includes("patch it"))).toHaveLength(1);
  });

  it("drops configuration, telemetry and provider-opaque values", async () => {
    const result = await parseTranscriptFile(fixture("codex-rollout.jsonl"));
    const serialized = JSON.stringify(result);

    for (const forbidden of [
      "SYSTEM INSTRUCTIONS THAT MUST NOT BE IMPORTED", // base_instructions
      "ENCRYPTEDBLOBTHATMUSTNOTBEIMPORTED", // reasoning.encrypted_content
      "gpt-5.5", // turn_context model
      "on-request", // approval policy
      "workspace-write", // sandbox policy
      "private.git", // git remote
      "call_1", // the call id: nothing can be correlated or re-run
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    // session_meta, turn_context and token_usage_record.
    expect(result.counts.droppedConfiguration).toBe(3);
    expect(result.unknownTypes).toEqual([{ type: "event_msg:token_count", count: 1 }]);
    expect(result.warnings.map((warning) => warning.code)).toContain("codex.multimodal-dropped");
  });

  it("marks a thread that continues another rollout incomplete, without opening it", async () => {
    const result = await parseTranscriptFile(fixture("codex-history-base.jsonl"));

    expect(result.complete).toBe(false);
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "codex.history-prefix-missing",
    ]);
    // The referenced prefix rollout id never becomes part of the snapshot.
    expect(JSON.stringify(result)).not.toContain("44444444-4444-4444-8444-444444444444");
    expect(texts(result)).toEqual(["message:continuing from before"]);
  });

  it("falls back to event echoes only when there is no canonical text, and says so", async () => {
    const result = await parseTranscriptFile(fixture("codex-events-only.jsonl"));

    expect(texts(result)).toEqual(["message:only an echo", "message:echoed reply"]);
    expect(result.entries.map((entry) => entry.label)).toEqual(["user", "assistant"]);
    expect(result.warnings.map((warning) => warning.code)).toEqual(["codex.event-echo-fallback"]);
    // Nothing was both echoed *and* kept.
    expect(result.counts.echoedEvents).toBe(0);
  });

  it("refuses a rollout whose records disagree about the thread id", async () => {
    const file = writeTemp(
      "codex-conflict.jsonl",
      [
        JSON.stringify({
          timestamp: "2026-02-01T00:00:00.000Z",
          type: "session_meta",
          payload: { id: "33333333-3333-4333-8333-333333333333", cwd: "C:/x" },
        }),
        JSON.stringify({
          timestamp: "2026-02-01T00:00:01.000Z",
          type: "session_meta",
          payload: { id: "55555555-5555-4555-8555-555555555555", cwd: "C:/x" },
        }),
      ].join("\n"),
    );
    await expect(parseTranscriptFile(file)).rejects.toMatchObject({
      code: "conflicting-identity",
      line: 2,
    });
  });

  it("refuses a file that is neither backend", async () => {
    const file = writeTemp("mystery.jsonl", '{"type":"whatever","stuff":1}\n');
    await expect(parseTranscriptFile(file)).rejects.toMatchObject({ code: "unknown-format" });
  });
});

describe("byte bounds on normalized text", () => {
  it("clips a multi-byte message on a code-point boundary and marks it", async () => {
    const emoji = "✨".repeat(200); // 3 bytes each
    const file = writeTemp(
      "codex-unicode.jsonl",
      [
        JSON.stringify({
          timestamp: "2026-02-01T00:00:00.000Z",
          type: "session_meta",
          payload: { id: "33333333-3333-4333-8333-333333333333", cwd: "C:/x" },
        }),
        JSON.stringify({
          timestamp: "2026-02-01T00:00:01.000Z",
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: emoji }] },
        }),
      ].join("\n"),
    );

    const result = await parseTranscriptFile(file, { limits: { maxMessageBytes: 128 } });
    const entry = result.entries[0];
    expect(entry?.truncated).toBe(true);
    expect(result.counts.truncatedTexts).toBe(1);
    expect(entry?.text).toContain("truncated at the import limit");
    expect(Buffer.byteLength(entry?.text ?? "", "utf8")).toBeLessThanOrEqual(128);
    // Round-tripping proves no code point was cut in half.
    const kept = (entry?.text ?? "").replace(/\n… \[capygen: truncated.*$/s, "");
    expect(Buffer.from(kept, "utf8").toString("utf8")).toBe(kept);
    expect(kept.length * 3).toBe(Buffer.byteLength(kept, "utf8"));
  });

  it("bounds historical tool text separately from message text", async () => {
    const output = "x".repeat(5_000);
    const file = writeTemp(
      "codex-bigtool.jsonl",
      [
        JSON.stringify({
          timestamp: "2026-02-01T00:00:00.000Z",
          type: "session_meta",
          payload: { id: "33333333-3333-4333-8333-333333333333", cwd: "C:/x" },
        }),
        JSON.stringify({
          timestamp: "2026-02-01T00:00:01.000Z",
          type: "response_item",
          payload: { type: "function_call_output", call_id: "c1", name: "shell", output },
        }),
      ].join("\n"),
    );

    const result = await parseTranscriptFile(file, { limits: { maxToolTextBytes: 512 } });
    const entry = result.entries[0];
    expect(entry?.kind).toBe("activity-result");
    expect(entry?.truncated).toBe(true);
    expect(Buffer.byteLength(entry?.text ?? "", "utf8")).toBeLessThanOrEqual(512);
  });

  it("refuses a transcript that normalizes past the total byte cap", async () => {
    const lines = [
      JSON.stringify({
        timestamp: "2026-02-01T00:00:00.000Z",
        type: "session_meta",
        payload: { id: "33333333-3333-4333-8333-333333333333", cwd: "C:/x" },
      }),
    ];
    for (let i = 0; i < 20; i += 1) {
      lines.push(
        JSON.stringify({
          timestamp: "2026-02-01T00:00:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "y".repeat(200) }],
          },
        }),
      );
    }
    const file = writeTemp("codex-flood.jsonl", lines.join("\n"));
    await expect(
      parseTranscriptFile(file, { limits: { maxNormalizedBytes: 1_000 } }),
    ).rejects.toMatchObject({ code: "normalized-too-large" });
  });
});

describe("parseTranscriptFile — Claude, chain integrity", () => {
  it("recognizes a transcript that opens with file-history/queue metadata", async () => {
    const reconstruct = fakeReconstructor();
    const result = await parseTranscriptFile(fixture("claude-leading-metadata.jsonl"), {
      reconstruct,
    });

    expect(result.backend).toBe("claude");
    expect(texts(result)).toEqual(["message:after the metadata"]);
    // The metadata records were replayed into the collector, not skipped.
    expect(result.counts.records).toBe(3);
    expect(result.counts.droppedConfiguration).toBe(2);
    expect(JSON.stringify(result)).not.toContain("trackedFileBackups");
    expect(JSON.stringify(result)).not.toContain("queued prompt");
  });

  it("refuses a file that repeats a uuid", async () => {
    await expect(
      parseTranscriptFile(fixture("claude-duplicate-uuid.jsonl"), {
        reconstruct: fakeReconstructor(),
      }),
    ).rejects.toMatchObject({ code: "conflicting-identity", line: 2 });
  });

  it("reports a missing parent and a compaction boundary as an incomplete snapshot", async () => {
    const reconstruct = fakeReconstructor();
    const result = await parseTranscriptFile(fixture("claude-missing-parent.jsonl"), {
      reconstruct,
    });

    expect(result.complete).toBe(false);
    expect(result.warnings.map((warning) => warning.code).sort()).toEqual([
      "claude.chain-partial",
      "claude.compacted",
      "claude.missing-parent",
    ]);
    // The record naming an absent parent cannot be placed in the chain, so it
    // is reported as missing rather than silently inserted at the root.
    expect(result.warnings.find((warning) => warning.code === "claude.chain-partial")?.count).toBe(
      1,
    );
    expect(texts(result)).toEqual(["notice:(the conversation was compacted here)"]);
  });
});

describe("parseTranscriptFile — Codex, pinned item variants", () => {
  it("reads custom tool calls and outputs, and inter-agent messages", async () => {
    const result = await parseTranscriptFile(fixture("codex-tools-agents.jsonl"));

    expect(texts(result)).toEqual([
      // `custom_tool_call` carries `input`, not `execution`.
      "activity:*** Begin Patch\n*** End Patch",
      // `custom_tool_call_output` shares function_call_output's array body.
      "activity-result:patch applied",
      "message:take the loader next",
    ]);
    expect(result.entries[0]?.label).toBe("apply_patch (historical)");
    expect(result.entries[2]?.label).toBe("planner → builder (historical)");

    // The encrypted agent message and the unreadable item are both omissions.
    expect(result.complete).toBe(false);
    expect(result.warnings.map((warning) => warning.code).sort()).toEqual([
      "codex.agent-message-unreadable",
      "codex.multimodal-dropped",
      "codex.unsupported-items",
    ]);
    expect(result.unknownTypes).toEqual([{ type: "response_item:some_future_item", count: 1 }]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("OPAQUEBLOB");
    expect(serialized).not.toContain("UNREADABLE PAYLOAD");
  });

  it("suppresses only the echo a canonical item covers, keeping order", async () => {
    const result = await parseTranscriptFile(fixture("codex-mixed-echo.jsonl"));

    // The matching echo is gone; the unmatched one stays where the file put it,
    // after the shell activity rather than appended at the end.
    expect(texts(result)).toEqual([
      "message:canonical question",
      'activity:{"command":["ls"]}',
      "message:reply that has no canonical item",
      "message:developer context",
    ]);
    expect(result.counts.echoedEvents).toBe(1);
    // A mixed snapshot cannot claim to be a clean canonical history.
    expect(result.complete).toBe(false);
    expect(result.warnings.map((warning) => warning.code)).toEqual(["codex.event-echo-mixed"]);
  });

  it("does not let a developer-role canonical message erase event-only turns", async () => {
    const file = writeTemp(
      "codex-developer-only.jsonl",
      [
        JSON.stringify({
          timestamp: "2026-04-02T00:00:00.000Z",
          type: "session_meta",
          payload: { id: "33333333-3333-4333-8333-333333333333", cwd: "C:/x" },
        }),
        JSON.stringify({
          timestamp: "2026-04-02T00:00:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: "developer context" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-02T00:00:02.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "the only user turn" },
        }),
      ].join("\n"),
    );

    const result = await parseTranscriptFile(file);
    expect(texts(result)).toEqual(["message:developer context", "message:the only user turn"]);
    expect(result.warnings.map((warning) => warning.code)).toEqual(["codex.event-echo-fallback"]);
  });
});

describe("normalized-representation bounds", () => {
  it("never exceeds a byte limit smaller than the truncation marker itself", () => {
    for (const maxBytes of [0, 1, 2, 3, 8, TRUNCATION_MARKER.length - 1]) {
      const clamped = clampUtf8("✨".repeat(50), maxBytes);
      expect(Buffer.byteLength(clamped.text, "utf8")).toBeLessThanOrEqual(maxBytes);
      expect(clamped.truncated).toBe(true);
    }
  });

  it("charges labels and names against the byte budget, not just the text", async () => {
    const hugeName = "n".repeat(4_000);
    const lines = [
      JSON.stringify({
        timestamp: "2026-05-01T00:00:00.000Z",
        type: "session_meta",
        payload: { id: "33333333-3333-4333-8333-333333333333", cwd: "C:/x" },
      }),
    ];
    for (let i = 0; i < 40; i += 1) {
      lines.push(
        JSON.stringify({
          timestamp: "2026-05-01T00:00:01.000Z",
          type: "response_item",
          payload: { type: "function_call", name: hugeName, arguments: "", call_id: `c${i}` },
        }),
      );
    }
    const file = writeTemp("codex-bigname.jsonl", lines.join("\n"));

    // Every entry's *text* is empty, so a text-only budget would never trip.
    await expect(
      parseTranscriptFile(file, { limits: { maxNormalizedBytes: 2_000 } }),
    ).rejects.toMatchObject({ code: "normalized-too-large" });

    // With room to spare, the name is still clamped rather than stored whole.
    const result = await parseTranscriptFile(file, { limits: { maxLabelChars: 32 } });
    const first = result.entries[0];
    expect(first?.kind).toBe("activity");
    expect(first?.kind === "activity" ? first.name.length : Infinity).toBeLessThanOrEqual(32);
    expect(first?.label.length).toBeLessThanOrEqual(32);
    expect(result.counts.normalizedBytes).toBeGreaterThan(0);
  });

  it("caps normalized entries independently of the record count", async () => {
    const blocks = Array.from({ length: 12 }, (_, i) => ({ type: "input_text", text: `part ${i}` }));
    const file = writeTemp(
      "codex-manyblocks.jsonl",
      [
        JSON.stringify({
          timestamp: "2026-05-02T00:00:00.000Z",
          type: "session_meta",
          payload: { id: "33333333-3333-4333-8333-333333333333", cwd: "C:/x" },
        }),
        ...Array.from({ length: 3 }, () =>
          JSON.stringify({
            timestamp: "2026-05-02T00:00:01.000Z",
            type: "response_item",
            payload: { type: "message", role: "user", content: blocks },
          }),
        ),
      ].join("\n"),
    );

    // Four records, well under maxRecords — but each message is one entry, and
    // the entry cap is what has to stop this.
    await expect(
      parseTranscriptFile(file, { limits: { maxEntries: 2 } }),
    ).rejects.toMatchObject({ code: "too-many-records" });
  });

  it("drops a timestamp that is not ISO-8601 instead of retaining it", async () => {
    const file = writeTemp(
      "codex-badtime.jsonl",
      [
        JSON.stringify({
          timestamp: "2026-05-03T00:00:00.000Z",
          type: "session_meta",
          payload: { id: "33333333-3333-4333-8333-333333333333", cwd: "C:/x" },
        }),
        JSON.stringify({
          timestamp: "yesterday, about tea time".repeat(4),
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "no usable time" }],
          },
        }),
      ].join("\n"),
    );

    const result = await parseTranscriptFile(file);
    expect(result.entries[0]?.at).toBeNull();
    expect(result.startedAt).toBe("2026-05-03T00:00:00.000Z");
    expect(JSON.stringify(result)).not.toContain("tea time");
  });
});

/** A minimal Codex rollout around `payloads`, for byte-accounting tests. */
function codexFile(name: string, payloads: unknown[]): string {
  return writeTemp(
    name,
    [
      JSON.stringify({
        timestamp: "2026-06-01T00:00:00.000Z",
        type: "session_meta",
        payload: { id: "33333333-3333-4333-8333-333333333333", cwd: "C:/x" },
      }),
      ...payloads.map((payload, i) =>
        JSON.stringify({
          timestamp: `2026-06-01T00:00:0${i % 10}.000Z`,
          type: "response_item",
          payload,
        }),
      ),
    ].join("\n"),
  );
}

describe("serialized-size accounting", () => {
  it("reports normalizedBytes equal to the snapshot's own serialized size", async () => {
    const result = await parseTranscriptFile(fixture("codex-rollout.jsonl"));
    expect(result.counts.normalizedBytes).toBe(Buffer.byteLength(JSON.stringify(result), "utf8"));
  });

  it("charges control characters at their escaped cost, not their raw byte", async () => {
    // 300 control characters: 300 raw UTF-8 bytes, but 1,800 bytes of JSON
    // (`\u0001` is six). A raw-byte budget would wave this through.
    const control = "\u0001".repeat(300);
    const file = codexFile("codex-control.jsonl", [
      { type: "message", role: "user", content: [{ type: "input_text", text: control }] },
    ]);

    await expect(
      parseTranscriptFile(file, { limits: { maxNormalizedBytes: 1_200 } }),
    ).rejects.toMatchObject({ code: "normalized-too-large" });

    const result = await parseTranscriptFile(file);
    const entry = result.entries[0];
    expect(entry?.text).toBe(control);
    expect(Buffer.byteLength(entry?.text ?? "", "utf8")).toBe(300);
    expect(result.counts.normalizedBytes).toBeGreaterThan(1_800);
    expect(result.counts.normalizedBytes).toBe(Buffer.byteLength(JSON.stringify(result), "utf8"));
  });

  it("counts the envelope, so a tiny transcript can still be too large", async () => {
    const file = codexFile("codex-envelope.jsonl", [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    ]);

    // The one entry is a few dozen bytes; the envelope (path, hash, counts,
    // tallies) is what carries this past a 300-byte cap.
    const kept = await parseTranscriptFile(file);
    const entryBytes = Buffer.byteLength(JSON.stringify(kept.entries), "utf8");
    expect(entryBytes).toBeLessThan(300);
    expect(kept.counts.normalizedBytes).toBeGreaterThan(300);

    await expect(
      parseTranscriptFile(file, { limits: { maxNormalizedBytes: 300 } }),
    ).rejects.toMatchObject({ code: "normalized-too-large" });
  });

  it("keeps the count exact after suppressed echoes are re-indexed", async () => {
    const result = await parseTranscriptFile(fixture("codex-mixed-echo.jsonl"));
    expect(result.entries.map((entry) => entry.index)).toEqual([0, 1, 2, 3]);
    expect(result.counts.normalizedBytes).toBe(Buffer.byteLength(JSON.stringify(result), "utf8"));
  });
});

describe("resolveLimits", () => {
  it("accepts a tightening override and returns the shipped values otherwise", () => {
    expect(resolveLimits()).toEqual(IMPORT_LIMITS);
    expect(resolveLimits({ maxRecords: 5 })).toEqual({ ...IMPORT_LIMITS, maxRecords: 5 });
  });

  it("refuses anything that would raise or disable a bound", () => {
    for (const bad of [
      { maxRecords: IMPORT_LIMITS.maxRecords + 1 },
      { maxSourceBytes: Number.POSITIVE_INFINITY },
      { maxNormalizedBytes: Number.NaN },
      { maxEntries: 0 },
      { maxEntries: -1 },
      { maxMessageBytes: 12.5 },
      { maxToolTextBytes: "64" as unknown as number },
      { notALimit: 1 } as unknown as Partial<typeof IMPORT_LIMITS>,
    ]) {
      expect(() => resolveLimits(bad)).toThrow(ImportError);
    }
  });

  it("is enforced through the parser entry point too", async () => {
    await expect(
      parseTranscriptFile(fixture("codex-rollout.jsonl"), {
        limits: { maxNormalizedBytes: IMPORT_LIMITS.maxNormalizedBytes * 2 },
      }),
    ).rejects.toMatchObject({ code: "unsupported-structure" });
  });
});

describe("echo dedup multiplicity", () => {
  it("suppresses one echo per canonical occurrence, keeping the rest", async () => {
    const file = writeTemp(
      "codex-repeats.jsonl",
      [
        JSON.stringify({
          timestamp: "2026-07-01T00:00:00.000Z",
          type: "session_meta",
          payload: { id: "33333333-3333-4333-8333-333333333333", cwd: "C:/x" },
        }),
        JSON.stringify({
          timestamp: "2026-07-01T00:00:01.000Z",
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "yes" }] },
        }),
        JSON.stringify({
          timestamp: "2026-07-01T00:00:02.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "yes" },
        }),
        JSON.stringify({
          timestamp: "2026-07-01T00:00:03.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "yes" },
        }),
      ].join("\n"),
    );

    const result = await parseTranscriptFile(file);
    // One canonical "yes" accounts for one echo; the second echo is a turn the
    // canonical items do not cover, so it survives.
    expect(texts(result)).toEqual(["message:yes", "message:yes"]);
    expect(result.counts.echoedEvents).toBe(1);
    expect(result.complete).toBe(false);
    expect(result.warnings.map((warning) => warning.code)).toEqual(["codex.event-echo-mixed"]);
  });
});

describe("Claude content semantics", () => {
  it("keeps truncation provenance across the SDK hop, even below the marker size", async () => {
    const long = "ünïcode ".repeat(400);
    const file = writeTemp(
      "claude-long.jsonl",
      [
        JSON.stringify({
          type: "user",
          uuid: "u-1",
          parentUuid: null,
          sessionId: "11111111-1111-4111-8111-111111111111",
          timestamp: "2026-08-02T00:00:00.000Z",
          message: { role: "user", content: long },
        }),
      ].join("\n"),
    );

    // 8 bytes: too small for the marker itself, so only the flag can tell the
    // truth about what happened.
    const tiny = await parseTranscriptFile(file, {
      reconstruct: fakeReconstructor(),
      limits: { maxMessageBytes: 8 },
    });
    const entry = tiny.entries[0];
    expect(entry?.truncated).toBe(true);
    expect(tiny.counts.truncatedTexts).toBe(1);
    expect(Buffer.byteLength(entry?.text ?? "", "utf8")).toBeLessThanOrEqual(8);

    const whole = await parseTranscriptFile(file, { reconstruct: fakeReconstructor() });
    expect(whole.entries[0]?.truncated).toBe(false);
    expect(whole.counts.truncatedTexts).toBe(0);
  });

  it("bounds a tool name before it reaches the SDK", async () => {
    const reconstruct = fakeReconstructor();
    const file = writeTemp(
      "claude-bigtoolname.jsonl",
      JSON.stringify({
        type: "assistant",
        uuid: "a-1",
        parentUuid: null,
        sessionId: "11111111-1111-4111-8111-111111111111",
        timestamp: "2026-08-02T00:00:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "N".repeat(5_000), input: {} }],
        },
      }),
    );

    const result = await parseTranscriptFile(file, { reconstruct, limits: { maxLabelChars: 40 } });
    const staged = reconstruct.seen[0]?.message?.content[0];
    expect(staged?.type).toBe("tool_use");
    expect(staged?.type === "tool_use" ? staged.name.length : Infinity).toBeLessThanOrEqual(40);
    expect(JSON.stringify(reconstruct.seen)).not.toContain("N".repeat(41));
    expect(result.entries[0]?.label.length).toBeLessThanOrEqual(40);
  });

  it("labels meta prose as historical system text and drops known config wrappers", async () => {
    const result = await parseTranscriptFile(fixture("claude-meta.jsonl"), {
      reconstruct: fakeReconstructor(),
    });

    expect(
      result.entries.map((entry) => [
        entry.kind === "message" ? entry.speaker : entry.kind,
        entry.label,
        entry.text,
      ]),
    ).toEqual([
      ["system", "system (historical)", "The user opened a new terminal."],
      ["system", "compacted summary (historical)", "Summary of the earlier conversation."],
      ["user", "user", "the real question"],
      ["assistant", "assistant", "the real answer"],
      // The reminder body is gone; what the user typed after it is not.
      ["user", "user", "please refactor the loader"],
      ["user", "user", "adjacent ordinary text"],
      // A typed slash command becomes an inert historical note.
      ["notice", "/init (historical)", "/init --force src"],
      // A marker mid-sentence is ordinary prose.
      ["user", "user", "Does a <system-reminder> ever show up mid-sentence like this?"],
    ]);
    // The command-output wrapper is configuration, counted and not retained.
    expect(JSON.stringify(result)).not.toContain("branch is clean");
    // local-command-stdout, two reminder bodies and the unterminated wrapper.
    expect(result.counts.droppedConfiguration).toBe(4);
    // Meta and compaction prose never become the title.
    expect(result.title).toBe("the real question");

    // The unreadable content block is an omission, not silence.
    expect(result.complete).toBe(false);
    expect(result.warnings.map((warning) => warning.code).sort()).toEqual([
      "claude.compacted",
      "claude.unsupported-content",
      "claude.unterminated-wrapper",
    ]);
    expect(result.unknownTypes).toEqual([{ type: "chart", count: 1 }]);
    expect(JSON.stringify(result)).not.toContain("UNREADABLE");
  });

  it("marks a dropped attachment as an omission", async () => {
    const result = await parseTranscriptFile(fixture("claude-chain.jsonl"), {
      reconstruct: fakeReconstructor(),
    });
    expect(result.complete).toBe(false);
    expect(result.warnings.find((w) => w.code === "claude.attachment-dropped")?.count).toBe(1);
  });
});

describe("Codex injected context", () => {
  it("drops recognized injected fragments without dropping the real text", async () => {
    const result = await parseTranscriptFile(fixture("codex-injected-context.jsonl"));

    expect(
      result.entries.map((entry) => [entry.kind, entry.label, entry.text]),
    ).toEqual([
      ["notice", "interrupted (historical)", "(the previous turn was interrupted)"],
      ["message", "user", "why is the branch dirty?"],
      // Ordinary prose that merely mentions a marker is not injected context.
      ["message", "user", "Does a message like <user_shell_command> ever appear in the docs?"],
    ]);

    // Injected instructions never become text, a title, or an echo key — the
    // trailing event echo of the AGENTS.md fragment is not resurrected either.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("always run the tests");
    expect(serialized).not.toContain("never ask");
    expect(result.title).toBe("why is the branch dirty?");
    // The echoed copy of the injected fragment is dropped as configuration
    // rather than resurrected as an unmatched echo.
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "codex.injected-context-mixed",
    ]);
    expect(result.counts.echoedEvents).toBe(0);
    // session_meta, the AGENTS.md item, the shell fragment, the developer
    // permissions block and the echoed copy of the AGENTS.md fragment.
    expect(result.counts.droppedConfiguration).toBe(5);
  });

  it.each([
    ["<user_instructions>", "user"],
    ["<environment_context>", "user"],
    ["<apps_instructions>", "developer"],
    ["<collaboration_mode>", "developer"],
    ["<multi_agent_mode>", "developer"],
    ["<environments_instructions>", "developer"],
    ["<plugins_instructions>", "developer"],
    ["<realtime_conversation>", "developer"],
    ["<skills_instructions>", "developer"],
    ["<tools>", "developer"],
    ["<context_window>", "developer"],
    ["<context_window_guidance>", "developer"],
  ] as const)("drops the pinned %s %s wrapper", async (prefix, role) => {
    const injected = `${prefix} private injected text`;
    const lines = [
      JSON.stringify({
        timestamp: "2026-09-02T00:00:00.000Z",
        type: "session_meta",
        payload: { id: "33333333-3333-4333-8333-333333333333" },
      }),
      JSON.stringify({
        timestamp: "2026-09-02T00:00:01.000Z",
        type: "response_item",
        payload:
          role === "user"
            ? {
                type: "message",
                role,
                content: [
                  { type: "input_text", text: injected },
                  { type: "input_text", text: "ordinary user text" },
                ],
              }
            : { type: "message", role, content: [{ type: "input_text", text: injected }] },
      }),
      ...(role === "user"
        ? [
            JSON.stringify({
              timestamp: "2026-09-02T00:00:02.000Z",
              type: "event_msg",
              payload: { type: "user_message", message: injected },
            }),
          ]
        : []),
      ...(role === "developer"
        ? [
            JSON.stringify({
              timestamp: "2026-09-02T00:00:03.000Z",
              type: "response_item",
              payload: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "ordinary user text" }],
              },
            }),
          ]
        : []),
    ];
    const result = await parseTranscriptFile(writeTemp(`codex-${role}-${prefix.slice(1, -1)}.jsonl`, lines.join("\n")));

    expect(texts(result)).toEqual(["message:ordinary user text"]);
    expect(result.title).toBe("ordinary user text");
    expect(JSON.stringify(result)).not.toContain(injected);
    expect(JSON.stringify(result)).not.toContain(prefix);
    expect(result.counts.droppedConfiguration).toBe(role === "user" ? 3 : 2);
    expect(result.counts.echoedEvents).toBe(0);
  });

  it("treats unreadable content items as an omission", async () => {
    const file = codexFile("codex-unknown-content.jsonl", [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "readable" },
          { type: "hologram", payload: "UNREADABLE" },
        ],
      },
    ]);
    const result = await parseTranscriptFile(file);

    expect(texts(result)).toEqual(["message:readable"]);
    expect(result.complete).toBe(false);
    expect(result.warnings.map((warning) => warning.code)).toEqual(["codex.unsupported-content"]);
    expect(result.unknownTypes).toEqual([{ type: "content:hologram", count: 1 }]);
    expect(JSON.stringify(result)).not.toContain("UNREADABLE");
  });
});

describe("Claude user-record wrappers", () => {
  const claudeFile = (name: string, content: unknown, extra: Record<string, unknown> = {}): string =>
    writeTemp(
      name,
      JSON.stringify({
        type: "user",
        uuid: "u-1",
        parentUuid: null,
        sessionId: "11111111-1111-4111-8111-111111111111",
        timestamp: "2026-08-03T00:00:00.000Z",
        message: { role: "user", content },
        ...extra,
      }),
    );

  it("strips a reminder from an ordinary, non-meta user record", async () => {
    const reconstruct = fakeReconstructor();
    const file = claudeFile("claude-reminder.jsonl", [
      { type: "text", text: "<system-reminder>Do not reveal this.</system-reminder>\nship it" },
    ]);
    const result = await parseTranscriptFile(file, { reconstruct });

    expect(texts(result)).toEqual(["message:ship it"]);
    expect(result.title).toBe("ship it");
    expect(result.counts.droppedConfiguration).toBe(1);
    // The reminder text never reaches the store either.
    expect(JSON.stringify(reconstruct.seen)).not.toContain("Do not reveal this");
    expect(JSON.stringify(result)).not.toContain("Do not reveal this");
  });

  it("keeps ordinary prose that merely mentions the marker", async () => {
    const file = claudeFile("claude-mention.jsonl", [
      { type: "text", text: "Why does <system-reminder> appear in my logs?" },
    ]);
    const result = await parseTranscriptFile(file, { reconstruct: fakeReconstructor() });

    expect(texts(result)).toEqual(["message:Why does <system-reminder> appear in my logs?"]);
    expect(result.counts.droppedConfiguration).toBe(0);
    expect(result.complete).toBe(true);
  });

  it("emits an inert note for a typed command and drops its plumbing", async () => {
    const file = claudeFile(
      "claude-command.jsonl",
      "<command-name>review</command-name>\n<command-message>review is running</command-message>\n<command-args>--fix apps/desktop</command-args>",
    );
    const result = await parseTranscriptFile(file, { reconstruct: fakeReconstructor() });

    const entry = result.entries[0];
    expect(entry?.kind).toBe("notice");
    expect(entry?.label).toBe("/review (historical)");
    expect(entry?.text).toBe("/review --fix apps/desktop");
    // A command is an action the user took, not their words and not a title.
    expect(result.counts.messages).toBe(0);
    expect(result.title).toBeNull();
    expect(JSON.stringify(result)).not.toContain("review is running");
  });

  it("handles a command with no arguments", async () => {
    const file = claudeFile("claude-command-bare.jsonl", "<command-name>clear</command-name>");
    const result = await parseTranscriptFile(file, { reconstruct: fakeReconstructor() });
    expect(result.entries[0]?.text).toBe("/clear");
  });

  it("bounds a command's arguments and keeps the truncation honest", async () => {
    const file = claudeFile(
      "claude-command-long.jsonl",
      `<command-name>run</command-name><command-args>${"ünïcode ".repeat(300)}</command-args>`,
    );
    const result = await parseTranscriptFile(file, {
      reconstruct: fakeReconstructor(),
      limits: { maxMessageBytes: 64 },
    });

    const entry = result.entries[0];
    expect(entry?.truncated).toBe(true);
    expect(result.counts.truncatedTexts).toBe(1);
    expect(Buffer.byteLength(entry?.text ?? "", "utf8")).toBeLessThanOrEqual(64 + "/run ".length);
    expect(result.counts.normalizedBytes).toBe(Buffer.byteLength(JSON.stringify(result), "utf8"));
  });

  it("omits an unterminated wrapper's contents and says that it did", async () => {
    for (const [name, text] of [
      ["claude-open-reminder.jsonl", "<system-reminder>never closed, and the rest is unknown"],
      ["claude-open-command.jsonl", "<command-name>half-written"],
    ] as const) {
      const result = await parseTranscriptFile(claudeFile(name, [{ type: "text", text }]), {
        reconstruct: fakeReconstructor(),
      });

      expect(result.entries).toEqual([]);
      expect(result.complete).toBe(false);
      expect(result.warnings.map((warning) => warning.code)).toEqual([
        "claude.unterminated-wrapper",
      ]);
      expect(result.counts.droppedConfiguration).toBe(1);
      expect(JSON.stringify(result)).not.toContain("the rest is unknown");
      expect(JSON.stringify(result)).not.toContain("half-written");
    }
  });
  it("removes consecutive leading reminders before keeping the user's text", async () => {
    const reconstruct = fakeReconstructor();
    const result = await parseTranscriptFile(claudeFile("consecutive-reminders.jsonl",
      "<system-reminder>first configuration</system-reminder>\n<system-reminder>second configuration</system-reminder>\nDo the task"), { reconstruct });
    expect(texts(result)).toEqual(["message:Do the task"]);
    expect(result.title).toBe("Do the task");
    expect(result.counts.droppedConfiguration).toBe(2);
    expect(JSON.stringify(reconstruct.seen)).not.toContain("configuration");
  });

  it("keeps an existing slash in a historical command name", async () => {
    const result = await parseTranscriptFile(claudeFile("slash-name.jsonl",
      "<command-name>/review</command-name>"), { reconstruct: fakeReconstructor() });
    expect(result.entries[0]?.text).toBe("/review");
    expect(result.entries[0]?.label).toBe("/review (historical)");
  });

  it("does not invent a command when its argument wrapper is truncated", async () => {
    const result = await parseTranscriptFile(claudeFile("open-args.jsonl",
      "<command-name>/review</command-name><command-args>unfinished arguments"), { reconstruct: fakeReconstructor() });
    expect(result.entries).toEqual([]);
    expect(result.complete).toBe(false);
    expect(result.warnings.map((warning) => warning.code)).toContain("claude.unterminated-wrapper");
  });

});
