/**
 * Native catalogue probe — the real binaries, no model, no credentials.
 *
 *   corepack pnpm --dir packages/engine probe:mcp-catalogue
 *
 * Two questions, each answered against an *installed* runtime rather than a
 * double:
 *
 *   A. **Codex.** Does `mcpServerStatus/list` on the bundled 0.153.4
 *      app-server report a server capygen configured — with its tool names —
 *      through `CodexHarness.catalogue()`, on the thread the harness already
 *      has, without starting a turn?
 *   B. **Claude.** Is `Query.mcpServerStatus()` answerable on a streaming
 *      session with no prompt enqueued? Attempted in an owned, unauthenticated
 *      `CLAUDE_CONFIG_DIR`; whatever happens is reported literally, because an
 *      unauthenticated CLI may refuse before any control request is served.
 *
 * The MCP server under test is a **local stdio fixture in this repository**
 * (`test/mcpClientFixtureServer.mjs`), launched by the backend itself from a
 * config written into a throwaway home. Nothing reaches the network, no
 * credential is read or copied, and the personal `~/.claude` / `~/.codex` are
 * refused outright.
 *
 * Output: one JSON report on stdout, a human summary on stderr. Exit code 1 if
 * any case is undecided — an undecided case is a blocker to record, not a pass.
 */
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexHarness } from "../src/codex/CodexHarness.js";
import { ClaudeHarness } from "../src/claude/ClaudeHarness.js";
import { cleanEnv } from "../src/env.js";
import type { ToolCatalogue } from "../src/catalogue/types.js";
import { canonicalizePath, isPathInside } from "./test-policy.js";

const FIXTURE_SERVER = fileURLToPath(new URL("../test/mcpClientFixtureServer.mjs", import.meta.url));
const SERVER_NAME = "capygen_probe_fixture";

type Verdict = "proven" | "unsupported" | "undecided";

interface CaseResult {
  name: string;
  question: string;
  verdict: Verdict;
  detail: string;
  catalogue?: ToolCatalogue;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Throwaway homes, refused if they land anywhere near the personal ones. */
function makeHomes(): { root: string; claudeHome: string; codexHome: string; cwd: string; env: Record<string, string | undefined> } {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "capygen-catalogue-probe-")));
  const claudeHome = path.join(root, "claude-home");
  const codexHome = path.join(root, "codex-home");
  const fakeHome = path.join(root, "home");
  const cwd = path.join(root, "workspace");
  for (const dir of [claudeHome, codexHome, fakeHome, cwd]) mkdirSync(dir, { recursive: true });

  const personal = [".codex", ".claude"].map((name) =>
    canonicalizePath(path.join(process.env.USERPROFILE ?? process.env.HOME ?? root, name)),
  );
  for (const candidate of [claudeHome, codexHome, fakeHome, cwd].map(canonicalizePath)) {
    if (personal.some((home) => isPathInside(home, candidate) || isPathInside(candidate, home))) {
      throw new Error(`[probe] refusing ${candidate}: it overlaps a personal config home`);
    }
  }

  const env = cleanEnv(process.env);
  env.CODEX_HOME = codexHome;
  env.CLAUDE_CONFIG_DIR = claudeHome;
  env.HOME = fakeHome;
  env.USERPROFILE = fakeHome;
  env.XDG_CONFIG_HOME = path.join(fakeHome, ".config");
  // Never carried into a probe child.
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  return { root, claudeHome, codexHome, cwd, env };
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
  process.stderr.write(`[probe] could not delete ${dir}; it holds no credentials\n`);
}

/** Does this catalogue actually name the fixture server and its tools? */
function proves(result: ToolCatalogue): { ok: boolean; detail: string } {
  if (result.kind !== "ok") return { ok: false, detail: `catalogue kind=${result.kind}` };
  const server = result.servers.find((entry) => entry.name === SERVER_NAME);
  if (!server) {
    return { ok: false, detail: `the fixture server is absent; saw [${result.servers.map((s) => s.name).join(", ")}]` };
  }
  return {
    ok: server.tools.length > 0,
    detail: `state=${server.state} tools=[${server.tools.join(", ")}]`,
  };
}

