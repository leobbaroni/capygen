/**
 * capygen Phase 3 spike — MCP Apps (SPEC R31, PLAN A13).
 *
 * Answers the one question the widget host cannot be built without: **where
 * does the `ui://` HTML come from** for a server the backend hosts, not us?
 *
 * Steps (`SPIKE_STEPS=client,claude,higgs`, all by default):
 *
 *   status  `Query.mcpServerStatus()` on a streaming session with the fixture
 *           registered: which servers the CLI has, their `config` (this is how
 *           capygen learns whether it can open its own client to one) and
 *           whether the status listing carries the tools' `_meta`. No prompt is
 *           sent, so no model turn and no cost.
 *   client  capygen's own MCP client against the fixture server
 *           (tests/fixtures/mcp-apps-server): tools/list `_meta`,
 *           resources/read on the `ui://` uri, tools/call of the widget's
 *           own tool. No model, no cost.
 *   claude  the Claude Agent SDK with the same server passed through
 *           `options.mcpServers`, asked to call `show_card`: records exactly
 *           what the stream exposes for that call (tool_use, tool_result,
 *           tool_use_result, `_meta`, structuredContent, resource_links) and
 *           whether any SDK surface returns the resource itself.
 *   higgs   the user's Higgsfield claude.ai connector (a `claudeai-proxy`
 *           server the CLI owns): `balance` only — it is free and read-only.
 *           NEVER call a generating tool here.
 *
 * Raw stream → docs/spikes/mcp-apps.raw.json (gitignored).
 * Trimmed evidence → docs/spikes/mcp-apps.evidence.json (committed).
 *
 * Run: corepack pnpm --dir packages/engine exec tsx scripts/spike-mcp-apps.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { cleanEnv } from "../src/env.js";
import { requireIsolatedHomes, TEST_CLAUDE_MODEL, TEST_EFFORT } from "./test-policy.js";

const REPO = "C:/Users/TugaPlayz/Desktop/GITHUB/capygen";
const FIXTURE = `${REPO}/tests/fixtures/mcp-apps-server/server.mjs`;
const RAW = `${REPO}/docs/spikes/mcp-apps.raw.json`;
const EVIDENCE = `${REPO}/docs/spikes/mcp-apps.evidence.json`;
const TIMEOUT_MS = 240_000;

const steps = new Set((process.env.SPIKE_STEPS ?? "status,client,claude,higgs,higgscost").split(","));

type LogEntry = { step: string; t: number; kind: string; data: unknown };
const log: LogEntry[] = [];
const evidence: Record<string, unknown> = {};
const t0 = Date.now();

function rec(step: string, kind: string, data: unknown): void {
  log.push({ step, t: Date.now() - t0, kind, data });
}
/**
 * Steps are run separately (`SPIKE_STEPS=client`, then `claude`, then `higgs`),
 * because one of them costs tokens and another needs a signed-in CLI. So the
 * evidence file is *merged*, never overwritten: a re-run of one step must not
 * erase what the other steps proved.
 */
function flush(): void {
  mkdirSync(dirname(RAW), { recursive: true });
  writeFileSync(RAW, JSON.stringify(log, null, 1), "utf8");
  let previous: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(EVIDENCE, "utf8"));
    if (parsed && typeof parsed === "object") previous = parsed as Record<string, unknown>;
  } catch {
    /* first run, or a half-written file — start from nothing */
  }
  writeFileSync(EVIDENCE, JSON.stringify({ ...previous, ...evidence }, null, 2), "utf8");
}
function cap(name: string, status: "PASS" | "PARTIAL" | "FAIL", detail: string): void {
  console.log(`CAP ${name} ${status} - ${detail}`);
}
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// step: client — our own MCP client, the path the widget host would use
// ---------------------------------------------------------------------------

