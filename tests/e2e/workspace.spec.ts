/**
 * Phase 5 end to end: the workspace panes and dev servers (SPEC R16-R18,
 * G5, G6), entirely offline — `CAPYGEN_ENGINE=stub`, a fixture project made
 * of copied files and a `git init`, and a dev server that is a 30-line node
 * script. No model call, no network, no cost.
 *
 * Seven proofs, run in order against **one** profile because two of them are
 * only meaningful across a restart:
 *
 *   (a) Files + Editor — open the tree, open a file, type into CodeMirror,
 *       Ctrl+S, and assert the bytes on disk changed. The whole path:
 *       `fs.list` → `fs.read` → `fs.write`;
 *   (b) Diff — the same edit shows up in `git.status`/`git.diff`;
 *   (c) Tasks — a recorded `TodoWrite` block (the echo engine's `todo:`
 *       prefix) becomes task rows through the broadcast tap, without any
 *       model being asked for a plan (R26);
 *   (d) Terminal — `echo capy` into a real ConPTY and `capy` back out of
 *       xterm's own buffer, read through xterm's addon-free API;
 *   (e) Layout — drag the Terminal tab into the Browser group with the
 *       mouse, restart the app on the same profile, and assert the group
 *       tree comes back in the same shape (SPEC R17, G5);
 *   (f) Servers — the fixture's `dev` script is detected, Start streams its
 *       log, discovery reads the URL it printed, and the Browser pane's
 *       native `WebContentsView` actually loads it (SPEC R18, G6);
 *   (g) Overlay tracking — the native view's `getBounds()` and the
 *       placeholder's `getBoundingClientRect()` agree to within 2px through
 *       a group maximise and a window resize. The one assertion here that a
 *       screenshot cannot make, since neither process can photograph the
 *       other.
 *
 * Screenshots: `e2e-out/workspace-layout.png`, `workspace-server.png`,
 * `workspace-server-view.png`, `workspace-tasks.png`.
 *
 * A note on what a screenshot can show: the Browser pane is a native
 * `WebContentsView` floating *above* the renderer (Omnigent's pattern, never
 * `<webview>`), so `page.screenshot()` — which captures one web contents —
 * cannot contain it. `workspace-server.png` is therefore the app's own UI
 * (URL bar, title strip, running server, log tail) and
 * `workspace-server-view.png` is the native view's own `capturePage()`.
 * Together they show the same fact from both sides; the assertions do not
 * depend on either.
 */
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

/** One set of disposable backend homes for this spec file; a relaunch in the
 *  same test must see the same (still empty) homes. */
const homes = backendHomes("workspace");
test.afterAll(() => homes.cleanup());

const repoRoot = path.resolve(__dirname, "..", "..");
const appDir = path.join(repoRoot, "apps", "desktop");
const outDir = path.join(repoRoot, "e2e-out");
const fixtureDir = path.join(repoRoot, "tests", "fixtures", "servers", "node");

/** The port the fixture's `dev` script binds (`package.json`). */
const FIXTURE_PORT = 5199;
const FIXTURE_URL = `http://localhost:${FIXTURE_PORT}/`;
/** Starting a server means spawning a package manager: slower than a click. */
const SERVER_TIMEOUT_MS = 90_000;

let app: ElectronApplication;
let page: Page;
let userDataDir: string;
let projectDir: string;
let sessionId: string;
const pageErrors: string[] = [];

/** dockview writes a branch node as `{type:"branch", data:[…]}` and a leaf as
 *  `{type:"leaf", data:{views:[panelId,…], activeView, id}}` — the payload is
 *  always under `data`, which is what makes a naive `node.views` read come
 *  back empty. */
interface SerializedGroup {
  type: string;
  data: SerializedGroup[] | { views?: string[]; activeView?: string; id?: string };
}

test.describe.configure({ mode: "serial" });

async function launch(): Promise<void> {
  pageErrors.length = 0;
  app = await electron.launch({
    args: [appDir, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
    // Offline: the workspace panes are the subject, not a model.
    env: launchEnv({ userDataDir, projectDir, homes, engine: "stub" }),
  });
  page = await app.firstWindow();
  page.on("pageerror", (err) => pageErrors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") pageErrors.push(`console: ${msg.text()}`);
  });
  await page.waitForLoadState("domcontentloaded");
  // A window wide enough for a workspace beside the transcript; the default
  // e2e window is narrower than the pane host's own minimum.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1600, 1000);
  });
}

