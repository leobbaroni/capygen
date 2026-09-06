/**
 * capygen Phase 1 spike — Claude Agent SDK capability proof (headless, signed-in Claude Code).
 *
 * Runs one query() per capability against cwd = repo root and logs every SDKMessage to
 * docs/spikes/claude.raw.json (gitignored). Prints one "CAP <name> PASS|PARTIAL|FAIL - <evidence>"
 * line per capability, then writes docs/spikes/claude.evidence.json — a small, redacted,
 * commit-able extract (init summary, canUseTool call/return, hook input/output, per-step usage)
 * that backs up every PASS without requiring the full (gitignored) raw log. Always exits 0.
 *
 * Steps: a=stream_text, b=system_init_commands, c=slash_context (local, no model call),
 * d=plugin_command, e=ask_user_question, f=pretooluse_hook_task, g=routing_lever
 * (SPEC R12 sub-agent routing: does a PreToolUse hook's updatedInput.model actually steer the
 * spawned sub-agent?). usage_reporting is derived from a/b/d/e/f, not run as its own query.
 *
 * Run: corepack pnpm --dir packages/engine exec tsx scripts/spike-claude.ts
 * Env: SPIKE_CLAUDE_EXE=<path to claude.exe> to override the SDK-bundled binary.
 *      SPIKE_STEPS=a,b,c,... to run a subset.
 */
import {
  query,
  type CanUseTool,
  type HookCallback,
  type Options,
  type PermissionMode,
  type SDKMessage,
  type SDKResultMessage,
  type SDKSystemMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { requireIsolatedHomes, TEST_CLAUDE_MODEL, TEST_EFFORT } from './test-policy.js';

const CWD = 'C:/Users/TugaPlayz/Desktop/GITHUB/capygen';
const RAW = `${CWD}/docs/spikes/claude.raw.json`;
const EVIDENCE = `${CWD}/docs/spikes/claude.evidence.json`;
const QUERY_TIMEOUT_MS = 240_000;

// ---------- logging ----------
type LogEntry = { step: string; t: number; kind: string; data: unknown };
const log: LogEntry[] = [];
const t0 = Date.now();
function rec(step: string, kind: string, data: unknown): void {
  log.push({ step, t: Date.now() - t0, kind, data });
}
function flush(): void {
  mkdirSync(dirname(RAW), { recursive: true });
  writeFileSync(RAW, JSON.stringify(log, null, 1), 'utf8');
}
const caps: Array<{ name: string; status: 'PASS' | 'PARTIAL' | 'FAIL'; evidence: string }> = [];
function cap(name: string, status: 'PASS' | 'PARTIAL' | 'FAIL', evidence: string): void {
  caps.push({ name, status, evidence });
  console.log(`CAP ${name} ${status} - ${evidence}`);
}

// ---------- child env: strip the nested Claude Code session ----------
function childEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(env)) {
    if (
      k === 'CLAUDECODE' ||
      k === 'CLAUDE_PID' ||
      k === 'CLAUDE_EFFORT' ||
      k === 'CLAUDE_AGENT_SDK_VERSION' ||
      k.startsWith('CLAUDE_CODE_')
    ) {
      delete env[k];
    }
  }
  env.PYTHONUTF8 = '1';
  return env;
}

function redact(v: unknown): unknown {
  // The stream carries no credentials; the only personal fields are the account email/organization
  // (nested under initializationResult.account and accountInfo). Deep-replace them before logging.
  return JSON.parse(
    JSON.stringify(v, (k, x) => (k === 'email' || k === 'organization') && typeof x === 'string' ? '<redacted>' : x),
  );
}

// ---------- query runner ----------
type RunResult = {
  messages: SDKMessage[];
  init?: SDKSystemMessage;
  result?: SDKResultMessage;
  finalText: string;
  stderr: string[];
  error?: string;
  timedOut: boolean;
  controls?: Record<string, unknown>;
};

type RunOpts = {
  step: string;
  prompt: string;
  permissionMode?: PermissionMode;
  maxTurns?: number;
  canUseTool?: CanUseTool;
  hooks?: Options['hooks'];
  includePartialMessages?: boolean;
  includeHookEvents?: boolean;
  /** Keep stdin open and issue control requests once the result arrives. */
  streaming?: boolean;
  extraEnv?: Record<string, string>;
  forwardSubagentText?: boolean;
  model?: string;
  effort?: Options["effort"];
};

