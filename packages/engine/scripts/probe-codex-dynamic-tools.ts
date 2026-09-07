/**
 * Capability probe for Codex client-hosted (`dynamic`) tools.
 *
 *   corepack pnpm --dir packages/engine probe:codex-dynamic-tools
 *
 * Two parts, against the **bundled pinned binary**, with no paid model:
 *
 *   A. *Schema acceptance* — does `thread/start` accept `dynamicTools`, and is
 *      the field gated behind the `experimentalApi` capability? These are local
 *      operations: no prompt is sent and no model runs.
 *
 *   B. *Behaviour* — a **loopback Responses provider** on `127.0.0.1`, declared
 *      in the throwaway `CODEX_HOME`'s own `config.toml`, serves the turns. The
 *      real binary therefore runs a real turn without any remote API, any
 *      credential, or any spend, and the probe can observe what it actually
 *      does: whether the declared tool reaches the model request, whether a
 *      tool call comes back as `item/tool/call`, and whether either survives a
 *      resume in a fresh app-server process.
 *
 * What part B does **not** establish: that a *real* model chooses to call the
 * tool. The loopback provider decides that, not a model. Tool routing is proven;
 * model behaviour is not, and no claim here depends on it.
 *
 * Isolation, per CLAUDE.md: the child is spawned with a throwaway `CODEX_HOME`,
 * `HOME`/`USERPROFILE` and cwd created under the OS temp directory for this run
 * and deleted afterwards. Nothing is read from or written to `~/.codex`, no
 * credential is copied, and the probe refuses to run if the homes it built
 * resolve anywhere near the personal ones. An unauthenticated home is fine:
 * `thread/start` is a local operation.
 *
 * Output is one JSON report on stdout plus a human summary on stderr. Exit code
 * is 0 when every case produced a definite accepted/rejected verdict, 1 when a
 * case could not be decided (which is a blocker to record, not a pass).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodexAppServerClient } from "../src/codex/CodexAppServerClient.js";
import { CODEX_METHODS } from "../src/codex/protocol.js";
import { resolveCodexBinary } from "../src/codex/binary.js";
import { cleanEnv } from "../src/env.js";
import { canonicalizePath, isPathInside } from "./test-policy.js";

const TOOL_SPEC = {
  type: "function" as const,
  name: "delegate_task",
  description: "Run one task on another model through capygen and return its answer.",
  inputSchema: {
    type: "object",
    properties: {
      description: { type: "string" },
      prompt: { type: "string" },
    },
    required: ["description", "prompt"],
    additionalProperties: false,
  },
};

type Verdict = "accepted" | "rejected" | "undecided";

/** Named only so the thread is configured like a real one; the loopback
 *  provider answers, so no model of this or any other name is ever reached. */
const NOMINAL_MODEL = "gpt-5.6-luna";
/** How long a loopback-served turn is given to settle before it is read. */
const TURN_SETTLE_MS = 6_000;

interface CaseResult {
  name: string;
  question: string;
  verdict: Verdict;
  detail: string;
  /** Whatever the server echoed back that is worth quoting, trimmed. */
  evidence?: unknown;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  process.stderr.write(`[probe] could not delete ${dir}; it holds no credentials and can be removed later\n`);
}

/** A throwaway CODEX_HOME / HOME / cwd that is provably not the user's. */
function makeIsolatedHomes(): {
  root: string;
  env: Record<string, string | undefined>;
  cwd: string;
  codexHome: string;
} {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "capygen-codex-probe-")));
  const codexHome = path.join(root, "codex-home");
  const fakeHome = path.join(root, "home");
  const cwd = path.join(root, "workspace");
  for (const dir of [codexHome, fakeHome, cwd]) mkdirSync(dir, { recursive: true });

  // The same guard the live scripts use, applied to homes this script minted
  // rather than to ones a caller supplied.
  const personal = [".codex", ".claude"].map((name) =>
    canonicalizePath(path.join(process.env.USERPROFILE ?? process.env.HOME ?? root, name)),
  );
  for (const candidate of [codexHome, fakeHome, cwd].map(canonicalizePath)) {
    if (personal.some((home) => isPathInside(home, candidate) || isPathInside(candidate, home))) {
      throw new Error(`[probe] refusing to use ${candidate}: it overlaps a personal config home`);
    }
  }

  const env = cleanEnv(process.env);
  env.CODEX_HOME = codexHome;
  env.HOME = fakeHome;
  env.USERPROFILE = fakeHome;
  env.XDG_CONFIG_HOME = path.join(fakeHome, ".config");
  // Never inherited into the probe child: an API key in the ambient shell would
  // be a credential this script had no business carrying.
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  return { root, env, cwd, codexHome };
}

