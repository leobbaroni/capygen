/**
 * `prereqs.status` / `prereqs.run` — the setup panel's IPC surface (SPEC R3).
 *
 * Detection (`../prereqs/detect.ts`) needs no Electron: it is real by default,
 * the same way `harness.list` is. The run gate's two Electron-shaped pieces —
 * the native confirm dialog and the visible console — are injected the same
 * way `browser`/`widgets` are in `handlers.ts` (Electron is type-only up
 * here), but default to a real implementation (`../prereqs/electronDefaults.ts`,
 * loaded with a runtime `import()`) so the app gets a working setup panel with
 * no extra wiring in `main.ts` — only a test overrides `confirm`/`openConsole`
 * with a fake.
 */
import { probeCodex, type CodexProbeResult } from "@capygen/engine";
import type { InvokeArgs, InvokeResult, PrereqStep } from "@capygen/shared";
import { CACHE_TTL_MS, type CliProbe } from "./harnessList.js";
import { defaultConfirm, defaultOpenConsole } from "../prereqs/electronDefaults.js";
import { detectPrereqSteps, recommendationFor } from "../prereqs/detect.js";
import { confirmOptionsFor, consoleArgv, firstUnmetDependency, type ConfirmOptions, type ConsoleArgv } from "../prereqs/runGate.js";