async function invoke<T>(channel: string, payload: unknown): Promise<T> {
  return page.evaluate(
    async ([ch, args]) => {
      const bridge = (
        window as unknown as {
          capygen?: { invoke(channel: string, payload: unknown): Promise<unknown> };
        }
      ).capygen;
      if (!bridge) throw new Error("preload bridge missing");
      return bridge.invoke(ch as string, args);
    },
    [channel, payload] as const,
  ) as Promise<T>;
}

/** Route to the session and make sure the workspace host is showing. */
async function openWorkspace(): Promise<void> {
  await page.evaluate((id) => {
    window.location.hash = `#/c/${id}`;
  }, sessionId);
  await expect(page.getByTestId("chat-page")).toBeVisible();
  if (!(await page.getByTestId("workspace-host").isVisible())) {
    // The header row shares its space with the window-wide `.titlebar-drag`
    // strip, which swallows a plain click (see roundtable.spec.ts).
    await page.getByTestId("agents-pane-toggle").dispatchEvent("click");
  }
  await expect(page.getByTestId("workspace-host")).toBeVisible();
}

/** Open one pane through the workspace toolbar, tolerating "already open". */
async function openPane(kind: string): Promise<void> {
  const button = page.getByTestId(`workspace-pane-toggle-${kind}`);
  if ((await button.getAttribute("aria-pressed")) === "true") {
    // Open already — click would close it if it is also the active tab.
    await page.locator(`.dv-tab`, { hasText: paneTitle(kind) }).first().click();
    return;
  }
  await button.click();
}

function paneTitle(kind: string): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

/** Flatten dockview's serialized grid into "which panels, in which leaf". */
function leafViews(node: SerializedGroup | undefined): string[][] {
  if (!node) return [];
  if (node.type === "leaf") {
    const data = node.data as { views?: string[] };
    return [data?.views ?? []];
  }
  return ((node.data as SerializedGroup[]) ?? []).flatMap((child) => leafViews(child));
}

test.beforeAll(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-ws-"));
  projectDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "capygen-ws-proj-")));
  fs.mkdirSync(outDir, { recursive: true });

  // The fixture dev-server project (SPEC R18's package.json detector), copied
  // out of the repo so `git.status` sees *this* project rather than capygen's
  // own working tree, and so the editor may write to it.
  //
  // `pnpm-lock.yaml` is deliberately **not** copied. The lockfile is what the
  // detector reads to choose a runner, and `corepack pnpm` outside a project
  // with a `packageManager` field asks corepack for a pnpm build this machine
  // has never downloaded — offline, that is a `MODULE_NOT_FOUND` before the
  // script ever runs. Without the lockfile the runner is `npm run dev`, which
  // is a `.cmd` shim and therefore also exercises the `cmd.exe /d /s /c` path
  // `resolveWindowsCommand` exists for (COMPAT.md, CVE-2024-27980).
  for (const name of ["package.json", "server.mjs"]) {
    fs.copyFileSync(path.join(fixtureDir, name), path.join(projectDir, name));
  }
  fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "src", "greeting.txt"), "hello\n", "utf8");

  // A committed baseline, so the Diff pane has something to diff *against*.
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: projectDir, stdio: "ignore" });
  };
  git("init", "-q");
  git("config", "user.email", "e2e@capygen.local");
  git("config", "user.name", "capygen e2e");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture baseline");

  await launch();
  const projects = await invoke<{ id: string; path: string }[]>("projects.list", {});
  const project = projects.find((p) => p.path === projectDir) ?? projects[0]!;
  const created = await invoke<{ session: { id: string } }>("sessions.create", {
    projectId: project.id,
    mode: "solo",
    title: "workspace",
    agents: [{ name: "Echo", mentionName: "echo", backend: "claude", model: "stub", role: "lead" }],
  });
  sessionId = created.session.id;
  await openWorkspace();
});