async function stepClient(): Promise<void> {
  const client = new Client(
    { name: "capygen-spike", version: "0.1.0" },
    // MCP Apps capability negotiation (ext-apps `EXTENSION_ID`): servers may
    // register app tools only when the client says it can render them.
    {
      capabilities: {
        experimental: {},
      },
    },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [FIXTURE],
    env: cleanEnv() as Record<string, string>,
  });
  await client.connect(transport);

  const tools = await client.listTools();
  rec("client", "tools/list", tools);
  const resources = await client.listResources();
  rec("client", "resources/list", resources);

  const showCard = tools.tools.find((t) => t.name === "show_card");
  const uri = readUiResourceUri(showCard?._meta);
  const read = uri ? await client.readResource({ uri }) : null;
  rec("client", "resources/read", read);

  const called = await client.callTool({
    name: "show_card",
    arguments: { title: "Spike card", note: "from the client step" },
  });
  rec("client", "tools/call show_card", called);
  const echoed = await client.callTool({ name: "echo", arguments: { text: "ping" } });
  rec("client", "tools/call echo", echoed);

  const contents = (read?.contents ?? []) as Array<Record<string, unknown>>;
  const first = contents[0];
  const html = typeof first?.text === "string" ? first.text : "";

  evidence.client = {
    toolNames: tools.tools.map((t) => t.name),
    showCardMeta: showCard?._meta ?? null,
    resourceUri: uri ?? null,
    resourceMimeType: first?.mimeType ?? null,
    resourceMeta: first?._meta ?? null,
    htmlBytes: html.length,
    htmlHead: html.slice(0, 120),
    showCardResult: called,
    echoResult: echoed,
  };
  await client.close();

  cap(
    "own_mcp_client_resource_read",
    html.length > 0 ? "PASS" : "FAIL",
    `${uri ?? "no ui:// uri"} → ${html.length} bytes of ${String(first?.mimeType)}`,
  );
  cap(
    "own_mcp_client_call_tool",
    Array.isArray((echoed as { content?: unknown[] }).content) ? "PASS" : "FAIL",
    JSON.stringify((echoed as { content?: unknown[] }).content),
  );
}

/** ext-apps `getToolUiResourceUri`, inlined so the spike has no host import. */
function readUiResourceUri(meta: unknown): string | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const record = meta as Record<string, unknown>;
  const nested = record.ui;
  if (nested && typeof nested === "object") {
    const value = (nested as Record<string, unknown>).resourceUri;
    if (typeof value === "string" && value.startsWith("ui://")) return value;
  }
  const flat = record["ui/resourceUri"];
  if (typeof flat === "string" && flat.startsWith("ui://")) return flat;
  return undefined;
}

// ---------------------------------------------------------------------------
// Claude SDK runner
// ---------------------------------------------------------------------------

interface RunResult {
  messages: SDKMessage[];
  error?: string;
}

async function runClaude(step: string, prompt: string, extra: Partial<Options>): Promise<RunResult> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const abort = new AbortController();
  const out: RunResult = { messages: [] };
  const timer = setTimeout(() => {
    rec(step, "timeout", { ms: TIMEOUT_MS });
    abort.abort();
  }, TIMEOUT_MS);
  try {
    const q = query({
      prompt,
      options: {
        cwd: REPO,
        env: cleanEnv(),
        abortController: abort,
        model: TEST_CLAUDE_MODEL,
        effort: TEST_EFFORT,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: ["user", "project"],
        maxTurns: 6,
        stderr: (chunk: string) => rec(step, "stderr", chunk.trimEnd()),
        ...extra,
      },
    });
    for await (const message of q) {
      out.messages.push(message);
      rec(step, `message:${message.type}`, redact(message));
    }
  } catch (err) {
    out.error = describe(err);
    rec(step, "error", out.error);
  } finally {
    clearTimeout(timer);
  }
  return out;
}

requireIsolatedHomes("spike-mcp-apps");

function redact(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, v) =>
      (key === "email" || key === "organization") && typeof v === "string" ? "<redacted>" : v,
    ),
  );
}