async function run(o: RunOpts): Promise<RunResult> {
  const out: RunResult = { messages: [], finalText: '', stderr: [], timedOut: false };
  const abort = new AbortController();
  const env = { ...childEnv(), ...(o.extraEnv ?? {}) };
  const options: Options = {
    cwd: CWD,
    env,
    abortController: abort,
    permissionMode: o.permissionMode ?? 'bypassPermissions',
    model: o.model ?? TEST_CLAUDE_MODEL,
    effort: o.effort ?? TEST_EFFORT,
    allowDangerouslySkipPermissions: (o.permissionMode ?? 'bypassPermissions') === 'bypassPermissions',
    settingSources: ['user', 'project'],
    maxTurns: o.maxTurns ?? 4,
    includePartialMessages: o.includePartialMessages ?? false,
    includeHookEvents: o.includeHookEvents ?? false,
    forwardSubagentText: o.forwardSubagentText ?? false,
    canUseTool: o.canUseTool,
    hooks: o.hooks,
    stderr: (d) => {
      out.stderr.push(d);
      rec(o.step, 'stderr', d.slice(0, 2000));
    },
  };
  if (process.env.SPIKE_CLAUDE_EXE) options.pathToClaudeCodeExecutable = process.env.SPIKE_CLAUDE_EXE;

  rec(o.step, 'options', {
    ...options,
    env: '<stripped process.env: CLAUDECODE, CLAUDE_PID, CLAUDE_EFFORT, CLAUDE_AGENT_SDK_VERSION, CLAUDE_CODE_*; +PYTHONUTF8=1>',
    canUseTool: options.canUseTool ? '<fn>' : undefined,
    hooks: options.hooks ? Object.fromEntries(Object.entries(options.hooks).map(([k, v]) => [k, v?.map((m) => ({ matcher: m.matcher, hooks: m.hooks.length }))])) : undefined,
    stderr: '<fn>',
    abortController: '<AbortController>',
    prompt: o.prompt,
    streaming: !!o.streaming,
  });

  // Streaming form: yield one SDKUserMessage, then hold stdin open until we say so.
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  async function* input(): AsyncIterable<SDKUserMessage> {
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: o.prompt },
      parent_tool_use_id: null,
    };
    rec(o.step, 'sent_user_message', msg);
    yield msg;
    await released;
  }

  const timer = setTimeout(() => {
    out.timedOut = true;
    rec(o.step, 'timeout', { ms: QUERY_TIMEOUT_MS });
    abort.abort();
    release();
  }, QUERY_TIMEOUT_MS);

  const q = query({ prompt: o.streaming ? input() : o.prompt, options });
  try {
    for await (const m of q) {
      out.messages.push(m);
      rec(o.step, 'msg', redact(m));
      if (m.type === 'system' && m.subtype === 'init') out.init = m;
      if (m.type === 'assistant') {
        for (const b of m.message.content) {
          if (b.type === 'text' && !m.parent_tool_use_id) out.finalText = b.text;
        }
      }
      if (m.type === 'result') {
        out.result = m;
        if (m.subtype === 'success' && m.result) out.finalText = m.result;
        if (o.streaming) {
          // Control requests while the process is still alive.
          const controls: Record<string, unknown> = {};
          const tryCtl = async (name: string, fn: () => Promise<unknown>) => {
            try {
              controls[name] = redact(await fn());
            } catch (e) {
              controls[name] = { error: String(e) };
            }
          };
          await tryCtl('initializationResult', () => q.initializationResult());
          await tryCtl('supportedCommands', () => q.supportedCommands());
          await tryCtl('supportedAgents', () => q.supportedAgents());
          await tryCtl('supportedModels', () => q.supportedModels());
          await tryCtl('accountInfo', () => q.accountInfo());
          await tryCtl('mcpServerStatus', () => q.mcpServerStatus());
          out.controls = controls;
          rec(o.step, 'controls', controls);
          release();
        }
      }
    }
  } catch (e) {
    out.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    rec(o.step, 'error', out.error);
  } finally {
    clearTimeout(timer);
    release();
    try {
      q.close();
    } catch {
      /* already closed */
    }
    flush();
  }
  return out;
}

requireIsolatedHomes('spike-claude');

function usageLine(r: RunResult): string {
  const res = r.result;
  if (!res) return 'no result message';
  const u = res.usage;
  const models = Object.entries(res.modelUsage ?? {})
    .map(([m, mu]) => `${m}: in=${mu.inputTokens} out=${mu.outputTokens} cacheRead=${mu.cacheReadInputTokens} cacheCreate=${mu.cacheCreationInputTokens} cost=$${mu.costUSD.toFixed(4)} ctx=${mu.contextWindow}`)
    .join('; ');
  return `subtype=${res.subtype} turns=${res.num_turns} ${res.duration_ms}ms usage{input=${u.input_tokens} output=${u.output_tokens} cache_creation=${u.cache_creation_input_tokens} cache_read=${u.cache_read_input_tokens}} total_cost_usd=${res.total_cost_usd.toFixed(4)} modelUsage{${models}}`;
}

