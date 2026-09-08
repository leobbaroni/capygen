/**
 * Where a decision was enforced, recorded from the **capture** (ADR-0007, 0012).
 *
 * `AgentPolicyContext.executionSite` is set by main when it records a capture.
 * The audit row must read it from there, never from `AuthorizeRequest`: the
 * request's copy is caller-supplied, and a log that echoed it could report a
 * site a caller merely asserted.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openStore, type CapygenStore } from "@capygen/db";
import { LocalPolicyService, type AgentPolicyContext } from "../src/policies/LocalPolicyService.js";

const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../../packages/db/migrations", import.meta.url),
);

let dir: string;
let store: CapygenStore;
let sessionId: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-audit-site-svc-"));
  store = openStore(path.join(dir, "test.db"), { migrationsDir: MIGRATIONS_DIR });
  const project = store.projects.upsertByPath({ path: path.join(dir, "p"), name: "P" });
  sessionId = store.sessions.create({ projectId: project.id, mode: "solo", agents: [] }).session.id;
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function serviceFor(
  context: AgentPolicyContext | null,
  over: { resolveContext?: () => AgentPolicyContext | null; ask?: () => Promise<unknown> } = {},
): LocalPolicyService {
  return new LocalPolicyService({
    store,
    resolveContext: over.resolveContext ?? (() => context),
    ask: (over.ask ?? (async () => ({ kind: "deny" }))) as never,
    interruptAndDeny: () => {},
    isQuiescent: () => true,
  });
}

const widgetContext: AgentPolicyContext = {
  projectId: null,
  readOnly: false,
  backend: "api",
  lifecycleToken: "tok_widget",
  availableBoundaries: ["api-tool"],
  executionSite: "widget-host",
};

/**
 * A caller *does* state its own site, and it must agree with the capture — that
 * agreement is what makes naming one useless as a bypass. So a widget request
 * says `widget-host`; the spoof case below is the one that disagrees on purpose.
 */
const request = (over: Record<string, unknown> = {}) => ({
  sessionId,
  agentId: "agt_1",
  boundary: "api-tool" as const,
  toolName: "mcp__docs__search",
  input: { q: "x" },
  cwd: "C:\\proj",
  lifecycleToken: "tok_widget",
  executionSite: "widget-host" as const,
  ...over,
});

