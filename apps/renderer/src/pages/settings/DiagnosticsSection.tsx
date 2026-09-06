/**
 * Settings ▸ Diagnostics (Task B2 item 2): `diagnostics.get` rendered as
 * label/value tables (versions, paths, per-backend availability, DB size,
 * log dir) plus a Copy button (`diagnostics.copy` — the main process owns
 * the clipboard write, same pattern as `secrets.*`: this page never touches
 * `navigator.clipboard` itself).
 */
import { useEffect, useState } from "react";
import { CheckCircle2Icon, CircleAlertIcon, ClipboardIcon } from "lucide-react";
import type { DiagnosticsInfo } from "@capygen/shared";
import { Button } from "@/components/ui/button";
import { SectionError, SectionIntro, SectionLoading } from "@/components/settings/primitives";
import { ipc } from "@/lib/ipc";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export function DiagnosticsSection() {
  const [info, setInfo] = useState<DiagnosticsInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void ipc()
      .invoke("diagnostics.get", {})
      .then((result) => {
        if (!cancelled) setInfo(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function copy(): Promise<void> {
    await ipc().invoke("diagnostics.copy", {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (error) return <SectionError message={error} />;
  if (!info) return <SectionLoading />;

  return (
    <div data-testid="settings-diagnostics">
      <div className="mb-6 flex items-start justify-between gap-3">
        <SectionIntro title="Diagnostics" description="Versions, paths and backend availability, for a bug report." />
        <Button size="sm" variant="outline" data-testid="diagnostics-copy" onClick={() => void copy()}>
          <ClipboardIcon className="size-3.5" />
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>

      <DiagnosticsTable title="Versions" entries={info.versions} testId="diagnostics-versions" />
      <DiagnosticsTable title="Paths" entries={info.paths} testId="diagnostics-paths" />

      <div className="mb-5">
        <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Backend availability
        </p>
        <div className="flex flex-col" data-testid="diagnostics-harnesses">
          {info.harnessAvailability.map((h) => (
            <div key={h.backend} className="flex items-center justify-between border-b border-border-weak py-1.5 text-sm last:border-b-0">
              <span className="text-foreground">{h.backend}</span>
              <span className={`flex items-center gap-1 text-xs ${h.available ? "text-success" : "text-warning"}`}>
                {h.available ? <CheckCircle2Icon className="size-3.5" /> : <CircleAlertIcon className="size-3.5" />}
                {h.available ? "available" : (h.reason ?? "unavailable")}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex justify-between text-sm text-muted-foreground">
        <span data-testid="diagnostics-db-size">Database: {formatBytes(info.dbSizeBytes)}</span>
        <span data-testid="diagnostics-log-dir">Logs: {info.logDir}</span>
      </div>
    </div>
  );
}

function DiagnosticsTable({ title, entries, testId }: { title: string; entries: Record<string, string>; testId: string }) {
  return (
    <div className="mb-5">
      <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
      <div className="flex flex-col" data-testid={testId}>
        {Object.entries(entries).map(([key, value]) => (
          <div key={key} className="flex items-center justify-between gap-3 border-b border-border-weak py-1.5 text-sm last:border-b-0">
            <span className="text-foreground">{key}</span>
            <span className="truncate font-mono text-xs text-muted-foreground">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