function failReason(r: RunResult): string {
  if (r.timedOut) return `timed out after ${QUERY_TIMEOUT_MS}ms`;
  if (r.error) return r.error;
  if (r.result && r.result.subtype !== 'success') return `result.subtype=${r.result.subtype} errors=${JSON.stringify(r.result.errors)}`;
  if (r.result && r.result.is_error) return `result.is_error=true result=${JSON.stringify(r.result.subtype === 'success' ? r.result.result : '').slice(0, 300)}`;
  const tail = r.stderr.join('').trim().split('\n').slice(-3).join(' | ');
  return `no result; stderr tail: ${tail.slice(0, 400)}`;
}

const wanted = new Set((process.env.SPIKE_STEPS ?? 'a,b,c,d,e,f,g').split(','));
const usage: Record<string, string> = {};
/** Numeric twin of `usage`, used by the usage_reporting gate (§g below) instead of regexing strings. */
type UsageNums = { input: number; output: number; cost: number } | null;
const usageNums: Record<string, UsageNums> = {};
function recordUsage(step: string, r: RunResult): void {
  usage[step] = usageLine(r);
  usageNums[step] = r.result ? { input: r.result.usage.input_tokens, output: r.result.usage.output_tokens, cost: r.result.total_cost_usd } : null;
}

// ---------- a) ping ----------
if (wanted.has('a')) {
  const r = await run({ step: 'a', prompt: 'Reply with exactly the word pong.', maxTurns: 2, includePartialMessages: true });
  recordUsage('a', r);
  const streamEvents = r.messages.filter((m) => m.type === 'stream_event').length;
  if (/pong/i.test(r.finalText)) {
    cap('stream_text', 'PASS', `result.result=${JSON.stringify(r.finalText.trim())} model=${r.init?.model} claude_code_version=${r.init?.claude_code_version} stream_event msgs=${streamEvents} apiKeySource=${r.init?.apiKeySource}`);
  } else {
    cap('stream_text', 'FAIL', failReason(r));
  }
}

// ---------- b) system init: slash commands, plugins, skills ----------
let pluginCommands: string[] = [];
let toolNames: string[] = [];
if (wanted.has('b')) {
  const r = await run({ step: 'b', prompt: 'Reply with exactly the word ok.', maxTurns: 2, streaming: true });
  recordUsage('b', r);
  const init = r.init;
  if (init) {
    const sc = init.slash_commands ?? [];
    toolNames = init.tools ?? [];
    const builtins = ['context', 'compact', 'help', 'clear', 'model', 'usage', 'cost', 'status', 'init', 'review'].filter((c) => sc.includes(c));
    pluginCommands = sc.filter((c) => c.includes(':'));
    const hasPilot = sc.includes('cockpit:pilot');
    const ctl = (r.controls?.supportedCommands as Array<{ name: string; description: string; argumentHint: string }> | undefined) ?? [];
    const pilotCtl = Array.isArray(ctl) ? ctl.find((c) => c.name === 'cockpit:pilot') : undefined;
    const ev =
      `slash_commands=${sc.length} builtins present=[${builtins.join(',')}] plugin-qualified=${pluginCommands.length} ` +
      `(${pluginCommands.slice(0, 8).join(',')}${pluginCommands.length > 8 ? ',…' : ''}) cockpit:pilot=${hasPilot} ` +
      `plugins=[${(init.plugins ?? []).map((p) => `${p.name}@${p.version ?? '?'}`).join(',')}] skills=${(init.skills ?? []).length} ` +
      `tools=${toolNames.length} (AskUserQuestion=${toolNames.includes('AskUserQuestion')}, Task=${toolNames.includes('Task')}, Agent=${toolNames.includes('Agent')}) ` +
      `mcp_servers=${(init.mcp_servers ?? []).length} model=${init.model} output_style=${init.output_style} capabilities=${JSON.stringify(init.capabilities ?? null)} ` +
      `supportedCommands()=${Array.isArray(ctl) ? ctl.length : JSON.stringify(ctl).slice(0, 120)} pilotDesc=${pilotCtl ? JSON.stringify(pilotCtl.description.slice(0, 80)) : 'n/a'}`;
    if (builtins.length >= 3 && hasPilot) cap('system_init_commands', 'PASS', ev);
    else if (builtins.length >= 3) cap('system_init_commands', 'PARTIAL', `plugin command cockpit:pilot missing; ${ev}`);
    else cap('system_init_commands', 'FAIL', ev);
  } else {
    cap('system_init_commands', 'FAIL', failReason(r));
  }
}

