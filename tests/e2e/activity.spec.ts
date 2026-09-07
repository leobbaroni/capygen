import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { backendHomes, launchEnv, type BackendHomes } from "./testPolicy.js";

const repoRoot = path.resolve(__dirname, "..", "..");
const appDir = path.join(repoRoot, "apps", "desktop");
const evidenceDir = path.join(repoRoot, "e2e-out", "activity");

type CreatedSession = {
  session: { id: string; title: string; status: string };
  agents: Array<{ id: string }>;
};
type TaskRow = { id: string; sessionId: string | null; title: string; status: string };
type Automation = {
  id: string;
  name: string;
  enabled: boolean;
  lastRunStatus: string | null;
  lastRunSessionId: string | null;
};
type AutomationRun = {
  id: string;
  trigger: "scheduled" | "manual";
  status: string;
  scheduledAt: number | null;
  sessionId: string | null;
};
type InboxItem = {
  id: string;
  sessionId: string;
  turnId: string;
  kind: string;
  title: string;
  body: string;
  readAt: number | null;
};

let app: ElectronApplication;
let page: Page;
let homes: BackendHomes;
let userDataDir: string;
let projectDir: string;
const pageErrors: string[] = [];

async function invoke<T>(channel: string, payload: unknown): Promise<T> {
  return page.evaluate(
    async ({ channel: selectedChannel, payload: selectedPayload }) => {
      const bridge = (
        window as unknown as {
          capygen?: { invoke(channel: string, payload: unknown): Promise<unknown> };
        }
      ).capygen;
      if (!bridge) throw new Error("preload bridge missing");
      return bridge.invoke(selectedChannel, selectedPayload);
    },
    { channel, payload },
  ) as Promise<T>;
}

async function launchApp(): Promise<void> {
  app = await electron.launch({
    args: [appDir, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
    env: launchEnv({ userDataDir, projectDir, homes, engine: "stub" }),
  });
  page = await app.firstWindow();
  page.on("pageerror", (error) => pageErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(`console: ${message.text()}`);
  });
  await page.waitForLoadState("domcontentloaded");
}

async function sendTodo(sessionId: string, text: string): Promise<void> {
  await invoke("chat.send", { sessionId, text: `todo: ${text}`, agentId: null });
  await expect
    .poll(
      async () => (await invoke<TaskRow[]>("tasks.list", { sessionId })).map((row) => row.title),
      { timeout: 15_000 },
    )
    .toEqual(text.split(",").map((part) => part.trim()));
}

async function seedUsage(first: CreatedSession, second: CreatedSession): Promise<void> {
  await app.evaluate(
    async (_electron, input) => {
      // Keep node:sqlite inside Electron. Playwright's Node 22 TypeScript
      // loader cannot load that experimental built-in from the test process.
      const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
      const db = new sqlite.DatabaseSync(input.dbFile);
      try {
        const insert = db.prepare(`INSERT INTO usage_events
          (id, session_id, agent_id, turn_id, backend, model, input_tokens,
           output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, cost_known, ts)
          VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 0, ?, ?)`);
        const now = Date.now();
        insert.run("usage_known_zero", input.firstSessionId, input.firstAgentId, "api", "fixture-free", 123, 45, 6, 7, 1, now);
        insert.run("usage_unknown", input.secondSessionId, input.secondAgentId, "codex", "fixture-unknown", 10, 20, 0, 1, 0, now + 1);
      } finally {
        db.close();
      }
    },
    {
      dbFile: path.join(userDataDir, "capygen.db"),
      firstSessionId: first.session.id,
      firstAgentId: first.agents[0]!.id,
      secondSessionId: second.session.id,
      secondAgentId: second.agents[0]!.id,
    },
  );
}

test.beforeAll(async () => {
  test.setTimeout(140_000);
  homes = backendHomes("activity");
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-activity-e2e-"));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-activity-project-"));
  fs.mkdirSync(evidenceDir, { recursive: true });
  await launchApp();
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
  homes.cleanup();
});

