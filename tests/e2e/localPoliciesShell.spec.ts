import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { backendHomes, launchEnv, PERSONAL_KEY_ENV, E2E_API_CONFIG, E2E_CLAUDE_MODEL } from "./testPolicy.js";

const repoRoot = path.resolve(__dirname, "..", "..");

async function invoke<T>(page: Page, channel: string, payload: unknown): Promise<T> {
  return page.evaluate(async ({ channel, payload }) => {
    const bridge = (window as unknown as {
      capygen: { invoke(channel: string, payload: unknown): Promise<unknown> };
    }).capygen;
    return bridge.invoke(channel, payload);
  }, { channel, payload }) as Promise<T>;
}

// Actual main/runner/service/preload, with no live provider credentials or model calls.
// API is chosen so an accidental dispatch cannot launch an authenticated native CLI.
test("local profiles persist and a viewer is refused by the native policy runtime", async () => {
  const homes = backendHomes("local-policy-shell");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-local-policy-"));
  const userDataDir = path.join(root, "profile");
  const projectDir = path.join(root, "project with spaces");
  fs.mkdirSync(projectDir, { recursive: true });
  let app: ElectronApplication | undefined;
  const launch = async () => {
    const env = launchEnv({ userDataDir, projectDir, homes });
    // This proof is always offline, even when the full suite has a dedicated identity.
    const secretKeys = new Set(PERSONAL_KEY_ENV.map((key) => key.toLowerCase()));
    for (const key of Object.keys(env)) if (secretKeys.has(key.toLowerCase())) delete env[key];
    app = await electron.launch({
      args: [path.join(repoRoot, "apps", "desktop"), `--user-data-dir=${userDataDir}`],
      cwd: repoRoot,
      env,
    });
    return app.firstWindow();
  };
  try {
    let page = await launch();
    const projects = await invoke<Array<{ id: string }>>(page, "projects.list", {});
    const created = await invoke<{ session: { id: string } }>(page, "sessions.create", {
      projectId: projects[0]!.id, mode: "solo", title: "Local policy refusal",
      agents: [{ name: "Fixture", backend: "api", model: E2E_CLAUDE_MODEL,
        role: "lead", config: E2E_API_CONFIG }],
    });
    const { member } = await invoke<{ member: { id: string } }>(page, "policy.members.create", {
      label: "Read only reviewer", role: "viewer",
    });
    await invoke(page, "policy.session.subject.assign", { sessionId: created.session.id, memberId: member.id });
    await invoke(page, "chat.send", { sessionId: created.session.id, text: "This must be refused before execution." });
    await expect.poll(async () => {
      const state = await invoke<{ blocks: Array<{ kind: string; message?: string }> }>(page,
        "sessions.get", { sessionId: created.session.id });
      return state.blocks.filter((block) => block.kind === "error").map((block) => block.message).join("\n");
    }).toContain("viewer");
    await app!.close();
    app = undefined;
    page = await launch();
    const restored = await invoke<{ subject: { member: { id: string; role: string }; explicit: boolean } }>(
      page, "policy.session.subject.get", { sessionId: created.session.id });
    expect(restored.subject.member).toMatchObject({ id: member.id, role: "viewer" });
    expect(restored.subject.explicit).toBe(true);
    await page.evaluate(() => {
      const target = window as unknown as {
        policyChanges: unknown[];
        capygen: { subscribe(channel: string, listener: (value: unknown) => void): () => void };
      };
      target.policyChanges = [];
      target.capygen.subscribe("policy.changed", (value) => target.policyChanges.push(value));
    });
    await invoke(page, "policy.members.update", { memberId: member.id, label: "Renamed reviewer" });
    await expect.poll(() => page.evaluate(() =>
      (window as unknown as { policyChanges: unknown[] }).policyChanges,
    )).toContainEqual({ area: "members", sessionId: null });
  } finally {
    try { await app?.close(); }
    finally { homes.cleanup(); fs.rmSync(root, { recursive: true, force: true }); }
  }
});