async function runCase(
  name: string,
  question: string,
  work: () => Promise<{ verdict: Verdict; detail: string; evidence?: unknown }>,
): Promise<CaseResult> {
  try {
    const outcome = await work();
    return { name, question, ...outcome };
  } catch (err) {
    return { name, question, verdict: "undecided", detail: describe(err) };
  }
}

/** `thread/start`, reported as accepted/rejected rather than thrown. */
async function startThread(
  client: CodexAppServerClient,
  params: Record<string, unknown>,
): Promise<{ verdict: Verdict; detail: string; evidence?: unknown }> {
  try {
    const response = (await client.request(CODEX_METHODS.threadStart, params, 60_000)) as {
      thread?: { id?: string };
    };
    const threadId = response?.thread?.id;
    if (!threadId) {
      return { verdict: "undecided", detail: "thread/start answered without a thread id", evidence: response };
    }
    return { verdict: "accepted", detail: `thread ${threadId} started`, evidence: { threadId } };
  } catch (err) {
    const message = describe(err);
    // An auth failure is not a verdict about the *field*; say so instead of
    // scoring it as a rejection of `dynamicTools`.
    if (/unauthor|login|sign in|401/i.test(message)) {
      return { verdict: "undecided", detail: `not a schema verdict — authentication: ${message}` };
    }
    return { verdict: "rejected", detail: message };
  }
}


// ---------------------------------------------------------------------------
// Part B: a loopback Responses provider
// ---------------------------------------------------------------------------

/**
 * The smallest HTTP server the pinned binary will talk to as a model provider:
 * it answers `POST …/responses` with a Responses-API SSE stream, and records
 * every request body so the probe can see what the binary actually asked for.
 *
 * It binds `127.0.0.1` on an ephemeral port and is declared only inside the
 * throwaway `CODEX_HOME`. No traffic leaves the machine and no credential is
 * involved — `env_key` points at a dummy variable this script sets itself.
 */
interface Loopback {
  port: number;
  requests: { body: unknown }[];
  /** What the next turn's response should be. */
  next: "call-tool" | "text";
  close(): Promise<void>;
}

