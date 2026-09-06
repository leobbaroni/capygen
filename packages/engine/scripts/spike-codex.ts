/**
 * capygen Phase-1 spike — prove the Codex capabilities capygen needs, headless,
 * against the user's signed-in Codex CLI.
 *
 *   corepack pnpm --dir packages/engine exec tsx scripts/spike-codex.ts
 *     [--only auth,a,b,c,d,e]      subset of checks (default: all; "auth" = account/read with refreshToken)
 *     [--bin bundled|installed|<path-to-codex.exe>]   default: bundled (@openai/codex 0.153.4)
 *     [--raw <path>]               raw event log (default docs/spikes/codex.raw.json, gitignored)
 *
 * Checks:
 *   a) SDK runStreamed: "Reply with exactly the word pong." + resumeThread; usage recorded.
 *   b) SDK: a turn that must run a command under approvalPolicy=untrusted (SDK has no approval hook).
 *   c) app-server over stdio: initialize -> thread/start -> turn/start -> stream -> turn/completed (+ thread/resume).
 *   d) app-server: item/commandExecution/requestApproval answered with {decision:"accept"}; output shows.
 *   e) app-server discovery: model/list, skills/list, mcpServerStatus/list, config/read, hooks/list, ...
 *
 * Prints "CAP <name> PASS|PARTIAL|FAIL - <evidence>" lines and always exits 0.
 * Never prints or stores secrets: the raw log is redacted (token/email/key fields) and gitignored.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { Codex, type ThreadEvent, type ThreadItem, type Usage } from "@openai/codex-sdk";
import { requireIsolatedHomes, TEST_CODEX_MODEL, TEST_EFFORT } from "./test-policy.js";

// ---------------------------------------------------------------- setup

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const T0 = Date.now();

function argOf(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const ONLY = new Set((argOf("--only") ?? "auth,a,b,c,d,e").split(",").map((s) => s.trim()));
const RAW_LOG = path.resolve(REPO_ROOT, argOf("--raw") ?? "docs/spikes/codex.raw.json");

type Bin = { exe: string; pathDirs: string[]; label: string; version: string };

/** Mirror the SDK's own binary discovery (dist/index.js findCodexPath) so we know what it will spawn. */
function resolveBundledCodex(): Bin | null {
  try {
    // @openai/codex-sdk's "exports" map only has an "import" condition (no ./package.json, no CJS), so resolve the ESM
    // entry with import.meta.resolve and realpath through pnpm's symlinks before walking to @openai/codex-win32-x64.
    const sdkEntry = realpathSync(fileURLToPath(import.meta.resolve("@openai/codex-sdk")));
    const codexPkg = realpathSync(createRequire(sdkEntry).resolve("@openai/codex/package.json"));
    const platPkg = realpathSync(createRequire(codexPkg).resolve("@openai/codex-win32-x64/package.json"));
    const root = path.join(path.dirname(platPkg), "vendor", "x86_64-pc-windows-msvc");
    const exe = path.join(root, "bin", "codex.exe");
    if (!existsSync(exe)) return null;
    const pathDir = path.join(root, "codex-path");
    return { exe, pathDirs: existsSync(pathDir) ? [pathDir] : [], label: "bundled", version: "" };
  } catch {
    return null;
  }
}
function resolveInstalledCodex(): Bin | null {
  const exe = path.join(process.env.LOCALAPPDATA ?? "", "Programs", "OpenAI", "Codex", "bin", "codex.exe");
  return existsSync(exe) ? { exe, pathDirs: [], label: "installed", version: "" } : null;
}
function pickBin(): Bin {
  const want = argOf("--bin") ?? "bundled";
  let bin: Bin | null = null;
  if (want === "bundled") bin = resolveBundledCodex() ?? resolveInstalledCodex();
  else if (want === "installed") bin = resolveInstalledCodex() ?? resolveBundledCodex();
  else bin = { exe: want, pathDirs: [], label: "custom", version: "" };
  if (!bin) throw new Error("no codex binary found");
  const v = spawnSync(bin.exe, ["--version"], { encoding: "utf8", windowsHide: true, env: cleanEnv([]) });
  bin.version = (v.stdout || v.stderr || "").trim();
  return bin;
}

