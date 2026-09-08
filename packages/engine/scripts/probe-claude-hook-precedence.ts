/**
 * Native precedence probe for the matcher-less `PreToolUse` hook (ADR-0007).
 *
 *   corepack pnpm --dir packages/engine probe:claude-hook-precedence
 *
 * The question ADR-0007 leaves open, and which fixtures cannot answer: when the
 * user's own Claude configuration says `allow` — or the session runs under
 * `bypassPermissions` — does a hook denial still stop the tool? And in the other
 * direction, does a *neutral* hook (capygen's local allow) leave a native
 * `deny` intact rather than widening it?
 *
 * Answered against the **real pinned CLI** (`claude.exe`, bundled with
 * `@anthropic-ai/claude-agent-sdk` 0.3.261), with no remote model and no
 * credential: `ANTHROPIC_BASE_URL` points at a loopback Anthropic-compatible
 * Messages endpoint on `127.0.0.1` that serves a deterministic `tool_use`
 * followed by a final text block — the same principle as the Codex Responses
 * fixture in `probe-codex-dynamic-tools.ts`. `ANTHROPIC_API_KEY` is a dummy the
 * fixture ignores.
 *
 * The observable is a **sentinel file**. The scripted turn asks for the native
 * `Write` tool against a path inside the throwaway workspace; whether that file
 * exists afterwards is the ground truth about who won, independent of anything
 * capygen reports about itself.
 *
 * Isolation: throwaway `CLAUDE_CONFIG_DIR`, `HOME`/`USERPROFILE` and cwd, all
 * refused if they overlap the personal ones. No personal config is read, no
 * credential is copied, and every request the CLI makes is logged so an
 * unexpected outbound host is visible rather than assumed absent.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClaudeHarness } from "../src/claude/ClaudeHarness.js";
import type { EngineEvent } from "../src/harness.js";
import type { LocalAuthorize } from "../src/policy/types.js";
import { canonicalizePath, isPathInside } from "./test-policy.js";

/** The one model any request may name. Never reached: the fixture answers. */
const NOMINAL_MODEL = "claude-sonnet-5";
const SENTINEL = "policy-sentinel.txt";
/** The native tool the scripted turn calls; its execution is the observable. */
const TOOL = "Write";
/** Distinguishes the real agent turn from the CLI's small auxiliary call. */
const MAIN_TURN_MIN_BYTES = 20_000;
/** Ceiling on one scripted turn, so a wedged CLI cannot hang the probe. */
const TURN_DEADLINE_MS = 90_000;

type Verdict = "proven" | "refuted" | "undecided";

interface CaseResult {
  name: string;
  question: string;
  verdict: Verdict;
  detail: string;
  evidence?: unknown;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sse(res: ServerResponse, events: { event: string; data: unknown }[]): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const entry of events) {
    res.write(`event: ${entry.event}\ndata: ${JSON.stringify(entry.data)}\n\n`);
  }
  res.end();
}

interface Loopback {
  port: number;
  /** Every request the CLI made: path plus the model it asked for. */
  seen: {
    advertisesTool: boolean;
    url: string;
    model: string | null;
    carriesPrompt: boolean;
    bytes: number;
    encoding: string;
    served: boolean;
  }[];
  /** Reset per case; the scripted turn serves the tool call exactly once. */
  reset(toolInput: Record<string, unknown>, marker: string, tool: string): void;
  /** Metadata about the advertised tool surface, for the report. */
  probe(): { toolNames: string[]; beta: string; version: string; toolChoice: string };
  close(): Promise<void>;
}

