import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
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
const fixtureDir = path.join(repoRoot, "tests", "fixtures", "imports");
const evidenceDir = path.join(repoRoot, "e2e-out", "imports");

type Preview = {
  handle: string;
  backend: "claude" | "codex";
  nativeId: string;
  title: string | null;
  counts: { entries: number };
  existingSessionId?: string;
};
type ImportedSession = { id: string; title: string };
type ImportEntry = { kind: string; text: string };

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

function namesOrEmpty(directory: string): string[] {
  return fs.existsSync(directory) ? fs.readdirSync(directory).sort() : [];
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
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

async function bindNativeSelections(files: string[]): Promise<void> {
  await app.evaluate(({ dialog }, selectedFiles) => {
    const queue = [...selectedFiles];
    dialog.showOpenDialog = (async () => {
      const file = queue.shift();
      return file
        ? { canceled: false, filePaths: [file] }
        : { canceled: true, filePaths: [] };
    }) as typeof dialog.showOpenDialog;
  }, files);
}

test.beforeAll(async () => {
  homes = backendHomes("imports");
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-import-e2e-"));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-import-project-"));
  fs.mkdirSync(evidenceDir, { recursive: true });

  // Never add a test-owned file to a persistent dedicated identity. The
  // ordinary gate uses disposable homes and gets the sentinel proof below.
  if (!homes.dedicated) {
    for (const [home, marker] of [
      [homes.claudeHome, "claude-home-marker"],
      [homes.codexHome, "codex-home-marker"],
    ] as const) {
      fs.writeFileSync(path.join(home, "import-e2e-sentinel.txt"), marker, "utf8");
    }
  }
  await launchApp();
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
  homes.cleanup();
});

