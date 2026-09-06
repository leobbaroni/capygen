/**
 * Setup panel detection (SPEC R3): what is on this machine right now, probed
 * fresh every call — a cached "detected" bit would be stale the moment the
 * user installs the thing capygen is telling them to install
 * (`PrereqStepSchema`'s own doc comment).
 *
 * Reuses `harnessList.ts`'s probes rather than duplicating them: the same
 * `CliProbe` (`execFile`, `windowsHide: true`, 5s timeout) and the same
 * `probeCodex()` (`account/read`, not `codex login status` — see that file's
 * header for why the CLI's own status command lies about a dead token) answer
 * both `harness.list` and this panel, so the two never disagree about whether
 * Claude/Codex are usable.
 *
 * Every command below is the one CLAUDE.md requires: exact, pasteable,
 * winget/npm/official-installer spellings a user could run by hand — nothing
 * here ever executes one itself (that is `runGate.ts` + a confirm dialog).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { probeCodex, type CodexProbeResult } from "@capygen/engine";
import type { PrereqStep } from "@capygen/shared";
import { claudeSignInSignal, defaultCliProbe, type CliProbe } from "../ipc/harnessList.js";

export interface DetectPrereqsDeps {
  probe?: CliProbe;
  probeCodexBackend?: () => Promise<CodexProbeResult>;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Overridable in tests; the default is `fs.existsSync`. */
  exists?: (p: string) => boolean;
}

interface CliDetection {
  found: boolean;
  version?: string;
  path?: string;
}

/**
 * `claude.exe` can be a native install (`~/.local/bin/claude.exe`, this
 * machine's own, per SPEC "Current State") or an npm global install, and
 * either may or may not be on PATH yet — a fresh shell needs a restart to
 * pick up a PATH change a native installer just made, so PATH alone
 * undercounts. Three checks, in the order a user would actually discover it:
 * PATH (covers the common case, and any npm-global install whose shim is on
 * PATH), the native installer's fixed location, then `npm config get prefix`
 * for an npm-global install whose shim is not on PATH yet.
 */
export async function detectClaudeCli(deps: DetectPrereqsDeps): Promise<CliDetection> {
  const probe = deps.probe ?? defaultCliProbe;
  const exists = deps.exists ?? fs.existsSync;
  const home = deps.home ?? os.homedir();

  const onPath = await probe("claude", ["--version"]);
  if (onPath.ok) return { found: true, version: onPath.version };

  const localBin = path.join(home, ".local", "bin", "claude.exe");
  if (exists(localBin)) {
    const probed = await probe(localBin, ["--version"]);
    return { found: true, ...(probed.version ? { version: probed.version } : {}), path: localBin };
  }

  const npmPrefix = await probe("npm", ["config", "get", "prefix"]);
  if (npmPrefix.ok && npmPrefix.version) {
    const shim = path.join(npmPrefix.version, "claude.cmd");
    if (exists(shim)) return { found: true, path: shim };
  }

  return { found: false };
}

/** `codex.exe` — PATH only. Unlike Claude this machine's Codex is an npm
 *  global install (SPEC "Current State"), which puts its shim on PATH by
 *  npm's own convention, so the extra checks `detectClaudeCli` needs do not
 *  apply here. */
export async function detectCodexCli(deps: DetectPrereqsDeps): Promise<CliDetection> {
  const probe = deps.probe ?? defaultCliProbe;
  const r = await probe("codex", ["--version"]);
  return r.ok ? { found: true, version: r.version } : { found: false };
}

async function detectSimple(deps: DetectPrereqsDeps, command: string): Promise<CliDetection> {
  const probe = deps.probe ?? defaultCliProbe;
  const r = await probe(command, ["--version"]);
  return r.ok ? { found: true, version: r.version } : { found: false };
}

/** Every step's exact command (CLAUDE.md: "confirms the exact command"). */
export const PREREQ_COMMANDS = {
  node: "winget install --id=OpenJS.NodeJS.LTS -e",
  git: "winget install --id=Git.Git -e",
  ripgrep: "winget install --id=BurntSushi.ripgrep.MSVC -e",
  claudeCli: 'powershell -ExecutionPolicy ByPass -c "irm https://claude.ai/install.ps1 | iex"',
  claudeLogin: "claude",
  codexCli: "npm install -g @openai/codex",
  codexLogin: "codex login",
  uv: 'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"',
  windowsTerminal: "winget install --id Microsoft.WindowsTerminal -e",
} as const;

/**
 * The setup panel's whole step list (R3), freshly probed. Order is the order
 * a user would want to work through them: the two runtimes/tools that other
 * steps can depend on, then each backend's install-then-sign-in pair, then
 * the two optional extras.
 */