async function startLoopback(): Promise<Loopback> {
  const seen: Loopback["seen"] = [];
  // Keyed on the probe's own prompt marker rather than "the first request":
  // the CLI makes unrelated pre-flight calls, and serving the tool_use to one
  // of those means the scripted turn never sees a tool at all.
  const state = {
    served: 0,
    toolInput: {} as Record<string, unknown>,
    marker: "",
    tool: TOOL,
    // Metadata only: tool *names*, the negotiated beta/version headers and the
    // tool_choice shape. The raw bodies are never retained — they carry the
    // CLI's whole system prompt and the throwaway home's paths.
    probe: { toolNames: [] as string[], beta: "none", version: "none", toolChoice: "null" },
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let parsed: { model?: string } | null = null;
      try {
        parsed = JSON.parse(body) as { model?: string };
      } catch {
        parsed = null;
      }
      const carriesPrompt = state.marker.length > 0 && body.includes(state.marker);
      if (carriesPrompt && state.probe.toolNames.length === 0) {
        const request = parsed as { tools?: { name?: string; type?: string }[]; tool_choice?: unknown } | null;
        state.probe.toolNames = (request?.tools ?? [])
          .map((tool) => tool?.name ?? `<${tool?.type ?? "?"}>`)
          .filter((name): name is string => typeof name === "string");
        state.probe.beta = String(req.headers["anthropic-beta"] ?? "none");
        state.probe.version = String(req.headers["anthropic-version"] ?? "none");
        state.probe.toolChoice = JSON.stringify(request?.tool_choice ?? null);
      }
      seen.push({
        advertisesTool:
          body.includes(`"name":"${state.tool}"`) || body.includes(`"name": "${state.tool}"`),
        url: req.url ?? "",
        model: parsed?.model ?? null,
        carriesPrompt,
        bytes: body.length,
        encoding: String(req.headers["content-encoding"] ?? "none"),
        served: false,
      });

      if (!req.url?.includes("/v1/messages") || req.url.includes("count_tokens")) {
        res.writeHead(404, { "content-type": "application/json" }).end("{}");
        return;
      }
      /**
       * The CLI makes a small auxiliary call that also carries the user's text
       * (4 KB, no tool schemas) before the real agent turn (~115 KB, the full
       * tool surface). Serving the scripted `tool_use` to the auxiliary one
       * means the actual turn never sees a tool — which is exactly how the
       * first version of this probe produced four meaningless results.
       *
       * So the gate is the tool surface itself: only a request that actually
       * advertises the tool can be answered with a call to it.
       */
      const advertisesTool =
        body.includes(`"name":"${state.tool}"`) || body.includes(`"name": "${state.tool}"`);
      /**
       * A *denied* tool is not advertised at all — the CLI strips it from the
       * tool surface — so `advertisesTool` can never match in that case. The
       * main agent turn is identified by its size instead (~115 KB of system
       * prompt and schemas, against ~4 KB for the auxiliary call).
       */
      const isAgentTurn = advertisesTool || body.length > MAIN_TURN_MIN_BYTES;
      const first = carriesPrompt && isAgentTurn && state.served === 0;
      if (first) {
        state.served += 1;
        const last = seen[seen.length - 1];
        if (last) last.served = true;
      }
      const block = first
        ? { type: "tool_use", id: "toolu_probe", name: state.tool, input: {} }
        : { type: "text", text: "done" };
      const events: { event: string; data: unknown }[] = [
        {
          event: "message_start",
          data: {
            type: "message_start",
            message: {
              id: `msg_${seen.length}`,
              type: "message",
              role: "assistant",
              model: NOMINAL_MODEL,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 8, output_tokens: 1 },
            },
          },
        },
        { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: block } },
      ];
      if (first) {
        events.push({
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(state.toolInput) },
          },
        });
      } else {
        events.push({
          event: "content_block_delta",
          data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
        });
      }
      events.push(
        { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
        {
          event: "message_delta",
          data: {
            type: "message_delta",
            delta: { stop_reason: first ? "tool_use" : "end_turn", stop_sequence: null },
            usage: { output_tokens: 4 },
          },
        },
        { event: "message_stop", data: { type: "message_stop" } },
      );
      sse(res, events);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as { port: number }).port,
    seen,
    probe: () => ({ ...state.probe, toolNames: [...state.probe.toolNames] }),
    reset(toolInput, marker, tool) {
      state.probe = { toolNames: [], beta: "none", version: "none", toolChoice: "null" };
      state.served = 0;
      state.toolInput = toolInput;
      state.marker = marker;
      state.tool = tool;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * The only variables inherited from this process.
 *
 * [review] `cleanEnv(process.env)` copied the whole environment, which on a
 * developer machine carries provider keys, `HTTPS_PROXY`, `CODEX_HOME`, cloud
 * selectors (`CLAUDE_CODE_USE_BEDROCK`, `AWS_*`, `GOOGLE_*`) and anything else
 * that happens to be set — none of which belongs in a probe that claims to run
 * with no credential. An allowlist inverts the default: a variable reaches the
 * child only if Windows genuinely needs it to start a process.
 */
const INHERITED_ENV = [
  "SystemRoot",
  "SystemDrive",
  "windir",
  "COMSPEC",
  "PATH",
  "PATHEXT",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
] as const;

function makeHomes(): {
  root: string;
  configDir: string;
  cwd: string;
  env: Record<string, string | undefined>;
} {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "capygen-hook-probe-")));
  const configDir = path.join(root, "claude-home");
  const fakeHome = path.join(root, "home");
  const cwd = path.join(root, "workspace");
  const scratch = path.join(root, "scratch");
  for (const dir of [configDir, fakeHome, cwd, scratch]) mkdirSync(dir, { recursive: true });

  const personal = [".claude", ".codex"].map((name) =>
    canonicalizePath(path.join(process.env.USERPROFILE ?? process.env.HOME ?? root, name)),
  );
  for (const candidate of [configDir, fakeHome, cwd].map(canonicalizePath)) {
    if (personal.some((home) => isPathInside(home, candidate) || isPathInside(candidate, home))) {
      throw new Error(`[probe] refusing ${candidate}: it overlaps a personal config home`);
    }
  }

  const env: Record<string, string | undefined> = {};
  for (const name of INHERITED_ENV) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  // Every home and scratch path points inside the throwaway root, so nothing
  // the child writes can land in a personal profile.
  env.CLAUDE_CONFIG_DIR = configDir;
  env.HOME = fakeHome;
  env.USERPROFILE = fakeHome;
  env.APPDATA = path.join(fakeHome, "AppData", "Roaming");
  env.LOCALAPPDATA = path.join(fakeHome, "AppData", "Local");
  env.XDG_CONFIG_HOME = path.join(fakeHome, ".config");
  env.TEMP = scratch;
  env.TMP = scratch;
  // A dummy the loopback fixture never checks; there is no real credential here.
  env.ANTHROPIC_API_KEY = "capygen-loopback-not-a-real-key";
  // Supported by the pinned CLI (verified against its own strings): no
  // auto-update, telemetry, error reporting or other non-essential traffic, so
  // the only thing it should have reason to talk to is the loopback endpoint.
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.DISABLE_AUTOUPDATER = "1";
  env.DISABLE_TELEMETRY = "1";
  env.DISABLE_ERROR_REPORTING = "1";
  env.DISABLE_BUG_COMMAND = "1";
  // Belt and braces: an inherited proxy is impossible under the allowlist, and
  // these make that explicit for anyone reading the report.
  env.NO_PROXY = "*";
  env.no_proxy = "*";
  return { root, configDir, cwd, env };
}

