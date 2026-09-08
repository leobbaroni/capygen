import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { backendHomes, launchEnv, PERSONAL_KEY_ENV, E2E_API_CONFIG, E2E_CLAUDE_MODEL } from "./testPolicy.js";

const repoRoot = path.resolve(__dirname, "..", "..");
const CONTENT = "Written by the offline policy fixture.";

async function invoke<T>(page: Page, channel: string, payload: unknown): Promise<T> {
  return page.evaluate(async ({ channel, payload }) => {
    const bridge = (window as unknown as {
      capygen: { invoke(channel: string, payload: unknown): Promise<unknown> };
    }).capygen;
    return bridge.invoke(channel, payload);
  }, { channel, payload }) as Promise<T>;
}

interface State {
  turns: Array<{ id: string; status: string }>;
  blocks: Array<{ id: string; kind: string; turnId: string; decision?: unknown;
    request?: { requestId: string; localPolicy?: { ruleId: string } } }>;
}

test("native API tools obey changed policy and exact session grants", async () => {
  const homes = backendHomes("local-policy-tools");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-policy-tools-"));
  const userDataDir = path.join(root, "profile");
  const projectDir = path.join(root, "project with spaces");
  fs.mkdirSync(projectDir, { recursive: true });
  const sentinel = path.join(projectDir, "policy-proof.txt");
  let requests = 0;
  const models = new Set<string>();
  // This server is the provider, not a mocked harness/tool/policy service. It stores no
  // requests or headers and only asks the real tool runtime to write our owned fixture.
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      if (request.url !== "/v1/messages") {
        response.writeHead(404).end();
        return;
      }
      const parsed = JSON.parse(body) as {
        model: string;
        messages: Array<{ content: unknown }>;
      };
      requests += 1;
      models.add(parsed.model);
      const last = parsed.messages.at(-1)?.content;
      const toolResult = Array.isArray(last) && last.some((part) => part?.type === "tool_result");
      const block = toolResult
        ? { type: "text", text: "Fixture complete." }
        : { type: "tool_use", id: `toolu_fixture_${requests}`, name: "write_file", input: {} };
      const events: Array<{ event: string; data: unknown }> = [
        { event: "message_start", data: { type: "message_start", message: {
          id: `msg_fixture_${requests}`, type: "message", role: "assistant", model: E2E_CLAUDE_MODEL,
          content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 },
        } } },
        { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: block } },
      ];
      if (!toolResult) events.push({ event: "content_block_delta", data: {
        type: "content_block_delta", index: 0,
        // os.tmpdir may use a Windows 8.3 alias while main canonicalizes the
        // project root. Exercise that real spelling across the native runtime.
        delta: { type: "input_json_delta", partial_json: JSON.stringify({ path: sentinel, content: CONTENT }) },
      } });
      events.push(
        { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
        { event: "message_delta", data: { type: "message_delta",
          delta: { stop_reason: toolResult ? "end_turn" : "tool_use", stop_sequence: null },
          usage: { output_tokens: 5 } } },
        { event: "message_stop", data: { type: "message_stop" } },
      );
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""));
    });
  });
  let app: ElectronApplication | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture port");
    const env = launchEnv({ userDataDir, projectDir, homes });
    const secretKeys = new Set(PERSONAL_KEY_ENV.map((key) => key.toLowerCase()));
    for (const key of Object.keys(env)) if (secretKeys.has(key.toLowerCase())) delete env[key];
    env.ANTHROPIC_API_KEY = "dummy-local-policy-fixture";
    app = await electron.launch({
      args: [path.join(repoRoot, "apps", "desktop"), `--user-data-dir=${userDataDir}`],
      cwd: repoRoot, env,
    });
    const page = await app.firstWindow();
    const projects = await invoke<Array<{ id: string }>>(page, "projects.list", {});
    const created = await invoke<{ session: { id: string } }>(page, "sessions.create", {
      projectId: projects[0]!.id, mode: "solo", title: "Offline policy execution",
      agents: [{ name: "Fixture", backend: "api", model: E2E_CLAUDE_MODEL, role: "lead",
        config: { api: { ...E2E_API_CONFIG.api, baseUrl: `http://127.0.0.1:${address.port}`,
          permissionMode: "bypassPermissions" } } }],
    });
    const sessionId = created.session.id;
    await page.evaluate((id) => { location.hash = `/c/${id}`; }, sessionId);
    const state = () => invoke<State>(page, "sessions.get", { sessionId });
    const send = () => invoke<{ agentTurnId: string }>(page, "chat.send", { sessionId, text: "Run the owned fixture write." });
    const done = async (turnId: string) => {
      await expect.poll(async () => (await state()).turns.find((turn) => turn.id === turnId)?.status).toBe("done");
    };
    const control = await send();
    await done(control.agentTurnId);
    expect(fs.existsSync(sentinel), JSON.stringify((await state()).blocks)).toBe(true);
    expect(fs.readFileSync(sentinel, "utf8")).toBe(CONTENT);
    fs.unlinkSync(sentinel);
    const { rule } = await invoke<{ rule: { id: string } }>(page, "policy.rules.create", {
      scope: { kind: "session", sessionId }, boundary: "api-tool", pattern: "write_file", decision: "ask", enabled: true,
    });
    const waiting = await send();
    const pendingCard = async (turnId: string) => (await state()).blocks.find((block) =>
      block.turnId === turnId && block.kind === "permission" && block.decision === null && block.request?.localPolicy);
    await expect.poll(async () => (await pendingCard(waiting.agentTurnId))?.request?.localPolicy?.ruleId).toBe(rule.id);
    expect((await state()).turns.find((turn) => turn.id === waiting.agentTurnId)?.status).toBe("streaming");
    const oldRequest = (await pendingCard(waiting.agentTurnId))!.request!.requestId;
    await invoke(page, "policy.rules.update", { ruleId: rule.id, decision: "deny" });
    expect(await invoke(page, "permission.answer", { requestId: oldRequest, decision: "allow", scope: "session" })).toMatchObject({ ok: true });
    await done(waiting.agentTurnId);
    expect(fs.existsSync(sentinel)).toBe(false);
    expect(await invoke(page, "policy.grants.list", {})).toEqual({ grants: [] });

    await invoke(page, "policy.rules.update", { ruleId: rule.id, decision: "ask" });
    const granting = await send();
    await expect.poll(async () => (await pendingCard(granting.agentTurnId))?.request?.localPolicy?.ruleId).toBe(rule.id);
    const grantCard = (await pendingCard(granting.agentTurnId))!;
    await page.evaluate(() => { location.hash = "/approve"; });
    await expect(page.getByTestId("approve-page")).toBeVisible();
    await expect(page.getByTestId(`approve-row-${grantCard.id}`)).toContainText("write_file");
    await page.getByTestId(`approve-allow-session-${grantCard.id}`).click();
    await done(granting.agentTurnId);
    expect(fs.existsSync(sentinel), JSON.stringify((await state()).blocks.filter((block) => block.turnId === granting.agentTurnId))).toBe(true);
    expect(fs.readFileSync(sentinel, "utf8")).toBe(CONTENT);
    const granted = await invoke<{ grants: Array<{ grantId: string }> }>(page, "policy.grants.list", {});
    expect(granted.grants).toHaveLength(1);
    await expect(page.getByTestId("approve-empty")).toBeVisible();
    fs.unlinkSync(sentinel);
    const repeated = await send();
    await done(repeated.agentTurnId);
    expect(fs.readFileSync(sentinel, "utf8")).toBe(CONTENT);
    expect(await pendingCard(repeated.agentTurnId)).toBeUndefined();
    expect(requests).toBe(8);
    fs.unlinkSync(sentinel);
    await invoke(page, "policy.grants.revoke", { grantId: granted.grants[0]!.grantId });
    const cancelling = await send();
    await expect.poll(async () => (await pendingCard(cancelling.agentTurnId))?.request?.localPolicy?.ruleId).toBe(rule.id);
    const cancelledRequest = (await pendingCard(cancelling.agentTurnId))!.request!.requestId;
    const { member: owner } = await invoke<{ member: { id: string } }>(page, "policy.members.create", { label: "Other owner", role: "owner" });
    await expect(invoke(page, "policy.session.subject.assign", { sessionId, memberId: owner.id })).rejects.toThrow(/session-busy/);
    const { member: viewer } = await invoke<{ member: { id: string } }>(page, "policy.members.create", { label: "Restricted fixture", role: "viewer" });
    await invoke(page, "policy.session.subject.assign", { sessionId, memberId: viewer.id });
    await expect.poll(async () => (await state()).turns.find((turn) => turn.id === cancelling.agentTurnId)?.status).not.toBe("streaming");
    expect(await pendingCard(cancelling.agentTurnId)).toBeUndefined();
    expect(await invoke(page, "permission.answer", { requestId: cancelledRequest, decision: "allow" })).toMatchObject({ ok: false });
    expect(fs.existsSync(sentinel)).toBe(false);
    expect(await invoke(page, "policy.grants.list", {})).toEqual({ grants: [] });
    expect(requests).toBe(9);
    const refused = await send();
    await expect.poll(async () => (await state()).turns.find((turn) => turn.id === refused.agentTurnId)?.status).toBe("error");
    expect(JSON.stringify((await state()).blocks.filter((block) => block.turnId === refused.agentTurnId))).toMatch(/viewer/i);
    expect(requests).toBe(9);
    expect([...models]).toEqual([E2E_CLAUDE_MODEL]);
  } finally {
    try { await app?.close(); }
    finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      homes.cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
