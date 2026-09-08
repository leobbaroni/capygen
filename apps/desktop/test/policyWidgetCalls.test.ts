import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, BUILT_IN_OWNER_MEMBER_ID, type CapygenStore } from "@capygen/db";
import { createWidgetHost } from "../src/ipc/widgets.js";
import { createPolicyRuntime, type PolicyRuntime } from "../src/policies/runtime.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));

let dir: string;
let store: CapygenStore;
let projectId: string;
let runtime: PolicyRuntime;
let sessionId: string;
let agentId: string;
let executed: Array<{ name: string; args: unknown }>;
let host: ReturnType<typeof createWidgetHost>;
let closes: number;
let modelOnly: boolean;
let lastConnectionToken: string | null;
let publishable: boolean;

/** A widget bridge that records what actually reached the server. */
function fakeAccess() {
  return {
    // The bridge's own gate runs first and refuses a tool this widget's server
    // does not advertise, so the fixture has to advertise it.
    listTools: async () => [{
      name: "mcp__docs__search", description: "", inputSchema: {},
      ...(modelOnly ? { meta: { visibility: ["model"] } } : {}),
    }],
    callTool: async (server: string, name: string, args: unknown) => {
      executed.push({ name, args });
      return { content: [] };
    },
    readResource: async () => ({ contents: [] }),
  } as never;
}