interface ToolCallTrace {
  name: string;
  id: string;
  input: unknown;
  meta: unknown;
  /** The assistant message's own `tool_use_meta[]` entry for this id, if any. */
  frameMeta: unknown;
  resultContent: unknown;
  resultMeta: unknown;
  toolUseResult: unknown;
  structuredContent: unknown;
  resourceLinks: unknown;
  isError: unknown;
}

/** Pull every tool_use/tool_result pair out of a run, with all `_meta` kept. */
function traceToolCalls(messages: SDKMessage[], match: (name: string) => boolean): ToolCallTrace[] {
  const traces = new Map<string, ToolCallTrace>();
  for (const raw of messages) {
    const message = raw as unknown as Record<string, unknown>;
    if (message.type === "assistant") {
      const inner = message.message as { content?: unknown[] } | undefined;
      for (const block of inner?.content ?? []) {
        const b = block as Record<string, unknown>;
        if (b.type !== "tool_use") continue;
        const name = String(b.name ?? "");
        if (!match(name)) continue;
        const frameMeta = Array.isArray(message.tool_use_meta)
          ? (message.tool_use_meta as Array<Record<string, unknown>>).find(
              (m) => String(m.id) === String(b.id),
            )
          : undefined;
        traces.set(String(b.id), {
          name,
          id: String(b.id),
          input: b.input ?? null,
          meta: b._meta ?? null,
          frameMeta: frameMeta ?? null,
          resultContent: null,
          resultMeta: null,
          toolUseResult: null,
          structuredContent: null,
          resourceLinks: null,
          isError: null,
        });
      }
    }
    if (message.type === "user") {
      const inner = message.message as { content?: unknown[] } | undefined;
      for (const block of inner?.content ?? []) {
        const b = block as Record<string, unknown>;
        if (b.type !== "tool_result") continue;
        const trace = traces.get(String(b.tool_use_id));
        if (!trace) continue;
        trace.resultContent = b.content ?? null;
        trace.resultMeta = b._meta ?? null;
        trace.isError = b.is_error ?? null;
        const tur = message.tool_use_result;
        trace.toolUseResult = tur ?? null;
        if (tur && typeof tur === "object") {
          const r = tur as Record<string, unknown>;
          trace.structuredContent = r.structuredContent ?? null;
          trace.resourceLinks = r.resourceLinks ?? null;
        }
      }
    }
  }
  return [...traces.values()];
}

// ---------------------------------------------------------------------------
// step: claude — the fixture server, registered through options.mcpServers
// ---------------------------------------------------------------------------

async function stepClaude(): Promise<void> {
  const run = await runClaude(
    "claude",
    'Call the capyfixture MCP tool "show_card" with title "Hello from capygen" and ' +
      'note "spike". Then reply with exactly the word done. Do not call any other tool.',
    {
      mcpServers: {
        capyfixture: {
          type: "stdio",
          command: process.execPath,
          args: [FIXTURE],
          alwaysLoad: true,
        },
      },
    },
  );

  const init = run.messages.find(
    (m) => (m as { type?: string }).type === "system",
  ) as unknown as Record<string, unknown> | undefined;
  const traces = traceToolCalls(run.messages, (n) => n.includes("show_card"));
  rec("claude", "traces", traces);

  const trace = traces[0];
  evidence.claudeFixture = {
    mcpServersFromInit: init?.mcpServers ?? null,
    toolNameOnTheWire: trace?.name ?? null,
    toolUseMeta: trace?.meta ?? null,
    toolUseMetaFrame: trace?.frameMeta ?? null,
    toolResultContent: trace?.resultContent ?? null,
    toolResultMeta: trace?.resultMeta ?? null,
    toolUseResult: trace?.toolUseResult ?? null,
    structuredContent: trace?.structuredContent ?? null,
    resourceLinks: trace?.resourceLinks ?? null,
    error: run.error ?? null,
  };

  cap(
    "claude_stream_exposes_mcp_tool_call",
    trace ? "PASS" : "FAIL",
    trace ? `${trace.name} → ${JSON.stringify(trace.resultContent).slice(0, 160)}` : "no trace",
  );
  const anyUiMeta =
    readUiResourceUri(trace?.meta) ?? readUiResourceUri(trace?.resultMeta) ?? null;
  cap(
    "claude_stream_exposes_ui_meta",
    anyUiMeta ? "PASS" : "FAIL",
    anyUiMeta ?? "no ui:// uri anywhere on the tool_use / tool_result frames",
  );
}