test.afterAll(async () => {
  // Never leave a dev server holding 5199 behind for the next run.
  try {
    const rows = await invoke<{ server: { id: string }; run: { status: string } | null }[]>(
      "servers.list",
      { projectId: (await invoke<{ id: string; path: string }[]>("projects.list", {})).find((p) => p.path === projectDir)?.id },
    );
    for (const row of rows) {
      if (row.run && row.run.status === "running") {
        await invoke("servers.stop", { serverId: row.server.id });
      }
    }
  } catch {
    // The app may already be gone; `dispose()` kills the children anyway.
  }
  await app?.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
});

test.afterEach(() => {
  expect(pageErrors, pageErrors.join(" | ")).toEqual([]);
});

test("(a) Files opens a file in the Editor and Ctrl+S writes it to disk", async () => {
  await openPane("files");
  await expect(page.getByTestId("files-pane")).toBeVisible();

  // The tree lists the project root, lazily (`fs.list`, depth 1).
  const srcRow = page.locator('[data-testid="file-tree-row"][data-path="src"]');
  await expect(srcRow).toBeVisible();
  await srcRow.locator('[role="treeitem"]').first().click();

  const fileRow = page.locator('[data-testid="file-tree-row"][data-path="src/greeting.txt"]');
  await expect(fileRow).toBeVisible();
  await fileRow.locator('[role="treeitem"]').first().dblclick();

  // Opening a file creates the Editor panel (`workspace/openInEditor.ts`).
  await expect(page.getByTestId("editor-pane")).toBeVisible();
  await expect(page.getByTestId("editor-tab")).toHaveCount(1);
  const content = page.locator(".cm-content");
  await expect(content).toContainText("hello");

  await content.click();
  // A click lands wherever it lands (the file's last line is empty), so put
  // the caret at a known place before typing.
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("End");
  await page.keyboard.type(" workspace");
  // Dirty is computed by comparing the document to what was read, not by a
  // sticky flag — so the marker appearing means the buffer really differs.
  await expect(page.getByTestId("editor-tab-dirty")).toBeVisible();

  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("editor-tab-dirty")).toHaveCount(0);

  // The point of the whole path: the bytes on disk.
  await expect
    .poll(() => fs.readFileSync(path.join(projectDir, "src", "greeting.txt"), "utf8"))
    .toContain("hello workspace");
});

test("(b) the Diff pane shows the file the Editor just changed", async () => {
  await openPane("diff");
  await expect(page.getByTestId("diff-pane")).toBeVisible();

  const row = page.getByTestId("diff-status-row").filter({ hasText: "src/greeting.txt" });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();

  // `git.diff` for one path, rendered by the transcript's own DiffView.
  await expect(page.getByTestId("diff-body")).toContainText("hello workspace");
});

test("(c) a recorded TodoWrite block becomes rows in the Tasks pane", async () => {
  // The echo engine writes a real Claude-shaped `TodoWrite` tool call for a
  // `todo:` message (`apps/desktop/src/engine/stub.ts`). Nothing asks a model
  // for a plan — the derivation is the broadcast tap in `ipc/handlers.ts`.
  await openPane("tasks");
  await expect(page.getByTestId("tasks-pane")).toBeVisible();
  await expect(page.getByTestId("tasks-empty")).toBeVisible();

  const composer = page.getByTestId("chat-composer-input");
  await composer.click();
  await composer.fill("todo: wire the panes, prove the layout, ship phase 5");
  await composer.press("Enter");

  await expect(page.getByTestId("task-row")).toHaveCount(3, { timeout: 20_000 });
  await expect(page.getByTestId("tasks-group-in_progress")).toContainText("wire the panes");
  await expect(page.getByTestId("tasks-group-pending")).toContainText("ship phase 5");

  await page.screenshot({ path: path.join(outDir, "workspace-tasks.png") });
});

test("(d) a terminal runs a command and its output reaches the xterm buffer", async () => {
  await openPane("terminal");
  await expect(page.getByTestId("terminal-pane")).toBeVisible();
  await expect(page.getByTestId("terminal-tab")).toHaveCount(1);

  // xterm takes keystrokes through its own hidden textarea; the pane focuses
  // it for the active tab, and clicking the viewport is what a user does.
  await page.locator(".xterm-screen").first().click();
  await page.keyboard.type("echo capy");
  await page.keyboard.press("Enter");

  // Read xterm's own buffer rather than the DOM: the WebGL renderer draws to
  // a canvas, so "what is on screen" is not in the accessibility tree.
  await expect
    .poll(async () => terminalBufferText(), { timeout: 30_000, intervals: [500] })
    .toContain("capy");
});

