/**
 * `harness.list` backend: what backends/models the New Session picker and
 * Settings ▸ Harnesses can offer *right now*, on *this* machine.
 *
 * TODO(integrator, Phase 4+): there is no engine/harness registry yet (PLAN.md
 * — Phase 3 introduces the `Harness` interface and the Claude harness; Codex
 * and API-model harnesses, and any registry that knows their capabilities and
 * live model catalogs, land later). Until one exists, this probes the two
 * CLIs a real capygen install can have (`claude --version`, `codex
 * --version`) and reports a static model list per backend. Replace the model
 * lists and the ad hoc probe with a call into that registry once it exists,
 * so `available`/`models` always reflect what the running harnesses actually
 * support (a live sign-in check, a real model catalog call) instead of a
 * hardcoded guess.
 */
import { execFile } from "node:child_process";
import type { HarnessInfo } from "@capygen/shared";

export interface CliProbeResult {
  ok: boolean;
  /** First line of stdout, when the probe succeeded. */
  version?: string;
  /** Why it failed — surfaced as `HarnessInfo.reason`. */
  reason?: string;
}

/** Overridable in tests; the default actually spawns the CLI (`windowsHide`,
 *  per CLAUDE.md's Windows-first rule — no console flash for a background
 *  probe the user never asked to see). */
export type CliProbe = (command: string, args: string[]) => Promise<CliProbeResult>;

const PROBE_TIMEOUT_MS = 5_000;

export const defaultCliProbe: CliProbe = (command, args) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { windowsHide: true, timeout: PROBE_TIMEOUT_MS },
      (err, stdout) => {
        if (err) {
          resolve({ ok: false, reason: `${command} CLI not found on PATH` });
          return;
        }
        resolve({ ok: true, version: stdout.toString().trim().split("\n")[0] });
      },
    );
  });

/** Claude Code models this build knows how to offer explicitly (COMPAT.md:
 *  "never rely on the default" — `Options.model` is always passed). */
const CLAUDE_MODELS = [
  { id: "claude-opus-4-5", label: "Claude Opus 4.5" },
  { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
];

/** Codex model ids, per docs/spikes/codex-shapes.md's `model/list` sample —
 *  static until the registry can ask the running `codex app-server` directly. */
const CODEX_MODELS = [{ id: "gpt-5-codex", label: "GPT-5 Codex" }];

export interface HarnessListerDeps {
  /** The Claude backend's current default (Settings ▸ General). */
  defaultModel: () => string;
  probe?: CliProbe;
}

/** Builds the `deps.listHarnesses` the `harness.list` IPC handler calls. */
export function createHarnessLister(deps: HarnessListerDeps): () => Promise<HarnessInfo[]> {
  const probe = deps.probe ?? defaultCliProbe;

  return async (): Promise<HarnessInfo[]> => {
    const [claude, codex] = await Promise.all([
      probe("claude", ["--version"]),
      probe("codex", ["--version"]),
    ]);

    return [
      {
        backend: "claude",
        label: "Claude Code",
        available: claude.ok,
        ...(claude.ok ? {} : { reason: claude.reason ?? "claude CLI not found" }),
        models: claude.ok ? CLAUDE_MODELS : [],
        defaultModel: claude.ok ? deps.defaultModel() : "",
      },
      {
        backend: "codex",
        label: "Codex",
        available: codex.ok,
        ...(codex.ok ? {} : { reason: codex.reason ?? "codex CLI not found" }),
        models: codex.ok ? CODEX_MODELS : [],
        defaultModel: codex.ok ? CODEX_MODELS[0]!.id : "",
      },
      {
        // The API backend runs capygen's own agent loop against a key stored
        // via `secrets.*` (R21) — there is no CLI to probe, and no fixed model
        // list: Settings ▸ API keys is where a model id gets typed in.
        backend: "api",
        label: "API model",
        available: true,
        models: [],
        defaultModel: "",
      },
    ];
  };
}