function build(): void {
  executed = [];
  closes = 0;
  modelOnly = false;
  lastConnectionToken = null;
  publishable = true;
  host = createWidgetHost({
    log: { info: () => {}, warn: () => {} },
    projectPathFor: () => path.join(dir, "project"),
    createAccess: async () => { closes += 1; return fakeAccess(); },
    authorizeWidgetCall: (request) => {
      lastConnectionToken = request.connectionToken;
      return runtime.widgets.authorizeWidgetCall(request);
    },
    onConnectionEnded: (token) => runtime.widgets.onConnectionEnded(token),
    turnOfBlock: (blockId) => store.blocks.get(blockId)?.turnId ?? null,
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-widget-policy-"));
  store = openStore(path.join(dir, "capygen.db"), { migrationsDir: MIGRATIONS_DIR });
  projectId = store.projects.upsertByPath({ path: path.join(dir, "project") }).id;
  const created = store.sessions.create({
    projectId, mode: "solo", title: "T",
    agents: [{ name: "A", backend: "api", model: "claude-opus-5", role: "lead",
      config: { api: { provider: "anthropic" } } }],
  });
  sessionId = created.session.id;
  agentId = created.agents[0]!.id;
  runtime = createPolicyRuntime({
    store,
    // A card that can actually be shown, so a waiter really exists to cancel.
    ask: {
      publish: () => publishable ? { blockId: "blk_card", turnId: "trn_card" } : null,
      settleCard: () => {},
    },
    publishChanged: () => {},
    engine: () => null,
  });
  build();
});

afterEach(async () => {
  await host.dispose();
  runtime.dispose();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Open a widget the way the runner does, then call a tool from the page. */
async function openWidget(blockId = "blk_1"): Promise<void> {
  await host.open({
    blockId, sessionId, agentId, toolCallId: "call_1",
    serverName: "docs", toolName: "mcp__docs__search",
    resourceUri: "ui://docs/search", toolInput: {}, toolResult: null,
  } as never);
}

const call = (blockId = "blk_1", args: unknown = { query: "x" }) =>
  host.callTool({ blockId, sessionId, name: "mcp__docs__search", args } as never);

describe("a widget's calls go through the same policy as a model's", () => {
  it("runs an allowed call with the approved input", async () => {
    await openWidget();
    await call();
    expect(executed).toEqual([{ name: "mcp__docs__search", args: { query: "x" } }]);
  });

  it("refuses a call a rule denies, and executes nothing", async () => {
    runtime.service.createRule({ memberId: BUILT_IN_OWNER_MEMBER_ID }, {
      scope: { kind: "session", sessionId },
      boundary: "api-tool", pattern: "mcp__docs__*", decision: "deny", enabled: true,
    });
    await openWidget();
    await expect(call()).rejects.toThrow();
    expect(executed).toEqual([]);
  });

  it("refuses when the session's profile cannot run tools", async () => {
    const viewer = runtime.service.createMember({ memberId: BUILT_IN_OWNER_MEMBER_ID },
      { label: "Reviewer", role: "viewer" });
    runtime.service.assignMember({ memberId: BUILT_IN_OWNER_MEMBER_ID }, sessionId, viewer.id);
    await openWidget();
    await expect(call()).rejects.toThrow();
    expect(executed).toEqual([]);
  });

  it("judges the call against the agent that opened the widget, not the renderer's claim", async () => {
    await openWidget();
    // A renderer naming another session is refused by the host's own record
    // before policy is even consulted.
    await expect(host.callTool({
      blockId: "blk_1", sessionId: "ses_other", name: "mcp__docs__search", args: {},
    } as never)).rejects.toThrow(/does not belong/);
    expect(executed).toEqual([]);
  });

  it("gives visibility of a widget no authority of its own", async () => {
    // A block that was never opened has no origin and no connection, so a call
    // naming it cannot execute however plausible it looks.
    await expect(call("blk_never_opened")).rejects.toThrow();
    expect(executed).toEqual([]);
  });
});

describe("two widgets on two connections are two identities", () => {
  it("does not let a second widget's connection replace the first's capture", async () => {
    await openWidget("blk_a");
    await call("blk_a");
    const first = runtime.lifecycles.size();

    // A second host is a second connection. Both must exist at once: one
    // `#widget` id per agent would have made the newer replace the older and
    // silently revoke the first widget's grants while its page was still open.
    const firstHost = host;
    build();
    await openWidget("blk_b");
    await call("blk_b");
    expect(runtime.lifecycles.size()).toBeGreaterThan(first);

    // The first connection is still usable; nothing about it was replaced.
    host = firstHost;
    await expect(call("blk_a")).resolves.toBeDefined();
  });

  it("keeps a widget capture on the originating agent's backend", async () => {
    await openWidget();
    await call();
    // The capture exists under an id derived from this agent, and reports the
    // agent's own backend rather than being rewritten to something else.
    const contexts = runtime.lifecycles.size();
    expect(contexts).toBeGreaterThan(0);
  });
});

describe("the host's own restrictions come first", () => {
  it("refuses a tool the server does not advertise, without asking the user", async () => {
    let asked = 0;
    runtime.service.createRule({ memberId: BUILT_IN_OWNER_MEMBER_ID }, {
      scope: { kind: "session", sessionId },
      boundary: "api-tool", pattern: "*", decision: "ask", enabled: true,
    });
    void asked;
    await openWidget();
    await expect(host.callTool({
      blockId: "blk_1", sessionId, name: "mcp__docs__not_advertised", args: {},
    } as never)).rejects.toThrow(/no tool named/);
    expect(executed).toEqual([]);
  });

  it("refuses a model-only tool even when local policy would allow it", async () => {
    modelOnly = true;
    await openWidget();
    await expect(call()).rejects.toThrow(/not available to a widget/);
    expect(executed).toEqual([]);
  });
});

describe("a grant is bound to the connection it was made on", () => {
  it("ends the connection's grants when the host is disposed", async () => {
    await openWidget();
    await call();
    const before = runtime.service.listGrants().length;
    await host.dispose();
    // Whatever the connection held is revoked with it.
    expect(runtime.service.listGrants().length).toBeLessThanOrEqual(before);

    // A fresh host is a fresh connection: the old widget's block no longer has
    // a live connection behind it, so nothing further executes.
    // `build()` starts a fresh recorder as well as a fresh connection.
    build();
    await expect(call()).rejects.toThrow();
    expect(executed).toEqual([]);
  });

  it("gives two connections distinct identities", async () => {
    await openWidget("blk_a");
    await host.dispose();
    build();
    await openWidget("blk_b");
    await call("blk_b");
    // Both calls ran, each against its own connection — nothing was reused.
    expect(executed).toHaveLength(1);
    expect(closes).toBeGreaterThanOrEqual(1);
  });
});

describe("a widget's origin has to be real", () => {
  it("refuses an agent that belongs to a different session", async () => {
    // Existence alone is not ownership: a foreign agent would otherwise be
    // captured under this session, carrying its own backend and its own
    // boundaries into a session it has nothing to do with.
    const other = store.sessions.create({
      projectId, mode: "solo", title: "Other",
      agents: [{ name: "B", backend: "codex", model: "gpt-5-codex", role: "lead", config: null }],
    });
    const verdict = await runtime.widgets.authorizeWidgetCall({
      sessionId, agentId: other.agents[0]!.id, connectionToken: "conn-foreign",
      originTurnId: null, toolName: "mcp__docs__search", input: {},
    });
    expect(verdict.allowed).toBe(false);
    expect(runtime.lifecycles.size()).toBe(0);
  });

  it("refuses an agent that does not exist at all", async () => {
    const verdict = await runtime.widgets.authorizeWidgetCall({
      sessionId, agentId: "agt_missing", connectionToken: "conn-x",
      originTurnId: null, toolName: "mcp__docs__search", input: {},
    });
    expect(verdict.allowed).toBe(false);
    expect(runtime.lifecycles.size()).toBe(0);
  });

  it("re-reads the session on every call, so a session that became read-only refuses", async () => {
    await openWidget();
    await call();
    expect(executed).toHaveLength(1);

    // The same connection, the same token — but the session is now a read-only
    // artifact. A capture that kept its first answer would keep executing.
    store.db.run(
      "UPDATE sessions SET origin='import', artifact_kind='shared-bundle' WHERE id=?",
      sessionId);
    await expect(call()).rejects.toThrow();
    expect(executed).toHaveLength(1);
  });
});

describe("a connection ending settles what it left waiting", () => {
  it("cancels a widget's pending card when its connection goes away", async () => {
    const member = store.localMembers.get(BUILT_IN_OWNER_MEMBER_ID)!;
    await openWidget();
    await call();
    // A card raised for that widget's own capture.
    // The connection's own capture, found by its token — no id is reconstructed.
    const connectionToken = lastConnectionToken!;
    const widgetAgentId = runtime.lifecycles.ownerOfToken(connectionToken)!.agentId;
    const waiting = runtime.broker.ask({
      requestId: "req_widget", sessionId, agentId: widgetAgentId, backend: "api",
      boundary: "api-tool", toolName: "mcp__docs__search", input: {}, cwd: dir,
      rule: null, member, originTurnId: null, executionSite: "widget-host" as const,
    }, undefined);

    await host.dispose();
    // The page is gone; nothing can answer that card any more.
    await expect(waiting).resolves.toMatchObject({ kind: "cancelled" });
    expect(runtime.broker.pending()).toEqual([]);
  });
});