/** Strip nested-Claude-session vars (this script runs inside Claude Code) and force UTF-8. */
function cleanEnv(extraPathDirs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    const K = k.toUpperCase();
    if (K === "CLAUDECODE" || K === "CLAUDE_PID" || K === "CLAUDE_EFFORT" || K.startsWith("CLAUDE_CODE_")) continue;
    out[k] = v;
  }
  out.PYTHONUTF8 = "1";
  if (extraPathDirs.length) {
    const key = Object.keys(out).find((k) => k.toLowerCase() === "path") ?? "PATH";
    out[key] = [...extraPathDirs, out[key] ?? ""].join(path.delimiter);
  }
  return out;
}

// ---------------------------------------------------------------- raw log + results

type RawEntry = { t: number; src: string; dir: string; data: unknown };
const raw: RawEntry[] = [];
const REDACT_KEY = /token|secret|api[_-]?key|email|authorization|password/i;
function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      o[k] = REDACT_KEY.test(k) && typeof val !== "object" ? "<redacted>" : redact(val);
    }
    return o;
  }
  return v;
}
function log(src: string, dir: string, data: unknown): void {
  raw.push({ t: Date.now() - T0, src, dir, data: redact(data) });
}
function flushRaw(): void {
  mkdirSync(path.dirname(RAW_LOG), { recursive: true });
  writeFileSync(RAW_LOG, JSON.stringify({ generatedAt: new Date().toISOString(), entries: raw }, null, 1));
}