async function removeQuietly(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

type Observable =
  /** Did the native tool actually run? */
  | { kind: "sentinel"; expectBlocked: boolean }
  /** Did a sub-agent turn actually reach the routed model? */
  | { kind: "routed-model"; model: string; expectReached: boolean };

interface CaseSpec {
  name: string;
  question: string;
  /** Written into the owned CLAUDE_CONFIG_DIR's settings.json. */
  permissions: Record<string, string[]>;
  permissionMode: "default" | "bypassPermissions";
  authorize: LocalAuthorize;
  observable: Observable;
  why: string;
  /** Overrides the scripted tool; defaults to `Write`. */
  tool?: string;
  toolInput?: (sentinel: string) => Record<string, unknown>;
  /** Rewrites the model on a spawn, exactly as the routing branch does. */
  route?: string;
  /** Whether the routed hook answers `allow` (today) or stays neutral. */
  routeDecision?: "allow" | "neutral";
}

async function runCase(
  spec: CaseSpec,
  homes: ReturnType<typeof makeHomes>,
  loopback: Loopback,
): Promise<CaseResult> {
  const sentinel = path.join(homes.cwd, `${spec.name}-${SENTINEL}`);
  if (existsSync(sentinel)) rmSync(sentinel);
  writeFileSync(
    path.join(homes.configDir, "settings.json"),
    JSON.stringify({ permissions: spec.permissions }, null, 2),
    "utf8",
  );
  const marker = `capygen-probe-${spec.name}`;
  loopback.reset(
    spec.toolInput
      ? spec.toolInput(sentinel)
      : { file_path: sentinel, content: "written by the probe\n" },
    marker,
    spec.tool ?? TOOL,
  );
  const before = loopback.seen.length;

  const harness = new ClaudeHarness({
    env: { ...homes.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${loopback.port}` },
    settingSources: ["user"],
    authorizeLocal: spec.authorize,
    ...(spec.route
      ? {
          routeSubagent: () => ({ backend: "claude" as const, model: spec.route! }),
          // The whole question: does the routed model survive a *neutral*
          // hook, or does it need the unconditional native `allow` the code
          // returns today?
          routingPermissionDecision: spec.routeDecision ?? "allow",
        }
      : {}),
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  const events: EngineEvent[] = [];
  let cards = 0;
  const blocks: string[] = [];
  const said: string[] = [];
  try {
    await harness.start(
      { sessionId: "probe", projectPath: homes.cwd },
      {
        agentId: "probe",
        name: "probe",
        backend: "claude",
        model: NOMINAL_MODEL,
        permissionMode: spec.permissionMode,
        resumeSessionId: null,
        config: null,
      } as never,
    );
    const turn = (async () => {
      for await (const event of harness.send({ turnId: "t1", text: `write the sentinel ${marker}` })) {
        events.push(event);
        // Cards are *allowed*, and counted. A card means the native gate asked
        // rather than deciding, which is itself evidence — and denying them
        // would make every case "blocked" for a reason unrelated to the hook.
        if (event.type === "permission") {
          cards += 1;
          harness.answerPermission(event.requestId, { behavior: "allow" });
        }
        if (event.type === "block") {
          blocks.push(`${event.patch.kind}`);
          if (event.patch.kind === "text") said.push(event.patch.text);
        }
        if (event.type === "turn") blocks.push(`turn:${event.status}${event.error ? `:${event.error}` : ""}`);
      }
    })();
    // Cleared as soon as the turn settles: an un-cleared 90s timer kept the
    // process alive long after every result had been written.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      turn.finally(() => {
        if (deadline) clearTimeout(deadline);
      }),
      new Promise((resolve) => {
        deadline = setTimeout(resolve, TURN_DEADLINE_MS);
        deadline.unref?.();
      }),
    ]);
  } catch (err) {
    return { name: spec.name, question: spec.question, verdict: "undecided", detail: describe(err) };
  } finally {
    await harness.dispose().catch(() => undefined);
  }

  const requests = loopback.seen.slice(before);
  if (requests.length === 0) {
    return {
      name: spec.name,
      question: spec.question,
      verdict: "undecided",
      detail: "the CLI never reached the loopback endpoint, so nothing was exercised",
      evidence: { events: events.length },
    };
  }
  /**
   * The control that makes the other cases mean anything.
   *
   * "The sentinel is absent" is only evidence of a *block* if the tool could
   * have run at all. Without a `tool_call` in the stream the turn never reached
   * a tool, so every case would read as "blocked" for a reason that has nothing
   * to do with hooks — which is exactly the false proof this guard exists to
   * refuse.
   */
  // Served to a request that actually advertised the tool — i.e. the real agent
  // turn, not the CLI's small auxiliary call.
  const servedToAgentTurn = requests.some(
    (r) => r.served && (r.advertisesTool || r.bytes > MAIN_TURN_MIN_BYTES),
  );
  if (!servedToAgentTurn) {
    return {
      name: spec.name,
      question: spec.question,
      verdict: "undecided",
      detail:
        "the fixture never delivered a tool_use to a tool-advertising agent turn, so nothing " +
        "about hook precedence was exercised",
      evidence: {
        requests: requests.length,
        promptRequests: requests.filter((r) => r.carriesPrompt).length,
        stream: blocks,
        assistantText: said.slice(-2),
        advertised: loopback.probe(),
        requestDetail: requests,
      },
    };
  }
  const modelsSeen = [...new Set(requests.map((r) => r.model))];
  if (spec.observable.kind === "routed-model") {
    // Matched as a substring: the CLI resolves an alias like `haiku` to a
    // dated id (`claude-haiku-4-5-…`), which is the spike's own observation.
    const needle = spec.observable.model;
    const reached = modelsSeen.some((model) => typeof model === "string" && model.includes(needle));
    const expected = spec.observable.expectReached;
    return {
      name: spec.name,
      question: spec.question,
      verdict: reached === expected ? "proven" : "refuted",
      detail:
        `${spec.why}: a turn ${reached ? "ran" : "never ran"} on ${needle}` +
        (reached === expected ? "" : " — the opposite of what this case requires"),
      evidence: { requests: requests.length, modelsSeen, stream: blocks, assistantText: said.slice(-2) },
    };
  }
  const expectBlocked = spec.observable.expectBlocked;
  const ran = existsSync(sentinel);
  const evidence = {
    requests: requests.length,
    promptRequests: requests.filter((r) => r.carriesPrompt).length,
    modelsSeen,
    sentinelWritten: ran,
    permissionCards: cards,
    stream: blocks,
    requestDetail: requests,
  };
  if (ran === expectBlocked) {
    return {
      name: spec.name,
      question: spec.question,
      verdict: "refuted",
      detail: ran
        ? `the tool executed despite ${spec.why}`
        : `the tool did not execute although ${spec.why} should have permitted it`,
      evidence,
    };
  }
  return { name: spec.name, question: spec.question, verdict: "proven", detail: spec.why, evidence };
}

const allow: LocalAuthorize = (request) => ({ allowed: true, approvedInput: request.input });
const deny: LocalAuthorize = () => ({ allowed: false, message: "refused by the probe's local policy" });

async function main(): Promise<void> {
  const homes = makeHomes();
  const loopback = await startLoopback();
  const results: CaseResult[] = [];
  try {
    const cases: CaseSpec[] = [
      {
        name: "control-neutral-under-native-allow",
        question: "does a neutral hook still let a natively allowed tool run?",
        permissions: { allow: [TOOL], deny: [], ask: [] },
        permissionMode: "default",
        authorize: allow,
        observable: { kind: "sentinel", expectBlocked: false },
        why: "a native allow rule with a neutral hook",
      },
      {
        name: "deny-under-native-allow",
        question: "does a hook denial hold when the user's own settings allow the tool?",
        permissions: { allow: [TOOL], deny: [], ask: [] },
        permissionMode: "default",
        authorize: deny,
        observable: { kind: "sentinel", expectBlocked: true },
        why: "a native allow rule",
      },
      {
        name: "deny-under-bypass",
        question: "does a hook denial hold under bypassPermissions?",
        permissions: { allow: [], deny: [], ask: [] },
        permissionMode: "bypassPermissions",
        authorize: deny,
        observable: { kind: "sentinel", expectBlocked: true },
        why: "bypassPermissions",
      },
      {
        name: "neutral-under-native-deny",
        question: "does a neutral hook leave a native deny intact instead of widening it?",
        permissions: { allow: [], deny: [TOOL], ask: [] },
        permissionMode: "default",
        authorize: allow,
        observable: { kind: "sentinel", expectBlocked: true },
        why: "a native deny rule with a neutral (locally allowed) hook",
      },
      {
        name: "routing-with-allow",
        question: "does the routed model apply with today's unconditional allow?",
        permissions: { allow: ["Agent"], deny: [], ask: [] },
        permissionMode: "default",
        authorize: allow,
        tool: "Agent",
        toolInput: () => ({
          description: "probe",
          prompt: "reply with ok",
          subagent_type: "general-purpose",
        }),
        // The alias form the Phase 1 spike proved, not a full id.
        route: "haiku",
        routeDecision: "allow",
        observable: { kind: "routed-model", model: "haiku", expectReached: true },
        why: "routing with permissionDecision allow",
      },
      {
        name: "routing-neutral",
        question: "does the routed model survive a neutral hook decision?",
        permissions: { allow: ["Agent"], deny: [], ask: [] },
        permissionMode: "default",
        authorize: allow,
        tool: "Agent",
        toolInput: () => ({
          description: "probe",
          prompt: "reply with ok",
          subagent_type: "general-purpose",
        }),
        route: "haiku",
        routeDecision: "neutral",
        observable: { kind: "routed-model", model: "haiku", expectReached: true },
        why: "routing with a neutral hook decision",
      },
      {
        name: "routing-neutral-under-native-deny",
        question: "does a native deny stop a routed spawn when the hook is neutral?",
        permissions: { allow: [], deny: ["Agent"], ask: [] },
        permissionMode: "default",
        authorize: allow,
        tool: "Agent",
        toolInput: () => ({
          description: "probe",
          prompt: "reply with ok",
          subagent_type: "general-purpose",
        }),
        route: "haiku",
        routeDecision: "neutral",
        observable: { kind: "routed-model", model: "haiku", expectReached: false },
        why: "a native deny on the spawn with a neutral hook",
      },
      {
        name: "routing-allow-under-native-deny",
        question: "does today's unconditional allow widen a native deny on the spawn?",
        permissions: { allow: [], deny: ["Agent"], ask: [] },
        permissionMode: "default",
        authorize: allow,
        tool: "Agent",
        toolInput: () => ({
          description: "probe",
          prompt: "reply with ok",
          subagent_type: "general-purpose",
        }),
        route: "haiku",
        routeDecision: "allow",
        // Recorded as a *finding*, not a requirement: if the spawn runs here,
        // the unconditional allow overrode the user's own deny rule.
        observable: { kind: "routed-model", model: "haiku", expectReached: false },
        why: "a native deny on the spawn with today's unconditional allow",
      },
    ];
    for (const spec of cases) results.push(await runCase(spec, homes, loopback));
  } finally {
    await loopback.close();
    await removeQuietly(homes.root);
  }


  const report = {
    probe: "claude-hook-precedence",
    binary: "@anthropic-ai/claude-agent-sdk 0.3.261 bundled claude.exe",
    usedRemoteModel: false,
    usedCredentials: false,
    nominalModel: NOMINAL_MODEL,
    modelsRequested: [...new Set(loopback.seen.map((r) => r.model).filter(Boolean))],
    pathsRequested: [...new Set(loopback.seen.map((r) => r.url))],
    /**
     * What this probe can and cannot say about network traffic.
     *
     * [review] The previous `offHostRequests` counted requests whose path did
     * not start with `/` — which is never true of a request a server has
     * already received, so it was structurally zero and observed nothing. The
     * probe sees only what reached the loopback endpoint; it does not watch the
     * child's sockets. What *does* constrain the child is the environment: an
     * allowlist with no proxy and no credential, plus the CLI's own
     * non-essential-traffic switches.
     */
    networkObservation:
      "requests received by the loopback endpoint only; the child's sockets are not observed",
    note:
      "Every model request was answered by a loopback Anthropic-compatible Messages endpoint on " +
      "127.0.0.1 in a throwaway CLAUDE_CONFIG_DIR. The child inherits an explicit Windows " +
      "environment allowlist — no provider key, proxy, cloud selector or personal backend " +
      "home — plus a dummy API key and the CLI's non-essential-traffic switches. The " +
      "observable is a sentinel file on disk, not a capygen self-report.",
    cases: results,
  };
  /**
   * The neutral routing case means nothing unless its control — the same spawn
   * with today's unconditional `allow` — actually reached the routed model. If
   * the fixture cannot elicit a sub-agent spawn at all, both are undecided, not
   * evidence against neutral.
   */
  const control = results.find((r) => r.name === "routing-with-allow");
  if (control && control.verdict !== "proven") {
    for (const result of results) {
      if (!result.name.startsWith("routing")) continue;
      result.verdict = "undecided";
      result.detail =
        "the fixture never got a sub-agent spawn to run, so neither the current allow lever " +
        "nor a neutral decision was exercised";
    }
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  for (const result of results) {
    process.stderr.write(`[${result.verdict.toUpperCase()}] ${result.name}: ${result.detail}\n`);
  }
  if (results.some((r) => r.verdict !== "proven")) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`[probe] failed: ${describe(err)}\n`);
  process.exitCode = 1;
});