/**
 * xterm draws to a canvas under the WebGL renderer, so "what the terminal
 * shows" is not in the DOM and not in the accessibility tree. The pane
 * therefore hangs the live `Terminal` on its own container element
 * (`__xterm`, see `TerminalPane.tsx`) and this reads the public buffer API
 * off it — the same thing an xterm addon would see.
 */
async function terminalBufferText(): Promise<string> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="terminal-instance"]') as
      | (HTMLElement & {
          __xterm?: {
            buffer: {
              active: {
                length: number;
                getLine(i: number): { translateToString(trim?: boolean): string } | undefined;
              };
            };
          };
        })
      | null;
    const buffer = el?.__xterm?.buffer.active;
    if (!buffer) return "";
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i += 1) {
      lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
    }
    return lines.join(String.fromCharCode(10));
  });
}

test("(e) dragging the Terminal tab under the Browser group survives a restart", async () => {
  // Both panes explicitly, so this test also stands on its own (`-g "(e)"`).
  await openPane("terminal");
  await expect(page.getByTestId("terminal-pane")).toBeVisible();
  await openPane("browser");
  await expect(page.getByTestId("browser-pane")).toBeVisible();

  // Every pane the toolbar opens joins the active group, so the workspace is
  // one tab stack at this point — a real starting state, and one where a
  // dock actually changes the tree rather than being a no-op.
  await expect.poll(async () => (await groupTabs()).length).toBe(1);

  // Drag the Terminal *tab* onto the bottom quadrant of the group's content
  // area. Dockview's drop target splits a group by quadrant, so this is the
  // gesture that means "dock it underneath" rather than "add another tab".
  const terminalTab = page.locator(".dv-tab", { hasText: "Terminal" }).first();
  await expect(terminalTab).toBeVisible();
  await dragTabToBottomOfGroup(terminalTab);

  // Two groups now, Terminal alone in the lower one (SPEC R17: dock
  // left/right/top/bottom, not only stack-as-tabs).
  await expect.poll(async () => await groupTabs(), { timeout: 20_000, intervals: [250] }).toEqual([
    expect.arrayContaining(["Browser"]),
    ["Terminal"],
  ]);
  const before = await groupTabs();
  expect(before[1]).toEqual(["Terminal"]);
  expect(before[0]).not.toContain("Terminal");

  // …and the same shape reached the saved row, which is what a restart
  // replays. `layout.set` is debounced, so poll for the settled write.
  const saved = async (): Promise<string[][]> =>
    leafViews(
      (
        await invoke<{ layoutJson: { grid?: { root?: SerializedGroup } } } | null>("layout.get", {
          projectId: await currentProjectId(),
        })
      )?.layoutJson.grid?.root,
    );
  await expect
    .poll(saved, { timeout: 20_000, intervals: [500] })
    .toEqual([expect.arrayContaining(["browser"]), ["terminal"]]);

  await page.screenshot({ path: path.join(outDir, "workspace-layout.png") });

  // Restart on the same profile — the whole point of R17's "saved per project".
  await app.close();
  await launch();
  await openWorkspace();
  await expect(page.locator(".dv-tab", { hasText: "Browser" })).toHaveCount(1);

  const after = await groupTabs();
  expect(after).toEqual(before);
});

/** Every dockview group's tab titles, in document order. */
async function groupTabs(): Promise<string[][]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".dv-groupview")).map((group) =>
      Array.from(group.querySelectorAll(".dv-tab")).map((tab) => (tab.textContent ?? "").trim()),
    ),
  );
}

async function currentProjectId(): Promise<string> {
  const projects = await invoke<{ id: string; path: string }[]>("projects.list", {});
  return (projects.find((p) => p.path === projectDir) ?? projects[0]!).id;
}

/**
 * Dockview's tabs are native HTML5 drag sources (`draggable=true` +
 * `dragstart`); its pointer backend deliberately ignores mouse input on a
 * fine-pointer device, so this has to be a real HTML5 drag. Playwright's
 * Chromium intercepts drags and synthesises the DnD event sequence from
 * mouse input, but only for a *stepped* gesture — one jump from source to
 * target never produces the `dragover` the drop target needs, and the drop
 * overlay needs a few frames inside the quadrant before it commits.
 *
 * The destination is the bottom eighth of the group's content area, which is
 * dockview's "dock below" quadrant.
 */