export interface PrereqsIpcDeps {
  probe?: CliProbe;
  probeCodexBackend?: () => Promise<CodexProbeResult>;
  env?: NodeJS.ProcessEnv;
  home?: string;
  exists?: (p: string) => boolean;
  /** Resolves `true` for Run, `false` for Cancel/close/Escape. Defaults to a
   *  real `dialog.showMessageBox` (see `electronDefaults.ts`). */
  confirm?: (options: ConfirmOptions) => Promise<boolean>;
  /** Launches the visible console. Defaults to a real detached PowerShell. */
  openConsole?: (argv: ConsoleArgv) => { pid?: number };
  log?: { info: (msg: string) => void; warn: (msg: string) => void };
  /** How long a Codex probe is reused before it is asked again — same idea
   *  and default as `harnessList.ts`'s `CACHE_TTL_MS`. 0 disables caching
   *  (tests want every call to probe). Ignored when `probeCodexBackend` is
   *  given explicitly — that dep owns its own caching, if any. */
  cacheTtlMs?: number;
  now?: () => number;
  /**
   * Fires with the fresh step list on a bounded background re-detect once a
   * run's console actually launches — the main-process half of "live
   * re-detect after a run finishes" (task B3 item 3), wired by `handlers.ts`
   * to `broadcast("prereqs.changed", { steps })` so a page that only
   * subscribes to that event (rather than polling `prereqs.status` itself,
   * as `PrereqPanel` does) still sees the step flip once its console
   * finishes. Optional: `prereqs.run` behaves identically without it — there
   * is simply no push update for that kind of listener.
   */
  broadcastChanged?: (steps: PrereqStep[]) => void;
  /** How often the background re-detect above polls, and how many times
   *  before it gives up — mirrors `PrereqPanel`'s own `POLL_MS`/`MAX_POLLS`
   *  so main and renderer agree on "how long is a run still worth watching". */
  pollIntervalMs?: number;
  maxPolls?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export type PrereqsHandlers = {
  "prereqs.status": (args: InvokeArgs<"prereqs.status">) => Promise<InvokeResult<"prereqs.status">>;
  "prereqs.run": (args: InvokeArgs<"prereqs.run">) => Promise<InvokeResult<"prereqs.run">>;
};

/**
 * Memoizes a Codex probe the same way `createHarnessLister` memoizes its own:
 * the *promise* is cached, not the value, so N callers mid-flight share one
 * probe; a rejected probe is forgotten immediately rather than remembered for
 * the TTL. Without this, the panel's own "poll `prereqs.status` every 3s
 * while a console is open" (SPEC R3 task) would spawn a fresh
 * `codex app-server` child every three seconds. `probe` is a parameter
 * (rather than calling `probeCodex()` directly) so this is testable without
 * a real Codex install — `createPrereqsIpc` is the only caller that defaults
 * it to the real thing.
 */
export function cachedCodexProbe(
  probe: () => Promise<CodexProbeResult>,
  ttlMs: number,
  now: () => number = Date.now,
): () => Promise<CodexProbeResult> {
  let cached: { at: number; value: Promise<CodexProbeResult> } | null = null;
  return () => {
    const at = now();
    if (cached && ttlMs > 0 && at - cached.at < ttlMs) return cached.value;
    const value = probe();
    cached = { at, value };
    value.catch(() => {
      if (cached?.value === value) cached = null;
    });
    return value;
  };
}

const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_MAX_POLLS = 40; // ~2 minutes at the default interval

export function createPrereqsIpc(deps: PrereqsIpcDeps = {}): { handlers: PrereqsHandlers } {
  const confirm = deps.confirm ?? defaultConfirm;
  const openConsole = deps.openConsole ?? defaultOpenConsole;
  const log = deps.log;
  const probeCodexBackend =
    deps.probeCodexBackend ?? cachedCodexProbe(probeCodex, deps.cacheTtlMs ?? CACHE_TTL_MS, deps.now ?? Date.now);
  const setIntervalFn = deps.setIntervalFn ?? setInterval;
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval;

  async function status(): Promise<InvokeResult<"prereqs.status">> {
    const steps = await detectPrereqSteps({
      probeCodexBackend,
      ...(deps.probe ? { probe: deps.probe } : {}),
      ...(deps.env ? { env: deps.env } : {}),
      ...(deps.home ? { home: deps.home } : {}),
      ...(deps.exists ? { exists: deps.exists } : {}),
    });
    return { steps, recommendation: recommendationFor(steps) };
  }

  /**
   * Re-detects every `pollIntervalMs` and pushes the fresh list to
   * `broadcastChanged`, stopping once `stepId` itself is detected or the poll
   * cap is reached (whichever first — a step no one asked about running is
   * not this loop's job to keep watching forever).
   */
  function watchUntilDetected(stepId: string): void {
    const onChanged = deps.broadcastChanged;
    if (!onChanged) return;
    const intervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const maxPolls = deps.maxPolls ?? DEFAULT_MAX_POLLS;
    let count = 0;
    const timer = setIntervalFn(() => {
      count += 1;
      if (count > maxPolls) {
        clearIntervalFn(timer);
        return;
      }
      void status()
        .then(({ steps }) => {
          onChanged(steps);
          if (steps.find((s) => s.id === stepId)?.detected) clearIntervalFn(timer);
        })
        .catch((err: unknown) => {
          log?.warn(`[prereqs] background re-detect failed: ${String(err)}`);
        });
    }, intervalMs);
  }

  async function run(
    args: InvokeArgs<"prereqs.run">,
  ): Promise<InvokeResult<"prereqs.run">> {
    const { steps } = await status();
    const step = steps.find((s) => s.id === args.stepId);
    if (!step) {
      log?.warn(`[prereqs] run: unknown step "${args.stepId}"`);
      return { ok: false, started: false };
    }

    const unmet = firstUnmetDependency(step, steps);
    if (unmet) {
      log?.warn(`[prereqs] refusing to run "${step.id}": "${unmet}" is not detected yet`);
      return { ok: false, started: false };
    }

    // R27/CLAUDE.md: nothing runs before this resolves `true`. A rejected
    // confirm (dialog closed, promise throws) reads the same as Cancel —
    // "nothing ran" is always the safe outcome of a broken dialog.
    let confirmed: boolean;
    try {
      confirmed = await confirm(confirmOptionsFor(step));
    } catch (err) {
      log?.warn(`[prereqs] confirm dialog failed for "${step.id}": ${String(err)}`);
      return { ok: false, started: false };
    }
    if (!confirmed) return { ok: false, started: false };

    try {
      const { pid } = openConsole(consoleArgv(step.command));
      log?.info(`[prereqs] launched "${step.id}" in a visible console (pid ${pid ?? "?"})`);
      watchUntilDetected(step.id);
      return { ok: true, started: true };
    } catch (err) {
      log?.warn(`[prereqs] failed to launch "${step.id}": ${String(err)}`);
      return { ok: false, started: false };
    }
  }

  return { handlers: { "prereqs.status": status, "prereqs.run": run } };
}