// ---------- c) /context ----------
if (wanted.has('c')) {
  const r = await run({ step: 'c', prompt: '/context', maxTurns: 2 });
  recordUsage('c', r);
  const withCtx = r.messages.find((m) => m.type === 'assistant' && (m as { context_usage?: unknown }).context_usage);
  const local = r.messages.find((m) => m.type === 'system' && (m as { subtype: string }).subtype === 'local_command_output');
  const textHit = /context|tokens/i.test(r.finalText);
  const kinds = r.messages.map((m) => `${m.type}${'subtype' in m ? ':' + (m as { subtype: string }).subtype : ''}`).join(',');
  if (withCtx) {
    const cu = (withCtx as { context_usage: { model: string; total_tokens: number; raw_max_tokens: number; percentage: number; categories: Array<{ name: string; tokens: number; kind: string }> } }).context_usage;
    cap('slash_context', 'PASS', `assistant.context_usage{model=${cu.model} total_tokens=${cu.total_tokens} raw_max=${cu.raw_max_tokens} pct=${cu.percentage} categories=${cu.categories.map((c) => `${c.name}=${c.tokens}`).join('|')}} msgs=[${kinds}]`);
  } else if (local || textHit) {
    cap('slash_context', 'PARTIAL', `no context_usage field; local_command_output=${!!local} text=${JSON.stringify(r.finalText.slice(0, 200))} msgs=[${kinds}]`);
  } else {
    cap('slash_context', 'FAIL', `${failReason(r)} msgs=[${kinds}] text=${JSON.stringify(r.finalText.slice(0, 200))}`);
  }
}

// ---------- d) plugin command ----------
if (wanted.has('d')) {
  const cmd = pluginCommands.includes('cockpit:pilot') || pluginCommands.length === 0 ? 'cockpit:pilot' : pluginCommands[0]!;
  const prompt = cmd === 'cockpit:pilot' ? "/cockpit:pilot what's next" : `/${cmd}`;
  // maxTurns 9 (was 6): the pilot skill's own step count varies with git-log verbosity on the
  // machine running it — a run observed hitting error_max_turns at 6 with the fingerprint tool call
  // already made but no final reply yet, which is a turn-budget artifact, not evidence the skill
  // didn't run. Give it enough headroom to reach its own natural finish.
  const r = await run({ step: 'd', prompt, maxTurns: 9 });
  recordUsage('d', r);
  const assistantMsgs = r.messages.filter(
    (m): m is Extract<SDKMessage, { type: 'assistant' }> => m.type === 'assistant' && !m.parent_tool_use_id,
  );
  const assistantTexts = assistantMsgs.flatMap((m) => m.message.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text));
  const allText = [...assistantTexts, r.finalText].join('\n');
  const toolsUsed = r.messages
    .filter((m): m is Extract<SDKMessage, { type: 'assistant' }> => m.type === 'assistant')
    .flatMap((m) => m.message.content.filter((b) => b.type === 'tool_use').map((b) => (b as { name: string }).name));
  const expanded = r.messages.some((m) => m.type === 'user' && JSON.stringify(m.message.content).includes('<command-name>'));
  const hit = /phase|plan/i.test(allText);

  // PASS predicate (tightened after adversarial review): "some tool ran and the reply sounds
  // plausible" is not evidence the *plugin skill* executed — an unmodified model can produce both
  // a Bash call and phase/plan-sounding prose with no plugin loaded at all. Require a fingerprint
  // that only cockpit:pilot's own script produces: its documented "Step 0" (skills/pilot's build
  // node — observed running verbatim in claude-sdk-shapes.md §8.4) issues `git log --oneline -5`
  // then `git status --short` as the FIRST top-level tool_use of the turn, before the model has
  // seen any other output to react to. That exact ordered pair, as the opening move, is not
  // something a bare model would improvise unprompted — it is the skill's literal command line.
  // PASS requires BOTH: (a) the fingerprint tool call — proof the skill's *code* ran — AND
  // (b) a phase/plan reply — proof the skill's *output* also matches its documented behaviour.
  // Either alone is insufficient: the fingerprint alone doesn't prove the rest of the skill ran
  // correctly, and the reply text alone is exactly the forgeable signal the previous gate accepted.
  const firstToolUse = assistantMsgs.flatMap((m) => m.message.content.filter((b) => b.type === 'tool_use'))[0] as
    | { name: string; input: unknown }
    | undefined;
  const firstBashCmd =
    firstToolUse && firstToolUse.name === 'Bash' ? String((firstToolUse.input as { command?: unknown }).command ?? '') : '';
  const pilotStepZeroFingerprint = /git log --oneline -5/.test(firstBashCmd) && /git status --short/.test(firstBashCmd);
  const isPilot = cmd === 'cockpit:pilot';

  const ev = `cmd=${prompt} isPilot=${isPilot} pilotStepZeroFingerprint=${pilotStepZeroFingerprint} firstToolUse=${firstToolUse?.name ?? 'none'} firstBashCmd=${JSON.stringify(firstBashCmd.slice(0, 160))} expanded(<command-name> in user msg)=${expanded} tools=[${toolsUsed.join(',')}] result.subtype=${r.result?.subtype} text=${JSON.stringify(allText.slice(0, 220))}`;

  if (isPilot) {
    if (pilotStepZeroFingerprint && hit) cap('plugin_command', 'PASS', ev);
    else if (pilotStepZeroFingerprint || hit) cap('plugin_command', 'PARTIAL', ev);
    else cap('plugin_command', 'FAIL', `${failReason(r)} ${ev}`);
  } else {
    // No known per-skill fingerprint for whatever plugin command ran instead (cockpit:pilot was
    // unavailable this run): tool use + on-topic text is suggestive, never proof, so this branch
    // cannot reach PASS.
    if (hit && toolsUsed.length > 0) cap('plugin_command', 'PARTIAL', `no fingerprint check available for ${cmd}; ${ev}`);
    else cap('plugin_command', 'FAIL', `${failReason(r)} no fingerprint check available for ${cmd}; ${ev}`);
  }
}