async function dragTabToBottomOfGroup(tab: ReturnType<Page["locator"]>): Promise<void> {
  const from = (await tab.boundingBox())!;
  const group = (await page.locator(".dv-groupview").first().boundingBox())!;
  const toX = group.x + group.width / 2;
  const toY = group.y + group.height * 0.93;
  const startX = from.x + from.width / 2;
  const startY = from.y + from.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  const steps = 16;
  for (let step = 1; step <= steps; step += 1) {
    await page.mouse.move(
      startX + ((toX - startX) * step) / steps,
      startY + ((toY - startY) * step) / steps,
      { steps: 4 },
    );
  }
  // Sit still inside the quadrant so the overlay resolves before the drop.
  await page.mouse.move(toX, toY);
  await page.waitForTimeout(200);
  await page.mouse.up();
}

test("(f) the fixture dev server is detected, started, and loaded in the Browser pane", async () => {
  test.setTimeout(SERVER_TIMEOUT_MS + 60_000);
  await openPane("servers");
  await expect(page.getByTestId("servers-pane")).toBeVisible();

  // R18's package.json detector: the `dev` script, run through the package
  // manager the lockfile names.
  const row = page.getByTestId("server-row").filter({ hasText: "npm dev" });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toContainText("port 5199");

  await row.getByTestId("server-logs-toggle").click();
  await row.getByTestId("server-start").click();

  // Status first (`servers.status`), then the log tail (`servers.log`).
  await expect(row.getByTestId("server-stop")).toBeVisible({ timeout: SERVER_TIMEOUT_MS });
  await expect(row.getByTestId("server-status-dot")).toHaveAttribute("data-status", "running", {
    timeout: SERVER_TIMEOUT_MS,
  });
  await expect(row.getByTestId("server-logs")).toContainText("Local:", {
    timeout: SERVER_TIMEOUT_MS,
  });

  // G6: the URL discovered from that log line opens in the Browser pane
  // without anyone clicking anything else.
  await expect(page.getByTestId("browser-url-input")).toHaveValue(FIXTURE_URL, {
    timeout: SERVER_TIMEOUT_MS,
  });
  // Proof the *native* view actually loaded the page rather than the URL bar
  // merely echoing what was typed: the title only exists if the document
  // parsed (`browser.state`, pushed from `did-navigate`/`page-title-updated`).
  await expect(page.getByTestId("browser-title")).toHaveText("capygen fixture dev server", {
    timeout: SERVER_TIMEOUT_MS,
  });

  await page.screenshot({ path: path.join(outDir, "workspace-server.png") });

  // …and the same fact from the other side: the WebContentsView's own pixels.
  const shot = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    for (const child of win?.contentView.children ?? []) {
      const contents = (child as unknown as { webContents?: Electron.WebContents }).webContents;
      if (!contents || contents.isDestroyed()) continue;
      const image = await contents.capturePage();
      return { url: contents.getURL(), png: image.toPNG().toString("base64") };
    }
    return null;
  });
  expect(shot?.url).toBe(FIXTURE_URL);
  fs.writeFileSync(path.join(outDir, "workspace-server-view.png"), Buffer.from(shot!.png, "base64"));

  // Opening the URL activated the Browser tab, which shares this group — the
  // Servers pane is mounted but hidden (`defaultRenderer: "always"`), so
  // bring it back to the front before clicking in it.
  await openPane("servers");
  await row.getByTestId("server-stop").click();
  await expect(row.getByTestId("server-start")).toBeVisible({ timeout: 30_000 });
});

