/**
 * Terminal pane (SPEC R16): `@xterm/xterm` 6 + addon-fit + addon-web-links +
 * addon-webgl (falling back to the default canvas renderer when WebGL is
 * unavailable), themed from capygen's own tokens (`xtermTheme.ts`).
 *
 * One `terminal.create` per tab, the session's project as `cwd` (SPEC R16 —
 * "the session's cwd"); data/exit events keep each tab's xterm instance in
 * sync; resizing re-fits and pushes `terminal.resize`; closing a tab kills
 * its pty. "Open claude / codex here" creates a dedicated raw CLI terminal
 * in the project through terminal.attach (SPEC P19). It does not write into
 * whatever process is currently running in another tab.
 *
 * [C] Mounting **adopts before it creates**. A pty outlives this component:
 * closing the Terminal tab, toggling the toolbar button, or closing the whole
 * workspace unmounts the pane, and `TerminalService` keeps the shell (and
 * whatever it started — a `pnpm dev`, a watcher) running deliberately. So the
 * mount effect asks `terminal.list` for this project's live terminals first
 * and re-attaches to them; only a project with none spawns one. The naive
 * version created unconditionally, which meant every open/close cycle left
 * one more unreachable pwsh.exe alive for the life of the app and presented
 * the user with an empty "Terminal 2" instead of the shell they were using.
 *
 * The auto-create also waits for the panel to be **visible**: `WorkspaceHost`
 * mounts every pane with `defaultRenderer="always"`, so a restored layout
 * with the Terminal sitting behind another tab would otherwise spawn a shell
 * nobody asked for and nobody can see (the Browser pane already gates on
 * `api.isVisible` for the same reason).
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { PlusIcon, SquareTerminalIcon, XIcon } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { ipc } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { registerPane } from "@/workspace/registry";
import type { WorkspacePaneProps } from "@/workspace/types";
import { readXtermFontFamily, readXtermTheme } from "./xtermTheme";

interface TerminalTab {
  id: string;
  title: string;
  exitCode: number | null | undefined; // undefined = still running
}

let tabCounter = 0;

export function TerminalPane({ params, api }: WorkspacePaneProps) {
  const { projectId, sessionId } = params;
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const creatingRef = useRef(false);
  /** Dockview keeps a hidden tab mounted and reports visibility instead of
   *  unmounting — see the module comment on why the first shell waits. */
  const [visible, setVisible] = useState(api.isVisible);
  useEffect(() => {
    setVisible(api.isVisible);
    const disposable = api.onDidVisibilityChange((event) => setVisible(event.isVisible));
    return () => disposable.dispose();
  }, [api]);

  const openTerminal = useCallback(async () => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    try {
      const info = await ipc().invoke("terminal.create", {
        projectId,
        sessionId,
        cols: 80,
        rows: 24,
      });
      tabCounter += 1;
      setTabs((prev) => [...prev, { id: info.id, title: `Terminal ${tabCounter}`, exitCode: undefined }]);
      setActiveId(info.id);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      creatingRef.current = false;
    }
  }, [projectId, sessionId]);

  /**
   * Adopt this project's already-running terminals, and answer whether any
   * were found. The ids are the ones `TerminalService` still holds, so the
   * `terminal.data`/`terminal.exit` subscriptions in `TerminalInstance` pick
   * up exactly where the previous mount left off.
   *
   * Scrollback from before this mount is genuinely gone (xterm's buffer lived
   * in the destroyed component, and `TerminalInfo` carries no history), but
   * the *shell* — and the process it is running — is the same one.
   */
  const adoptExisting = useCallback(async (): Promise<boolean> => {
    try {
      const existing = await ipc().invoke("terminal.list", { projectId });
      if (existing.length === 0) return false;
      setTabs(
        existing.map((info, index) => {
          tabCounter = Math.max(tabCounter, index + 1);
          return { id: info.id, title: info.title.endsWith(" CLI") ? info.title : `Terminal ${index + 1}`, exitCode: undefined };
        }),
      );
      setActiveId(existing[0]!.id);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }, [projectId]);

  // One terminal once this pane is actually on screen, matching every other
  // pane's "ready to use" default — but adopting before creating.
  useEffect(() => {
    if (!visible || tabs.length > 0 || creatingRef.current) return;
    let cancelled = false;
    void adoptExisting().then((adopted) => {
      if (cancelled || adopted) return;
      void openTerminal();
    });
    return () => {
      cancelled = true;
    };
    // `tabs.length` is read, not depended on: re-running on every tab change
    // would race a create in flight. `creatingRef` covers the same window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, adoptExisting, openTerminal]);

  function closeTab(id: string): void {
    void ipc().invoke("terminal.kill", { id }).catch(() => undefined);
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (activeId === id) setActiveId(next[next.length - 1]?.id ?? null);
      return next;
    });
  }

  function markExited(id: string, exitCode: number | null): void {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, exitCode } : t)));
  }

  async function quickOpen(backend: "claude" | "codex"): Promise<void> {
    if (creatingRef.current) return;
    creatingRef.current = true;
    try {
      const info = await ipc().invoke("terminal.attach", { projectId, sessionId, backend, cols: 80, rows: 24 });
      setTabs(prev => [...prev, { id: info.id, title: info.title, exitCode: undefined }]);
      setActiveId(info.id);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { creatingRef.current = false; }
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col" data-testid="terminal-pane">
      <div className="flex shrink-0 items-center gap-1 border-b border-border-weak bg-card px-1.5 py-1">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" data-testid="terminal-tabs">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              data-testid="terminal-tab"
              data-active={tab.id === activeId || undefined}
              aria-current={tab.id === activeId}
              onClick={() => setActiveId(tab.id)}
              className={cn(
                "group flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs",
                tab.id === activeId
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              )}
            >
              <SquareTerminalIcon className="size-3.5 shrink-0" />
              <span className="max-w-24 truncate">{tab.title}</span>
              {tab.exitCode !== undefined ? (
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {tab.exitCode === null ? "killed" : `exit ${tab.exitCode}`}
                </span>
              ) : null}
              <span
                role="button"
                tabIndex={0}
                aria-label={`Close ${tab.title}`}
                data-testid="terminal-tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    e.stopPropagation();
                    closeTab(tab.id);
                  }
                }}
                className="shrink-0 rounded p-0.5 opacity-0 hover:bg-accent/50 group-hover:opacity-100 focus-visible:opacity-100"
              >
                <XIcon className="size-3" />
              </span>
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => void openTerminal()}
          aria-label="New terminal"
          title="New terminal"
          data-testid="terminal-new"
          className="flex size-6 shrink-0 items-center justify-center rounded text-foreground hover:bg-muted"
        >
          <PlusIcon className="size-4" />
        </button>
        <div className="mx-1 h-4 w-px shrink-0 bg-border-weak" aria-hidden="true" />
        <button
          type="button"
          onClick={() => void quickOpen("claude")}
          data-testid="terminal-open-claude"
          className="shrink-0 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          claude here
        </button>
        <button
          type="button"
          onClick={() => void quickOpen("codex")}
          data-testid="terminal-open-codex"
          className="shrink-0 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          codex here
        </button>
      </div>

      {error ? (
        <p role="alert" data-testid="terminal-error" className="shrink-0 px-2 py-1 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <div className="relative min-h-0 min-w-0 flex-1 bg-code-bg">
        {tabs.length === 0 ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
            No terminal yet.
          </div>
        ) : (
          tabs.map((tab) => (
            <TerminalInstance
              key={tab.id}
              id={tab.id}
              active={tab.id === activeId}
              onExit={(code) => markExited(tab.id, code)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function TerminalInstance({
  id,
  active,
  onExit,
}: {
  id: string;
  active: boolean;
  onExit: (exitCode: number | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const frameRef = useRef(0);
  const domId = useId();

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: readXtermFontFamily(),
      fontSize: 13,
      theme: readXtermTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    // GPU-accelerated renderer where available; the default (canvas) renderer
    // is a perfectly fine fallback, so a WebGL failure is silent, not fatal.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // No WebGL context (headless/software rendering, or the addon threw) —
      // keep the default renderer.
    }

    term.open(el);
    // [C] The only way to read what a terminal is showing from the outside.
    // Under the WebGL (or canvas) renderer xterm draws to a canvas and puts
    // *nothing* in the DOM, and it offers no DOM-element → instance lookup,
    // so `tests/e2e/workspace.spec.ts` would have no way to assert on the
    // buffer at all. Attaching the instance to its own container is a
    // renderer-local back-pointer: it crosses no bridge, is not on `window`,
    // and dies with the element.
    (el as HTMLElement & { __xterm?: Terminal }).__xterm = term;
    fit.fit();
    void ipc()
      .invoke("terminal.resize", { id, cols: term.cols, rows: term.rows })
      .catch(() => undefined);

    const offData = ipc().on("terminal.data", (evt) => {
      if (evt.id === id) term.write(evt.data);
    });
    const offExit = ipc().on("terminal.exit", (evt) => {
      if (evt.id !== id) return;
      onExit(evt.exitCode);
      term.write(
        `\r\n\x1b[2m[process exited${evt.exitCode === null ? "" : ` with code ${evt.exitCode}`}]\x1b[0m\r\n`,
      );
    });

    const dataDisposable = term.onData((data) => {
      void ipc().invoke("terminal.write", { id, data }).catch(() => undefined);
    });

    // Ctrl+Shift+C copies the selection; Ctrl+Shift+V pastes the clipboard —
    // xterm's own defaults are plain Ctrl+C/V, which the shell needs for
    // SIGINT/paste-as-Vim-block, so this pane uses the Windows-terminal
    // convention instead.
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown" || !event.ctrlKey || !event.shiftKey) return true;
      if (event.key === "C" || event.key === "c") {
        const selection = term.getSelection();
        if (selection) void navigator.clipboard?.writeText(selection).catch(() => undefined);
        return false;
      }
      if (event.key === "V" || event.key === "v") {
        void navigator.clipboard
          ?.readText()
          .then((text) => {
            if (text) void ipc().invoke("terminal.write", { id, data: text }).catch(() => undefined);
          })
          .catch(() => undefined);
        return false;
      }
      return true;
    });

    const scheduleFit = () => {
      if (frameRef.current) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = 0;
        fit.fit();
        void ipc()
          .invoke("terminal.resize", { id, cols: term.cols, rows: term.rows })
          .catch(() => undefined);
      });
    };
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleFit);
    ro?.observe(el);
    window.addEventListener("resize", scheduleFit);

    termRef.current = term;
    fitRef.current = fit;

    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", scheduleFit);
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      dataDisposable.dispose();
      offData();
      offExit();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // One instance for this tab's whole lifetime — `id` never changes for a
    // mounted `TerminalInstance` (the parent keys the tab list on it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Re-fit (and re-push cols/rows) whenever this tab becomes the visible one
  // — a background tab's container may have been resized while hidden.
  useEffect(() => {
    if (!active) return;
    const fit = fitRef.current;
    const term = termRef.current;
    if (!fit || !term) return;
    fit.fit();
    void ipc()
      .invoke("terminal.resize", { id, cols: term.cols, rows: term.rows })
      .catch(() => undefined);
    // [C] Without this the pane opens with a terminal nobody can type into
    // until they think to click the black rectangle: xterm only takes
    // keystrokes through its own hidden textarea, and nothing had focused
    // it. Focusing the *active* tab is also what makes switching tabs put
    // the caret where the user is looking.
    term.focus();
  }, [active, id]);

  return (
    <div
      ref={containerRef}
      data-testid="terminal-instance"
      data-terminal-id={domId}
      className={cn("absolute inset-0 p-1", !active && "invisible")}
    />
  );
}

registerPane({
  kind: "terminal",
  title: "Terminal",
  icon: SquareTerminalIcon,
  component: TerminalPane,
});