test("persists tasks, Inbox, usage, and a real scheduled automation across restart", async () => {
  test.setTimeout(140_000);
  const projects = await invoke<Array<{ id: string; path: string }>>("projects.list", {});
  expect(projects).toHaveLength(1);
  const project = projects[0]!;

  const first = await invoke<CreatedSession>("sessions.create", {
    projectId: project.id,
    mode: "solo",
    title: "Activity alpha",
    agents: [{ name: "Alpha", backend: "claude", model: "stub", role: "lead" }],
  });
  const second = await invoke<CreatedSession>("sessions.create", {
    projectId: project.id,
    mode: "solo",
    title: "Activity beta",
    agents: [{ name: "Beta", backend: "codex", model: "stub", role: "lead" }],
  });

  await sendTodo(first.session.id, "alpha running, alpha queued");
  await sendTodo(second.session.id, "beta running, beta queued");
  await seedUsage(first, second);

  const timeZone = await page.evaluate(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  );
  const scheduleAnchorAt = Math.floor(Date.now() / 60_000) * 60_000;
  const automation = await invoke<Automation>("automations.create", {
    projectId: project.id,
    agentId: first.agents[0]!.id,
    name: "Minute acceptance",
    prompt: "todo: scheduled running, scheduled queued",
    rrule: "FREQ=MINUTELY;INTERVAL=1",
    timeZone,
    scheduleAnchorAt,
  });

  // Exercise the production scheduler's wall-clock timer. Calling runNow here
  // would skip the restart-safe scheduled claim and deduplication path.
  let scheduledRun: AutomationRun | undefined;
  await expect
    .poll(
      async () => {
        const runs = await invoke<AutomationRun[]>("automations.listRuns", {
          id: automation.id,
          limit: 10,
        });
        scheduledRun = runs.find(
          (run) => run.trigger === "scheduled" && run.status === "succeeded",
        );
        return scheduledRun?.status;
      },
      { timeout: 75_000, intervals: [250, 500, 1_000] },
    )
    .toBe("succeeded");

  expect(scheduledRun?.scheduledAt).not.toBeNull();
  expect(scheduledRun?.sessionId).toBeTruthy();
  const scheduledSessionId = scheduledRun!.sessionId!;
  const paused = await invoke<Automation>("automations.update", {
    id: automation.id,
    patch: { enabled: false },
  });
  expect(paused.enabled).toBe(false);

  const scheduledSession = await invoke<{
    session: { id: string; title: string; status: string };
    blocks: Array<{ kind: string; text?: string; name?: string }>;
  } | null>("sessions.get", { sessionId: scheduledSessionId });
  expect(scheduledSession?.session).toMatchObject({
    id: scheduledSessionId,
    title: "Minute acceptance",
    status: "idle",
  });
  expect(scheduledSession?.blocks.some((block) => block.name === "TodoWrite")).toBe(true);
  expect(scheduledSession?.blocks.some((block) => block.text === "echo: todo: scheduled running, scheduled queued")).toBe(true);
  await expect
    .poll(async () => (await invoke<TaskRow[]>("tasks.list", { sessionId: scheduledSessionId })).map((row) => row.title))
    .toEqual(["scheduled running", "scheduled queued"]);

  const inboxBeforeRestart = await invoke<{ items: InboxItem[]; unreadCount: number }>(
    "inbox.list",
    { limit: 100 },
  );
  const scheduledFinished = inboxBeforeRestart.items.filter(
    (item) => item.sessionId === scheduledSessionId && item.kind === "finished",
  );
  expect(scheduledFinished).toHaveLength(1);
  expect(scheduledFinished[0]).toMatchObject({ title: "Turn finished", body: "Minute acceptance" });
  expect(inboxBeforeRestart.unreadCount).toBeGreaterThan(0);

  await page.evaluate(() => { window.location.hash = "#/tasks"; });
  await expect(page.getByTestId("tasks-page")).toBeVisible();
  for (const title of ["alpha running", "beta queued", "scheduled running"]) {
    await expect(page.getByTestId("tasks-page")).toContainText(title);
  }
  await page.screenshot({ path: path.join(evidenceDir, "tasks.png") });

  await page.evaluate(() => { window.location.hash = "#/usage"; });
  const usagePage = page.getByTestId("usage-page");
  await expect(usagePage).toBeVisible();
  await expect(usagePage.getByText("Events", { exact: true }).locator("..")).toContainText("2");
  await expect(usagePage.getByText("Input tokens", { exact: true }).locator("..")).toContainText("133");
  await expect(usagePage.getByText("Output tokens", { exact: true }).locator("..")).toContainText("65");
  await expect(usagePage.getByText("Known cost", { exact: true }).locator("..")).toContainText("$0.0000");
  await expect(usagePage.getByText("Unknown cost events", { exact: true }).locator("..")).toContainText("1");
  await expect(usagePage).toContainText("api · fixture-free");
  await expect(usagePage).toContainText("codex · fixture-unknown");
  await expect(usagePage).toContainText("Activity alpha");
  await expect(usagePage).toContainText("Activity beta");
  await page.screenshot({ path: path.join(evidenceDir, "usage.png") });

  await page.evaluate(() => { window.location.hash = "#/automations"; });
  const automationsPage = page.getByTestId("automations-page");
  await expect(automationsPage).toContainText("Minute acceptance");
  await expect(automationsPage).toContainText("Paused");
  await expect(automationsPage).toContainText("Last succeeded");
  await automationsPage.getByRole("button", { name: "Run history" }).click();
  await expect(automationsPage).toContainText("succeeded");
  await expect(automationsPage.getByRole("link", { name: "Open session" })).toBeVisible();
  await page.screenshot({ path: path.join(evidenceDir, "automations.png") });

  await page.evaluate(() => { window.location.hash = "#/inbox"; });
  await expect(page.getByTestId("inbox-page")).toContainText("Minute acceptance");
  await expect(page.getByTestId("inbox-badge")).toBeVisible();
  await page.screenshot({ path: path.join(evidenceDir, "inbox.png") });

  await app.close();
  await launchApp();

  const persistedAutomation = (await invoke<Automation[]>("automations.list", {})).find(
    (item) => item.id === automation.id,
  );
  expect(persistedAutomation).toMatchObject({
    enabled: false,
    lastRunStatus: "succeeded",
    lastRunSessionId: scheduledSessionId,
  });
  const persistedRuns = await invoke<AutomationRun[]>("automations.listRuns", {
    id: automation.id,
    limit: 10,
  });
  expect(persistedRuns.filter((run) => run.trigger === "scheduled" && run.status === "succeeded"))
    .toHaveLength(1);
  const persistedInbox = await invoke<{ items: InboxItem[]; unreadCount: number }>("inbox.list", {
    limit: 100,
  });
  expect(
    persistedInbox.items.filter(
      (item) => item.sessionId === scheduledSessionId && item.kind === "finished",
    ),
  ).toHaveLength(1);
  expect(await invoke<TaskRow[]>("tasks.list", { sessionId: scheduledSessionId })).toHaveLength(2);

  const report = await invoke<{
    totals: { events: number; inputTokens: number; outputTokens: number; knownCostUsd: number; unknownCostEvents: number };
  }>("usage.report", { from: 0, to: Date.now() + 1, timeZone });
  expect(report.totals).toEqual({
    events: 2,
    inputTokens: 133,
    outputTokens: 65,
    cacheReadTokens: 6,
    cacheCreationTokens: 8,
    knownCostUsd: 0,
    unknownCostEvents: 1,
  });

  await page.evaluate(() => { window.location.hash = "#/inbox"; });
  const inboxPage = page.getByTestId("inbox-page");
  await expect(inboxPage).toContainText("Minute acceptance");
  await expect(page.getByTestId("inbox-badge")).toBeVisible();
  await inboxPage.getByRole("button", { name: "Mark all read" }).click();
  await expect
    .poll(async () => (await invoke<{ unreadCount: number }>("inbox.list", { limit: 1 })).unreadCount)
    .toBe(0);
  await expect(page.getByTestId("inbox-badge")).toHaveCount(0);

  expect(pageErrors, pageErrors.join(" | ")).toEqual([]);
});
