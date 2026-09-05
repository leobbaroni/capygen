/**
 * Windows shell helpers. These are the ported pieces from the sibling project;
 * the tests pin the behaviour that made them worth porting.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, redact } from "../src/win/logger.js";
import { NESTED_SESSION_ENV, cliCommandString, cliEnv, spawnOptions } from "../src/win/env.js";
import {
  CAPTION_WIDTH_REM,
  cssColorToHex,
  overlayColors,
  symbolColorFor,
  windowOptions,
  APP_PAGE_CSS,
} from "../src/win/chrome.js";
import {
  captureWindowState,
  clampToDisplays,
  parseWindowState,
} from "../src/win/windowState.js";
import { createTrayIntegration } from "../src/win/tray.js";
import { createStubEngine } from "../src/engine/stub.js";
import { resolveInitialProjectDir } from "../src/win/projectArg.js";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-win-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("logger", () => {
  it("redacts secret-shaped values", () => {
    expect(redact("Authorization: Bearer abc.def-123")).toBe(
      "Authorization: Bearer [redacted]",
    );
    expect(redact("ANTHROPIC_API_KEY=sk-ant-0123456789abcdef")).toContain("[redacted]");
    expect(redact("api_key: hunter2")).toBe("api_key: [redacted]");
    expect(redact("nothing to hide here")).toBe("nothing to hide here");
  });

  it("writes timestamped, levelled lines to its file", () => {
    const dir = tempDir();
    const log = createLogger({ dir, fileName: "t.log" });
    log.info("hello", { a: 1 });
    log.error(new Error("boom"));
    const text = fs.readFileSync(path.join(dir, "t.log"), "utf8");
    expect(text).toMatch(/\[info\] hello \{"a":1\}/);
    expect(text).toMatch(/\[error\] Error: boom/);
  });

  it("rotates at the size limit and keeps the configured number of files", () => {
    const dir = tempDir();
    const log = createLogger({ dir, fileName: "t.log", maxBytes: 200, keep: 3 });
    for (let i = 0; i < 40; i += 1) log.info(`line ${i} ${"x".repeat(40)}`);
    const files = fs.readdirSync(dir).sort();
    expect(files).toContain("t.log");
    expect(files).toContain("t.log.1");
    expect(files.length).toBeLessThanOrEqual(3);
  });

  it("mirrors console into the file and restores it afterwards", () => {
    const dir = tempDir();
    const log = createLogger({ dir, fileName: "t.log" });
    const fake = { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const restore = log.captureConsole(fake as unknown as Console);
    fake.log("through the mirror");
    restore();
    expect(fs.readFileSync(path.join(dir, "t.log"), "utf8")).toContain("through the mirror");
  });
});

describe("cliEnv", () => {
  it("strips the nested-session markers a Claude Code terminal exports", () => {
    const env = cliEnv({
      PATH: "C:\\bin",
      CLAUDECODE: "1",
      CLAUDE_PID: "123",
      CLAUDE_EFFORT: "high",
      CLAUDE_CODE_SESSION_ID: "abc",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      KEEP_ME: "yes",
    });
    for (const key of NESTED_SESSION_ENV) expect(env[key]).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.KEEP_ME).toBe("yes");
    expect(env.PATH).toBe("C:\\bin");
  });

  it("forces UTF-8 for Python-based children", () => {
    const env = cliEnv({});
    expect(env.PYTHONUTF8).toBe("1");
    expect(env.PYTHONIOENCODING).toBe("utf-8");
  });

  it("always sets windowsHide and a cleaned env on spawns", () => {
    const opts = spawnOptions({ cwd: "C:\\proj", env: { CLAUDECODE: "1", A: "b" } });
    expect(opts.windowsHide).toBe(true);
    expect(opts.cwd).toBe("C:\\proj");
    expect(opts.env.CLAUDECODE).toBeUndefined();
    expect(opts.env.A).toBe("b");
  });

  it("quotes a command line for the visible console", () => {
    expect(cliCommandString("C:\\Program Files\\claude.exe", ["-p", "hi there"])).toBe(
      "& 'C:\\Program Files\\claude.exe' -p 'hi there'",
    );
  });
});

describe("seamless chrome", () => {
  it("hides the title bar and asks for a caption overlay", () => {
    const opts = windowOptions(false);
    expect(opts.titleBarStyle).toBe("hidden");
    expect(opts.titleBarOverlay.height).toBe(36);
    expect(opts.autoHideMenuBar).toBe(true);
    expect(overlayColors(true).color).toBe("#0e1013");
  });

  it("parses the colours a page reports, rejecting transparent ones", () => {
    expect(cssColorToHex("rgb(255, 255, 255)")).toBe("#ffffff");
    expect(cssColorToHex("rgba(14, 16, 19, 1)")).toBe("#0e1013");
    expect(cssColorToHex("#ABCDEF")).toBe("#abcdef");
    expect(cssColorToHex("rgba(0, 0, 0, 0)")).toBeNull();
    expect(cssColorToHex("transparent")).toBeNull();
    expect(cssColorToHex(null)).toBeNull();
  });

  it("picks a caption glyph colour with contrast against the sampled page", () => {
    expect(symbolColorFor("#ffffff")).toBe("#1b1b1f");
    expect(symbolColorFor("#0e1013")).toBe("#e6e6ea");
  });

  it("reserves the caption-button width in the injected stylesheet", () => {
    expect(APP_PAGE_CSS).toContain(`right: ${CAPTION_WIDTH_REM}rem`);
    expect(APP_PAGE_CSS).toContain("-webkit-app-region: drag");
    expect(APP_PAGE_CSS).toContain("-webkit-app-region: no-drag");
  });
});

describe("window state", () => {
  it("falls back to the default geometry for junk", () => {
    expect(parseWindowState(null)).toMatchObject({ width: 1280, height: 860 });
    expect(parseWindowState({ width: -5 })).toMatchObject({ width: 1280 });
  });

  it("keeps a position that lands on a display", () => {
    const state = parseWindowState({ x: 100, y: 100, width: 1000, height: 700 });
    const displays = [{ x: 0, y: 0, width: 1920, height: 1040 }];
    expect(clampToDisplays(state, displays)).toMatchObject({ x: 100, y: 100 });
  });

  it("drops a position on a monitor that is gone, so Electron re-centres", () => {
    const state = parseWindowState({ x: 3000, y: 2400, width: 1000, height: 700 });
    const clamped = clampToDisplays(state, [{ x: 0, y: 0, width: 1920, height: 1040 }]);
    expect(clamped.x).toBeUndefined();
    expect(clamped.y).toBeUndefined();
    expect(clamped.width).toBe(1000);
  });

  it("captures normal bounds plus the maximized flag", () => {
    const win = {
      isDestroyed: () => false,
      isMaximized: () => true,
      isMinimized: () => false,
      getNormalBounds: () => ({ x: 10.4, y: 20.6, width: 1200.2, height: 800.9 }),
    };
    expect(captureWindowState(win)).toEqual({
      x: 10,
      y: 21,
      width: 1200,
      height: 801,
      maximized: true,
    });
  });
});

describe("tray / close-to-tray", () => {
  function makeTray(closeToTray = true) {
    const calls = { reveal: 0, createWindow: 0, quit: 0 };
    const trayInstance = {
      setToolTip: vi.fn(),
      setContextMenu: vi.fn(),
      on: vi.fn(),
      displayBalloon: vi.fn(),
      destroy: vi.fn(),
    };
    const integration = createTrayIntegration({
      Tray: vi.fn(() => trayInstance) as never,
      Menu: { buildFromTemplate: vi.fn((t) => t) } as never,
      nativeImage: {
        createFromPath: () => ({ isEmpty: () => false, resize: () => "icon" }),
      } as never,
      shell: { openPath: vi.fn() } as never,
      iconPath: "icon.png",
      logDir: "logs",
      reveal: () => {
        calls.reveal += 1;
      },
      createWindow: () => {
        calls.createWindow += 1;
      },
      quit: () => {
        calls.quit += 1;
      },
      log: { info: vi.fn(), warn: vi.fn() },
      closeToTray: () => closeToTray,
    });
    return { integration, trayInstance, calls };
  }

  it("offers Open / New Window / Quit (R2)", () => {
    const { integration } = makeTray();
    const labels = integration
      .menuTemplate()
      .map((item) => item.label)
      .filter(Boolean);
    expect(labels).toEqual([
      "Open capygen",
      "New Window",
      "Open Log Folder",
      "Quit capygen",
    ]);
  });

  it("hides the window instead of closing it while the tray is up", () => {
    const { integration } = makeTray();
    integration.create();
    const handlers: Record<string, (e: { preventDefault: () => void }) => void> = {};
    const win = {
      on: (event: string, cb: (e: { preventDefault: () => void }) => void) => {
        handlers[event] = cb;
      },
      hide: vi.fn(),
    };
    integration.onWindowCreated(win as never);

    const prevented = vi.fn();
    handlers.close!({ preventDefault: prevented });
    expect(prevented).toHaveBeenCalled();
    expect(win.hide).toHaveBeenCalled();
    expect(integration.shouldQuitOnAllClosed()).toBe(false);
  });

  it("lets a real quit through", () => {
    const { integration } = makeTray();
    integration.create();
    integration.markQuitting();
    const handlers: Record<string, (e: { preventDefault: () => void }) => void> = {};
    const win = { on: (e: string, cb: never) => (handlers[e] = cb), hide: vi.fn() };
    integration.onWindowCreated(win as never);
    const prevented = vi.fn();
    handlers.close!({ preventDefault: prevented });
    expect(prevented).not.toHaveBeenCalled();
    expect(integration.shouldQuitOnAllClosed()).toBe(true);
  });

  it("quits on last window when the tray could not be created", () => {
    const { integration } = makeTray();
    // never calls create(): no tray
    expect(integration.hasTray).toBe(false);
    expect(integration.shouldQuitOnAllClosed()).toBe(true);
  });

  it("quits on last window when the user turned close-to-tray off", () => {
    const { integration } = makeTray(false);
    integration.create();
    expect(integration.shouldQuitOnAllClosed()).toBe(true);
  });
});

describe("stub engine", () => {
  it("echoes the prompt back after its delay", async () => {
    const seen: string[] = [];
    const done: string[] = [];
    const engine = createStubEngine(
      {
        onText: ({ text }) => seen.push(text),
        onDone: ({ turnId }) => done.push(turnId),
        onError: () => {},
      },
      1,
    );
    engine.send({ sessionId: "ses_1", turnId: "trn_1", text: "hello" });
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual(["echo: hello"]);
    expect(done).toEqual(["trn_1"]);
    engine.dispose();
  });

  it("interrupt cancels the pending reply", async () => {
    const seen: string[] = [];
    const engine = createStubEngine(
      { onText: ({ text }) => seen.push(text), onDone: () => {}, onError: () => {} },
      20,
    );
    engine.send({ sessionId: "ses_1", turnId: "trn_1", text: "hello" });
    expect(engine.interrupt("ses_1")).toBe(true);
    expect(engine.interrupt("ses_1")).toBe(false);
    await new Promise((r) => setTimeout(r, 40));
    expect(seen).toEqual([]);
    engine.dispose();
  });
});

describe("launch-time project folder", () => {
  // Forward slashes throughout: path.resolve normalises them on Windows, and
  // the parser must not care which separator the user typed.
  const isDirectory = (p: string) => p.replaceAll("\\", "/").endsWith("/real");
  const expected = path.resolve("C:/src/real");

  it("takes --project=<dir>", () => {
    expect(
      resolveInitialProjectDir({
        argv: ["electron.exe", "app", "--project=C:/src/real"],
        env: {},
        isDirectory,
      }),
    ).toBe(expected);
  });

  it("takes --project <dir> as two arguments, and strips quotes", () => {
    expect(
      resolveInitialProjectDir({
        argv: ["electron.exe", "--project", '"C:/src/real"'],
        env: {},
        isDirectory,
      }),
    ).toBe(expected);
  });

  it("falls back to CAPYGEN_PROJECT_DIR, with the flag winning", () => {
    expect(
      resolveInitialProjectDir({
        argv: [],
        env: { CAPYGEN_PROJECT_DIR: "C:/src/real" },
        isDirectory,
      }),
    ).toBe(expected);
    expect(
      resolveInitialProjectDir({
        argv: ["--project=C:/src/real"],
        env: { CAPYGEN_PROJECT_DIR: "C:/src/other" },
        isDirectory,
      }),
    ).toBe(expected);
  });

  it("opens nothing implicitly: a missing or non-directory path resolves to null", () => {
    expect(resolveInitialProjectDir({ argv: [], env: {}, isDirectory })).toBeNull();
    expect(
      resolveInitialProjectDir({
        argv: ["--project=C:/src/a-file.txt"],
        env: {},
        isDirectory,
      }),
    ).toBeNull();
    expect(
      resolveInitialProjectDir({ argv: ["--project="], env: {}, isDirectory }),
    ).toBeNull();
    expect(
      resolveInitialProjectDir({ argv: ["--project"], env: {}, isDirectory }),
    ).toBeNull();
  });
});
