/**
 * Servers pane (SPEC R18): `servers.detect` on open (plus a Refresh), one row
 * per dev server with a source badge, status dot, Start/Stop, a log-tail
 * drawer (`servers.log` ring, `servers.logs` for the initial tail — visual
 * language matches `reference/omnigent/web/src/shell/ExecutionLogsPanel.tsx`:
 * a collapsible line list, expand-to-pretty on click is not needed here since
 * log lines are already plain text), "Open in Browser pane" once a URL is
 * known, and an add-custom-server form (command/args/cwd/port).
 *
 * Port-conflict handling (SPEC Edge Cases: "show the owning PID and offer to
 * open the existing URL instead") is best-effort: `servers.start` has no
 * structured conflict shape in the contract (`DevServerRunSchema` carries no
 * error field), so the row shows the backend's raw error text and, when the
 * server already has a known `url` (a previous successful start, or one
 * typed into the add form), an "Open existing URL" button next to it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ExternalLinkIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  ScrollTextIcon,
  ServerIcon,
  SquareIcon,
  Trash2Icon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import type { DevServerDraft, DevServerRunStatus, DevServerWithRun } from "@capygen/shared";
import { Badge } from "@/components/ui/badge";
import { ipc } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { openUrlInBrowserPane } from "@/workspace/openInBrowser";
import { registerPane } from "@/workspace/registry";
import type { WorkspacePaneProps } from "@/workspace/types";

const STATUS_DOT: Record<DevServerRunStatus, string> = {
  starting: "bg-info animate-pulse",
  running: "bg-success",
  stopped: "bg-muted-foreground/50",
  failed: "bg-destructive",
};

const LOG_TAIL = 200;
const LOG_CAP = 500;

export function ServersPane({ params, containerApi }: WorkspacePaneProps) {
  const { projectId } = params;
  const [rows, setRows] = useState<DevServerWithRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openLogsId, setOpenLogsId] = useState<string | null>(null);
  const [logsById, setLogsById] = useState<Record<string, string[]>>({});
  /** [C] Which servers have had their ring-buffer tail fetched, tracked apart
   *  from "has any lines". The live `servers.log` subscription creates a
   *  `logsById` key the moment one line streams, so keying the backlog fetch
   *  off that map meant a server already running when this pane mounted (an
   *  adopted run after a relaunch, a start from another window) showed only
   *  the lines since mount and never the earlier ones — including the
   *  `Local: http://localhost:...` line G6 is about. */
  const backlogFetched = useRef<Set<string>>(new Set());
  /** The open log drawer's scroll box, so new lines are actually seen. */
  const logBoxRef = useRef<HTMLDivElement | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  /** [C] Servers whose Start *this pane* asked for and that have not yet
   *  produced a URL. Only these auto-open the Browser pane (SPEC G6): a
   *  `servers.status` for a server somebody else started — another window,
   *  a restored run — must not hijack the user's Browser tab. */
  const awaitingOpen = useRef<Set<string>>(new Set());

  /** Open a dev-server URL in the Browser pane, creating that panel when it
   *  is closed (the default layout's state). `browserBus` alone only
   *  reaches an already-mounted pane — see `workspace/openInBrowser.ts`. */
  const openInBrowser = useCallback(
    (url: string) => openUrlInBrowserPane(containerApi, params, url),
    [containerApi, params],
  );

  // Pin the drawer to its newest line, the way the reference log panel does
  // (`ExecutionLogsPanel.tsx`: `el.scrollTop = el.scrollHeight` per event).
  // The box is nine lines tall; a real Vite/Next startup prints more than
  // that before it prints its URL.
  useEffect(() => {
    const el = logBoxRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [openLogsId, logsById]);

  async function detect(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      setRows(await ipc().invoke("servers.detect", { projectId }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void detect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    const offStatus = ipc().on("servers.status", ({ run }) => {
      setRows((prev) => prev.map((row) => (row.server.id === run.serverId ? { ...row, run } : row)));
      // SPEC G6/R18: "starting streams logs and opens the URL in the Browser
      // pane once the port answers". The URL is only known once discovery
      // has finished, which is this event, not `servers.start`'s return.
      if (run.status === "running" && run.url && awaitingOpen.current.delete(run.serverId)) {
        openInBrowser(run.url);
      }
      if (run.status === "stopped" || run.status === "failed") {
        awaitingOpen.current.delete(run.serverId);
      }
    });
    const offLog = ipc().on("servers.log", ({ serverId, line }) => {
      setLogsById((prev) => {
        const existing = prev[serverId] ?? [];
        return { ...prev, [serverId]: [...existing, line].slice(-LOG_CAP) };
      });
    });
    return () => {
      offStatus();
      offLog();
    };
  }, [openInBrowser]);

  async function start(row: DevServerWithRun): Promise<void> {
    setBusyId(row.server.id);
    setRowErrors((prev) => ({ ...prev, [row.server.id]: "" }));
    // A new run gets a new ring buffer; the previous run's lines are history
    // this pane no longer has a way to fetch, so they go rather than sit
    // above the new ones pretending to belong to them.
    setLogsById((prev) => ({ ...prev, [row.server.id]: [] }));
    backlogFetched.current.add(row.server.id);
    awaitingOpen.current.add(row.server.id);
    try {
      const run = await ipc().invoke("servers.start", { serverId: row.server.id });
      setRows((prev) => prev.map((r) => (r.server.id === row.server.id ? { ...r, run } : r)));
      // A server that was already answering is adopted synchronously — its
      // `running` status may have been broadcast before this promise
      // resolved, so the event above had nothing to open yet.
      if (run.status === "running" && run.url && awaitingOpen.current.delete(row.server.id)) {
        openInBrowser(run.url);
      }
    } catch (err) {
      awaitingOpen.current.delete(row.server.id);
      setRowErrors((prev) => ({
        ...prev,
        [row.server.id]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setBusyId(null);
    }
  }

  async function stop(row: DevServerWithRun): Promise<void> {
    setBusyId(row.server.id);
    try {
      const run = await ipc().invoke("servers.stop", { serverId: row.server.id });
      setRows((prev) => prev.map((r) => (r.server.id === row.server.id ? { ...r, run } : r)));
    } catch (err) {
      setRowErrors((prev) => ({
        ...prev,
        [row.server.id]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(row: DevServerWithRun): Promise<void> {
    setBusyId(row.server.id);
    try {
      const { ok } = await ipc().invoke("servers.remove", { serverId: row.server.id });
      if (ok) setRows((prev) => prev.filter((r) => r.server.id !== row.server.id));
    } catch (err) {
      setRowErrors((prev) => ({
        ...prev,
        [row.server.id]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setBusyId(null);
    }
  }

  async function toggleLogs(row: DevServerWithRun): Promise<void> {
    const id = row.server.id;
    if (openLogsId === id) {
      setOpenLogsId(null);
      return;
    }
    setOpenLogsId(id);
    if (!backlogFetched.current.has(id)) {
      backlogFetched.current.add(id);
      try {
        const { lines } = await ipc().invoke("servers.logs", { serverId: id, tail: LOG_TAIL });
        // The tail is the authoritative history; anything the live
        // subscription added since mount is already in it (same ring buffer),
        // so it replaces rather than appends.
        setLogsById((prev) => ({ ...prev, [id]: lines.slice(-LOG_CAP) }));
      } catch (err) {
        backlogFetched.current.delete(id);
        setRowErrors((prev) => ({ ...prev, [id]: err instanceof Error ? err.message : String(err) }));
      }
    }
  }

  async function addCustom(draft: DevServerDraft): Promise<void> {
    const server = await ipc().invoke("servers.saveCustom", { projectId, server: draft });
    setRows((prev) => [...prev, { server, run: null }]);
    setAddOpen(false);
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col" data-testid="servers-pane">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border-weak px-3">
        <ServerIcon className="size-3.5 text-muted-foreground" />
        <span className="flex-1 text-sm font-medium text-foreground">Servers</span>
        <button
          type="button"
          onClick={() => setAddOpen((v) => !v)}
          aria-label="Add a custom server"
          aria-pressed={addOpen}
          title="Add a custom server"
          data-testid="servers-add-toggle"
          className={cn(
            "flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground",
            addOpen && "bg-muted text-foreground",
          )}
        >
          <PlusIcon className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={() => void detect()}
          aria-label="Refresh servers"
          title="Refresh"
          data-testid="servers-refresh"
          className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
        </button>
      </div>

      {error ? (
        <p role="alert" data-testid="servers-error" className="shrink-0 px-3 py-1.5 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      {addOpen ? (
        <AddServerForm onCancel={() => setAddOpen(false)} onSubmit={(draft) => void addCustom(draft)} />
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {!loading && rows.length === 0 ? (
          <p data-testid="servers-empty" className="px-2 py-3 text-sm text-muted-foreground">
            No dev servers detected. Add `.claude/launch.json`, a `dev`/`start`/`serve` script in
            `package.json`, a `pyproject.toml`/`manage.py`, or a `docker-compose.yml`.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map((row) => {
              const status = row.run?.status ?? "stopped";
              const running = status === "running" || status === "starting";
              const rowError = rowErrors[row.server.id];
              // The live run's URL is known the instant a start succeeds —
              // before any detector persists it back onto the `DevServer`
              // row (`DevServerSchema`'s own doc comment) — so prefer it.
              const knownUrl = row.run?.url ?? row.server.url;
              return (
                <li
                  key={row.server.id}
                  data-testid="server-row"
                  data-server-id={row.server.id}
                  className="rounded-lg border border-border-weak bg-card p-2"
                >
                  <div className="flex items-center gap-2">
                    <span
                      data-testid="server-status-dot"
                      // [C] The status is otherwise only a colour class, and
                      // an e2e cannot assert on `bg-success` without pinning
                      // the palette; `aria-label` alone is read by the screen
                      // reader but is not a stable machine-readable state.
                      data-status={status}
                      aria-label={status}
                      className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[status])}
                    />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground" title={row.server.name}>
                      {row.server.name}
                    </span>
                    <Badge variant="outline">{row.server.source}</Badge>
                    {knownUrl ? (
                      <button
                        type="button"
                        onClick={() => openInBrowser(knownUrl)}
                        aria-label={`Open ${knownUrl} in the Browser pane`}
                        title="Open in Browser pane"
                        data-testid="server-open-browser"
                        className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        <ExternalLinkIcon className="size-3.5" />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => void toggleLogs(row)}
                      aria-label="Toggle logs"
                      aria-pressed={openLogsId === row.server.id}
                      title="Logs"
                      data-testid="server-logs-toggle"
                      className={cn(
                        "flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground",
                        openLogsId === row.server.id && "bg-muted text-foreground",
                      )}
                    >
                      <ScrollTextIcon className="size-3.5" />
                    </button>
                    {running ? (
                      <button
                        type="button"
                        onClick={() => void stop(row)}
                        disabled={busyId === row.server.id}
                        aria-label={`Stop ${row.server.name}`}
                        data-testid="server-stop"
                        className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-destructive disabled:opacity-50"
                      >
                        <SquareIcon className="size-3.5" />
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void start(row)}
                        disabled={busyId === row.server.id}
                        aria-label={`Start ${row.server.name}`}
                        data-testid="server-start"
                        className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-success disabled:opacity-50"
                      >
                        <PlayIcon className="size-3.5" />
                      </button>
                    )}
                    {row.server.source === "custom" ? (
                      <button
                        type="button"
                        onClick={() => void remove(row)}
                        disabled={busyId === row.server.id}
                        aria-label={`Remove ${row.server.name}`}
                        title="Remove"
                        data-testid="server-remove"
                        className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-destructive disabled:opacity-50"
                      >
                        <Trash2Icon className="size-3.5" />
                      </button>
                    ) : null}
                  </div>
                  <p className="mt-0.5 truncate pl-4 text-xs text-muted-foreground" title={row.server.command}>
                    {row.server.command} {row.server.args.join(" ")}
                    {row.server.port ? ` · port ${row.server.port}` : ""}
                  </p>
                  {rowError ? (
                    <div
                      role="alert"
                      data-testid="server-error"
                      className="mt-1.5 flex items-start gap-1.5 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1 text-xs text-destructive"
                    >
                      <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                      <span className="min-w-0 flex-1 break-words">{rowError}</span>
                      {knownUrl ? (
                        <button
                          type="button"
                          onClick={() => openInBrowser(knownUrl)}
                          data-testid="server-open-existing-url"
                          className="shrink-0 whitespace-nowrap underline"
                        >
                          Open existing URL
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                  {openLogsId === row.server.id ? (
                    <div
                      ref={logBoxRef}
                      data-testid="server-logs"
                      className="mt-1.5 max-h-40 overflow-y-auto rounded-md border border-border-weak bg-code-bg p-1.5 font-mono text-xs text-foreground"
                    >
                      {(logsById[row.server.id] ?? []).length === 0 ? (
                        <p className="text-muted-foreground">No logs yet.</p>
                      ) : (
                        (logsById[row.server.id] ?? []).map((line, i) => (
                          <div key={i} className="whitespace-pre-wrap break-words">
                            {line}
                          </div>
                        ))
                      )}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function AddServerForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (draft: DevServerDraft) => void;
}) {
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  // Left blank by default and sent as "." — the Build task's DevServerService
  // (apps/desktop/src/workspace/**) resolves a relative cwd against the
  // project's own path; a bare "." reads as "the project root" the same way
  // it would on a shell prompt already `cd`ed there.
  const [cwd, setCwd] = useState("");
  const [port, setPort] = useState("");

  function submit(): void {
    if (!command.trim()) return;
    onSubmit({
      name: name.trim() || command.trim(),
      source: "custom",
      command: command.trim(),
      args: args.trim().length > 0 ? args.trim().split(/\s+/) : [],
      cwd: cwd.trim() || ".",
      ...(port.trim() ? { port: Number(port.trim()) } : {}),
    });
  }

  return (
    <div data-testid="server-add-form" className="shrink-0 border-b border-border-weak bg-card p-2">
      <div className="grid grid-cols-2 gap-1.5">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name"
          data-testid="server-add-name"
          className="rounded-md border border-input bg-transparent px-2 py-1 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring"
        />
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="Command (e.g. npm)"
          data-testid="server-add-command"
          className="rounded-md border border-input bg-transparent px-2 py-1 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring"
        />
        <input
          value={args}
          onChange={(e) => setArgs(e.target.value)}
          placeholder="Args (space-separated)"
          data-testid="server-add-args"
          className="rounded-md border border-input bg-transparent px-2 py-1 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring"
        />
        <input
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          placeholder="Working directory (blank = project root)"
          data-testid="server-add-cwd"
          className="rounded-md border border-input bg-transparent px-2 py-1 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring"
        />
        <input
          value={port}
          onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ""))}
          placeholder="Port (optional)"
          inputMode="numeric"
          data-testid="server-add-port"
          className="rounded-md border border-input bg-transparent px-2 py-1 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring"
        />
      </div>
      <div className="mt-1.5 flex justify-end gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          data-testid="server-add-cancel"
          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
        >
          <XIcon className="size-3.5" />
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!command.trim()}
          data-testid="server-add-submit"
          className="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
        >
          Add server
        </button>
      </div>
    </div>
  );
}

registerPane({ kind: "servers", title: "Servers", icon: ServerIcon, component: ServersPane });
