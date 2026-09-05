/**
 * capygen Phase 1 spike — engine capability proof (Claude Agent SDK + Codex CLI), consolidated.
 *
 * Runs the two backend probes one after the other as tsx child processes and merges their verdicts.
 * (Each probe is a standalone script that ends with process.exit(), so they cannot be imported into
 * one process without changing them.)
 *   1. scripts/spike-claude.ts — @anthropic-ai/claude-agent-sdk, headless against the signed-in Claude Code
 *   2. scripts/spike-codex.ts  — @openai/codex-sdk + `codex app-server`, headless against the signed-in Codex CLI
 * Their stdout/stderr is forwarded verbatim (after masking e-mail addresses and token-like JSON fields);
 * every "CAP <name> PASS|PARTIAL|FAIL - <evidence>" line is collected and the run ends with
 *   SPIKE <n> PASS, <m> PARTIAL, <k> FAIL
 * Exit code is 1 when any capability is FAIL (PLAN.md §Verification keeps this as a regression check), else 0.
 *
 * Run:  corepack pnpm spike                            (root script → @capygen/engine "spike")
 *       corepack pnpm --dir packages/engine spike
 * Options:
 *   --only claude,codex            subset of backends (default: both); env SPIKE_BACKENDS does the same
 *   --claude-steps a,b,c,d,e,f     forwarded to spike-claude.ts as SPIKE_STEPS
 *   --codex-only auth,a,b,c,d,e    forwarded to spike-codex.ts as --only
 *   --codex-bin bundled|installed|<path>   forwarded to spike-codex.ts as --bin
 *   SPIKE_TIMEOUT_MS=<ms>          per-backend wall clock (default 20 min); the child process tree is killed on expiry
 * Outputs (both gitignored): docs/spikes/engine.spike.log (transcript), docs/spikes/engine.raw.json (structured verdicts).
 * The probes keep their own raw logs (docs/spikes/claude.raw.json, docs/spikes/codex.raw.json).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const LOG_PATH = path.join(REPO_ROOT, 'docs', 'spikes', 'engine.spike.log');
const RAW_PATH = path.join(REPO_ROOT, 'docs', 'spikes', 'engine.raw.json');
const TIMEOUT_MS = Number(process.env.SPIKE_TIMEOUT_MS ?? 20 * 60_000);
const CAP_LINE = /^CAP (\S+) (PASS|PARTIAL|FAIL) - (.*)$/;

type Status = 'PASS' | 'PARTIAL' | 'FAIL';
type BackendId = 'claude' | 'codex';
type Cap = { backend: BackendId; name: string; status: Status; evidence: string };
type Backend = { id: BackendId; script: string; args: string[]; env: NodeJS.ProcessEnv };
type BackendResult = {
  id: BackendId;
  script: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  timedOut: boolean;
  stdoutLines: number;
  stderrLines: number;
  caps: Cap[];
};

// ---------------------------------------------------------------- args

function argOf(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const only = new Set(
  (argOf('--only') ?? process.env.SPIKE_BACKENDS ?? 'claude,codex')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

function backends(): Backend[] {
  const list: Backend[] = [];
  if (only.has('claude')) {
    const steps = argOf('--claude-steps');
    list.push({
      id: 'claude',
      script: path.join(HERE, 'spike-claude.ts'),
      args: [],
      env: { ...process.env, ...(steps ? { SPIKE_STEPS: steps } : {}) },
    });
  }
  if (only.has('codex')) {
    const args: string[] = [];
    const o = argOf('--codex-only');
    if (o) args.push('--only', o);
    const b = argOf('--codex-bin');
    if (b) args.push('--bin', b);
    list.push({ id: 'codex', script: path.join(HERE, 'spike-codex.ts'), args, env: { ...process.env } });
  }
  return list;
}

// ---------------------------------------------------------------- output (console + transcript), masked

const transcript: string[] = [];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const SECRET_FIELD = /("(?:[a-z_]*token|secret|api[_-]?key|authorization|password)"\s*:\s*")[^"]*(")/gi;
/** The probes already redact their raw logs; console lines get the same treatment before they are echoed or stored. */
function mask(line: string): string {
  return line.replace(EMAIL, '<redacted-email>').replace(SECRET_FIELD, '$1<redacted>$2');
}
function out(line: string): void {
  const l = mask(line);
  console.log(l);
  transcript.push(l);
}
function err(line: string): void {
  const l = mask(line);
  console.error(l);
  transcript.push(`[stderr] ${l}`);
}

// ---------------------------------------------------------------- child runner

/** Run a .ts script in a child: reuse the tsx hooks this process was started with, else the tsx CLI. */
function nodeArgs(script: string, args: string[]): string[] {
  if (process.execArgv.some((a) => /[\\/]tsx[\\/]/.test(a))) return [...process.execArgv, script, ...args];
  const cli = createRequire(import.meta.url).resolve('tsx/cli');
  return [cli, script, ...args];
}

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    // child.kill() would leave claude.exe / codex.exe grandchildren running
    spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' });
  } else {
    child.kill('SIGKILL');
  }
}

let current: ChildProcess | null = null;

