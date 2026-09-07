import { execFileSync } from "node:child_process";
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
const branch = "codex/e2e-worktree";

let app: ElectronApplication;
let page: Page;
let homes: BackendHomes;
let fixtureRoot: string;
let sourceRepo: string;
let destination: string;
let userDataDir: string;
let gitEnv: NodeJS.ProcessEnv;
const pageErrors: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: gitEnv,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

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

test.beforeAll(async () => {
  homes = backendHomes("worktrees");
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-worktree-e2e-"));
  sourceRepo = path.join(fixtureRoot, "source repo ünïcode");
  destination = path.join(fixtureRoot, "linked worktree ✨");
  userDataDir = path.join(fixtureRoot, "profile");
  const gitHome = path.join(fixtureRoot, "git-home");
  const gitConfig = path.join(gitHome, ".gitconfig");
  fs.mkdirSync(sourceRepo, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(gitHome, { recursive: true });
  fs.writeFileSync(
    gitConfig,
    "[user]\n\tname = capygen e2e\n\temail = worktrees@capygen.local\n[core]\n\tautocrlf = false\n",
    "utf8",
  );
  const inheritedGitEnv: NodeJS.ProcessEnv = { ...process.env };
  // A developer shell inside a hook/rebase may carry GIT_DIR, GIT_WORK_TREE,
  // index or object redirects. The fixture repo must be the only authority.
  for (const key of Object.keys(inheritedGitEnv)) {
    if (key.toLowerCase().startsWith("git_")) delete inheritedGitEnv[key];
  }
  gitEnv = {
    ...inheritedGitEnv,
    HOME: gitHome,
    USERPROFILE: gitHome,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };

  git(sourceRepo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(sourceRepo, "selected.txt"), "selected baseline\n", "utf8");
  fs.writeFileSync(path.join(sourceRepo, "unselected.txt"), "unselected baseline\n", "utf8");
  git(sourceRepo, "add", "--", "selected.txt", "unselected.txt");
  git(sourceRepo, "commit", "-q", "-m", "fixture baseline");

  app = await electron.launch({
    args: [appDir, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
    env: launchEnv({
      userDataDir,
      projectDir: sourceRepo,
      homes,
      engine: "stub",
      extra: {
        HOME: gitHome,
        USERPROFILE: gitHome,
        GIT_CONFIG_GLOBAL: gitConfig,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    }),
  });
  page = await app.firstWindow();
  page.on("pageerror", (error) => pageErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(`console: ${message.text()}`);
  });
  await page.waitForLoadState("domcontentloaded");
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1600, 1000);
  });

  await app.evaluate(({ dialog }, exactDestination) => {
    dialog.showSaveDialog = (async (...args: unknown[]) => {
      const options = args.at(-1) as { title?: string; defaultPath?: string; buttonLabel?: string };
      (globalThis as { __capygenWorktreePicker?: unknown }).__capygenWorktreePicker = options;
      return { canceled: false, filePath: exactDestination };
    }) as typeof dialog.showSaveDialog;
  }, destination);
});

test.afterAll(async () => {
  await app?.close();
  const resolved = path.resolve(fixtureRoot);
  if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
  homes.cleanup();
});

test.afterEach(() => {
  expect(pageErrors, pageErrors.join(" | ")).toEqual([]);
});

