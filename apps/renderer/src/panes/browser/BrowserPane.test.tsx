import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DockviewApi, DockviewPanelApi } from "dockview-react";
import type { WorkspacePaneParams } from "@/workspace/types";
import { BrowserPane } from "./BrowserPane";
import { openInBrowserPane } from "../browserBus";

const ipcInvoke = vi.fn();
const listeners = new Map<string, Set<(payload: unknown) => void>>();
const ipcOn = vi.fn((event: string, listener: (payload: unknown) => void) => {
  const bucket = listeners.get(event) ?? new Set();
  bucket.add(listener);
  listeners.set(event, bucket);
  return () => bucket.delete(listener);
});

function emit(event: string, payload: unknown): void {
  for (const listener of listeners.get(event) ?? []) listener(payload);
}

vi.mock("@/lib/ipc", () => ({
  ipc: () => ({ invoke: ipcInvoke, on: ipcOn }),
  hasBridge: () => true,
}));

/** A minimal stand-in for the slice of `DockviewPanelApi` this pane reads —
 *  `isVisible` plus the event dockview fires when a stacked tab's own
 *  visibility flips (never unmounted, per that api's own doc comment), and
 *  `onDidDimensionsChange`, which the bounds tracker listens to so the
 *  native view follows a dock/drag/maximise that moved the box without
 *  resizing it. */
function fakeApi(initialVisible = true): DockviewPanelApi & { setVisible: (v: boolean) => void } {
  const handlers = new Set<(e: { isVisible: boolean }) => void>();
  let isVisible = initialVisible;
  return {
    get isVisible() {
      return isVisible;
    },
    onDidVisibilityChange: (listener: (e: { isVisible: boolean }) => void) => {
      handlers.add(listener);
      return { dispose: () => handlers.delete(listener) };
    },
    onDidDimensionsChange: () => ({ dispose: () => undefined }),
    setVisible(next: boolean) {
      isVisible = next;
      for (const h of handlers) h({ isVisible: next });
    },
  } as unknown as DockviewPanelApi & { setVisible: (v: boolean) => void };
}

let rectSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  ipcInvoke.mockReset();
  ipcOn.mockClear();
  listeners.clear();
  ipcInvoke.mockImplementation((channel: string) => {
    if (channel === "browser.attach") return Promise.resolve({ ok: true });
    if (channel === "browser.detach") return Promise.resolve({ ok: true });
    if (channel === "browser.navigate") return Promise.resolve({ ok: true });
    if (channel === "browser.setBounds") return Promise.resolve({ ok: true });
    if (channel === "browser.devtools") return Promise.resolve({ ok: true });
    return Promise.reject(new Error(`unexpected channel ${channel}`));
  });
  // jsdom's getBoundingClientRect is all-zero by default, which the pane
  // treats as "nothing to attach to yet".
  rectSpy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 40,
    width: 640,
    height: 480,
    top: 40,
    left: 0,
    right: 640,
    bottom: 520,
    toJSON: () => "",
  });
});

// Only this spy is restored — `vi.restoreAllMocks()` would also wipe the
// plain `vi.fn()`s above (`ipcInvoke`/`ipcOn`), and RTL's own `cleanup()`
// (registered globally, so it runs *after* this file's own afterEach) then
// unmounts the just-tested component, running its `browser.detach` effect
// cleanup against a mock with no implementation left.
afterEach(() => {
  rectSpy.mockRestore();
});

const params: WorkspacePaneParams = { projectId: "p1", sessionId: "s1" };
const containerApi = {
  onDidLayoutChange: () => ({ dispose: () => undefined }),
  // Maximising a group rearranges the grid's presentation without changing
  // the serialisable tree, so the bounds tracker subscribes to this
  // separately from `onDidLayoutChange`.
  onDidMaximizedGroupChange: () => ({ dispose: () => undefined }),
} as unknown as DockviewApi;