// ---------- e) AskUserQuestion via canUseTool ----------
if (wanted.has('e')) {
  const attempt = async (mode: PermissionMode) => {
    const seen: Array<{ toolName: string; input: unknown; opts: unknown }> = [];
    const canUseTool: CanUseTool = async (toolName, input, opts) => {
      const { signal: _s, ...rest } = opts;
      seen.push({ toolName, input, opts: rest });
      rec('e', 'canUseTool', { toolName, input, options: rest, permissionMode: mode });
      if (toolName === 'AskUserQuestion') {
        const questions = (input as { questions?: Array<{ question: string; options: Array<{ label: string }> }> }).questions ?? [];
        const answers: Record<string, string> = {};
        for (const qq of questions) {
          const blue = qq.options.find((op) => /blue/i.test(op.label));
          answers[qq.question] = blue?.label ?? 'blue';
        }
        const res = { behavior: 'allow' as const, updatedInput: { ...input, answers } };
        rec('e', 'canUseTool_response', res);
        return res;
      }
      return { behavior: 'allow' as const, updatedInput: input };
    };
    const r = await run({
      step: 'e',
      prompt: 'Use the AskUserQuestion tool to ask me whether I prefer red or blue, then reply with just the colour I chose.',
      maxTurns: 4,
      permissionMode: mode,
      canUseTool,
    });
    return { r, seen };
  };
  let { r, seen } = await attempt('bypassPermissions');
  let mode: PermissionMode = 'bypassPermissions';
  if (!seen.some((s) => s.toolName === 'AskUserQuestion')) {
    rec('e', 'note', 'canUseTool not invoked for AskUserQuestion under bypassPermissions; retrying with permissionMode=default');
    ({ r, seen } = await attempt('default'));
    mode = 'default';
  }
  recordUsage('e', r);
  const asked = seen.find((s) => s.toolName === 'AskUserQuestion');
  const toolResult = r.messages.find((m) => m.type === 'user' && JSON.stringify(m.message.content).includes('tool_result'));
  const tur = toolResult ? (toolResult as { tool_use_result?: unknown }).tool_use_result : undefined;
  const ev = `mode=${mode} canUseTool calls=[${seen.map((s) => s.toolName).join(',')}] question=${JSON.stringify((asked?.input as { questions?: Array<{ question: string }> })?.questions?.[0]?.question ?? null)} tool_use_result=${JSON.stringify(tur ?? null).slice(0, 200)} final=${JSON.stringify(r.finalText.trim().slice(0, 80))}`;
  if (asked && /blue/i.test(r.finalText) && !/red/i.test(r.finalText.replace(/blue/gi, ''))) cap('ask_user_question', 'PASS', ev);
  else if (asked) cap('ask_user_question', 'PARTIAL', ev);
  else cap('ask_user_question', 'FAIL', `${failReason(r)} ${ev} tools_in_init=${toolNames.includes('AskUserQuestion')}`);
}

