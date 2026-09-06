/**
 * `BrowserViewService` (SPEC R16) against a fake `WebContentsView`.
 *
 * Electron itself is not under test here — the *rules* are: one view per
 * `viewId` in its own session partition, http(s) only, popups denied and sent
 * to the OS browser, and a detach that actually closes the web contents rather
 * than leaking a renderer process per pane the user ever opened.
 */
import type { BaseWindow, WebContentsView as WebContentsViewClass } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBrowserViewService,
  isWebUrl,
  normaliseUrl,
  type BrowserViewHandlers,
  type PartitionSessionLike,
} from "../src/workspace/BrowserViewService.js";
import { makeHarness, type Harness } from "./workspaceHarness.js";

type Listener = (...args: unknown[]) => void;

class FakeWebContents {
  url = "";
  title = "";
  loading = false;
  back = false;
  forward = false;
  destroyed = false;
  closed = false;
  devtoolsOpen = false;
  windowOpenHandler: ((details: { url: string }) => { action: string }) | null = null;
  readonly listeners = new Map<string, Listener[]>();

  readonly navigationHistory = {
    canGoBack: () => this.back,
    canGoForward: () => this.forward,
    goBack: () => void (this.url = "back()"),
    goForward: () => void (this.url = "forward()"),
  };

  on(event: string, handler: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), handler]);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.listeners.get(event) ?? []) handler(...args);
  }
  setWindowOpenHandler(handler: (details: { url: string }) => { action: string }): void {
    this.windowOpenHandler = handler;
  }
  loadURL(url: string): Promise<void> {
    this.url = url;
    return Promise.resolve();
  }
  reload(): void {
    this.url = `reload(${this.url})`;
  }
  getURL(): string {
    return this.url;
  }
  getTitle(): string {
    return this.title;
  }
  isLoading(): boolean {
    return this.loading;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  close(): void {
    this.closed = true;
    this.destroyed = true;
  }
  isDevToolsOpened(): boolean {
    return this.devtoolsOpen;
  }
  openDevTools(): void {
    this.devtoolsOpen = true;
  }
  closeDevTools(): void {
    this.devtoolsOpen = false;
  }
}

const created: { options: unknown; view: FakeView }[] = [];

class FakeView {
  readonly webContents = new FakeWebContents();
  bounds: { x: number; y: number; width: number; height: number } | null = null;
  constructor(options: unknown) {
    created.push({ options, view: this });
  }
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.bounds = bounds;
  }
}

/** One fake shell window; `id` is what scopes the service's view map, so the
 *  multi-window test below hands out two of these. */
function makeWindow(id: number, added: FakeView[], removed: FakeView[]): BaseWindow {
  return {
    id,
    isDestroyed: () => false,
    contentView: {
      addChildView: (view: FakeView) => void added.push(view),
      removeChildView: (view: FakeView) => void removed.push(view),
    },
  } as unknown as BaseWindow;
}

/** The permission handlers each partitioned session was given, by partition. */
interface FakeSession {
  partition: string;
  request: ((contents: unknown, permission: string, cb: (ok: boolean) => void) => void) | null;
  check: (() => boolean) | null;
}

let sessions: FakeSession[];

function fakeSessionFromPartition(partition: string): PartitionSessionLike {
  const entry: FakeSession = { partition, request: null, check: null };
  sessions.push(entry);
  return {
    setPermissionRequestHandler: (handler) => void (entry.request = handler),
    setPermissionCheckHandler: (handler) => void (entry.check = handler),
  };
}

let h: Harness;
let service: BrowserViewHandlers;
let added: FakeView[];
let removed: FakeView[];
let opened: string[];

beforeEach(() => {
  h = makeHarness({ prefix: "capygen-browser-" });
  created.length = 0;
  added = [];
  removed = [];
  opened = [];
  sessions = [];
  const window = makeWindow(1, added, removed);

  service = createBrowserViewService({
    window: () => window,
    WebContentsView: FakeView as unknown as typeof WebContentsViewClass,
    sessionFromPartition: fakeSessionFromPartition,
    openExternal: (url) => void opened.push(url),
    broadcast: h.broadcast,
    log: h.log,
  });
});

afterEach(() => {
  service.dispose();
  h.close();
});

function contentsOf(index = 0): FakeWebContents {
  return created[index]!.view.webContents;
}