// ---------------------------------------------------------------------------
// step: higgs — the user's claude.ai connector (proxy server, CLI-owned)
// ---------------------------------------------------------------------------

async function stepHiggs(): Promise<void> {
  const run = await runClaude(
    "higgs",
    "Call the Higgsfield MCP tool `balance` once to show my credit balance, then " +
      "reply with exactly the word done. Do not call any image, video or audio " +
      "generating tool.",
    {},
  );

  const init = run.messages.find(
    (m) => (m as { type?: string }).type === "system",
  ) as unknown as Record<string, unknown> | undefined;
  const servers = (init?.mcpServers ?? []) as Array<Record<string, unknown>>;
  const traces = traceToolCalls(run.messages, (n) => /balance|higgs/i.test(n));
  rec("higgs", "traces", traces);
  const trace = traces[0];

  evidence.higgsfield = {
    servers: servers.map((s) => ({
      name: s.name,
      status: s.status,
      // The connector's own config shape is what decides whether capygen can
      // open its own client to it (a claudeai-proxy has no local command).
      config: s.config ?? null,
    })),
    toolNameOnTheWire: trace?.name ?? null,
    toolUseMeta: trace?.meta ?? null,
    toolUseMetaFrame: trace?.frameMeta ?? null,
    toolResultContent: trace?.resultContent ?? null,
    toolResultMeta: trace?.resultMeta ?? null,
    toolUseResult: trace?.toolUseResult ?? null,
    structuredContent: trace?.structuredContent ?? null,
    resourceLinks: trace?.resourceLinks ?? null,
    error: run.error ?? null,
  };

  cap(
    "higgsfield_tool_call_visible",
    trace ? "PASS" : "FAIL",
    trace ? trace.name : "no Higgsfield tool call in the stream",
  );
  const uri = readUiResourceUri(trace?.meta) ?? readUiResourceUri(trace?.resultMeta);
  cap(
    "higgsfield_ui_meta",
    uri ? "PASS" : "PARTIAL",
    uri ?? "no ui:// uri on the connector's tool frames (fallback card applies)",
  );
}

// ---------------------------------------------------------------------------
// step: higgscost — a Higgsfield *generating* tool asked only for its price
// ---------------------------------------------------------------------------

/**
 * `generate_image` with `get_cost: true` returns the credit cost and generates
 * nothing, so this is the only way to see what a Higgsfield tool that *does*
 * have a UI in Claude Code desktop (Animate / Edit / Download actions) puts on
 * the wire, without spending the user's credits. Never call a generating tool
 * here without `get_cost`.
 */
async function stepHiggsCost(): Promise<void> {
  const run = await runClaude(
    "higgscost",
    "Call the Higgsfield MCP tool `generate_image` exactly once with " +
      '{"prompt": "a capybara wearing a pink hoodie", "get_cost": true} so it only ' +
      "reports the price and generates nothing. Then reply with exactly the word done. " +
      "Never call it without get_cost:true.",
    {},
  );
  const traces = traceToolCalls(run.messages, (n) => /generate_image/i.test(n));
  rec("higgscost", "traces", traces);
  const trace = traces[0];

  evidence.higgsfieldGenerateImageCost = {
    toolNameOnTheWire: trace?.name ?? null,
    input: trace?.input ?? null,
    toolUseMeta: trace?.meta ?? null,
    toolUseMetaFrame: trace?.frameMeta ?? null,
    toolResultContent: trace?.resultContent ?? null,
    toolResultMeta: trace?.resultMeta ?? null,
    toolUseResult: trace?.toolUseResult ?? null,
    structuredContent: trace?.structuredContent ?? null,
    resourceLinks: trace?.resourceLinks ?? null,
    error: run.error ?? null,
  };

  const uri =
    readUiResourceUri(trace?.meta) ??
    readUiResourceUri(trace?.resultMeta) ??
    readUiResourceUri((trace?.toolUseResult as { _meta?: unknown })?._meta);
  cap(
    "higgsfield_generating_tool_ui_meta",
    uri ? "PASS" : "PARTIAL",
    uri ?? "no ui:// uri on generate_image's frames either (fallback card applies)",
  );
}