// ---------- f) PreToolUse hook on Task + subagent ----------
if (wanted.has('f')) {
  const fired: Array<{ tool_name: string; tool_use_id: string; toolUseID: string | undefined; agent_id?: string; tool_input: unknown }> = [];
  const hook: HookCallback = async (input, toolUseID) => {
    rec('f', 'hook_PreToolUse', { input, toolUseID });
    if (input.hook_event_name === 'PreToolUse') {
      fired.push({ tool_name: input.tool_name, tool_use_id: input.tool_use_id, toolUseID, agent_id: input.agent_id, tool_input: input.tool_input });
    }
    const res = {};
    rec('f', 'hook_PreToolUse_response', res);
    return res;
  };
  const r = await run({
    step: 'f',
    prompt: 'Use the Task tool to spawn a subagent that counts the .md files in this directory and report the number.',
    maxTurns: 6,
    hooks: { PreToolUse: [{ matcher: 'Task|Agent', hooks: [hook] }] },
    includeHookEvents: true,
  });
  recordUsage('f', r);
  const taskStarted = r.messages.filter((m) => m.type === 'system' && (m as { subtype: string }).subtype === 'task_started');
  const subMsgs = r.messages.filter((m) => (m.type === 'assistant' || m.type === 'user') && m.parent_tool_use_id);
  const taskNotif = r.messages.filter((m) => m.type === 'system' && (m as { subtype: string }).subtype === 'task_notification');
  const hookEvents = r.messages.filter((m) => m.type === 'system' && /^hook_/.test((m as { subtype: string }).subtype)).map((m) => `${(m as { subtype: string }).subtype}:${(m as { hook_event?: string }).hook_event}`);
  const ts0 = taskStarted[0] as { task_id?: string; subagent_type?: string; description?: string; is_backgrounded?: boolean; spawn_depth?: number } | undefined;
  const ev = `hook fired=${fired.length} [${fired.map((f) => `${f.tool_name}#${f.tool_use_id.slice(0, 8)}${f.agent_id ? ' agent=' + f.agent_id : ''}`).join(',')}] task_started=${taskStarted.length}${ts0 ? ` {task_id=${ts0.task_id} subagent_type=${ts0.subagent_type} desc=${JSON.stringify(ts0.description)} bg=${ts0.is_backgrounded} depth=${ts0.spawn_depth}}` : ''} subagent msgs(parent_tool_use_id)=${subMsgs.length} task_notification=${taskNotif.length} hook_events=[${hookEvents.slice(0, 6).join(',')}] final=${JSON.stringify(r.finalText.trim().slice(0, 120))}`;
  const ran = taskStarted.length > 0 || subMsgs.length > 0;
  if (fired.length > 0 && ran) cap('pretooluse_hook_task', 'PASS', ev);
  else if (fired.length > 0 || ran) cap('pretooluse_hook_task', 'PARTIAL', ev);
  else cap('pretooluse_hook_task', 'FAIL', `${failReason(r)} ${ev}`);
}