test("(g) the native overlay tracks its placeholder through maximise and a window resize", async () => {
  // The Browser pane is a native `WebContentsView` positioned in *window*
  // coordinates over a placeholder div, so "does it line up" is a fact about
  // two numbers that live in two processes. This reads both and compares
  // them — the only assertion in this file that can catch the overlay
  // drifting, because a screenshot of the renderer cannot contain the view
  // and a screenshot of the view cannot contain the page.
  await openPane("browser");
  await expect(page.getByTestId("browser-pane")).toBeVisible();

  // A native view only exists once something has navigated — an un-navigated
  // pane deliberately shows its "Enter a URL" card rather than a blank
  // rectangle. The full-file run arrives here already on the fixture URL from
  // (f); this covers `-g "(g)"` on a fresh profile, where whether the page
  // loads does not matter (the view is created either way).
  const urlBar = page.getByTestId("browser-url-input");
  if ((await urlBar.inputValue()) === "") {
    await urlBar.fill(FIXTURE_URL);
    await urlBar.press("Enter");
  }
  await expect.poll(overlayOffset, { timeout: 20_000, intervals: [250] }).toBeLessThanOrEqual(2);

  // Maximising is only a *change* when there is a second group to maximise
  // over. The full-file run arrives here with one from (e); this rebuilds it
  // so `-g "(g)"` on a fresh profile means the same thing.
  if ((await groupTabs()).length < 2) {
    await openPane("terminal");
    await expect(page.getByTestId("terminal-pane")).toBeVisible();
    await dragTabToBottomOfGroup(page.locator(".dv-tab", { hasText: "Terminal" }).first());
    await expect.poll(async () => (await groupTabs()).length, { timeout: 20_000 }).toBe(2);
  }

  // Maximise the Browser's group: the placeholder grows to the whole
  // workspace column. Dockview does this without touching the serialisable
  // grid, so it is `onDidMaximizedGroupChange` — not `onDidLayoutChange` —
  // that has to move the view.
  const before = (await placeholderBox())!;
  await browserGroupMaximizeButton().click();
  await expect.poll(async () => (await placeholderBox())!.height).toBeGreaterThan(before.height + 20);
  await expect.poll(overlayOffset, { timeout: 20_000, intervals: [250] }).toBeLessThanOrEqual(2);

  // …and a window resize, which moves the box's *left edge* as well as its
  // size — the case a `ResizeObserver` on the placeholder alone would catch
  // but a naive width-only sync would not.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1280, 900);
  });
  await expect.poll(async () => (await placeholderBox())!.x).not.toBe(before.x);
  await expect.poll(overlayOffset, { timeout: 20_000, intervals: [250] }).toBeLessThanOrEqual(2);

  // Leave the workspace as the other tests found it.
  await browserGroupMaximizeButton().click();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1600, 1000);
  });
});

/**
 * The maximize/restore button in the header of whichever group currently
 * holds the Browser tab.
 *
 * Found by the *tab*, not by the pane body: under `defaultRenderer="always"`
 * dockview hoists every panel's content out of its `.dv-groupview` into a
 * shared overlay container, so `{ has: getByTestId("browser-pane") }` matches
 * nothing at all — the pane's DOM is not inside the group that owns it.
 */
function browserGroupMaximizeButton(): ReturnType<Page["locator"]> {
  return page
    .locator(".dv-groupview")
    .filter({ has: page.locator(".dv-tab", { hasText: "Browser" }) })
    .getByTestId("workspace-group-maximize");
}

/** The placeholder the native view is supposed to cover, in CSS pixels. */
async function placeholderBox(): Promise<{
  x: number;
  y: number;
  width: number;
  height: number;
} | null> {
  return page.getByTestId("browser-container").boundingBox();
}

/**
 * How far the native `WebContentsView` is from the placeholder it overlays,
 * in device-independent pixels — the largest of the four edge deltas.
 *
 * `getBounds()` on the view is in the window's *content* coordinate space,
 * which is exactly the space `getBoundingClientRect()` returns for a page
 * that does not scroll as a whole (the app's shell never does), so the two
 * are directly comparable. Rounding on the renderer side is why the tests
 * allow 2px rather than demanding equality.
 */
async function overlayOffset(): Promise<number> {
  const box = await placeholderBox();
  if (!box) return Number.POSITIVE_INFINITY;
  const view = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    for (const child of win?.contentView.children ?? []) {
      const contents = (child as unknown as { webContents?: Electron.WebContents }).webContents;
      if (!contents || contents.isDestroyed()) continue;
      return (child as unknown as { getBounds(): Electron.Rectangle }).getBounds();
    }
    return null;
  });
  if (!view) return Number.POSITIVE_INFINITY;
  return Math.max(
    Math.abs(view.x - box.x),
    Math.abs(view.y - box.y),
    Math.abs(view.width - box.width),
    Math.abs(view.height - box.height),
  );
}
