/**
 * capygen Phase 1 spike — Claude Agent SDK capability proof (headless, signed-in Claude Code).
 *
 * Runs one query() per capability against cwd = repo root and logs every SDKMessage to
 * docs/spikes/claude.raw.json (gitignored). Prints one "CAP <name> PASS|PARTIAL|FAIL - <evidence>"
 * line per capability. Always exits 0.
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

const CWD = 'C:/Users/TugaPlayz/Desktop/GITHUB/capygen';
const RAW = `${CWD}/docs/spikes/claude.raw.json`;
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

const wanted = new Set((process.env.SPIKE_STEPS ?? 'a,b,c,d,e,f').split(','));
const usage: Record<string, string> = {};

// ---------- a) ping ----------
if (wanted.has('a')) {
  const r = await run({ step: 'a', prompt: 'Reply with exactly the word pong.', maxTurns: 2, includePartialMessages: true });
  usage.a = usageLine(r);
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
  usage.b = usageLine(r);
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
  usage.c = usageLine(r);
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
  const r = await run({ step: 'd', prompt, maxTurns: 6 });
  usage.d = usageLine(r);
  const assistantTexts = r.messages
    .filter((m): m is Extract<SDKMessage, { type: 'assistant' }> => m.type === 'assistant' && !m.parent_tool_use_id)
    .flatMap((m) => m.message.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text));
  const allText = [...assistantTexts, r.finalText].join('\n');
  const toolsUsed = r.messages
    .filter((m): m is Extract<SDKMessage, { type: 'assistant' }> => m.type === 'assistant')
    .flatMap((m) => m.message.content.filter((b) => b.type === 'tool_use').map((b) => (b as { name: string }).name));
  const expanded = r.messages.some((m) => m.type === 'user' && JSON.stringify(m.message.content).includes('<command-name>'));
  const hit = /phase|plan/i.test(allText);
  const ev = `cmd=${prompt} expanded(<command-name> in user msg)=${expanded} tools=[${toolsUsed.join(',')}] result.subtype=${r.result?.subtype} text=${JSON.stringify(allText.slice(0, 220))}`;
  if (hit && (expanded || toolsUsed.length > 0)) cap('plugin_command', 'PASS', ev);
  else if (hit || expanded) cap('plugin_command', 'PARTIAL', ev);
  else cap('plugin_command', 'FAIL', `${failReason(r)} ${ev}`);
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
  usage.e = usageLine(r);
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
    return {};
  };
  const r = await run({
    step: 'f',
    prompt: 'Use the Task tool to spawn a subagent that counts the .md files in this directory and report the number.',
    maxTurns: 6,
    hooks: { PreToolUse: [{ matcher: 'Task|Agent', hooks: [hook] }] },
    includeHookEvents: true,
  });
  usage.f = usageLine(r);
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

// ---------- g) usage ----------
for (const [k, v] of Object.entries(usage)) console.log(`USAGE ${k}: ${v}`);
cap('usage_reporting', Object.values(usage).some((u) => /total_cost_usd=\d/.test(u)) ? 'PASS' : 'FAIL', Object.values(usage).some((u) => /total_cost_usd=\d/.test(u)) ? `result.usage + result.modelUsage + total_cost_usd present on ${Object.keys(usage).join(',')}` : 'no result messages carried usage');

rec('summary', 'caps', caps);
rec('summary', 'usage', usage);
flush();
console.log(`RAW ${RAW} (${log.length} entries)`);
process.exit(0);