describe("attach", () => {
  it("creates one view per viewId, in its own session partition", () => {
    service.attach({ viewId: "pane-1", bounds: { x: 1, y: 2, width: 300, height: 200 } });
    service.attach({ viewId: "pane-1", bounds: { x: 1, y: 2, width: 300, height: 200 } });
    service.attach({ viewId: "pane-2", bounds: { x: 0, y: 0, width: 10, height: 10 } });

    expect(created).toHaveLength(2);
    expect(added).toHaveLength(2);
    const options = created[0]!.options as { webPreferences: Record<string, unknown> };
    expect(options.webPreferences.partition).toBe("persist:capygen-browser-pane-1");
    expect(options.webPreferences.nodeIntegration).toBe(false);
    expect(options.webPreferences.sandbox).toBe(true);
    expect((created[1]!.options as typeof options).webPreferences.partition).toBe(
      "persist:capygen-browser-pane-2",
    );
  });

  it("rounds the renderer's fractional rect", () => {
    service.attach({ viewId: "p", bounds: { x: 10.4, y: 20.6, width: 300.2, height: 199.9 } });
    expect(created[0]!.view.bounds).toEqual({ x: 10, y: 21, width: 300, height: 200 });
  });

  it("loads an http url and refuses anything else", () => {
    service.attach({ viewId: "p", bounds: { x: 0, y: 0, width: 1, height: 1 }, url: "http://localhost:5173" });
    expect(contentsOf().url).toBe("http://localhost:5173");

    expect(() =>
      service.attach({
        viewId: "q",
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        url: "file:///C:/Windows/win.ini",
      }),
    ).toThrow(/refused/);
  });

  it("answers false when there is no window to attach to", () => {
    const orphan = createBrowserViewService({
      window: () => null,
      WebContentsView: FakeView as unknown as typeof WebContentsViewClass,
      sessionFromPartition: fakeSessionFromPartition,
      openExternal: vi.fn(),
      broadcast: h.broadcast,
      log: h.log,
    });
    expect(orphan.attach({ viewId: "p", bounds: { x: 0, y: 0, width: 1, height: 1 } })).toEqual({
      ok: false,
    });
  });

  /**
   * Electron approves *every* permission request on a session that has no
   * handler registered, so a page in this pane could have turned on the
   * camera with no dialog. Both handlers are installed before the view is
   * created — the assertion is that the callback is given `false`.
   */
  it("denies every permission on the view's own partition", () => {
    service.attach({ viewId: "p", bounds: { x: 0, y: 0, width: 1, height: 1 } });
    const entry = sessions.find((s) => s.partition === "persist:capygen-browser-p");
    expect(entry).toBeDefined();
    expect(entry!.request).toBeTypeOf("function");
    expect(entry!.check).toBeTypeOf("function");

    const granted: boolean[] = [];
    for (const permission of ["media", "geolocation", "notifications", "midi"]) {
      entry!.request!(null, permission, (ok) => granted.push(ok));
    }
    expect(granted).toEqual([false, false, false, false]);
    expect(entry!.check!()).toBe(false);
  });

  /**
   * Two shell windows (the tray's "New Window", R2) share one service, and
   * React's `useId` hands two identical component trees the same `viewId` —
   * so the key has to carry the window too, or window 2's pane drives window
   * 1's native view.
   */
  it("scopes views by window, so the same viewId in two windows is two views", () => {
    const addedB: FakeView[] = [];
    const removedB: FakeView[] = [];
    const windowA = makeWindow(1, added, removed);
    const windowB = makeWindow(2, addedB, removedB);
    let current: BaseWindow = windowA;
    const twoWindows = createBrowserViewService({
      window: () => current,
      WebContentsView: FakeView as unknown as typeof WebContentsViewClass,
      sessionFromPartition: fakeSessionFromPartition,
      openExternal: vi.fn(),
      broadcast: h.broadcast,
      log: h.log,
    });

    twoWindows.attach({ viewId: "same", bounds: { x: 0, y: 0, width: 10, height: 10 } });
    current = windowB;
    twoWindows.attach({ viewId: "same", bounds: { x: 5, y: 5, width: 20, height: 20 } });

    // One view *per window*, each added to its own window's content view.
    expect(added).toHaveLength(1);
    expect(addedB).toHaveLength(1);
    expect(added[0]).not.toBe(addedB[0]);

    // A setBounds from window B moves B's view and leaves A's alone.
    twoWindows.setBounds({ viewId: "same", bounds: { x: 7, y: 7, width: 30, height: 30 } });
    expect(addedB[0]!.bounds).toEqual({ x: 7, y: 7, width: 30, height: 30 });
    expect(added[0]!.bounds).toEqual({ x: 0, y: 0, width: 10, height: 10 });

    twoWindows.dispose();
  });
});