type CapStatus = "PASS" | "PARTIAL" | "FAIL";
const caps: { name: string; status: CapStatus; evidence: string }[] = [];
function cap(name: string, status: CapStatus, evidence: string): void {
  caps.push({ name, status, evidence });
  console.log(`CAP ${name} ${status} - ${evidence}`);
}
function note(msg: string): void {
  console.log(`  .. ${msg}`);
  log("spike", "note", msg);
}
const short = (s: unknown, n = 160): string => {
  const t = typeof s === "string" ? s : JSON.stringify(s) ?? String(s);
  return t.length > n ? t.slice(0, n) + "..." : t;
};
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const SPIKE_FILE = "capy-spike.txt";
function cleanupSpikeFile(): void {
  try {
    rmSync(path.join(REPO_ROOT, SPIKE_FILE), { force: true });
  } catch {
    /* ignore */
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- SDK checks

function sdkClient(bin: Bin, config?: Record<string, string | number | boolean>): Codex {
  return new Codex({
    codexPathOverride: bin.exe,
    env: cleanEnv(bin.pathDirs),
    config: { model: TEST_CODEX_MODEL, model_reasoning_effort: TEST_EFFORT, ...config },
  });
}

requireIsolatedHomes("spike-codex");

async function collect(events: AsyncGenerator<ThreadEvent>, src: string) {
  const types: string[] = [];
  const items: ThreadItem[] = [];
  let text = "";
  let usage: Usage | null = null;
  let failed: string | null = null;
  for await (const ev of events) {
    log(src, "event", ev);
    types.push(ev.type);
    if (ev.type === "item.completed") {
      items.push(ev.item);
      if (ev.item.type === "agent_message") text = ev.item.text;
    } else if (ev.type === "turn.completed") usage = ev.usage;
    else if (ev.type === "turn.failed") failed = ev.error.message;
    else if (ev.type === "error") failed = ev.message;
  }
  return { types, items, text, usage, failed };
}

async function checkA(bin: Bin): Promise<void> {
  const name = "sdk-runStreamed-pong";
  try {
    const codex = sdkClient(bin);
    const thread = codex.startThread({
      workingDirectory: REPO_ROOT,
      skipGitRepoCheck: true,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      model: TEST_CODEX_MODEL,
      modelReasoningEffort: TEST_EFFORT,
    });
    const { events } = await thread.runStreamed("Reply with exactly the word pong.", { signal: AbortSignal.timeout(240_000) });
    const r = await collect(events, "sdk-a");
    note(`sdk thread.id=${thread.id} events=${r.types.join(",")}`);
    note(`sdk usage=${JSON.stringify(r.usage)}`);
    if (r.failed) return cap(name, "FAIL", `turn failed: ${r.failed}`);
    if (!/pong/i.test(r.text)) return cap(name, "FAIL", `text did not contain pong: ${short(r.text)}`);
    cap(name, "PASS", `text=${JSON.stringify(r.text)} usage=${JSON.stringify(r.usage)} events=[${[...new Set(r.types)].join(",")}]`);

    // resume the persisted thread by id (README: threads persisted in ~/.codex/sessions)
    const rname = "sdk-resumeThread";
    try {
      const resumed = codex.resumeThread(thread.id!, {
        workingDirectory: REPO_ROOT,
        skipGitRepoCheck: true,
        sandboxMode: "read-only",
        approvalPolicy: "never",
        model: TEST_CODEX_MODEL,
        modelReasoningEffort: TEST_EFFORT,
      });
      const { events: ev2 } = await resumed.runStreamed("Which single word did you reply with just before? Answer with only that word.", {
        signal: AbortSignal.timeout(240_000),
      });
      const r2 = await collect(ev2, "sdk-a-resume");
      note(`sdk resume usage=${JSON.stringify(r2.usage)} text=${JSON.stringify(r2.text)}`);
      if (r2.failed) cap(rname, "FAIL", r2.failed);
      else cap(rname, /pong/i.test(r2.text) ? "PASS" : "PARTIAL", `resumed ${thread.id} -> ${JSON.stringify(short(r2.text, 60))} usage=${JSON.stringify(r2.usage)}`);
    } catch (e) {
      cap(rname, "FAIL", errMsg(e));
    }
  } catch (e) {
    cap(name, "FAIL", errMsg(e));
  }
}

async function checkB(bin: Bin): Promise<void> {
  const name = "sdk-command-approval";
  // The SDK exposes no approval callback (index.d.ts: TurnOptions = {outputSchema?, signal?}; ThreadOptions.approvalPolicy only).
  // `codex exec` is non-interactive, so we can only observe what happens when a command needs approval.
  // Note: codex 0.153.4 `exec` rejects `--config approval_policy="untrusted"` ("no longer supported") although the SDK's
  // ApprovalMode type still lists it; "on-request" + a read-only sandbox forces an escalation request instead.
  const prompts = [
    "Run the shell command `echo capy` and tell me its output.",
    `Using one shell command, write the word capy into a new file named ${SPIKE_FILE} in the current directory, then print that file's contents. If the sandbox blocks the write, request approval to run it outside the sandbox.`,
  ];
  const observed: string[] = [];
  try {
    // approvals_reviewer=user overrides the user's config.toml auto_review so the request is not auto-decided by a subagent.
    const codex = sdkClient(bin, { approvals_reviewer: "user" });
    for (const [i, prompt] of prompts.entries()) {
      const thread = codex.startThread({
        workingDirectory: REPO_ROOT,
        skipGitRepoCheck: true,
        sandboxMode: "read-only",
        approvalPolicy: "on-request",
        model: TEST_CODEX_MODEL,
        modelReasoningEffort: TEST_EFFORT,
      });
      const { events } = await thread.runStreamed(prompt, { signal: AbortSignal.timeout(300_000) });
      const r = await collect(events, `sdk-b${i + 1}`);
      cleanupSpikeFile();
      const cmds = r.items.filter((it) => it.type === "command_execution");
      const errs = r.items.filter((it) => it.type === "error");
      const summary = `attempt${i + 1}: commands=${JSON.stringify(
        cmds.map((c) => (c.type === "command_execution" ? { command: c.command, status: c.status, exit_code: c.exit_code, out: short(c.aggregated_output, 80) } : c)),
      )} errors=${JSON.stringify(errs)} failed=${r.failed} text=${JSON.stringify(short(r.text, 120))} usage=${JSON.stringify(r.usage)}`;
      note(summary);
      observed.push(summary);
      const ranOk = cmds.some((c) => c.type === "command_execution" && /capy/.test(c.aggregated_output) && c.exit_code === 0);
      if (!ranOk || i === prompts.length - 1) break; // first prompt ran without approval -> try a command the sandbox blocks
    }
    cap(name, "PARTIAL", `SDK has no approval hook (TurnOptions/ThreadOptions in index.d.ts); observed: ${observed.join(" | ")}`);
  } catch (e) {
    cap(name, "PARTIAL", `SDK has no approval hook; run errored: ${errMsg(e)}; observed: ${observed.join(" | ")}`);
  }
}

// ---------------------------------------------------------------- app-server JSON-RPC client

type Json = any;
type Pending = { resolve: (v: Json) => void; reject: (e: Error) => void; method: string };
type NotifHandler = (method: string, params: Json) => void;

class AppServer {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Set<NotifHandler>();
  private stderrLines = 0;
  readonly methodsUsed = new Set<string>();
  readonly notificationsSeen = new Map<string, number>();
  readonly serverRequestsSeen: string[] = [];
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Server -> client requests (approvals etc.). Return the result object or throw to send a JSON-RPC error. */
  onServerRequest: (method: string, params: Json) => Promise<Json> | Json = (m) => {
    throw new Error(`unhandled server request ${m}`);
  };

  constructor(
    readonly bin: Bin,
    readonly tag: string,
  ) {
    this.child = spawn(bin.exe, ["app-server"], {
      env: cleanEnv(bin.pathDirs),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exited = new Promise((resolve) => this.child.once("exit", (code, signal) => resolve({ code, signal })));
    this.child.once("error", (e) => log(tag, "spawn-error", errMsg(e)));
    readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity }).on("line", (line) => this.onLine(line));
    readline.createInterface({ input: this.child.stderr, crlfDelay: Infinity }).on("line", (line) => {
      if (this.stderrLines++ < 300) log(tag, "stderr", line);
    });
  }

  private send(msg: Json): void {
    log(this.tag, "out", msg);
    this.child.stdin.write(JSON.stringify(msg) + "\n"); // JSONL; "jsonrpc":"2.0" is omitted on the wire (app-server README)
  }

  private onLine(line: string): void {
    let msg: Json;
    try {
      msg = JSON.parse(line);
    } catch {
      log(this.tag, "stdout-nonjson", line);
      return;
    }
    log(this.tag, "in", msg);
    if (msg.method !== undefined && msg.id !== undefined) {
      this.serverRequestsSeen.push(msg.method);
      Promise.resolve()
        .then(() => this.onServerRequest(msg.method, msg.params))
        .then(
          (result) => this.send({ id: msg.id, result }),
          (err) => this.send({ id: msg.id, error: { code: -32601, message: errMsg(err) } }),
        );
    } else if (msg.method !== undefined) {
      this.notificationsSeen.set(msg.method, (this.notificationsSeen.get(msg.method) ?? 0) + 1);
      for (const h of this.handlers) h(msg.method, msg.params);
    } else if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method} -> JSON-RPC error ${msg.error.code}: ${msg.error.message}${msg.error.data ? " " + short(msg.error.data) : ""}`));
      else p.resolve(msg.result);
    }
  }

  request(method: string, params?: Json, timeoutMs = 60_000): Promise<Json> {
    const id = this.nextId++;
    this.methodsUsed.add(method);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.send(params === undefined ? { id, method } : { id, method, params });
    });
  }

  notify(method: string, params?: Json): void {
    this.methodsUsed.add(method);
    this.send(params === undefined ? { method } : { method, params });
  }

  onNotification(h: NotifHandler): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  async close(): Promise<void> {
    try {
      this.child.stdin.end();
    } catch {
      /* ignore */
    }
    const t = setTimeout(() => this.child.kill(), 1500);
    await Promise.race([this.exited, sleep(3000)]);
    clearTimeout(t);
    if (this.child.exitCode === null) this.child.kill();
  }
}

async function startServer(bin: Bin, tag: string): Promise<AppServer> {
  const srv = new AppServer(bin, tag);
  const init = await srv.request(
    "initialize",
    {
      clientInfo: { name: "capygen-spike", title: "capygen spike", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    },
    30_000,
  );
  note(`${tag} initialize -> ${JSON.stringify(init)}`);
  srv.notify("initialized");
  return srv;
}

type TurnRun = { turn: Json; items: Json[]; deltas: string; usage: Json | null; seen: string[]; agentText: string; error: Json | null };

async function runTurn(srv: AppServer, threadId: string, text: string, extra: Json = {}, timeoutMs = 300_000): Promise<TurnRun> {
  const items: Json[] = [];
  const seen: string[] = [];
  let deltas = "";
  let usage: Json | null = null;
  let agentText = "";
  let turnId: string | null = null;
  let error: Json | null = null;
  const done = new Promise<Json>((resolve, reject) => {
    const off = srv.onNotification((m, p) => {
      if (!p || p.threadId !== threadId) return;
      seen.push(m);
      if (m === "item/agentMessage/delta") deltas += p.delta;
      else if (m === "item/completed") {
        items.push(p.item);
        if (p.item?.type === "agentMessage") agentText = p.item.text;
      } else if (m === "thread/tokenUsage/updated") usage = p.tokenUsage;
      else if (m === "turn/completed") {
        off();
        resolve(p.turn);
      } else if (m === "error" && p.willRetry === false) {
        error = p.error; // fatal: turn/completed (status "failed") normally follows within a moment
        setTimeout(() => {
          off();
          reject(new Error(`error notification without turn/completed: ${p.error?.message}`));
        }, 5000);
      }
    });
  });
  const res = await srv.request("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }], ...extra });
  turnId = res.turn?.id ?? null;
  note(`turn/start -> turn.id=${turnId} status=${res.turn?.status}`);
  let timer: NodeJS.Timeout | undefined;
  const turn = await Promise.race([
    done,
    new Promise<never>((_, reject) => {
      timer = setTimeout(async () => {
        try {
          if (turnId) await srv.request("turn/interrupt", { threadId, turnId });
        } catch {
          /* ignore */
        }
        reject(new Error(`turn did not complete within ${timeoutMs}ms`));
      }, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
  if (!usage) await sleep(600); // thread/tokenUsage/updated can trail turn/completed
  return { turn, items, deltas, usage, seen, agentText, error };
}

// ---------------------------------------------------------------- app-server checks

/** Is the CLI actually signed in? `codex login status` only checks that auth.json exists; a refresh round-trip proves it. */
async function checkAuth(bin: Bin): Promise<void> {
  const name = "codex-auth";
  let srv: AppServer | null = null;
  try {
    srv = await startServer(bin, "appserver-auth");
    const status = await srv.request("getAuthStatus", { includeToken: false, refreshToken: false });
    note(`getAuthStatus(no refresh) -> ${JSON.stringify(status)}`);
    const acct = await srv.request("account/read", { refreshToken: true }, 45_000);
    note(`account/read(refreshToken:true) -> ${JSON.stringify(acct)}`);
    if (acct.account) cap(name, "PASS", `account.type=${acct.account.type} planType=${acct.account.planType ?? "-"} authMethod=${status.authMethod}`);
    else cap(name, "FAIL", `account/read returned account=null (authMethod=${status.authMethod}, requiresOpenaiAuth=${acct.requiresOpenaiAuth}); see stderr in raw log (token refresh)`);
  } catch (e) {
    cap(name, "FAIL", errMsg(e));
  } finally {
    await srv?.close();
  }
}

async function checkC(bin: Bin): Promise<void> {
  const name = "appserver-thread-turn-stream";
  let srv: AppServer | null = null;
  try {
    srv = await startServer(bin, "appserver-c");
    const started = await srv.request("thread/start", {
      cwd: REPO_ROOT,
      model: TEST_CODEX_MODEL,
      approvalPolicy: "never",
      sandbox: "read-only",
      approvalsReviewer: "user",
    });
    const threadId: string = started.thread.id;
    note(
      `thread/start -> thread.id=${threadId} model=${started.model} provider=${started.modelProvider} approvalPolicy=${JSON.stringify(started.approvalPolicy)} sandbox=${JSON.stringify(started.sandbox)} reasoningEffort=${started.reasoningEffort} status=${JSON.stringify(started.thread.status)}`,
    );
    const r = await runTurn(srv, threadId, "Reply with exactly the word pong.", { effort: TEST_EFFORT });
    note(`turn ${r.turn.id} status=${r.turn.status} items=${r.items.map((i) => i.type).join(",")} deltas=${JSON.stringify(short(r.deltas, 40))} usage=${JSON.stringify(r.usage)}`);
    const text = r.agentText || r.deltas;
    const order = [...new Set(r.seen)];
    if (r.turn.status !== "completed") return cap(name, "FAIL", `turn status ${r.turn.status}: turn.error=${JSON.stringify(r.turn.error)} error-notification=${JSON.stringify(r.error)} notifications=[${[...new Set(r.seen)].join(",")}]`);
    if (!/pong/i.test(text)) return cap(name, "FAIL", `no pong in ${JSON.stringify(text)}`);
    cap(
      name,
      "PASS",
      `methods=[${[...srv.methodsUsed].join(",")}] notifications=[${order.join(",")}] text=${JSON.stringify(text)} usage.last=${JSON.stringify(r.usage?.last)} contextWindow=${r.usage?.modelContextWindow}`,
    );

    // resume the same thread in a fresh server process (persisted rollout)
    const rname = "appserver-thread-resume";
    try {
      await srv.close();
      srv = await startServer(bin, "appserver-c-resume");
      const resumed = await srv.request("thread/resume", { threadId, cwd: REPO_ROOT, approvalPolicy: "never", sandbox: "read-only" });
      const turns = resumed.thread?.turns ?? [];
      note(
        `thread/resume -> turns=${turns.length} first.items=${JSON.stringify(turns[0]?.items?.map((i: Json) => i.type))} cursors=${JSON.stringify({ turnsBackwardsCursor: resumed.turnsBackwardsCursor, itemsBackwardsCursor: resumed.itemsBackwardsCursor })}`,
      );
      cap(rname, turns.length > 0 ? "PASS" : "PARTIAL", `thread/resume returned thread.turns=${turns.length}, model=${resumed.model}, status=${JSON.stringify(resumed.thread?.status)}`);
    } catch (e) {
      cap(rname, "FAIL", errMsg(e));
    }
  } catch (e) {
    cap(name, "FAIL", errMsg(e));
  } finally {
    await srv?.close();
  }
}

async function checkD(bin: Bin): Promise<void> {
  const name = "appserver-command-approval";
  const writePrompt = `Using one shell command, write the word capy into a new file named ${SPIKE_FILE} in the current directory, then print that file's contents. If the sandbox blocks the write, request approval to run it outside the sandbox.`;
  const attempts: { approvalPolicy: string; sandbox: string; prompt: string }[] = [
    { approvalPolicy: "untrusted", sandbox: "workspace-write", prompt: "Run the shell command `echo capy` and tell me its output." },
    { approvalPolicy: "untrusted", sandbox: "workspace-write", prompt: "Run the shell command `node -e \"console.log('capy')\"` and tell me its output. Do not use any other command." },
    { approvalPolicy: "on-request", sandbox: "read-only", prompt: writePrompt },
  ];
  const observed: string[] = [];
  for (const [i, att] of attempts.entries()) {
    let srv: AppServer | null = null;
    try {
      srv = await startServer(bin, `appserver-d${i + 1}`);
      const approvals: Json[] = [];
      srv.onServerRequest = (method, params) => {
        if (method === "item/commandExecution/requestApproval") {
          approvals.push(params);
          note(`approval request: kind=${params.kind} command=${JSON.stringify(params.command)} cwd=${params.cwd} reason=${JSON.stringify(params.reason)} availableDecisions=${JSON.stringify(params.availableDecisions)}`);
          return { decision: "accept" };
        }
        if (method === "item/fileChange/requestApproval") {
          approvals.push(params);
          return { decision: "accept" };
        }
        if (method === "execCommandApproval") {
          approvals.push(params);
          return { decision: "approved" }; // legacy v1 shape
        }
        throw new Error(`spike does not handle ${method}`);
      };
      const started = await srv.request("thread/start", {
        cwd: REPO_ROOT,
        model: TEST_CODEX_MODEL,
        approvalPolicy: att.approvalPolicy,
        sandbox: att.sandbox,
        approvalsReviewer: "user",
      });
      const threadId: string = started.thread.id;
      note(`attempt${i + 1}: thread ${threadId} sandbox=${JSON.stringify(started.sandbox)} approvalPolicy=${JSON.stringify(started.approvalPolicy)} reviewer=${started.approvalsReviewer}`);
      const r = await runTurn(srv, threadId, att.prompt, { effort: TEST_EFFORT });
      cleanupSpikeFile();
      const cmds = r.items.filter((it) => it.type === "commandExecution");
      const summary = `attempt${i + 1}(${att.approvalPolicy}/${att.sandbox}): approvals=${approvals.length} serverRequests=[${srv.serverRequestsSeen.join(",")}] commands=${JSON.stringify(
        cmds.map((c) => ({ command: c.command, status: c.status, exitCode: c.exitCode, out: short(c.aggregatedOutput, 60) })),
      )} turn=${r.turn.status}${r.turn.status !== "completed" ? ` error=${JSON.stringify(r.turn.error?.message ?? r.error?.message)}` : ""} text=${JSON.stringify(short(r.agentText, 100))} usage.last=${JSON.stringify(r.usage?.last)}`;
      note(summary);
      observed.push(summary);
      const outputShown = cmds.some((c) => c.status === "completed" && /capy/.test(c.aggregatedOutput ?? "")) || /capy/.test(r.agentText);
      if (approvals.length > 0 && outputShown) {
        return cap(name, "PASS", `server request item/commandExecution/requestApproval for ${JSON.stringify(approvals[0].command)} answered {decision:"accept"}; ${summary}`);
      }
      if (r.turn.status !== "completed") continue; // sandbox failure etc. -> next attempt
    } catch (e) {
      const m = `attempt${i + 1}(${att.approvalPolicy}/${att.sandbox}) error: ${errMsg(e)}`;
      note(m);
      observed.push(m);
    } finally {
      await srv?.close();
    }
  }
  cap(name, "FAIL", observed.join(" | "));
}

async function checkE(bin: Bin): Promise<void> {
  const name = "appserver-discovery";
  let srv: AppServer | null = null;
  const found: string[] = [];
  const failures: string[] = [];
  try {
    srv = await startServer(bin, "appserver-e");
    const calls: [string, Json | undefined, (r: Json) => string][] = [
      [
        "model/list",
        {},
        (r) => `models=${r.data.map((m: Json) => `${m.id}${m.isDefault ? "*" : ""}[${m.supportedReasoningEfforts?.map((e: Json) => e.reasoningEffort ?? e).join("/")}]`).join(",")}`,
      ],
      [
        "skills/list",
        { cwds: [REPO_ROOT] },
        (r) => `skills=${r.data.flatMap((e: Json) => e.skills.map((s: Json) => `${s.name}(${s.scope}${s.enabled ? "" : ",disabled"})`)).join(",")} errors=${r.data.flatMap((e: Json) => e.errors).length}`,
      ],
      [
        "mcpServerStatus/list",
        {},
        (r) => `mcpServers=${r.data.map((s: Json) => `${s.name}:${s.runtimeStatus ?? "?"}/${s.authStatus}/tools=${Object.keys(s.tools ?? {}).length}`).join(",") || "(none)"}`,
      ],
      [
        "hooks/list",
        { cwds: [REPO_ROOT] },
        (r) =>
          `hooks=${r.data.flatMap((e: Json) => e.hooks.map((h: Json) => `${h.eventName ?? h.event ?? "?"}:${h.source?.type ?? JSON.stringify(h.source) ?? ""}`)).join(",") || "(none)"} warnings=${r.data.flatMap((e: Json) => e.warnings).length}`,
      ],
      [
        "config/read",
        { includeLayers: true, cwd: REPO_ROOT },
        (r) =>
          `config.model=${r.config.model} approval_policy=${JSON.stringify(r.config.approval_policy)} sandbox_mode=${r.config.sandbox_mode} approvals_reviewer=${r.config.approvals_reviewer} reasoning=${r.config.model_reasoning_effort} mcp_servers=${JSON.stringify(Object.keys(r.config.mcp_servers ?? {}))} layers=${r.layers?.map((l: Json) => l.name?.type).join(",")}`,
      ],
      ["account/read", { refreshToken: false }, (r) => `account.type=${r.account?.type} planType=${r.account?.planType} requiresOpenaiAuth=${r.requiresOpenaiAuth}`],
      ["getAuthStatus", { includeToken: false, refreshToken: false }, (r) => `authMethod=${r.authMethod} requiresOpenaiAuth=${r.requiresOpenaiAuth}`],
      ["account/rateLimits/read", undefined, (r) => `rateLimits.primary=${JSON.stringify(r.rateLimits?.primary)} secondary=${JSON.stringify(r.rateLimits?.secondary)} plan=${r.rateLimits?.planType}`],
      ["permissionProfile/list", { cwd: REPO_ROOT }, (r) => `permissionProfiles=${r.data.map((p: Json) => `${p.id}${p.allowed ? "" : "(!)"}`).join(",")}`],
      ["experimentalFeature/list", {}, (r) => `experimentalFeatures=${r.data.length} enabled=${r.data.filter((f: Json) => f.enabled).map((f: Json) => f.name).join(",")}`],
      ["collaborationMode/list", {}, (r) => `collaborationModes=${r.data.map((m: Json) => m.name ?? m.mode ?? JSON.stringify(m).slice(0, 30)).join(",")}`],
      ["windowsSandbox/readiness", undefined, (r) => `windowsSandbox=${JSON.stringify(r)}`],
      ["thread/list", { limit: 3, useStateDbOnly: true }, (r) => `threads(sample)=${r.data.length} sources=${r.data.map((t: Json) => JSON.stringify(t.source)).join(",")}`],
      [
        "plugin/list",
        { cwds: [REPO_ROOT], forceRefetch: false },
        (r) => `marketplaces=${r.marketplaces.map((m: Json) => `${m.name ?? m.id}:${(m.plugins ?? []).length}`).join(",") || "(none)"} loadErrors=${r.marketplaceLoadErrors.length}`,
      ],
      ["app/list", {}, (r) => `apps=${(r.data ?? r.apps ?? []).length}`],
      ["server/diagnostics", {}, (r) => `diagnostics keys=${Object.keys(r).join(",")}`],
    ];
    for (const [method, params, summarize] of calls) {
      try {
        const r = await srv.request(method, params, 45_000);
        const s = summarize(r);
        found.push(`${method}: ${s}`);
        note(`${method} -> ${short(s, 400)}`);
      } catch (e) {
        failures.push(`${method}: ${errMsg(e)}`);
        note(`${method} FAILED ${errMsg(e)}`);
      }
    }
    // Slash commands: no protocol method lists them (grep of the generated schema found none). Skills are the
    // discoverable "commands"; the TUI's /review, /compact, /model map to review/start, thread/compact/start, turn/start.model.
    const core = ["model/list", "skills/list", "mcpServerStatus/list", "config/read"];
    const coreOk = core.filter((m) => found.some((f) => f.startsWith(m + ":")));
    const status: CapStatus = coreOk.length === core.length ? "PASS" : coreOk.length ? "PARTIAL" : "FAIL";
    cap(
      name,
      status,
      `ok=[${found.map((f) => f.split(":")[0]).join(",")}] failed=[${failures.map((f) => f.split(":")[0]).join(",")}]; slash commands: not exposed by the protocol (skills/list + review/start + thread/compact/start cover the TUI commands)`,
    );
  } catch (e) {
    cap(name, "FAIL", `${errMsg(e)}; ok=[${found.join(" ; ")}] failed=[${failures.join(" ; ")}]`);
  } finally {
    await srv?.close();
  }
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  const bin = pickBin();
  const bundled = resolveBundledCodex();
  const installed = resolveInstalledCodex();
  console.log(`codex binary (${bin.label}): ${bin.exe} -> ${bin.version}`);
  console.log(`  bundled  : ${bundled?.exe ?? "(none)"}`);
  console.log(`  installed: ${installed?.exe ?? "(none)"}`);
  console.log(`  raw log  : ${RAW_LOG}`);
  log("spike", "note", { bin, bundled, installed, only: [...ONLY], repoRoot: REPO_ROOT, node: process.version });
  if (ONLY.has("auth")) await checkAuth(bin);
  if (ONLY.has("a")) await checkA(bin);
  if (ONLY.has("b")) await checkB(bin);
  if (ONLY.has("c")) await checkC(bin);
  if (ONLY.has("d")) await checkD(bin);
  if (ONLY.has("e")) await checkE(bin);
}

main()
  .catch((e) => {
    console.error("spike crashed:", e);
    cap("spike", "FAIL", errMsg(e));
  })
  .finally(() => {
    flushRaw();
    console.log(`\nSUMMARY ${caps.map((c) => `${c.name}=${c.status}`).join(" ")}`);
    console.log(`raw log: ${RAW_LOG} (${raw.length} entries)`);
    process.exit(0);
  });
