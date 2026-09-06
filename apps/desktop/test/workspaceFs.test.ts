/**
 * `FsService` against a real temp tree (SPEC R16, bounded per R23-R26).
 *
 * The three things worth pinning: the ignore list is honoured, every cap is
 * real (and says so with `truncated`), and no path can escape the project
 * root — the Files pane is reachable from anything that can reach the
 * renderer.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FsService,
  MAX_ENTRIES_PER_DIR,
  WATCH_DEBOUNCE_MS,
  looksBinary,
} from "../src/workspace/FsService.js";
import { isIgnoredPath } from "../src/workspace/ignore.js";
import { resolveInside } from "../src/workspace/paths.js";
import { makeHarness, seed, sleep, waitFor, type Harness } from "./workspaceHarness.js";

let h: Harness;
let service: FsService;

beforeEach(() => {
  h = makeHarness({ prefix: "capygen-fs-" });
  service = new FsService({
    store: h.store,
    broadcast: h.broadcast,
    log: h.log,
    // The walker branch is what this machine has (no `rg` on PATH); pinning it
    // means the test does not depend on whether ripgrep is installed.
    ripgrepPath: () => null,
  });
});

afterEach(async () => {
  await service.dispose();
  h.close();
});

describe("fs.list", () => {
  it("lists one directory, dirs first, and skips ignored ones", () => {
    seed(h.root, {
      "src/main.ts": "export {};\n",
      "README.md": "# hi\n",
      "node_modules/left-pad/index.js": "module.exports = 1;\n",
      "dist/bundle.js": "1;\n",
      ".git/HEAD": "ref: refs/heads/main\n",
    });

    const result = service.list({ projectId: h.projectId, dir: "" });
    const names = result.entries.map((e) => e.name);

    expect(names).toEqual(["src", "README.md"]);
    expect(result.entries[0]?.kind).toBe("dir");
    expect(result.entries[1]?.path).toBe("README.md");
    expect(result.truncated).toBe(false);
  });

  it("recurses only as deep as `depth` says, with POSIX paths", () => {
    seed(h.root, { "a/b/c/deep.txt": "x", "a/top.txt": "y" });

    const shallow = service.list({ projectId: h.projectId, dir: "", depth: 0 });
    expect(shallow.entries.map((e) => e.path)).toEqual(["a"]);

    const deeper = service.list({ projectId: h.projectId, dir: "", depth: 2 });
    expect(deeper.entries.map((e) => e.path)).toContain("a/b/c");
    expect(deeper.entries.map((e) => e.path)).not.toContain("a/b/c/deep.txt");

    const deepest = service.list({ projectId: h.projectId, dir: "a/b", depth: 1 });
    expect(deepest.entries.map((e) => e.path)).toEqual(["a/b/c", "a/b/c/deep.txt"]);
  });

  it("caps one directory and reports it as truncated", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < MAX_ENTRIES_PER_DIR + 25; i += 1) {
      files[`many/file-${String(i).padStart(4, "0")}.txt`] = "x";
    }
    seed(h.root, files);

    const result = service.list({ projectId: h.projectId, dir: "many" });
    expect(result.entries).toHaveLength(MAX_ENTRIES_PER_DIR);
    expect(result.truncated).toBe(true);
  });

  it("refuses a path that escapes the project", () => {
    expect(() => service.list({ projectId: h.projectId, dir: "../.." })).toThrow(/escapes/);
    expect(() => service.read({ projectId: h.projectId, path: "..\\secrets.txt" })).toThrow(
      /escapes/,
    );
    expect(() => resolveInside(h.root, "C:/Windows/System32")).toThrow(/escapes/);
  });

  it("throws for an unknown project rather than answering empty", () => {
    expect(() => service.list({ projectId: "prj_nope", dir: "" })).toThrow(/unknown project/);
  });
});

describe("fs.read / fs.write", () => {
  it("reads utf8 and reports the size", () => {
    seed(h.root, { "notes.md": "héllo\n" });
    const result = service.read({ projectId: h.projectId, path: "notes.md" });
    expect(result.encoding).toBe("utf8");
    expect(result.binary).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.content).toBe("héllo\n");
    expect(result.path).toBe("notes.md");
  });

  it("truncates at maxBytes but still reports the real size", () => {
    seed(h.root, { "big.txt": "abcdefghij" });
    const result = service.read({ projectId: h.projectId, path: "big.txt", maxBytes: 4 });
    expect(result.content).toBe("abcd");
    expect(result.size).toBe(10);
    expect(result.truncated).toBe(true);
  });

  it("returns base64 for a binary file instead of refusing it", () => {
    fs.writeFileSync(path.join(h.root, "logo.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    const result = service.read({ projectId: h.projectId, path: "logo.bin" });
    expect(result.binary).toBe(true);
    expect(result.encoding).toBe("base64");
    expect(Buffer.from(result.content, "base64")).toEqual(Buffer.from([0x89, 0x50, 0x00, 0x01]));
  });

  it("writes atomically, creating parents, and leaves no temp file behind", () => {
    service.write({ projectId: h.projectId, path: "src/new/file.ts", content: "export {};\n" });
    expect(fs.readFileSync(path.join(h.root, "src/new/file.ts"), "utf8")).toBe("export {};\n");
    expect(fs.readdirSync(path.join(h.root, "src", "new"))).toEqual(["file.ts"]);
  });

  /**
   * A junction inside the project is lexically indistinguishable from a
   * folder: `path.relative` says `<root>/escape/x.txt` is inside the root, and
   * the OS then follows the link and writes outside it. `read`/`list` have
   * always realpath-checked; `write` is the one that creates bytes, so it is
   * the one that mattered.
   */
  it("refuses a write that leaves the project through a junction/symlink", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-outside-"));
    let linked = false;
    try {
      // Windows: a directory junction needs no elevation; POSIX: a symlink.
      fs.symlinkSync(outside, path.join(h.root, "escape"), "junction");
      linked = true;
    } catch {
      // No permission to create one (a locked-down profile) — nothing to
      // prove here, and a skipped assertion beats a false red.
    }
    if (!linked) {
      fs.rmSync(outside, { recursive: true, force: true });
      return;
    }

    expect(() =>
      service.write({ projectId: h.projectId, path: "escape/pwned.txt", content: "x" }),
    ).toThrow(/escapes the project/);
    expect(fs.existsSync(path.join(outside, "pwned.txt"))).toBe(false);

    // A directory *below* the junction that does not exist yet is the same
    // attack with one more component; the nearest-existing-ancestor check is
    // what catches that one.
    expect(() =>
      service.write({ projectId: h.projectId, path: "escape/deep/pwned.txt", content: "x" }),
    ).toThrow(/escapes the project/);
    expect(fs.existsSync(path.join(outside, "deep"))).toBe(false);

    fs.rmSync(path.join(h.root, "escape"), { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
});

describe("fs.search", () => {
  beforeEach(() => {
    seed(h.root, {
      "src/main.ts": "1",
      "src/mailer.ts": "1",
      "docs/manual.md": "1",
      "node_modules/mail/index.js": "1",
    });
  });

  it("matches a case-insensitive substring of the project-relative path", () => {
    const result = service.search({ projectId: h.projectId, query: "MAI" });
    const paths = result.entries.map((e) => e.path).sort();
    expect(paths).toEqual(["src/mailer.ts", "src/main.ts"]);
  });

  it("never returns ignored directories", () => {
    const result = service.search({ projectId: h.projectId, query: "mail" });
    expect(result.entries.map((e) => e.path)).not.toContain("node_modules/mail/index.js");
  });

  it("honours the limit and says it truncated", () => {
    const result = service.search({ projectId: h.projectId, query: "ma", limit: 1 });
    expect(result.entries).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it("an empty query matches nothing rather than everything", () => {
    expect(service.search({ projectId: h.projectId, query: "   " }).entries).toEqual([]);
  });
});

describe("fs.watch", () => {
  it("batches changes into one debounced fs.changed event", async () => {
    // A fake watcher: chokidar's own behaviour is its business, the debouncing
    // and the batch shape are capygen's.
    const listeners = new Map<string, (p: string) => void>();
    let closed = false;
    const withFake = new FsService({
      store: h.store,
      broadcast: h.broadcast,
      log: h.log,
      createWatcher: () => ({
        on: (event, handler) => listeners.set(event, handler),
        close: () => {
          closed = true;
        },
      }),
    });
    await withFake.watch({ projectId: h.projectId });

    listeners.get("add")?.(path.join(h.root, "a.txt"));
    listeners.get("add")?.(path.join(h.root, "a.txt")); // deduped
    listeners.get("change")?.(path.join(h.root, "b", "c.txt"));
    expect(h.eventsOn("fs.changed")).toHaveLength(0);

    await sleep(WATCH_DEBOUNCE_MS + 60);
    const [batch] = h.eventsOn("fs.changed") as { projectId: string; changes: unknown[] }[];
    expect(batch?.projectId).toBe(h.projectId);
    expect(batch?.changes).toEqual([
      { path: "a.txt", kind: "add" },
      { path: "b/c.txt", kind: "change" },
    ]);

    await withFake.unwatch({ projectId: h.projectId });
    expect(closed).toBe(true);
    // Idempotent both ways.
    expect(await withFake.unwatch({ projectId: h.projectId })).toEqual({ ok: true });
  });

  /**
   * Two Files panes can want the same project watched at once — two sessions
   * on one directory, or the tray's "New Window" (R2). The second `watch` is
   * a no-op on the same chokidar instance, so without a subscriber count the
   * *first* pane to unmount closed the watcher and the other pane silently
   * stopped receiving `fs.changed` for the rest of the app's life.
   */
  it("is reference-counted: one unwatch of two does not close the shared watcher", async () => {
    const listeners = new Map<string, (p: string) => void>();
    let closed = false;
    let watchersCreated = 0;
    const withFake = new FsService({
      store: h.store,
      broadcast: h.broadcast,
      log: h.log,
      createWatcher: () => {
        watchersCreated += 1;
        return {
          on: (event, handler) => listeners.set(event, handler),
          close: () => {
            closed = true;
          },
        };
      },
    });

    await withFake.watch({ projectId: h.projectId });
    await withFake.watch({ projectId: h.projectId });
    expect(watchersCreated).toBe(1);

    // Pane A goes away…
    await withFake.unwatch({ projectId: h.projectId });
    expect(closed).toBe(false);

    // …and pane B still gets its events.
    listeners.get("change")?.(path.join(h.root, "still-watched.txt"));
    await sleep(WATCH_DEBOUNCE_MS + 60);
    expect(
      (h.eventsOn("fs.changed") as { changes: { path: string }[] }[]).some((e) =>
        e.changes.some((c) => c.path === "still-watched.txt"),
      ),
    ).toBe(true);

    // The last one out closes it.
    await withFake.unwatch({ projectId: h.projectId });
    expect(closed).toBe(true);
  });

  it("a real chokidar watcher reports a real write", async () => {
    await service.watch({ projectId: h.projectId });
    // Chokidar needs a moment to finish its initial scan before it emits.
    await sleep(300);
    fs.writeFileSync(path.join(h.root, "watched.txt"), "hello");
    const saw = await waitFor(() =>
      (h.eventsOn("fs.changed") as { changes: { path: string }[] }[]).some((e) =>
        e.changes.some((c) => c.path === "watched.txt"),
      ),
    );
    expect(saw).toBe(true);
  });
});

describe("helpers", () => {
  it("isIgnoredPath matches an ignored segment at any depth", () => {
    expect(isIgnoredPath("node_modules/x/y.js")).toBe(true);
    expect(isIgnoredPath("packages\\db\\dist\\index.js")).toBe(true);
    expect(isIgnoredPath("src/distance.ts")).toBe(false);
    expect(isIgnoredPath("")).toBe(false);
  });

  it("looksBinary is the NUL sniff, not a guess at the extension", () => {
    expect(looksBinary(Buffer.from("plain text"))).toBe(false);
    expect(looksBinary(Buffer.from([0x61, 0x00, 0x62]))).toBe(true);
  });
});