describe("navigate", () => {
  beforeEach(() => {
    service.attach({ viewId: "p", bounds: { x: 0, y: 0, width: 800, height: 600 } });
  });

  it("treats back/forward/reload as toolbar commands, not addresses", () => {
    const contents = contentsOf();
    contents.url = "http://example.com/";
    contents.back = true;

    service.navigate({ viewId: "p", url: "back" });
    expect(contents.url).toBe("back()");

    contents.url = "http://example.com/";
    service.navigate({ viewId: "p", url: "reload" });
    expect(contents.url).toBe("reload(http://example.com/)");
  });

  it("a back with no history is a no-op, not an error", () => {
    contentsOf().url = "http://example.com/";
    expect(service.navigate({ viewId: "p", url: "back" })).toEqual({ ok: true });
    expect(contentsOf().url).toBe("http://example.com/");
  });

  it("assumes http for a bare host typed in the URL bar", () => {
    service.navigate({ viewId: "p", url: "localhost:5173/app" });
    expect(contentsOf().url).toBe("http://localhost:5173/app");
  });

  it("refuses a non-web scheme outright", () => {
    expect(() => service.navigate({ viewId: "p", url: "file:///etc/passwd" })).toThrow(/refused/);
    expect(() => service.navigate({ viewId: "p", url: "javascript:alert(1)" })).toThrow(/refused/);
  });

  it("answers false for a viewId that was never attached", () => {
    expect(service.navigate({ viewId: "ghost", url: "http://x.test" })).toEqual({ ok: false });
  });
});

describe("guards", () => {
  beforeEach(() => {
    service.attach({ viewId: "p", bounds: { x: 0, y: 0, width: 800, height: 600 } });
  });

  it("denies every popup and hands a web one to the OS browser", () => {
    const handler = contentsOf().windowOpenHandler!;
    expect(handler({ url: "https://example.com/" })).toEqual({ action: "deny" });
    expect(opened).toEqual(["https://example.com/"]);

    expect(handler({ url: "steam://run/440" })).toEqual({ action: "deny" });
    // A non-web scheme is denied *and* not handed anywhere.
    expect(opened).toEqual(["https://example.com/"]);
  });

  it("blocks an in-view navigation to a non-web scheme", () => {
    const event = { preventDefault: vi.fn() };
    contentsOf().emit("will-navigate", event, "file:///C:/secret.txt");
    expect(event.preventDefault).toHaveBeenCalled();
    expect(opened).toEqual(["file:///C:/secret.txt"]);

    const allowed = { preventDefault: vi.fn() };
    contentsOf().emit("will-navigate", allowed, "https://example.com/next");
    expect(allowed.preventDefault).not.toHaveBeenCalled();
  });
});

describe("state events", () => {
  it("pushes the toolbar state after a navigation", () => {
    service.attach({ viewId: "p", bounds: { x: 0, y: 0, width: 1, height: 1 } });
    const contents = contentsOf();
    contents.url = "https://example.com/page";
    contents.title = "Example";
    contents.back = true;

    contents.emit("did-navigate");
    expect(h.eventsOn("browser.state").at(-1)).toEqual({
      viewId: "p",
      url: "https://example.com/page",
      title: "Example",
      canGoBack: true,
      canGoForward: false,
      loading: false,
    });
  });
});

describe("detach / devtools", () => {
  it("removes the view and closes its web contents", () => {
    service.attach({ viewId: "p", bounds: { x: 0, y: 0, width: 1, height: 1 } });
    expect(service.detach({ viewId: "p" })).toEqual({ ok: true });
    expect(removed).toHaveLength(1);
    expect(contentsOf().closed).toBe(true);
    // Idempotent: detaching twice is not an error.
    expect(service.detach({ viewId: "p" })).toEqual({ ok: true });
  });

  it("dispose detaches everything", () => {
    service.attach({ viewId: "a", bounds: { x: 0, y: 0, width: 1, height: 1 } });
    service.attach({ viewId: "b", bounds: { x: 0, y: 0, width: 1, height: 1 } });
    service.dispose();
    expect(removed).toHaveLength(2);
  });

  it("devtools toggles", () => {
    service.attach({ viewId: "p", bounds: { x: 0, y: 0, width: 1, height: 1 } });
    service.devtools({ viewId: "p" });
    expect(contentsOf().devtoolsOpen).toBe(true);
    service.devtools({ viewId: "p" });
    expect(contentsOf().devtoolsOpen).toBe(false);
  });
});

describe("url helpers", () => {
  it("isWebUrl is http/https only", () => {
    expect(isWebUrl("http://a.test")).toBe(true);
    expect(isWebUrl("HTTPS://a.test")).toBe(true);
    expect(isWebUrl("file:///c:/x")).toBe(false);
    expect(isWebUrl("capygen-widget://blk/index.html")).toBe(false);
  });

  it("normaliseUrl only fills in a missing scheme", () => {
    expect(normaliseUrl("example.com")).toBe("http://example.com");
    expect(normaliseUrl(" localhost:3000 ")).toBe("http://localhost:3000");
    expect(normaliseUrl("https://example.com")).toBe("https://example.com");
    expect(normaliseUrl("mailto:a@b.c")).toBe("mailto:a@b.c");
  });
});