// ---------------------------------------------------------------------------
// step: status — what the SDK tells a host about the servers the CLI owns
// ---------------------------------------------------------------------------

/** Keep the shape of a connector's identity without logging the identity. */
function redactConfig(config: unknown): unknown {
  if (!config || typeof config !== "object") return config ?? null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
    if (typeof value !== "string") {
      out[key] = value;
      continue;
    }
    if (key === "url") {
      try {
        const url = new URL(value);
        out[key] = `${url.protocol}//${url.host}${url.pathname.replace(/\/[^/]{8,}/g, "/<id>")}`;
      } catch {
        out[key] = "<unparseable url>";
      }
    } else if (key === "id") {
      out[key] = `<${value.length}-char id>`;
    } else {
      out[key] = value;
    }
  }
  return out;
}

async function stepStatus(): Promise<void> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const abort = new AbortController();
  // Streaming input with nothing pushed: control requests work, no turn runs.
  const never: AsyncIterable<never> = {
    [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
  };
  const q = query({
    prompt: never as never,
    options: {
      cwd: REPO,
      env: cleanEnv(),
      abortController: abort,
      model: TEST_CLAUDE_MODEL,
      effort: TEST_EFFORT,
      permissionMode: "default",
      settingSources: ["user", "project"],
      mcpServers: {
        capyfixture: {
          type: "stdio",
          command: process.execPath,
          args: [FIXTURE],
          alwaysLoad: true,
        },
      },
      stderr: (chunk: string) => rec("status", "stderr", chunk.trimEnd()),
    },
  });
  try {
    const servers = await q.mcpServerStatus();
    rec("status", "mcpServerStatus", servers);
    evidence.mcpServerStatus = servers.map((s) => ({
      name: s.name,
      status: s.status,
      scope: s.scope ?? null,
      config: redactConfig(s.config),
      toolCount: s.tools?.length ?? null,
      toolKeys: s.tools?.[0] ? Object.keys(s.tools[0]) : null,
      // The question this step exists to answer: does the listing carry the
      // tools' `_meta` (and with it the `ui://` uri)?
      firstToolHasMeta:
        s.tools?.[0] !== undefined && "_meta" in (s.tools[0] as Record<string, unknown>),
    }));
    const fixture = servers.find((s) => s.name === "capyfixture");
    cap(
      "sdk_mcp_server_status_config",
      fixture?.config ? "PASS" : "FAIL",
      `capyfixture config=${JSON.stringify(redactConfig(fixture?.config))}`,
    );
    cap(
      "sdk_mcp_server_status_tool_meta",
      fixture?.tools?.some((t) => "_meta" in (t as Record<string, unknown>)) ? "PASS" : "FAIL",
      `tools[] keys = ${JSON.stringify(fixture?.tools?.[0] ? Object.keys(fixture.tools[0]) : [])}`,
    );
  } finally {
    q.close();
    abort.abort();
  }
}

const RUNNERS: Array<[string, () => Promise<void>]> = [
  ["status", stepStatus],
  ["client", stepClient],
  ["claude", stepClaude],
  ["higgs", stepHiggs],
  ["higgscost", stepHiggsCost],
];

for (const [name, run] of RUNNERS) {
  if (!steps.has(name)) continue;
  console.log(`\n--- step ${name} ---`);
  try {
    await run();
  } catch (err) {
    rec(name, "step-error", describe(err));
    cap(name, "FAIL", describe(err));
  }
}

flush();
console.log(`\nraw:      ${RAW}`);
console.log(`evidence: ${EVIDENCE}`);