test("creates a worktree, runs there, and commits only the selected file", async () => {
  await expect(page.getByTestId("landing-heading")).toBeVisible();
  await page.getByTestId("worktree-chip").click();
  await expect(page.getByRole("button", { name: "Use main" })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel("Branch name").fill(branch);
  await page.getByRole("button", { name: "Choose destination and create" }).click();

  await expect(page.getByTestId("worktree-chip")).toContainText(branch);
  await expect(page.getByTestId("project-chip")).toContainText(path.basename(destination));
  expect(fs.existsSync(path.join(destination, ".git"))).toBe(true);
  expect(
    await app.evaluate(() =>
      (globalThis as { __capygenWorktreePicker?: unknown }).__capygenWorktreePicker,
    ),
  ).toMatchObject({
    title: `Create worktree for ${branch}`,
    buttonLabel: "Create worktree here",
  });

  const composer = page.getByTestId("landing-composer-input");
  await composer.fill("worktree fixture turn");
  await composer.press("Enter");
  await expect(page.getByTestId("chat-page")).toBeVisible();
  await expect(page.getByTestId("transcript")).toContainText("echo: worktree fixture turn");
  const sessionId = await page.evaluate(() => window.location.hash.split("/").pop() ?? "");

  const projects = await invoke<Array<{ id: string; path: string }>>("projects.list", {});
  const worktreeProject = projects.find((project) =>
    fs.realpathSync.native(project.path).toLowerCase() ===
      fs.realpathSync.native(destination).toLowerCase(),
  );
  expect(worktreeProject).toBeDefined();
  const opened = await invoke<{ session: { projectId: string } } | null>("sessions.get", { sessionId });
  expect(opened?.session.projectId).toBe(worktreeProject!.id);

  // A real terminal child supplies the strongest cwd proof available without
  // invoking a model. Capture its output through the production event bridge.
  await page.evaluate(() => {
    const target = globalThis as typeof globalThis & { __capygenTerminal?: string[] };
    target.__capygenTerminal = [];
    const bridge = (window as unknown as {
      capygen: { subscribe(channel: string, listener: (payload: { data?: string }) => void): () => void };
    }).capygen;
    bridge.subscribe("terminal.data", (payload) => {
      if (payload.data) target.__capygenTerminal!.push(payload.data);
    });
  });
  const terminal = await invoke<{ id: string; cwd: string }>("terminal.create", {
    projectId: worktreeProject!.id,
    sessionId,
    cols: 100,
    rows: 30,
  });
  expect(fs.realpathSync.native(terminal.cwd).toLowerCase()).toBe(
    fs.realpathSync.native(destination).toLowerCase(),
  );
  await invoke("terminal.write", {
    id: terminal.id,
    data: `node -e "console.log('CAPYGEN_CWD='+process.cwd())"\r`,
  });
  await expect.poll(() => page.evaluate(() =>
    ((globalThis as typeof globalThis & { __capygenTerminal?: string[] }).__capygenTerminal ?? []).join(""),
  )).toContain(`CAPYGEN_CWD=${terminal.cwd}`);
  await invoke("terminal.kill", { id: terminal.id });

  await invoke("fs.write", {
    projectId: worktreeProject!.id,
    path: "selected.txt",
    content: "selected change\n",
  });
  await invoke("fs.write", {
    projectId: worktreeProject!.id,
    path: "unselected.txt",
    content: "unselected change\n",
  });

  if (!(await page.getByTestId("workspace-host").isVisible())) {
    await page.getByTestId("agents-pane-toggle").dispatchEvent("click");
  }
  await expect(page.getByTestId("workspace-host")).toBeVisible();
  await page.getByTestId("workspace-pane-toggle-diff").click();
  const diff = page.getByTestId("diff-pane");
  await expect(diff).toBeVisible();
  const selectedRow = diff.locator('[data-testid="diff-status-row"][data-path="selected.txt"]');
  const unselectedRow = diff.locator('[data-testid="diff-status-row"][data-path="unselected.txt"]');
  await expect(selectedRow).toBeVisible({ timeout: 20_000 });
  await expect(unselectedRow).toBeVisible();
  await diff.getByLabel("Include unselected.txt in the commit").uncheck();
  await selectedRow.click();
  await expect(diff.getByTestId("diff-body")).toContainText("selected change");
  await diff.getByLabel("Commit message").fill("commit selected only");
  await expect(diff.getByTestId("diff-commit-submit")).toHaveText("Commit 1");
  await diff.getByTestId("diff-commit-submit").click();

  await expect(selectedRow).toHaveCount(0);
  await expect(unselectedRow).toBeVisible();
  expect(git(destination, "show", "--name-only", "--format=", "HEAD")).toBe("selected.txt");
  expect(git(destination, "status", "--porcelain")).toContain("unselected.txt");
  expect(fs.readFileSync(path.join(sourceRepo, "selected.txt"), "utf8")).toBe("selected baseline\n");
  expect(fs.readFileSync(path.join(sourceRepo, "unselected.txt"), "utf8")).toBe("unselected baseline\n");
  expect(git(sourceRepo, "status", "--porcelain")).toBe("");
});
