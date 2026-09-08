import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { backendHomes, launchEnv, E2E_API_CONFIG, E2E_CLAUDE_MODEL } from "./testPolicy.js";

const repoRoot = path.resolve(__dirname, "..", "..");

async function invoke<T>(page: Page, channel: string, payload: unknown): Promise<T> {
  return page.evaluate(async ({ channel, payload }) => {
    const bridge = (window as unknown as {
      capygen: { invoke(channel: string, payload: unknown): Promise<unknown> };
    }).capygen;
    return bridge.invoke(channel, payload);
  }, { channel, payload }) as Promise<T>;
}

test("sharing uses the native worker and preserves imported history across restart", async () => {
  const homes = backendHomes("sharing-shell");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-sharing-shell-"));
  const userDataDir = path.join(root, "profile");
  const projectDir = path.join(root, "project with spaces");
  fs.mkdirSync(projectDir, { recursive: true });
  const incoming = path.join(root, "incoming.json");
  const jsonPath = path.join(root, "reviewed.json");
  const htmlPath = path.join(root, "reviewed.html");
  fs.writeFileSync(incoming, JSON.stringify({
    kind: "capygen.share", version: 1, bundleId: "b".repeat(32),
    createdAt: "2026-09-08T01:00:00Z", appVersion: "0.1.0",
    source: { title: "Shared fixture", mode: "solo", startedAt: null, endedAt: null, agents: [] },
    entries: [{ index: 0, at: null, label: "assistant", truncated: false,
      kind: "message", speaker: "assistant", text: "A reviewed conversation, with café text." }],
    counts: { entries: 1, messages: 1, thinking: 0, activities: 0, notices: 0,
      truncatedTexts: 0, droppedInteractive: 0, droppedThinking: 0,
      droppedWidgets: 0, droppedUsage: 0, redactions: 0 },
    comments: [{ id: "c".repeat(32), entryIndex: 0, author: "Reviewer",
      body: "Please check this paragraph.", createdAt: "2026-09-08T01:01:00Z",
      replyToId: null, resolved: false }],
  }), "utf8");
  const original = fs.readFileSync(incoming);
  let app: ElectronApplication | undefined;
  const launch = async () => {
    app = await electron.launch({
      args: [path.join(repoRoot, "apps", "desktop"), `--user-data-dir=${userDataDir}`],
      cwd: repoRoot,
      env: launchEnv({ userDataDir, projectDir, homes, engine: "stub" }),
    });
    return app.firstWindow();
  };
  const pick = async (file: string) => {
    await app!.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [selected] })) as typeof dialog.showOpenDialog;
    }, file);
  };
  try {
    let page = await launch();
    const projects = await invoke<Array<{ id: string }>>(page, "projects.list", {});
    const projectId = projects[0]!.id;
    await pick(incoming);
    const preview = await invoke<{ handle: string; entryCount: number }>(page, "sharing.import.pick", { projectId });
    expect(preview.entryCount).toBe(1);
    const entries = await invoke<Array<{ text: string }>>(page, "sharing.import.entries", { handle: preview.handle });
    expect(entries[0]!.text).toContain("café");
    const comments = await invoke<Array<{ body: string }>>(page, "sharing.import.comments", {
      handle: preview.handle, offset: 0, limit: 1,
    });
    expect(comments[0]!.body).toBe("Please check this paragraph.");
    const imported = await invoke<{ session: { id: string; artifactKind: string }; duplicate: boolean }>(page,
      "sharing.import.commit", { handle: preview.handle });
    expect(imported.duplicate).toBe(false);
    expect(imported.session.artifactKind).toBe("shared-bundle");

    const exported = await invoke<{ handle: string; json: { bytes: number }; html: { bytes: number } }>(page,
      "sharing.export.preview", { sessionId: imported.session.id });
    expect(await invoke(page, "sharing.export.comments", { handle: exported.handle })).toEqual(comments);
    for (const [format, target] of [["json", jsonPath], ["html", htmlPath]] as const) {
      await app!.evaluate(({ dialog }, selected) => {
        dialog.showSaveDialog = (async () => ({ canceled: false, filePath: selected })) as typeof dialog.showSaveDialog;
      }, target);
      const saved = await invoke<{ bytes: number }>(page, "sharing.export.save", { handle: exported.handle, format });
      expect(fs.statSync(target).size).toBe(saved.bytes);
      expect(saved.bytes).toBe(exported[format].bytes);
    }
    // This fixture needs no redaction, so its reviewed content remains equal.
    const savedBundle = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    expect(savedBundle.entries).toEqual(entries);
    expect(savedBundle.comments).toEqual(comments);
    expect(fs.readFileSync(htmlPath, "utf8")).not.toContain("<script");
    await invoke(page, "sharing.export.cancel", { handle: exported.handle });
    const { note } = await invoke<{ note: { id: string } }>(page, "sharing.notes.create", {
      sessionId: imported.session.id, anchor: { kind: "entry", entryIndex: 0 },
      body: "Local reply to received feedback.", replyToReceivedId: "c".repeat(32),
    });
    await invoke(page, "sharing.notes.update", { noteId: note.id, resolved: true });
    expect(await invoke(page, "sharing.comments", { sessionId: imported.session.id })).toEqual(comments);
    await app!.close();
    app = undefined;

    page = await launch();
    const restored = await invoke<Array<{ text: string }>>(page, "sharing.entries", { sessionId: imported.session.id });
    expect(restored).toEqual(entries);
    expect(await invoke(page, "sharing.notes.list", { sessionId: imported.session.id })).toMatchObject({
      total: 1, notes: [{ id: note.id, resolved: true, replyToReceivedId: "c".repeat(32) }],
    });
    await pick(incoming);
    const again = await invoke<{ handle: string }>(page, "sharing.import.pick", { projectId });
    const duplicate = await invoke<{ session: { id: string }; duplicate: boolean }>(page,
      "sharing.import.commit", { handle: again.handle });
    expect(duplicate).toMatchObject({ duplicate: true, session: { id: imported.session.id } });
    const annotated = await invoke<{ handle: string }>(page, "sharing.export.preview", { sessionId: imported.session.id });
    expect(await invoke(page, "sharing.export.comments", { handle: annotated.handle })).toEqual([
      ...comments,
      expect.objectContaining({ body: "Local reply to received feedback.", entryIndex: 0,
        resolved: true, replyToId: "c".repeat(32) }),
    ]);
    await invoke(page, "sharing.export.cancel", { handle: annotated.handle });
    const continuation = await invoke<{ session: { id: string; origin: string }; agents: Array<{ id: string; sessionId: string }> }>(page,
      "sharing.continue", { sessionId: imported.session.id, projectId,
        agent: { name: "Fresh fixture", backend: "api", model: E2E_CLAUDE_MODEL,
          role: "lead", config: E2E_API_CONFIG } });
    expect(continuation.session.id).not.toBe(imported.session.id);
    expect(continuation.session.origin).toBe("live");
    expect(continuation.agents).toHaveLength(1);
    expect(continuation.agents[0]!.sessionId).toBe(continuation.session.id);
    expect(continuation.agents[0]!.id).toBeTruthy();
    const continued = await invoke<{ turns: Array<{ role: string }>; blocks: Array<{ id: string; text?: string }> }>(page,
      "sessions.get", { sessionId: continuation.session.id });
    expect(continued.turns.map((turn) => turn.role)).toEqual(["system"]);
    expect(continued.blocks.map((block) => block.text ?? "").join("\n")).toContain("café");
    expect(await invoke(page, "sharing.entries", { sessionId: imported.session.id })).toEqual(entries);
    const fakeToken = "sk-ant-fixtureOnly1234567890";
    await invoke(page, "sharing.notes.create", { sessionId: continuation.session.id,
      anchor: { kind: "block", blockId: continued.blocks[0]!.id }, body: `Example token ${fakeToken}` });
    const liveExport = await invoke<{ handle: string }>(page, "sharing.export.preview", { sessionId: continuation.session.id });
    const liveComments = await invoke<Array<{ body: string; entryIndex: number | null }>>(page,
      "sharing.export.comments", { handle: liveExport.handle });
    expect(liveComments).toHaveLength(1);
    expect(liveComments[0]!.body).not.toContain(fakeToken);
    expect(liveComments[0]!.entryIndex).toBe(0);
    await invoke(page, "sharing.export.cancel", { handle: liveExport.handle });
    await pick(htmlPath);
    const htmlPreview = await invoke<{ handle: string }>(page, "sharing.import.pick", { projectId });
    expect(await invoke(page, "sharing.import.entries", { handle: htmlPreview.handle })).toEqual(entries);
    expect(await invoke(page, "sharing.import.comments", { handle: htmlPreview.handle })).toEqual(comments);
    await invoke(page, "sharing.import.cancel", { handle: htmlPreview.handle });
    expect(fs.readFileSync(incoming)).toEqual(original);

    // Exercise the shipped settings/reader UI through the same real IPC/worker.
    await page.evaluate(() => { location.hash = "/settings/sharing"; });
    await expect(page.getByTestId("settings-sharing")).toBeVisible();
    await page.getByTestId("share-export-session").selectOption(imported.session.id);
    await page.getByTestId("share-export-stage").click();
    await expect(page.getByTestId("share-export-preview")).toContainText("Shared fixture");
    const uiJsonPath = path.join(root, "from-settings.json");
    await app!.evaluate(({ dialog }, selected) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: selected })) as typeof dialog.showSaveDialog;
    }, uiJsonPath);
    await page.getByTestId("share-export-save-json").click();
    await expect(page.getByTestId("share-export-saved")).toContainText("from-settings.json");
    await expect(page.getByTestId("share-export-stage")).toBeEnabled();
    expect(JSON.parse(fs.readFileSync(uiJsonPath, "utf8")).entries).toEqual(entries);
    await pick(incoming);
    await page.getByTestId("share-import-pick").click();
    await expect(page.getByTestId("share-import-preview")).toContainText("Shared fixture");
    await page.getByTestId("share-import-commit").click();
    await expect(page.getByTestId("shared-transcript")).toBeVisible();
    await expect(page.getByTestId("shared-entry-0")).toContainText("café");
  } finally {
    try { await app?.close(); }
    finally {
      try { fs.rmSync(root, { recursive: true, force: true }); }
      finally { homes.cleanup(); }
    }
  }
});
