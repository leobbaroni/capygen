/**
 * Settings ▸ Diagnostics (SPEC R19, R21).
 *
 * The load-bearing assertion is the last one: `diagnostics.copy` puts text on
 * the OS clipboard, so a key that reached this page would be one paste away
 * from a bug report. The tests below feed the service values shaped like every
 * secret this app can hold — a provider key, an OAuth token, an
 * `Authorization` header out of an MCP config — and assert that none of them
 * survives into either the object or the rendered text.
 */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseInvokeArgs,
  parseInvokeResult,
  type DiagnosticsInfo,
  type InvokeChannel,
} from "@capygen/shared";
import { createIpcContext, type IpcContext } from "../src/ipc/handlers.js";
import { DIAGNOSTICS_CHANNELS } from "../src/ipc/diagnostics.js";
import {
  DiagnosticsService,
  redact,
  renderDiagnostics,
} from "../src/integrations/DiagnosticsService.js";
import { createStubEngine } from "../src/engine/stub.js";
import { makeHarness, type Harness } from "./workspaceHarness.js";

let h: Harness;
let ipc: IpcContext;
let clipboard: string[];

async function call<C extends InvokeChannel>(channel: C, raw: unknown): Promise<unknown> {
  const args = parseInvokeArgs(channel, raw);
  const handler = ipc.handlers[channel] as (a: unknown) => unknown;
  return parseInvokeResult(channel, await handler(args));
}

beforeEach(() => {
  h = makeHarness({ prefix: "capygen-diag-" });
  clipboard = [];
  ipc = createIpcContext({
    store: h.store,
    broadcast: h.broadcast,
    log: h.log,
    makeEngine: createStubEngine,
    pickDirectory: async () => null,
    appInfo: () => ({
      name: "capygen",
      version: "0.1.0",
      electron: "44.2.0",
      chrome: "144.0.0",
      node: "24.20.0",
      platform: "win32",
      userDataDir: h.dir,
      logFile: path.join(h.dir, "logs", "capygen.log"),
      dbFile: h.store.db.file,
    }),
    listHarnesses: () => [
      { backend: "claude", label: "Claude Code", available: true, models: [], defaultModel: "x", providers: [] },
      {
        backend: "api",
        label: "API model",
        available: false,
        reason: "no API key stored — add one in Settings ▸ API keys",
        models: [],
        defaultModel: "",
      providers: [],
      },
    ],
    diagnostics: {
      writeClipboard: (text) => void clipboard.push(text),
      fileSize: () => 12_345,
      // Deterministic, and nothing spawns: the real one is `defaultCliProbe`.
      probe: async (command) =>
        command === "claude"
          ? { ok: true, version: "2.1.261 (Claude Code)" }
          : { ok: false, reason: "not found" },
      env: {
        ANTHROPIC_API_KEY: "sk-ant-api03-THISISASECRETVALUE0123456789",
        CLAUDE_CONFIG_DIR: path.join(h.dir, "claude"),
      },
      home: h.dir,
    },
    integrations: {
      env: { CLAUDE_CONFIG_DIR: path.join(h.dir, "claude"), CODEX_HOME: path.join(h.dir, "codex") },
      home: h.dir,
      createWatcher: () => ({ on: () => undefined, close: () => undefined }),
    },
  });
});

afterEach(async () => {
  await ipc.dispose();
  h.close();
});

describe("contract coverage", () => {
  it("answers exactly the two diagnostics channels", () => {
    expect([...DIAGNOSTICS_CHANNELS]).toEqual(["diagnostics.get", "diagnostics.copy"]);
    for (const channel of DIAGNOSTICS_CHANNELS) {
      expect(typeof ipc.handlers[channel]).toBe("function");
    }
  });
});

