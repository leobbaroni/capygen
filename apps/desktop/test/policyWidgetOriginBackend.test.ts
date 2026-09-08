import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type CapygenStore } from "@capygen/db";
import { createPolicyRuntime, type PolicyRuntime } from "../src/policies/runtime.js";

/**
 * A widget's tool call, judged by the **real** `LocalPolicyService`.
 *
 * The earlier widget tests all used an `api` session, so they never exercised
 * the one thing that decides whether a widget works at all: the service checks
 * `policyBoundaryBackend(boundary) === context.backend`, and a widget capture
 * carries its originating agent's backend. For a Claude or Codex session that
 * comparison is `api !== claude` / `api !== codex`, and the call is refused as
 * `boundary-unavailable` before any rule is consulted.
 *
 * Nothing here is mocked: the authorization is the production one.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));

let dir: string;
let store: CapygenStore;
let projectId: string;
let runtime: PolicyRuntime;

function sessionOn(backend: "api" | "claude" | "codex") {
  return store.sessions.create({
    projectId, mode: "solo", title: `${backend} session`,
    agents: [{
      name: "Assistant", backend,
      model: backend === "codex" ? "gpt-5-codex" : "claude-opus-5",
      role: "lead",
      config: backend === "api" ? { api: { provider: "anthropic" } } : null,
    }],
  });
}

const widgetCall = (sessionId: string, agentId: string, token: string) =>
  runtime.widgets.authorizeWidgetCall({
    sessionId, agentId, connectionToken: token, originTurnId: null,
    toolName: "mcp__docs__search", input: { query: "x" },
  });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-widget-origin-"));
  store = openStore(path.join(dir, "capygen.db"), { migrationsDir: MIGRATIONS_DIR });
  projectId = store.projects.upsertByPath({ path: path.join(dir, "project") }).id;
  runtime = createPolicyRuntime({
    store,
    ask: { publish: () => ({ blockId: "blk_1", turnId: "trn_1" }), settleCard: () => {} },
    publishChanged: () => {},
    engine: () => null,
  });
});

afterEach(() => {
  runtime.dispose();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("a widget call is authorized whatever backend its session runs on", () => {
  for (const backend of ["api", "claude", "codex"] as const) {
    it(`allows an unrestricted widget call from a ${backend} session`, async () => {
      const created = sessionOn(backend);
      const verdict = await widgetCall(
        created.session.id, created.agents[0]!.id, `conn-${backend}`);
      expect(verdict.allowed, verdict.message ?? "").toBe(true);
    });
  }

  it("does not report a backend mismatch for a Claude session's widget", async () => {
    const created = sessionOn("claude");
    const verdict = await widgetCall(created.session.id, created.agents[0]!.id, "conn-claude");
    // The failure this reproduces reads "This agent targets claude; an api-tool
    // request cannot be authorized for it." A widget must not be refused for
    // running in a Claude session.
    expect(verdict.message ?? "").not.toMatch(/targets claude/);
    expect(verdict.message ?? "").not.toMatch(/cannot enforce/);
  });
});

describe("a widget is governed by the origin's own restrictions", () => {
  const rule = (sessionId: string, boundary: string, decision: "deny" | "ask") =>
    runtime.service.createRule({ memberId: "mbr_builtin_owner" }, {
      scope: { kind: "session", sessionId },
      boundary: boundary as never, pattern: "mcp__docs__*", decision, enabled: true,
    });

  for (const [backend, boundary] of [
    ["api", "api-tool"],
    ["claude", "claude-pre-tool"],
    ["codex", "codex-dynamic-tool"],
  ] as const) {
    it(`refuses a widget call a ${backend} session's own ${boundary} rule denies`, async () => {
      const created = sessionOn(backend);
      rule(created.session.id, boundary, "deny");
      const verdict = await widgetCall(
        created.session.id, created.agents[0]!.id, `conn-${backend}`);
      // A widget must not be a way around a restriction the user wrote for the
      // agent whose result opened it.
      expect(verdict.allowed).toBe(false);
      expect(verdict.message ?? "").toMatch(/restriction/i);
    });
  }

  it("does not let another backend's rule govern this session's widget", async () => {
    const created = sessionOn("claude");
    // A rule filed at Codex's boundary says nothing about a Claude agent.
    rule(created.session.id, "codex-dynamic-tool", "deny");
    const verdict = await widgetCall(created.session.id, created.agents[0]!.id, "conn-claude");
    expect(verdict.allowed, verdict.message ?? "").toBe(true);
  });

  it("keeps the read-only and subject checks that are the origin's", async () => {
    const created = sessionOn("claude");
    store.db.run(
      "UPDATE sessions SET origin='import', artifact_kind='shared-bundle' WHERE id=?",
      created.session.id);
    const verdict = await widgetCall(created.session.id, created.agents[0]!.id, "conn-ro");
    expect(verdict.allowed).toBe(false);
    expect(verdict.message ?? "").toMatch(/read-only/i);
  });

  it("still refuses a genuine backend-boundary mismatch outside a widget", async () => {
    // The site only relaxes the check for calls capygen itself intercepts. A
    // backend-site call naming a foreign boundary is refused exactly as before.
    const created = sessionOn("claude");
    const agentId = created.agents[0]!.id;
    const token = runtime.hooks.capture({
      sessionId: created.session.id, agentId, projectId,
      backend: "claude", readOnly: false, declaresDynamicTools: false,
    });
    const authorization = await runtime.service.authorize({
      sessionId: created.session.id, agentId, lifecycleToken: token,
      boundary: "codex-dynamic-tool", toolName: "Bash", input: {}, cwd: dir,
    });
    expect(authorization.allowed).toBe(false);
    expect(authorization.reason).toBe("boundary-unavailable");
  });
});

describe("the execution site is the capture's, not the caller's", () => {
  const captureBackendSite = (backend: "api" | "claude" | "codex") => {
    const created = sessionOn(backend);
    const agentId = created.agents[0]!.id;
    const token = runtime.hooks.capture({
      sessionId: created.session.id, agentId, projectId, backend,
      readOnly: false, declaresDynamicTools: true,
      ...(backend === "codex" ? { codexApprovalPolicy: "on-request" as const } : {}),
    });
    return { sessionId: created.session.id, agentId, token };
  };

  it("refuses a request that claims the widget site on a backend capture", async () => {
    const { sessionId, agentId, token } = captureBackendSite("claude");
    // Spoofing the site is the whole attack: it must not reach the widget
    // path's relaxed availability.
    const authorization = await runtime.service.authorize({
      sessionId, agentId, lifecycleToken: token,
      boundary: "claude-pre-tool", toolName: "Bash", input: {}, cwd: dir,
      executionSite: "widget-host",
    });
    expect(authorization.allowed).toBe(false);
    expect(authorization.reason).toBe("boundary-unavailable");
    expect(authorization.message ?? "").toMatch(/captured at its backend/);
  });

  it("refuses a backend-site request against a widget capture", async () => {
    const created = sessionOn("claude");
    const agentId = created.agents[0]!.id;
    // A widget capture, registered the way the widget path registers one.
    const widgetAgentId = `${agentId}#widget:conn-1`;
    const widgetToken = runtime.hooks.capture({
      sessionId: created.session.id, agentId: widgetAgentId, projectId,
      backend: "claude", readOnly: false, widgetHost: true,
    } as never);
    const authorization = await runtime.service.authorize({
      sessionId: created.session.id, agentId: widgetAgentId, lifecycleToken: widgetToken,
      boundary: "claude-pre-tool", toolName: "Bash", input: {}, cwd: dir,
    });
    expect(authorization.allowed).toBe(false);
    expect(authorization.message ?? "").toMatch(/captured at its widget-host/);
  });

  it("refuses a widget naming another backend's boundary", async () => {
    const created = sessionOn("claude");
    const agentId = created.agents[0]!.id;
    const widgetAgentId = `${agentId}#widget:conn-2`;
    const widgetToken = runtime.hooks.capture({
      sessionId: created.session.id, agentId: widgetAgentId, projectId,
      backend: "claude", readOnly: false, widgetHost: true,
    } as never);
    // Backend equality is still checked at the widget site.
    const authorization = await runtime.service.authorize({
      sessionId: created.session.id, agentId: widgetAgentId, lifecycleToken: widgetToken,
      boundary: "api-tool", toolName: "x", input: {}, cwd: dir,
      executionSite: "widget-host",
    });
    expect(authorization.allowed).toBe(false);
    expect(authorization.message ?? "").toMatch(/targets claude/);
  });

  it("refuses a widget reaching a native approval category", async () => {
    const created = sessionOn("codex");
    const agentId = created.agents[0]!.id;
    const widgetAgentId = `${agentId}#widget:conn-3`;
    const widgetToken = runtime.hooks.capture({
      sessionId: created.session.id, agentId: widgetAgentId, projectId,
      backend: "codex", readOnly: false, widgetHost: true,
      codexApprovalPolicy: "on-request",
    } as never);
    for (const boundary of [
      "codex-command-approval", "codex-file-approval", "codex-permissions-approval",
    ] as const) {
      const authorization = await runtime.service.authorize({
        sessionId: created.session.id, agentId: widgetAgentId, lifecycleToken: widgetToken,
        boundary, toolName: "x", input: {}, cwd: dir, executionSite: "widget-host",
      });
      // An app host executes tool calls; a native approval prompt is not one,
      // and opening a widget must not make that category addressable.
      expect(authorization.allowed, boundary).toBe(false);
      expect(authorization.message ?? "").toMatch(/only be authorized against/);
    }
  });

  it("still allows the real widget path for Claude and Codex", async () => {
    for (const backend of ["claude", "codex"] as const) {
      const created = sessionOn(backend);
      const verdict = await widgetCall(
        created.session.id, created.agents[0]!.id, `conn-real-${backend}`);
      expect(verdict.allowed, verdict.message ?? "").toBe(true);
    }
  });
});