describe("BrowserPane (SPEC R16)", () => {
  it("attaches a native view with the placeholder's bounds once visible", async () => {
    render(<BrowserPane params={params} api={fakeApi()} containerApi={containerApi} />);

    await waitFor(() =>
      expect(ipcInvoke).toHaveBeenCalledWith(
        "browser.attach",
        expect.objectContaining({ bounds: expect.objectContaining({ width: 640, height: 480 }) }),
      ),
    );
    expect(await screen.findByTestId("browser-container")).toBeInTheDocument();
  });

  it("detaches when the tab is hidden", async () => {
    const api = fakeApi();
    render(<BrowserPane params={params} api={api} containerApi={containerApi} />);
    await waitFor(() => expect(ipcInvoke).toHaveBeenCalledWith("browser.attach", expect.anything()));

    act(() => api.setVisible(false));

    await waitFor(() => expect(ipcInvoke).toHaveBeenCalledWith("browser.detach", { viewId: expect.any(String) }));
  });

  it("re-attaches when the tab becomes visible again", async () => {
    const api = fakeApi();
    render(<BrowserPane params={params} api={api} containerApi={containerApi} />);
    await waitFor(() => expect(ipcInvoke).toHaveBeenCalledWith("browser.attach", expect.anything()));
    act(() => api.setVisible(false));
    await waitFor(() => expect(ipcInvoke).toHaveBeenCalledWith("browser.detach", expect.anything()));
    ipcInvoke.mockClear();

    act(() => api.setVisible(true));

    await waitFor(() => expect(ipcInvoke).toHaveBeenCalledWith("browser.attach", expect.anything()));
  });

  it("navigates on Enter in the address bar", async () => {
    const user = userEvent.setup();
    render(<BrowserPane params={params} api={fakeApi()} containerApi={containerApi} />);
    await waitFor(() => expect(ipcInvoke).toHaveBeenCalledWith("browser.attach", expect.anything()));
    ipcInvoke.mockClear();

    const input = screen.getByTestId("browser-url-input");
    await user.type(input, "example.com{Enter}");

    expect(ipcInvoke).toHaveBeenCalledWith("browser.navigate", {
      viewId: expect.any(String),
      url: "https://example.com",
    });
  });

  it("back/forward/reload send the control-word navigate calls", async () => {
    const user = userEvent.setup();
    render(<BrowserPane params={params} api={fakeApi()} containerApi={containerApi} />);
    await waitFor(() => expect(ipcInvoke).toHaveBeenCalledWith("browser.attach", expect.anything()));

    act(() => {
      emit("browser.state", {
        viewId: screen.getByTestId("browser-pane").dataset.viewId,
        url: "https://example.com",
        title: "Example",
        canGoBack: true,
        canGoForward: true,
        loading: false,
      });
    });

    expect(await screen.findByTestId("browser-title")).toHaveTextContent("Example");
    expect(screen.getByTestId("browser-back")).toBeEnabled();
    expect(screen.getByTestId("browser-forward")).toBeEnabled();

    ipcInvoke.mockClear();
    await user.click(screen.getByTestId("browser-back"));
    expect(ipcInvoke).toHaveBeenCalledWith("browser.navigate", { viewId: expect.any(String), url: "back" });

    await user.click(screen.getByTestId("browser-forward"));
    expect(ipcInvoke).toHaveBeenCalledWith("browser.navigate", { viewId: expect.any(String), url: "forward" });

    await user.click(screen.getByTestId("browser-reload"));
    expect(ipcInvoke).toHaveBeenCalledWith("browser.navigate", { viewId: expect.any(String), url: "reload" });
  });

  it("opens DevTools", async () => {
    const user = userEvent.setup();
    render(<BrowserPane params={params} api={fakeApi()} containerApi={containerApi} />);
    await waitFor(() => expect(ipcInvoke).toHaveBeenCalledWith("browser.attach", expect.anything()));
    ipcInvoke.mockClear();

    await user.click(screen.getByTestId("browser-devtools"));

    expect(ipcInvoke).toHaveBeenCalledWith("browser.devtools", { viewId: expect.any(String) });
  });

  it("re-syncs bounds on window resize", async () => {
    render(<BrowserPane params={params} api={fakeApi()} containerApi={containerApi} />);
    await waitFor(() => expect(ipcInvoke).toHaveBeenCalledWith("browser.attach", expect.anything()));
    ipcInvoke.mockClear();

    act(() => {
      window.dispatchEvent(new Event("resize"));
    });

    await waitFor(() => expect(ipcInvoke).toHaveBeenCalledWith("browser.setBounds", expect.anything()));
  });

  it("the Servers pane's browserBus opens a URL here", async () => {
    render(<BrowserPane params={params} api={fakeApi()} containerApi={containerApi} />);
    await waitFor(() => expect(ipcInvoke).toHaveBeenCalledWith("browser.attach", expect.anything()));
    ipcInvoke.mockClear();

    act(() => {
      openInBrowserPane("http://localhost:3000");
    });

    await waitFor(() =>
      expect(ipcInvoke).toHaveBeenCalledWith("browser.navigate", {
        viewId: expect.any(String),
        url: "http://localhost:3000",
      }),
    );
  });

  it("shows a placeholder hint before anything is attached", () => {
    ipcInvoke.mockImplementation(() => new Promise(() => {})); // never resolves
    render(<BrowserPane params={params} api={fakeApi()} containerApi={containerApi} />);
    expect(screen.getByText(/enter a url/i)).toBeInTheDocument();
  });

  it("never attaches while the tab starts out hidden", async () => {
    render(<BrowserPane params={params} api={fakeApi(false)} containerApi={containerApi} />);
    await Promise.resolve();
    expect(ipcInvoke).not.toHaveBeenCalledWith("browser.attach", expect.anything());
  });
});
