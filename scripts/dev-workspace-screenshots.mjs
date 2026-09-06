// One-off screenshot capture for the Phase 5 B2 Done-when evidence
// (e2e-out/workspace-files.png, e2e-out/workspace-editor.png). Drives the
// /dev/workspace fixture route in a plain Chromium tab (not Electron — this
// route fakes its own IPC bridge, see DevWorkspacePage.tsx) against an
// already-running `vite` dev server. Not part of the test suite; run by hand.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE_URL = process.argv[2] ?? "http://localhost:5299";
const OUT_DIR = "e2e-out";
mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.on("pageerror", (err) => console.error("[pageerror]", err.message));
page.on("console", (msg) => {
  if (msg.type() === "error") console.error("[console.error]", msg.text());
});

await page.goto(`${BASE_URL}/#/dev/workspace`, { waitUntil: "networkidle" });
await page.getByTestId("workspace-host").waitFor({ state: "visible" });

// Widen the workspace host for a more legible screenshot (drag its resize
// handle). `dispatchEvent` avoids any flakiness in synthetic mouse-drag
// timing against the pointer-events-based handler.
await page.evaluate(() => {
  const handle = document.querySelector('[data-testid="workspace-resize-handle"]');
  const rect = handle.getBoundingClientRect();
  const startX = rect.x + rect.width / 2;
  const startY = rect.y + rect.height / 2;
  handle.dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, clientX: startX, clientY: startY, pointerId: 1 }),
  );
  window.dispatchEvent(
    new PointerEvent("pointermove", { bubbles: true, clientX: startX - 500, clientY: startY, pointerId: 1 }),
  );
  window.dispatchEvent(
    new PointerEvent("pointerup", { bubbles: true, clientX: startX - 500, clientY: startY, pointerId: 1 }),
  );
});
await page.waitForTimeout(150);

// --- workspace-files.png: Files tab active, "src" expanded ---
await page.getByRole("tab", { name: "Files" }).click();
await page.getByTestId("files-tree").waitFor({ state: "visible" });
await page.locator('[data-testid="file-tree-row"][data-path="src"] [role="treeitem"]').click();
await page.getByText("App.tsx").waitFor({ state: "visible" });
await page.screenshot({ path: `${OUT_DIR}/workspace-files.png` });
console.log("wrote", `${OUT_DIR}/workspace-files.png`);

// --- workspace-editor.png: open App.tsx, dirty tab, Diff tab visible too ---
await page.locator('[data-testid="file-tree-row"][data-path="src/App.tsx"] [role="treeitem"]').dblclick();
await page.getByTestId("editor-tab").waitFor({ state: "visible" });
await page.getByTestId("editor-cm-container").waitFor({ state: "visible" });
// Type a small edit so the dirty indicator and Ln/Col status have something
// to show, by dispatching a transaction straight at the mounted view (jsdom
// note applies to a real browser too: CodeMirror owns its own contentEditable
// and does not react to a plain DOM text mutation the way an <input> would,
// but here — a REAL browser — normal keyboard input works fine).
await page.locator(".cm-content").click();
await page.keyboard.type("\n// screenshot edit");
await page.waitForTimeout(150);
await page.screenshot({ path: `${OUT_DIR}/workspace-editor.png` });
console.log("wrote", `${OUT_DIR}/workspace-editor.png`);

await browser.close();