// ---------- g) routing_lever: PreToolUse hook rewrites a sub-agent's model (SPEC R12) ----------
// Sub-agent routing (SPEC R12) needs a lever that actually steers which model a spawned sub-agent
// runs on. The candidate lever is PreToolUse.hookSpecificOutput.updatedInput on the Task/Agent
// tool call (AgentInput.model, sdk-tools.d.ts:678, accepts 'sonnet'|'opus'|'haiku'|'fable'). This
// step forces model:'claude-sonnet-5' from the hook and checks the STREAM for proof it took effect, using
// exactly the places the SDK could report it: task_started (no model field in the .d.ts —
// recorded to confirm that absence rather than assume it), task_notification.usage (same), and
// the undocumented-but-observed tool_use_result.resolvedModel (claude-sdk-shapes.md §8.6).
// Because the parent and child are both pinned to Sonnet 5 for test-policy safety, this probe can
// establish that the hook ran and the child resolved, but cannot prove a model change.
if (wanted.has('g')) {
  const hookCalls: Array<{ tool_name: string; tool_input: unknown }> = [];
  const hook: HookCallback = async (input, toolUseID) => {
    rec('g', 'hook_PreToolUse', { input, toolUseID });
    if (input.hook_event_name === 'PreToolUse' && /^(Task|Agent)$/.test(input.tool_name)) {
      hookCalls.push({ tool_name: input.tool_name, tool_input: input.tool_input });
      const updatedInput = { ...(input.tool_input as Record<string, unknown>), model: TEST_CLAUDE_MODEL };
      const res = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'allow' as const,
          updatedInput,
        },
      };
      rec('g', 'hook_PreToolUse_response', res);
      return res;
    }
    const res = {};
    rec('g', 'hook_PreToolUse_response', res);
    return res;
  };
  const r = await run({
    step: 'g',
    prompt: 'Use the Task tool to spawn a subagent that lists the top-level folder names in this directory, one per line.',
    maxTurns: 6,
    hooks: { PreToolUse: [{ matcher: 'Task|Agent', hooks: [hook] }] },
  });
  recordUsage('g', r);
  const taskStarted = r.messages.filter((m) => m.type === 'system' && (m as { subtype: string }).subtype === 'task_started') as Array<
    Record<string, unknown>
  >;
  const taskNotif = r.messages.filter((m) => m.type === 'system' && (m as { subtype: string }).subtype === 'task_notification') as Array<
    Record<string, unknown>
  >;
  const taskResultFrame = r.messages.find(
    (m) => m.type === 'user' && !m.parent_tool_use_id && JSON.stringify((m as { tool_use_result?: unknown }).tool_use_result ?? '').includes('resolvedModel'),
  );
  const resolvedModel = taskResultFrame
    ? ((taskResultFrame as { tool_use_result?: { resolvedModel?: string } }).tool_use_result?.resolvedModel ?? null)
    : null;
  const modelUsageKeys = Object.keys(r.result?.modelUsage ?? {});
  const sonnetInResolved = resolvedModel === TEST_CLAUDE_MODEL;
  const ts0 = taskStarted[0];
  const tn0 = taskNotif[0];
  const ev =
    `hookFired=${hookCalls.length} sentUpdatedInput.model='${TEST_CLAUDE_MODEL}'=${hookCalls.length > 0} ` +
    `task_started.hasModelField=${!!(ts0 && 'model' in ts0)} task_started.fields=${ts0 ? JSON.stringify(Object.keys(ts0)) : 'n/a'} ` +
    `task_notification.usage.hasModelField=${!!(tn0 && typeof tn0.usage === 'object' && tn0.usage !== null && 'model' in (tn0.usage as object))} ` +
    `resolvedModel=${JSON.stringify(resolvedModel)} modelUsage keys=[${modelUsageKeys.join(',')}] final=${JSON.stringify(r.finalText.trim().slice(0, 100))}`;
  if (hookCalls.length === 0) {
    cap('routing_lever', 'FAIL', `hook never fired for a Task/Agent tool_use — could not attempt the override; ${ev}`);
  } else if (!taskStarted.length && !taskNotif.length) {
    cap('routing_lever', 'FAIL', `hook ran but no child task evidence was observed; ${ev}`);
  } else if (resolvedModel && resolvedModel !== TEST_CLAUDE_MODEL) {
    cap('routing_lever', 'FAIL', `child resolved to unexpected model ${JSON.stringify(resolvedModel)}; ${ev}`);
  } else {
    cap(
      'routing_lever',
      'PARTIAL',
      `hook ran and child evidence was observed${sonnetInResolved ? `; child resolved to ${TEST_CLAUDE_MODEL}` : ''}, ` +
        `but parent and child are both pinned to ${TEST_CLAUDE_MODEL}, so the rewrite cannot be proven; ${ev}`,
    );
  }
}

// ---------- h) usage_reporting ----------
for (const [k, v] of Object.entries(usage)) console.log(`USAGE ${k}: ${v}`);
// PASS predicate (tightened after adversarial review): "some step somewhere reported a nonzero
// cost" passed even when other model-calling steps silently reported nothing — a single lucky hit
// hid missing usage everywhere else. Every step that actually calls the model — a, b, d, e, f (g
// is the routing_lever probe, judged on its own evidence above, not folded into this average) —
// must independently show input>0, output>0 AND total_cost_usd>0: proof each call reached the API
// and was billed. Step c (/context) is a LOCAL command per the SDK's own contract (result.num_turns
// is 0, no model is called) — a zero there is correct behaviour, not missing evidence, so it is
// exempted from the check and labelled as local rather than counted for or against the capability.
const MODEL_CALLING_STEPS = ['a', 'b', 'd', 'e', 'f'];
const LOCAL_STEPS = ['c'];
const ranModelSteps = MODEL_CALLING_STEPS.filter((s) => wanted.has(s));
const zeroOrMissing = ranModelSteps.filter((s) => {
  const n = usageNums[s];
  return !n || !(n.input > 0 && n.output > 0 && n.cost > 0);
});
const detail = ranModelSteps
  .map((s) => `${s}:in=${usageNums[s]?.input ?? '-'},out=${usageNums[s]?.output ?? '-'},cost=${usageNums[s]?.cost ?? '-'}`)
  .join(' ');
const localDetail = LOCAL_STEPS.filter((s) => wanted.has(s))
  .map((s) => `${s}=local(cost=${usageNums[s]?.cost ?? 'n/a'})`)
  .join(',');