function sseEvents(res: ServerResponse, events: object[]): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const event of events) {
    res.write(`event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
}

async function startLoopback(): Promise<Loopback> {
  const requests: { body: unknown }[] = [];
  const state = { next: "call-tool" as "call-tool" | "text" };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (!req.url?.includes("responses")) {
        res.writeHead(404).end("{}");
        return;
      }
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }
      requests.push({ body: parsed });
      const id = `resp_${requests.length}`;
      const item =
        state.next === "call-tool"
          ? {
              type: "function_call",
              id: `fc_${requests.length}`,
              call_id: `call_${requests.length}`,
              name: TOOL_SPEC.name,
              arguments: JSON.stringify({ description: "probe", prompt: "probe" }),
            }
          : {
              type: "message",
              id: `msg_${requests.length}`,
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "done" }],
            };
      // One tool call per turn: the follow-up request carrying the tool result
      // must settle, or the turn never completes.
      state.next = "text";
      sseEvents(res, [
        { type: "response.created", response: { id, status: "in_progress" } },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id,
            status: "completed",
            output: [item],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ]);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    requests,
    get next() {
      return state.next;
    },
    set next(value: "call-tool" | "text") {
      state.next = value;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Codex renders a dynamic tool into the prompt as a TS declaration; this is
 *  the marker that says the tool was *declared to the model*, as opposed to
 *  merely mentioned by replayed history. */
function declaresTool(body: unknown): boolean {
  return JSON.stringify(body ?? {}).includes(`declare const tools: { ${TOOL_SPEC.name}`);
}


/**
 * One thread, three legs, all served by the loopback provider:
 *
 *   1. `thread/start` with `dynamicTools` → a turn → the provider answers with a
 *      `function_call` → does `item/tool/call` reach this client?
 *   2. `thread/resume` in the **same** process → a turn → is the tool still
 *      declared to the model?
 *   3. `thread/resume` from a **new app-server process** on the same
 *      `CODEX_HOME` — capygen's restart — → a turn whose provider answer is
 *      again a `function_call` → does the call still reach the client?
 *
 * Leg 3 is the one that decides what the harness may do on resume.
 */
async function runLoopbackCase(homes: {
  env: Record<string, string | undefined>;
  cwd: string;
  codexHome: string;
}): Promise<CaseResult> {
  const name = "loopback-tool-call-and-resume";
  const question =
    "does the pinned binary route item/tool/call for a declared tool, and is the set restored on resume?";
  const loopback = await startLoopback();
  const calls: { leg: number; params: unknown }[] = [];
  let leg = 1;

  writeFileSync(
    path.join(homes.codexHome, "config.toml"),
    [
      `model = "${NOMINAL_MODEL}"`,
      'model_provider = "loopback"',
      "",
      "[model_providers.loopback]",
      'name = "loopback"',
      `base_url = "http://127.0.0.1:${loopback.port}/v1"`,
      'env_key = "CAPYGEN_PROBE_LOOPBACK_KEY"',
      'wire_api = "responses"',
      "requires_openai_auth = false",
      "request_max_retries = 0",
      "stream_max_retries = 0",
      "",
    ].join("\n"),
    "utf8",
  );
  const env = { ...homes.env, CAPYGEN_PROBE_LOOPBACK_KEY: "loopback-not-a-real-key" };

  const connect = (): CodexAppServerClient => {
    const client = new CodexAppServerClient({
      spawnEnv: env,
      capabilities: { experimentalApi: true, requestAttestation: false },
      clientInfo: { name: "capygen-probe", title: "capygen dynamic-tools probe", version: "0.1.0" },
      requestTimeoutMs: 60_000,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    client.serverRequestHandler = async (method, params) => {
      if (method !== "item/tool/call") throw new Error(`unhandled ${method}`);
      calls.push({ leg, params });
      return { contentItems: [{ type: "inputText", text: "probe answered" }], success: true };
    };
    return client;
  };

  const turn = async (client: CodexAppServerClient, threadId: string): Promise<void> => {
    await client.request(
      CODEX_METHODS.turnStart,
      { threadId, input: [{ type: "text", text: "probe", text_elements: [] }] },
      60_000,
    );
    await new Promise((resolve) => setTimeout(resolve, TURN_SETTLE_MS));
  };

  try {
    let threadId: string;
    const first = connect();
    try {
      await first.start();
      const started = (await first.request(CODEX_METHODS.threadStart, {
        cwd: homes.cwd,
        approvalPolicy: "never",
        sandbox: "read-only",
        approvalsReviewer: "user",
        modelProvider: "loopback",
        model: NOMINAL_MODEL,
        dynamicTools: [TOOL_SPEC],
      })) as { thread?: { id?: string } };
      threadId = started?.thread?.id ?? "";
      if (!threadId) {
        return { name, question, verdict: "undecided", detail: "thread/start returned no id" };
      }
      loopback.next = "call-tool";
      await turn(first, threadId);

      leg = 2;
      await first.request(
        CODEX_METHODS.threadResume,
        { threadId, cwd: homes.cwd, excludeTurns: true },
        60_000,
      );
      loopback.next = "text";
      await turn(first, threadId);
    } finally {
      await first.close();
    }

    leg = 3;
    const restarted = connect();
    const legThreeFrom = loopback.requests.length;
    try {
      await restarted.start();
      await restarted.request(
        CODEX_METHODS.threadResume,
        { threadId, cwd: homes.cwd, excludeTurns: true },
        60_000,
      );
      loopback.next = "call-tool";
      await turn(restarted, threadId);
    } finally {
      await restarted.close();
    }

    const declared = loopback.requests.map((r) => declaresTool(r.body));
    const legThreeDeclared = declared.slice(legThreeFrom);
    const evidence = {
      modelRequests: loopback.requests.length,
      toolDeclaredPerRequest: declared,
      toolCallsByLeg: calls.map((c) => ({ leg: c.leg, params: c.params })),
    };
    const calledOnStart = calls.some((c) => c.leg === 1);
    const calledAfterRestart = calls.some((c) => c.leg === 3);
    const declaredAfterRestart = legThreeDeclared.some(Boolean);

    if (!calledOnStart) {
      return {
        name,
        question,
        verdict: "undecided",
        detail: "the binary never routed item/tool/call on the freshly started thread",
        evidence,
      };
    }
    if (calledAfterRestart && declaredAfterRestart) {
      return {
        name,
        question,
        verdict: "accepted",
        detail:
          "the pinned binary routes item/tool/call for a tool declared on thread/start, AND a " +
          "resume in a new app-server process still declares that tool to the model and still " +
          "routes its calls. The set declared at thread/start is persisted and restored; a " +
          "resume cannot change it (ThreadResumeParams has no dynamicTools field).",
        evidence,
      };
    }
    return {
      name,
      question,
      verdict: "rejected",
      detail:
        "the binary routes item/tool/call on a freshly started thread, but the tool did not " +
        "survive a resume in a new app-server process: treat a resumed thread as having no " +
        "client-hosted tools.",
      evidence,
    };
  } catch (err) {
    return { name, question, verdict: "undecided", detail: describe(err) };
  } finally {
    await loopback.close();
  }
}

async function main(): Promise<void> {
  const binary = resolveCodexBinary({});
  const homes = makeIsolatedHomes();
  const results: CaseResult[] = [];

  const open = (capabilities: { experimentalApi: boolean; requestAttestation: boolean }) =>
    new CodexAppServerClient({
      spawnEnv: homes.env,
      capabilities,
      clientInfo: { name: "capygen-probe", title: "capygen dynamic-tools probe", version: "0.1.0" },
      requestTimeoutMs: 60_000,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

  try {
    // ---------------------------------------------------------------------
    // 1. control: the shape capygen already ships, with no dynamicTools.
    // ---------------------------------------------------------------------
    const control = open({ experimentalApi: true, requestAttestation: false });
    try {
      await control.start();
      results.push(
        await runCase(
          "control-no-dynamic-tools",
          "does thread/start work at all in this isolated home?",
          () =>
            startThread(control, {
              cwd: homes.cwd,
              approvalPolicy: "never",
              sandbox: "read-only",
              approvalsReviewer: "user",
            }),
        ),
      );
    } finally {
      await control.close();
    }

    // ---------------------------------------------------------------------
    // 2. dynamicTools with experimentalApi: true — capygen's own handshake.
    // ---------------------------------------------------------------------
    const experimental = open({ experimentalApi: true, requestAttestation: false });
    try {
      await experimental.start();
      results.push(
        await runCase(
          "dynamic-tools-experimental-api",
          "does thread/start accept dynamicTools when experimentalApi is declared?",
          () =>
            startThread(experimental, {
              cwd: homes.cwd,
              approvalPolicy: "never",
              sandbox: "read-only",
              approvalsReviewer: "user",
              dynamicTools: [TOOL_SPEC],
            }),
        ),
      );

      // -------------------------------------------------------------------
      // 3. resume, schema only. `ThreadResumeParams` declares no
      //    `dynamicTools`. Asked on a thread id that certainly does not exist,
      //    so no turn has to run: if the key were a field the deserialiser
      //    refuses, the two errors would differ.
      //
      //    This says **only** that the key survives deserialisation, before the
      //    rollout lookup. It says nothing about what an existing-thread resume
      //    does with it, and nothing about whether a set declared at
      //    `thread/start` is restored — case 5 answers that one with a turn.
      // -------------------------------------------------------------------
      results.push(
        await runCase(
          "resume-schema-tolerates-the-key",
          "does a dynamicTools key survive thread/resume deserialisation?",
          async () => {
            const absent = `00000000-0000-0000-0000-0000000${String(Date.now()).slice(-5)}`;
            const attempt = async (extra: Record<string, unknown>): Promise<string> => {
              try {
                await experimental.request(
                  CODEX_METHODS.threadResume,
                  { threadId: absent, cwd: homes.cwd, excludeTurns: true, ...extra },
                  60_000,
                );
                return "resolved";
              } catch (err) {
                return describe(err);
              }
            };
            const withoutKey = await attempt({});
            const withKey = await attempt({ dynamicTools: [TOOL_SPEC] });
            const evidence = { withoutKey, withKey };
            if (withKey === withoutKey) {
              return {
                verdict: "accepted" as Verdict,
                detail:
                  "identical failure with and without the key: it passes deserialisation and is " +
                  "then unused. This is a statement about parsing only — capygen never sends it.",
                evidence,
              };
            }
            if (/dynamicTools|unknown field/i.test(withKey)) {
              return {
                verdict: "rejected" as Verdict,
                detail: "thread/resume refuses the key outright",
                evidence,
              };
            }
            return {
              verdict: "undecided" as Verdict,
              detail: "the two resume attempts differed for an unrelated reason",
              evidence,
            };
          },
        ),
      );
    } finally {
      await experimental.close();
    }

    // ---------------------------------------------------------------------
    // 4. dynamicTools with experimentalApi: false — is the field gated?
    // ---------------------------------------------------------------------
    const stable = open({ experimentalApi: false, requestAttestation: false });
    try {
      await stable.start();
      results.push(
        await runCase(
          "dynamic-tools-without-experimental-api",
          "is dynamicTools gated behind the experimentalApi capability?",
          () =>
            startThread(stable, {
              cwd: homes.cwd,
              approvalPolicy: "never",
              sandbox: "read-only",
              approvalsReviewer: "user",
              dynamicTools: [TOOL_SPEC],
            }),
        ),
      );
    } finally {
      await stable.close();
    }

    // ---------------------------------------------------------------------
    // 5. behaviour, through the loopback provider: does the real binary route
    //    a call back as `item/tool/call`, and does the tool set survive a
    //    resume in a *fresh app-server process* (capygen's restart case)?
    // ---------------------------------------------------------------------
    results.push(await runLoopbackCase(homes));
  } finally {
    // Best effort, and never allowed to mask the report: Windows keeps a handle
    // on a just-exited child's temp files for a moment, and an EBUSY while
    // deleting a throwaway directory is not a probe result.
    await removeQuietly(homes.root);
  }

  const report = {
    probe: "codex-dynamic-tools",
    provesLiveToolChoice: false,
    note:
      "No remote model, API or credential was involved: cases 1-4 are local thread operations, " +
      "and case 5 runs real turns whose prompts are answered by a synthetic loopback Responses " +
      "provider on 127.0.0.1 declared only in a throwaway CODEX_HOME. Those turns do send " +
      "prompts — the loopback answers them, so the tool call is the probe's choice, not a " +
      "model's. Schema acceptance and routing are proven; model behaviour is not.",
    binary: { exe: binary.exe, source: binary.source },
    isolatedHomes: true,
    cases: results,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  for (const result of results) {
    process.stderr.write(`[${result.verdict.toUpperCase()}] ${result.name}: ${result.detail}\n`);
  }
  const undecided = results.filter((r) => r.verdict === "undecided");
  if (results.length === 0 || undecided.length > 0) {
    process.stderr.write(`\n${undecided.length} case(s) undecided — record as a blocker, not a pass.\n`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`[probe] failed: ${describe(err)}\n`);
  process.exitCode = 1;
});