describe("the audit row reports the captured execution site", () => {
  it("records widget-host for a call captured at the widget host", async () => {
    const service = serviceFor(widgetContext);
    const outcome = await service.authorize(request());
    // Admitted, not refused for a mismatched site — otherwise this would assert
    // the right value for the wrong reason.
    expect(outcome.reason).not.toBe("boundary-unavailable");
    const rows = store.localPolicyAudit.bySession(sessionId, 10);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.executionSite).toBe("widget-host");
    // The origin survives alongside it: the refusal is still attributable to
    // this agent's backend and the boundary the rule was checked at.
    expect(rows[0]!.backend).toBe("api");
    expect(rows[0]!.boundary).toBe("api-tool");
  });

  it("records backend for an ordinary captured call", async () => {
    const service = serviceFor({ ...widgetContext, executionSite: "backend", lifecycleToken: "tok_b" });
    const outcome = await service.authorize(
      request({ lifecycleToken: "tok_b", executionSite: "backend" }),
    );
    expect(outcome.reason).not.toBe("boundary-unavailable");
    expect(store.localPolicyAudit.bySession(sessionId, 10)[0]!.executionSite).toBe("backend");
  });

  it("ignores a request that asserts a site its capture does not have", async () => {
    // The request claims the widget host; the capture says backend. The service
    // already refuses the mismatch — what matters here is that the *log* keeps
    // the captured value rather than the asserted one.
    const service = serviceFor({ ...widgetContext, executionSite: "backend", lifecycleToken: "tok_b" });
    await service.authorize(
      request({ lifecycleToken: "tok_b", executionSite: "widget-host" }) as never,
    );
    const rows = store.localPolicyAudit.bySession(sessionId, 10);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.executionSite === "backend")).toBe(true);
  });

  it("records unknown, not backend, when no capture ever matched", async () => {
    // Inventing `backend` here would be a claim about where the call ran. It
    // ran nowhere: main knows nothing about this agent.
    const service = serviceFor(null);
    await service.authorize(request({ executionSite: "backend" }));
    const rows = store.localPolicyAudit.bySession(sessionId, 10);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.executionSite === "unknown")).toBe(true);
  });

  it("keeps the widget site when the capture disappears while the ask is pending", async () => {
    // The exact lifecycle gap: a widget connection ends while its approval card
    // is open. Re-resolving at write time found no capture and recorded
    // `backend` — attribution rewritten by a disposal.
    let live: AgentPolicyContext | null = widgetContext;
    let asked = false;
    const service = serviceFor(null, {
      resolveContext: () => live,
      ask: async () => {
        asked = true;
        // The widget host goes away while the operator is still deciding.
        live = null;
        return { kind: "cancelled" };
      },
    });
    store.localPolicyRules.create({
      scope: { kind: "session", sessionId },
      boundary: "api-tool",
      pattern: "mcp__docs__*",
      decision: "ask",
      enabled: true,
    });
    await service.authorize(request());
    expect(asked).toBe(true);
    const rows = store.localPolicyAudit.bySession(sessionId, 10);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.executionSite).toBe("widget-host");
    // And it is still a refusal, not an accidental permit.
    expect(rows[0]!.decision).toBe("deny");
  });

  it("audits unknown when the supplied lifecycle does not match the live capture", async () => {
    // A capture exists and is current — but it is not this request's. Borrowing
    // its site would attribute the decision to a connection the call had
    // nothing to do with.
    const service = serviceFor({ ...widgetContext, lifecycleToken: "tok_other" });
    await service.authorize(request({ lifecycleToken: "tok_stale" }));
    const rows = store.localPolicyAudit.bySession(sessionId, 10);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.executionSite === "unknown")).toBe(true);
  });

  it("gives each invocation its own site when one request object is reused", async () => {
    // A caller may hand the *same object* to two overlapping authorizations —
    // a retry, a queued pair. One shared bookkeeping key lets the second
    // admission overwrite the first, and both rows then report the later site.
    const pending: Array<() => void> = [];
    let live: AgentPolicyContext = { ...widgetContext, executionSite: "widget-host" };
    const service = serviceFor(null, {
      resolveContext: () => live,
      ask: () =>
        new Promise((resolve) => {
          pending.push(() => resolve({ kind: "cancelled" }));
        }) as never,
    });
    store.localPolicyRules.create({
      scope: { kind: "session", sessionId },
      boundary: "api-tool",
      pattern: "mcp__docs__*",
      decision: "ask",
      enabled: true,
    });

    // One object, passed twice — no spread, no copy.
    const shared = request();
    const first = service.authorize(shared);
    await vi.waitFor(() => expect(pending).toHaveLength(1));

    // The capture is replaced between admissions: same session and lifecycle,
    // different site. The second invocation is admitted against it and settles
    // first, writing its row while the first is still waiting on its card.
    live = { ...widgetContext, executionSite: "backend" };
    const second = await service.authorize(shared);
    expect(second.allowed).toBe(false);

    for (const settle of pending) settle();
    await first;

    const sites = store.localPolicyAudit.bySession(sessionId, 10).map((row) => row.executionSite);
    expect(sites).toHaveLength(2);
    // Each settlement keeps the site *it* was admitted at, in either order.
    // Sharing one key collapses both to `backend`.
    expect([...sites].sort()).toEqual(["backend", "widget-host"]);
  });

  it("keeps the admitted site when the capture is replaced mid-flight", async () => {
    let live: AgentPolicyContext = widgetContext;
    const service = serviceFor(null, {
      resolveContext: () => live,
      ask: async () => {
        // A different capture takes over between admission and the write.
        live = { ...widgetContext, executionSite: "backend", lifecycleToken: "tok_other" };
        return { kind: "cancelled" };
      },
    });
    store.localPolicyRules.create({
      scope: { kind: "session", sessionId },
      boundary: "api-tool",
      pattern: "mcp__docs__*",
      decision: "ask",
      enabled: true,
    });
    await service.authorize(request());
    const rows = store.localPolicyAudit.bySession(sessionId, 10);
    expect(rows[0]!.executionSite).toBe("widget-host");
  });
});