if (ranModelSteps.length === 0) {
  cap('usage_reporting', 'FAIL', 'no model-calling step (a,b,d,e,f) ran; cannot verify usage reporting');
} else if (zeroOrMissing.length === 0) {
  cap('usage_reporting', 'PASS', `every model-calling step reports input>0,output>0,total_cost_usd>0: ${detail}; local (exempt, no model call): ${localDetail || 'none run'}`);
} else {
  cap(
    'usage_reporting',
    'FAIL',
    `zero/missing usage on model-calling step(s) [${zeroOrMissing.join(',')}]: ${detail}; local (exempt, no model call): ${localDetail || 'none run'}`,
  );
}

// ---------- evidence.json: trimmed, redacted, commit-able extract that backs every PASS above ----------
// Per-step: the init summary (system/init, trimmed to the fields the gates actually key on), the
// canUseTool call/return (step e), the PreToolUse hook input/output (steps f, g), and the per-step
// usage line — i.e. exactly the frames a reviewer needs to check each CAP line without opening the
// full (gitignored, ~350 KB raw) claude.raw.json.
function trimInit(m: Record<string, unknown>): unknown {
  const sc = (m.slash_commands as string[] | undefined) ?? [];
  const tools = (m.tools as string[] | undefined) ?? [];
  const skills = (m.skills as string[] | undefined) ?? [];
  const plugins = (m.plugins as Array<{ name: string; version?: string }> | undefined) ?? [];
  const pluginQualified = sc.filter((c) => c.includes(':'));
  return {
    model: m.model,
    claude_code_version: m.claude_code_version,
    apiKeySource: m.apiKeySource,
    permissionMode: m.permissionMode,
    output_style: m.output_style,
    capabilities: m.capabilities ?? null,
    mcp_servers: ((m.mcp_servers as Array<{ name: string; status: string }> | undefined) ?? []).map((s) => ({ name: s.name, status: s.status })),
    slash_commands: { count: sc.length, sample: sc.slice(0, 15), hasCockpitPilot: sc.includes('cockpit:pilot') },
    plugin_commands: { count: pluginQualified.length, sample: pluginQualified.slice(0, 10) },
    tools: { count: tools.length, hasAskUserQuestion: tools.includes('AskUserQuestion'), hasTask: tools.includes('Task'), hasAgent: tools.includes('Agent') },
    skills: { count: skills.length },
    plugins: plugins.map((p) => ({ name: p.name, version: p.version })),
  };
}

function buildEvidence(): unknown {
  const initEntry = log.find(
    (e) =>
      e.kind === 'msg' &&
      !!e.data &&
      typeof e.data === 'object' &&
      (e.data as { type?: string }).type === 'system' &&
      (e.data as { subtype?: string }).subtype === 'init',
  );
  const canUseToolCalls = log.filter((e) => e.kind === 'canUseTool').map((e) => ({ step: e.step, data: e.data }));
  const canUseToolResponses = log.filter((e) => e.kind === 'canUseTool_response').map((e) => ({ step: e.step, data: e.data }));
  const hookIO = log
    .filter((e) => e.kind === 'hook_PreToolUse' || e.kind === 'hook_PreToolUse_response')
    .map((e) => ({ step: e.step, kind: e.kind, data: e.data }));
  return {
    generatedAt: new Date().toISOString(),
    note:
      'Trimmed, redacted evidence for the Phase 1 Claude SDK spike gates (docs/spikes/claude-sdk-shapes.md, ' +
      'packages/engine/scripts/spike-claude.ts). Not the full raw stream — see claude.raw.json (gitignored, ' +
      'much larger) for that. Emails/organizations are redacted the same way as the raw log (see redact() below).',
    caps,
    init: initEntry ? trimInit(initEntry.data as Record<string, unknown>) : null,
    canUseTool: { calls: canUseToolCalls, responses: canUseToolResponses },
    hooks: hookIO,
    usage,
  };
}

try {
  const evidence = redact(buildEvidence());
  const json = JSON.stringify(evidence, null, 1);
  mkdirSync(dirname(EVIDENCE), { recursive: true });
  writeFileSync(EVIDENCE, json, 'utf8');
  console.log(`EVIDENCE ${EVIDENCE} (${(Buffer.byteLength(json) / 1024).toFixed(1)} KB)`);
} catch (e) {
  console.error(`evidence.json write failed: ${e instanceof Error ? e.message : String(e)}`);
}

rec('summary', 'caps', caps);
rec('summary', 'usage', usage);
flush();
console.log(`RAW ${RAW} (${log.length} entries)`);
process.exit(0);