test("imports Claude and Codex transcripts through the native utility worker", async () => {
  const sentinels = (homes.dedicated ? [] : [homes.claudeHome, homes.codexHome]).map((home) => {
    const file = path.join(home, "import-e2e-sentinel.txt");
    return { file, body: fs.readFileSync(file, "utf8"), mtimeMs: fs.statSync(file).mtimeMs };
  });
  const claudeFile = path.join(fixtureDir, "claude-chain.jsonl");
  const codexFile = path.join(fixtureDir, "codex-rollout.jsonl");
  const fixtureHashes = new Map([
    [claudeFile, sha256(claudeFile)],
    [codexFile, sha256(codexFile)],
  ]);
  const selections = [claudeFile, claudeFile, codexFile, codexFile, claudeFile];

  // Keep file authority in main: the renderer still calls imports.pick, while
  // only Electron's native dialog is replaced with a deterministic queue.
  await bindNativeSelections(selections);

  const projects = await invoke<Array<{ id: string; path: string }>>("projects.list", {});
  expect(projects).toHaveLength(1);
  const project = projects[0]!;
  // The global isolation setup may hand Electron an 8.3 spelling of the temp
  // root while Node returns the long spelling. Both resolve to one directory.
  expect(fs.realpathSync.native(project.path).toLowerCase()).toBe(
    fs.realpathSync.native(projectDir).toLowerCase(),
  );

  await page.evaluate(() => { window.location.hash = "#/settings/import"; });
  const importSettings = page.getByTestId("settings-import");
  await expect(importSettings).toBeVisible();
  await expect(importSettings.getByRole("heading", { name: "Import sessions" })).toBeVisible();
  await expect(importSettings.getByLabel("Destination project")).toHaveValue(project.id);

  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.setMinimumSize(0, 0);
    win?.setSize(380, 800);
  });
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(380);
  await page.screenshot({ path: path.join(evidenceDir, "settings-import-380.png") });
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1280, 900);
  });
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeGreaterThan(1000);

  // Exercise the user-facing route for one complete import. The button opens
  // the real imports.pick handler; only the native dialog itself is queued.
  await importSettings.getByRole("button", { name: "Choose transcript" }).click();
  const previewCard = importSettings.getByRole("region", { name: "Import preview" });
  await expect(previewCard.getByRole("heading", { name: "Refactor the loader" })).toBeVisible();
  await expect(previewCard).toContainText("claude");
  await expect(previewCard).toContainText("3 messages · 1 thinking entries · 2 activities");
  await previewCard.getByRole("button", { name: "Import snapshot" }).click();
  const importedView = page.getByTestId("imported-transcript");
  await expect(importedView).toBeVisible();
  const claudeSession: ImportedSession = {
    id: await page.evaluate(() => window.location.hash.split("/").pop() ?? ""),
    title: "Refactor the loader",
  };
  expect(claudeSession.id).not.toBe("");

  await page.screenshot({ path: path.join(evidenceDir, "imported-transcript.png") });

  const claudeEntries = await invoke<ImportEntry[]>("imports.entries", {
    sessionId: claudeSession.id,
    offset: 0,
    limit: 100,
  });
  expect(claudeEntries.map(({ kind, text }) => `${kind}:${text}`)).toEqual([
    "message:Hello ünïcode ✨ — please read the loader",
    "thinking:The loader is in src/loader.ts",
    "message:Reading it now.",
    'activity:{\n  "file_path": "C:/work/src/loader.ts"\n}',
    "activity-result:export const loader = 1;",
    "message:Done — the loader is fine.",
  ]);
  expect(await invoke("imports.get", { sessionId: claudeSession.id })).toMatchObject({
    backend: "claude",
    nativeId: "11111111-1111-4111-8111-111111111111",
    counts: { entries: 6 },
  });

  const duplicateClaude = await invoke<Preview>("imports.pick", { projectId: project.id });
  expect(duplicateClaude.existingSessionId).toBe(claudeSession.id);
  const duplicateClaudeCommit = await invoke<{
    session: ImportedSession;
    duplicate: boolean;
  }>("imports.commit", { handle: duplicateClaude.handle });
  expect(duplicateClaudeCommit).toMatchObject({ session: claudeSession, duplicate: true });

  const codexPreview = await invoke<Preview>("imports.pick", { projectId: project.id });
  expect(codexPreview).toMatchObject({
    backend: "codex",
    nativeId: "33333333-3333-4333-8333-333333333333",
    title: "Refatorar o carregador ✨",
    counts: { entries: 5 },
  });
  const codexCommit = await invoke<{ session: ImportedSession; duplicate: boolean }>(
    "imports.commit",
    { handle: codexPreview.handle },
  );
  expect(codexCommit.duplicate).toBe(false);
  const codexEntries = await invoke<ImportEntry[]>("imports.entries", {
    sessionId: codexCommit.session.id,
    offset: 0,
    limit: 100,
  });
  expect(codexEntries.map(({ kind, text }) => `${kind}:${text}`)).toEqual([
    "message:Refatorar o carregador ✨",
    "thinking:Plan the change",
    "message:I'll patch it.",
    'activity:{"command":["ls","-la"]}',
    "activity-result:loader.ts\nindex.ts",
  ]);

  const duplicateCodex = await invoke<Preview>("imports.pick", { projectId: project.id });
  expect(duplicateCodex.existingSessionId).toBe(codexCommit.session.id);
  expect(
    await invoke("imports.commit", { handle: duplicateCodex.handle }),
  ).toMatchObject({ session: { id: codexCommit.session.id }, duplicate: true });

  await page.evaluate((sessionId) => { window.location.hash = `#/c/${sessionId}`; }, claudeSession.id);
  await expect(importedView).toBeVisible();
  await expect(importedView.getByText("Imported snapshot · Read only")).toBeVisible();
  await expect(importedView.getByRole("heading", { name: "Refactor the loader" })).toBeVisible();
  await expect(importedView.locator("article")).toHaveCount(6);
  await expect(importedView.getByText("1–6 of 6")).toBeVisible();
  await expect(
    invoke("chat.send", { sessionId: claudeSession.id, text: "must stay read only" }),
  ).rejects.toThrow(/imported transcript sessions are read.only/i);

  const jobsDir = path.join(userDataDir, "imports", "jobs");
  const stagingDir = path.join(userDataDir, "imports", "staging");
  expect(namesOrEmpty(jobsDir)).toEqual([]);
  expect(namesOrEmpty(stagingDir)).toEqual([]);

  // Leave one live preview behind: app shutdown must dispose the staging
  // service and remove it, while every one-shot worker job is already gone.
  await invoke<Preview>("imports.pick", { projectId: project.id });
  expect(namesOrEmpty(stagingDir)).toHaveLength(1);
  await app.close();
  expect(namesOrEmpty(jobsDir)).toEqual([]);
  expect(namesOrEmpty(stagingDir)).toEqual([]);

  for (const [file, before] of fixtureHashes) expect(sha256(file)).toBe(before);

  // Reopen the same profile. Imported rows and entries must come from SQLite,
  // and a fresh native-dialog binding must still deduplicate both snapshots.
  await launchApp();
  await bindNativeSelections([claudeFile, codexFile]);
  const restartedProjects = await invoke<Array<{ id: string; path: string }>>("projects.list", {});
  expect(restartedProjects.map(({ id }) => id)).toContain(project.id);
  expect(await invoke<ImportEntry[]>("imports.entries", {
    sessionId: claudeSession.id,
    offset: 0,
    limit: 100,
  })).toEqual(claudeEntries);
  expect(await invoke<ImportEntry[]>("imports.entries", {
    sessionId: codexCommit.session.id,
    offset: 0,
    limit: 100,
  })).toEqual(codexEntries);

  const persistedClaude = await invoke<Preview>("imports.pick", { projectId: project.id });
  expect(persistedClaude.existingSessionId).toBe(claudeSession.id);
  expect(await invoke("imports.commit", { handle: persistedClaude.handle })).toMatchObject({
    session: { id: claudeSession.id },
    duplicate: true,
  });
  const persistedCodex = await invoke<Preview>("imports.pick", { projectId: project.id });
  expect(persistedCodex.existingSessionId).toBe(codexCommit.session.id);
  expect(await invoke("imports.commit", { handle: persistedCodex.handle })).toMatchObject({
    session: { id: codexCommit.session.id },
    duplicate: true,
  });
  expect(namesOrEmpty(jobsDir)).toEqual([]);
  expect(namesOrEmpty(stagingDir)).toEqual([]);
  await app.close();

  for (const [file, before] of fixtureHashes) expect(sha256(file)).toBe(before);

  for (const sentinel of sentinels) {
    expect(fs.readFileSync(sentinel.file, "utf8")).toBe(sentinel.body);
    expect(fs.statSync(sentinel.file).mtimeMs).toBe(sentinel.mtimeMs);
  }
  expect(pageErrors, pageErrors.join(" | ")).toEqual([]);
});