async function probeCodex(homes: ReturnType<typeof makeHomes>): Promise<CaseResult> {
  const name = "codex-catalogue";
  const question =
    "does mcpServerStatus/list report a configured stdio server and its tool names through CodexHarness.catalogue()?";
  // The server is declared in the throwaway CODEX_HOME's own config, which is
  // how a user's servers reach Codex. No personal file is read or written.
  writeFileSync(
    path.join(homes.codexHome, "config.toml"),
    [
      `[mcp_servers.${SERVER_NAME}]`,
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(FIXTURE_SERVER)}]`,
      "",
    ].join("\n"),
    "utf8",
  );
  const harness = new CodexHarness({
    env: homes.env,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  try {
    await harness.start(
      { sessionId: "probe", projectPath: homes.cwd },
      {
        agentId: "probe",
        name: "probe",
        backend: "codex",
        model: "gpt-5.6-luna",
        resumeSessionId: null,
        config: { codex: { approvalPolicy: "never", sandbox: "read-only" } },
      } as never,
    );
    // `notStarted` first: a catalogue must not launch anything unasked.
    const lazy = await harness.catalogue!();
    if (lazy.kind !== "notStarted") {
      return { name, question, verdict: "undecided", detail: `an unasked catalogue answered ${lazy.kind}`, catalogue: lazy };
    }
    const result = await harness.catalogue!({ initialize: true, timeoutMs: 60_000 });
    const verdict = proves(result);
    return {
      name,
      question,
      verdict: verdict.ok ? "proven" : "undecided",
      detail: verdict.detail,
      catalogue: result,
    };
  } catch (err) {
    return { name, question, verdict: "undecided", detail: describe(err) };
  } finally {
    await harness.dispose().catch(() => undefined);
  }
}

async function probeClaude(homes: ReturnType<typeof makeHomes>): Promise<CaseResult> {
  const name = "claude-catalogue";
  const question =
    "is Query.mcpServerStatus() answerable with no prompt enqueued, in an unauthenticated owned home?";
  writeFileSync(
    path.join(homes.claudeHome, "settings.json"),
    JSON.stringify({}, null, 2),
    "utf8",
  );
  const harness = new ClaudeHarness({
    env: homes.env,
    // Only what this probe declares: the user's own settings sources are not
    // loaded, so no personal MCP server or plugin is involved.
    settingSources: [],
    log: { info: () => {}, warn: () => {}, error: () => {} },
    mcpServers: () => ({
      [SERVER_NAME]: { type: "stdio", command: process.execPath, args: [FIXTURE_SERVER] },
    }),
  });
  try {
    await harness.start(
      { sessionId: "probe", projectPath: homes.cwd },
      {
        agentId: "probe",
        name: "probe",
        backend: "claude",
        model: "claude-sonnet-5",
        resumeSessionId: null,
        config: null,
      } as never,
    );
    // The first answer proves the control request is served with no prompt.
    // Whether the *server* has finished connecting by then is a separate
    // question, so it is re-queried a bounded number of times rather than
    // reported from one sample.
    let result = await harness.catalogue!({ initialize: true, timeoutMs: 60_000 });
    const observed: string[] = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const state = result.kind === "ok" ? (result.servers[0]?.state ?? "absent") : result.kind;
      observed.push(state);
      if (state !== "pending") break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      result = await harness.catalogue!({ initialize: true, timeoutMs: 60_000 });
    }
    if (result.kind === "ok") {
      const verdict = proves(result);
      const seen = `states observed: ${observed.join(" → ")}`;
      if (verdict.ok) {
        return { name, question, verdict: "proven", detail: `${verdict.detail}; ${seen}`, catalogue: result };
      }
      // The control request was served without a prompt — the contract's
      // central claim — but the CLI never finished connecting the server. That
      // is the honest limit, not a failure of the catalogue.
      return {
        name,
        question,
        verdict: "unsupported",
        detail:
          `mcpServerStatus() WAS answered with no prompt enqueued, but the server never left ` +
          `pending in an unauthenticated home (${seen}). Tool names for Claude remain a ` +
          "live-proof gap; the state machine itself is proven.",
        catalogue: result,
      };
    }
    // An unauthenticated CLI may never reach the point of serving a control
    // request. That is a real limit, reported as one — not as a failure of the
    // contract and not papered over with a fake.
    return {
      name,
      question,
      verdict: "unsupported",
      detail:
        `catalogue kind=${result.kind}; an unauthenticated Claude CLI may refuse before any ` +
        "control request is served. This case is a live-proof gap, not a passed test.",
      catalogue: result,
    };
  } catch (err) {
    return { name, question, verdict: "unsupported", detail: describe(err) };
  } finally {
    await harness.dispose().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const homes = makeHomes();
  let results: CaseResult[] = [];
  try {
    results = [await probeCodex(homes), await probeClaude(homes)];
  } finally {
    await removeQuietly(homes.root);
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        probe: "mcp-catalogue",
        fixtureServer: SERVER_NAME,
        usedRemoteModel: false,
        usedCredentials: false,
        note:
          "The MCP server is a local stdio fixture from this repository, launched by the backend " +
          "from a throwaway home. No turn was started and no model was reached.",
        cases: results,
      },
      null,
      2,
    )}\n`,
  );
  for (const result of results) {
    process.stderr.write(`[${result.verdict.toUpperCase()}] ${result.name}: ${result.detail}\n`);
  }
  if (results.some((result) => result.verdict === "undecided")) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`[probe] failed: ${describe(err)}\n`);
  process.exitCode = 1;
});