export async function detectPrereqSteps(deps: DetectPrereqsDeps = {}): Promise<PrereqStep[]> {
  // Same default as `harnessList.ts`'s `createHarnessLister` — a real
  // `account/read` probe unless a test overrides it — so this panel and the
  // New Session picker never disagree about whether Codex is signed in.
  const probeCodexBackend = deps.probeCodexBackend ?? (() => probeCodex());
  const [node, git, ripgrep, claude, codex, uv, windowsTerminal, codexAccount] = await Promise.all(
    [
      detectSimple(deps, "node"),
      detectSimple(deps, "git"),
      detectSimple(deps, "rg"),
      detectClaudeCli(deps),
      detectCodexCli(deps),
      detectSimple(deps, "uv"),
      detectSimple(deps, "wt"),
      // Never lets a hung child blank the panel — same guard `harnessList.ts`
      // wraps `probeCodexBackend` in, for the same reason (a thrown probe
      // must not fail the whole channel).
      probeCodexBackend().catch(
        (err: unknown): CodexProbeResult => ({
          signedIn: false,
          models: [],
          reason: err instanceof Error ? err.message : String(err),
        }),
      ),
    ],
  );

  const claudeLogin = claudeSignInSignal(deps.env ?? process.env, deps.home);

  const steps: PrereqStep[] = [
    {
      id: "node",
      title: "Install Node.js",
      detected: node.found,
      ...(node.version ? { version: node.version } : {}),
      command: PREREQ_COMMANDS.node,
      description:
        "JavaScript runtime the Codex CLI (an npm package) needs to install; capygen itself " +
        "does not need it at runtime.",
      kind: "runtime",
    },
    {
      id: "git",
      title: "Install Git",
      detected: git.found,
      ...(git.version ? { version: git.version } : {}),
      command: PREREQ_COMMANDS.git,
      description: "Version control — powers the Diff pane and git status/commit.",
      kind: "tool",
    },
    {
      id: "ripgrep",
      title: "Install ripgrep (optional)",
      detected: ripgrep.found,
      ...(ripgrep.version ? { version: ripgrep.version } : {}),
      command: PREREQ_COMMANDS.ripgrep,
      description:
        "Fast file search for the Files pane. Without it capygen falls back to a slower " +
        "built-in walker — nothing is broken, just slower on a large tree.",
      kind: "tool",
    },
    {
      id: "claude-cli",
      title: "Install Claude Code",
      detected: claude.found,
      ...(claude.version ? { version: claude.version } : {}),
      command: PREREQ_COMMANDS.claudeCli,
      description: "Anthropic's Claude Code CLI — one of capygen's two agent backends.",
      kind: "cli",
    },
    {
      id: "claude-login",
      title: "Sign in to Claude Code",
      detected: claudeLogin.signedIn,
      command: PREREQ_COMMANDS.claudeLogin,
      description:
        "Opens Claude Code so you can complete the browser sign-in. Type /exit when done, " +
        "then Re-detect.",
      blockedBy: ["claude-cli"],
      kind: "cli",
    },
    {
      id: "codex-cli",
      title: "Install Codex",
      detected: codex.found,
      ...(codex.version ? { version: codex.version } : {}),
      command: PREREQ_COMMANDS.codexCli,
      description: "OpenAI's Codex CLI — capygen's other agent backend.",
      blockedBy: ["node"],
      kind: "cli",
    },
    {
      id: "codex-login",
      title: "Sign in to Codex",
      detected: codexAccount.signedIn,
      command: PREREQ_COMMANDS.codexLogin,
      description: "Opens the ChatGPT sign-in Codex needs. Type /exit when done, then Re-detect.",
      blockedBy: ["codex-cli"],
      kind: "cli",
    },
    {
      id: "uv",
      title: "Install uv (optional)",
      detected: uv.found,
      ...(uv.version ? { version: uv.version } : {}),
      command: PREREQ_COMMANDS.uv,
      description:
        "Python package/tool manager some MCP servers and skills use. Not required for " +
        "Claude Code or Codex themselves.",
      kind: "tool",
    },
    {
      id: "windows-terminal",
      title: "Install Windows Terminal (optional)",
      detected: windowsTerminal.found,
      ...(windowsTerminal.version ? { version: windowsTerminal.version } : {}),
      command: PREREQ_COMMANDS.windowsTerminal,
      description:
        "capygen's own Terminal pane (node-pty + ConPTY) works without it — this only affects " +
        "opening a raw console yourself.",
      kind: "tool",
    },
  ];

  return steps;
}

/** One sentence for the top of the panel, matching whichever backends are
 *  ready right now rather than repeating the step list. */
export function recommendationFor(steps: PrereqStep[]): string {
  const by = (id: string): boolean => steps.find((s) => s.id === id)?.detected ?? false;
  const claudeReady = by("claude-cli") && by("claude-login");
  const codexReady = by("codex-cli") && by("codex-login");

  if (claudeReady && codexReady) return "Claude Code and Codex are both ready to use.";
  if (claudeReady) return "Claude Code is ready. Codex is optional — set it up below if you want it too.";
  if (codexReady) return "Codex is ready. Claude Code is optional — set it up below if you want it too.";
  if (by("claude-cli") || by("codex-cli")) {
    return "A CLI is installed but not signed in yet — finish the sign-in step below to start a session.";
  }
  return "Install and sign in to at least one backend — Claude Code or Codex — to start a session.";
}