describe("diagnostics.get", () => {
  it("reports versions, paths, backends and the database size", async () => {
    const info = (await call("diagnostics.get", {})) as DiagnosticsInfo;
    expect(info.versions.app).toBe("capygen 0.1.0");
    expect(info.versions.electron).toBe("44.2.0");
    expect(info.versions.claude).toBe("2.1.261 (Claude Code)");
    expect(info.versions.codex).toBe("not found");
    expect(info.paths.claudeHome).toBe(path.join(h.dir, "claude"));
    expect(info.paths.codexHome).toBe(path.join(h.dir, ".codex"));
    expect(info.dbSizeBytes).toBe(12_345);
    expect(info.logDir).toBe(path.join(h.dir, "logs"));
  });

  it("agrees with harness.list about which backends are usable", async () => {
    const info = (await call("diagnostics.get", {})) as DiagnosticsInfo;
    expect(info.harnessAvailability).toEqual([
      { backend: "claude", available: true },
      { backend: "api", available: false, reason: "no API key stored — add one in Settings ▸ API keys" },
    ]);
  });

  it("reports an API key as present, never by value (R21)", async () => {
    const info = (await call("diagnostics.get", {})) as DiagnosticsInfo;
    expect(info.versions["env.ANTHROPIC_API_KEY"]).toBe("set");
    expect(info.versions["env.OPENAI_API_KEY"]).toBe("not set");
    expect(JSON.stringify(info)).not.toContain("THISISASECRET");
  });
});

describe("diagnostics.copy", () => {
  it("copies a rendered, redacted report", async () => {
    expect(await call("diagnostics.copy", {})).toEqual({ ok: true });
    expect(clipboard).toHaveLength(1);
    const text = clipboard[0] as string;
    expect(text).toContain("capygen diagnostics");
    expect(text).toContain("- claude: 2.1.261 (Claude Code)");
    expect(text).toContain("- database: 12.1 KB");
    expect(text).toContain("- api: unavailable — no API key stored");
    expect(text).not.toContain("THISISASECRET");
  });

  it("refuses loudly when no clipboard is wired", async () => {
    const service = new DiagnosticsService({
      log: h.log,
      appInfo: () => ({
        name: "capygen",
        version: "0",
        electron: "",
        chrome: "",
        node: "",
        platform: "win32",
        userDataDir: "",
        logFile: "",
        dbFile: "",
      }),
      listHarnesses: () => [],
      probe: async () => ({ ok: false }),
    });
    await expect(service.copy()).rejects.toThrow(/no clipboard is wired/);
  });
});

describe("redact", () => {
  it("blanks every secret shape this app can actually hold", () => {
    expect(redact("sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF")).toBe("sk-ant-[redacted]");
    expect(redact("key=sk-proj-ZZZZYYYYXXXXWWWW1234")).toContain("[redacted]");
    // A short `Bearer <token>` used to survive: "Bearer" is what followed the
    // colon, and the token was under the entropy rule's length. The whole rest
    // of the line goes now.
    expect(redact("Authorization: Bearer abcdefghijklmnop")).toBe("Authorization: [redacted]");
    expect(redact('x-api-key = "0123456789abcdef"')).toBe("x-api-key = [redacted]");
    expect(
      redact("token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9aaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ).not.toContain("eyJhbG");
  });

  it("leaves an ordinary path and version alone", () => {
    expect(redact("C:\\Users\\TugaPlayz\\.claude")).toBe("C:\\Users\\TugaPlayz\\.claude");
    expect(redact("2.1.261 (Claude Code)")).toBe("2.1.261 (Claude Code)");
    expect(redact("claude-opus-4-5")).toBe("claude-opus-4-5");
  });

  it("is applied again at render time, not only at collection time", () => {
    // Belt and braces: a future probe that forgets to redact still cannot put
    // a token on the clipboard.
    const text = renderDiagnostics({
      versions: { rogue: "sk-ant-api03-LEAKEDLEAKEDLEAKED1234" },
      paths: { home: "C:\\Users\\x" },
      harnessAvailability: [
        { backend: "claude", available: false, reason: "token sk-ant-api03-ALSOLEAKED12345678" },
      ],
      dbSizeBytes: 0,
      logDir: "C:\\logs",
    });
    expect(text).not.toContain("LEAKED");
    expect(text).toContain("C:\\Users\\x");
  });
});