function lines(stream: NodeJS.ReadableStream, onLine: (l: string) => void): Promise<void> {
  return new Promise((resolve) => {
    readline.createInterface({ input: stream, crlfDelay: Infinity }).on('line', onLine).once('close', resolve);
  });
}

async function runBackend(b: Backend): Promise<BackendResult> {
  const t0 = Date.now();
  const res: BackendResult = {
    id: b.id,
    script: b.script,
    args: b.args,
    exitCode: null,
    signal: null,
    durationMs: 0,
    timedOut: false,
    stdoutLines: 0,
    stderrLines: 0,
    caps: [],
  };
  out('');
  out(`=== ${b.id}: ${path.relative(REPO_ROOT, b.script)}${b.args.length ? ' ' + b.args.join(' ') : ''} ===`);

  const child = spawn(process.execPath, nodeArgs(b.script, b.args), {
    cwd: REPO_ROOT,
    env: b.env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  current = child;
  const stderrTail: string[] = [];
  const stdoutDone = lines(child.stdout!, (line) => {
    res.stdoutLines++;
    out(line);
    const m = CAP_LINE.exec(line);
    if (m) res.caps.push({ backend: b.id, name: m[1]!, status: m[2] as Status, evidence: mask(m[3]!) });
  });
  const stderrDone = lines(child.stderr!, (line) => {
    res.stderrLines++;
    err(line);
    stderrTail.push(line);
    if (stderrTail.length > 5) stderrTail.shift();
  });
  const timer = setTimeout(() => {
    res.timedOut = true;
    err(`${b.id}: no completion after ${TIMEOUT_MS} ms; killing the process tree`);
    killTree(child);
  }, TIMEOUT_MS);

  const spawnError = new Promise<string | null>((resolve) => {
    child.once('error', (e) => resolve(e.message));
    child.once('spawn', () => resolve(null));
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
    child.once('error', () => resolve({ code: null, signal: null }));
  });
  const spawnErr = await spawnError;
  const { code, signal } = await closed;
  await Promise.all([stdoutDone, stderrDone]);
  clearTimeout(timer);
  current = null;
  res.exitCode = code;
  res.signal = signal;
  res.durationMs = Date.now() - t0;

  const problem = spawnErr
    ? `spawn failed: ${spawnErr}`
    : res.timedOut
      ? `timed out after ${TIMEOUT_MS} ms`
      : code !== 0
        ? `exit code ${code}${signal ? ` signal ${signal}` : ''}`
        : res.caps.length === 0
          ? 'exited 0 without printing any CAP line'
          : null;
  if (problem) {
    const tail = stderrTail.join(' | ').slice(0, 400);
    const evidence = `${problem}${tail ? `; stderr tail: ${tail}` : ''}`;
    res.caps.push({ backend: b.id, name: `${b.id}-spike`, status: 'FAIL', evidence: mask(evidence) });
    out(`CAP ${b.id}-spike FAIL - ${evidence}`);
  }
  out(`=== ${b.id} done in ${(res.durationMs / 1000).toFixed(1)} s (exit ${code ?? 'n/a'}${signal ? `, ${signal}` : ''}) ===`);
  return res;
}

// ---------------------------------------------------------------- main

function writeArtifacts(results: BackendResult[], summary: Record<Status, number>, startedAt: string): void {
  mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  writeFileSync(LOG_PATH, transcript.join('\n') + '\n', 'utf8');
  writeFileSync(
    RAW_PATH,
    JSON.stringify(
      {
        startedAt,
        finishedAt: new Date().toISOString(),
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        repoRoot: REPO_ROOT,
        backends: results,
        summary,
      },
      null,
      1,
    ),
    'utf8',
  );
}

async function main(): Promise<number> {
  const startedAt = new Date().toISOString();
  const list = backends();
  const results: BackendResult[] = [];
  const summary: Record<Status, number> = { PASS: 0, PARTIAL: 0, FAIL: 0 };
  out(`capygen engine spike — ${startedAt} — node ${process.version} — backends: ${list.map((b) => b.id).join(', ') || '(none)'}`);
  if (list.length === 0) out(`nothing selected (--only ${[...only].join(',')}); valid backends: claude, codex`);
  try {
    for (const b of list) results.push(await runBackend(b));
  } finally {
    const caps = results.flatMap((r) => r.caps);
    for (const c of caps) summary[c.status]++;
    out('');
    out('SPIKE RESULTS');
    for (const c of caps) out(`  ${c.backend.padEnd(6)} ${c.name.padEnd(30)} ${c.status.padEnd(7)} ${c.evidence.slice(0, 120)}${c.evidence.length > 120 ? '...' : ''}`);
    out(`SPIKE ${summary.PASS} PASS, ${summary.PARTIAL} PARTIAL, ${summary.FAIL} FAIL`);
    out(`LOG ${LOG_PATH}`);
    out(`RAW ${RAW_PATH}`);
    writeArtifacts(results, summary, startedAt);
  }
  return summary.FAIL > 0 ? 1 : 0;
}

process.on('SIGINT', () => {
  if (current) killTree(current);
  process.exit(130);
});

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error('spike-engine crashed:', e);
    process.exit(1);
  });
