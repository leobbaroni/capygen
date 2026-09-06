/**
 * Phase 4 end to end: the round table, the hop cap, and sub-agent routing
 * (SPEC R10-R13, ADR-0002).
 *
 * Five tests, three of them live:
 *
 *   (a) **round table** — one session with a Claude agent and a Codex agent;
 *       "@claude write a haiku… @codex review what @claude wrote…" opens two
 *       agent turns, Claude's first, and Codex's answer quotes the haiku,
 *       which is only possible if the labelled context delta reached it
 *       (SPEC R23: a stateful backend is never re-sent the transcript, it is
 *       sent the turns since its own last one);
 *   (b) **hop cap** — offline, on the echo double with `peerMentions`
 *       (`CAPYGEN_ENGINE=stub-roundtable`), because a loop bound is exactly
 *       the thing that must not be proved with a model that might choose to
 *       stop on its own. The dispatcher under test is the shipping one;
 *   (c) **routed sub-agent (PARTIAL)** — a solo Claude session with a
 *       same-backend `subagentRouting` rule: the `Task` spawn is written as a
 *       native, non-delegated `subagent` block on the pinned model. The e2e
 *       model policy allows only one Claude model, so this can no longer prove
 *       the `PreToolUse` rewrite *changed* anything — that proof lives in
 *       `apps/desktop/test/sessionRunnerRoundTable.test.ts`;
 *   (d) **cross-backend delegation** — a Claude lead routed to `codex`: the
 *       hook cannot do that, so the lead is told to call `delegate_task`, and
 *       the block records `backend: "codex"`, `delegated: true`;
 *   (e) **agent info drawer** — description, model, tools and the other agent
 *       (SPEC R13), read through the real `agents.describe` after a turn has
 *       run, so the tools come from the live harness rather than from config.
 *
 * Cost: (a) is two short turns (one Claude, one Codex); (c) and (d) are one
 * Claude turn each plus one sub-agent; (e) reuses (a)'s pattern with one cheap
 * turn. (b) spends nothing. Every live test asks `harness.list` first and
 * skips with the backend's own reason rather than failing on a 401.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import {
  assertSessionPinned,
  backendHomes,
  launchEnv,
  pinnedConfigFor,
  E2E_CLAUDE_MODEL,
  E2E_CODEX_MODEL,
  type BackendHomes,
} from "./testPolicy.js";

/** One set of disposable backend homes for this spec file; a relaunch in the
 *  same test must see the same (still empty) homes. */
const homes = backendHomes("rt");
test.afterAll(() => homes.cleanup());

const repoRoot = path.resolve(__dirname, "..", "..");
const appDir = path.join(repoRoot, "apps", "desktop");
const outDir = path.join(repoRoot, "e2e-out");

/** A live turn is a real model call; a round-table round is two of them. */
const LIVE_TIMEOUT_MS = 180_000;
/**
 * The pinned Claude model every live test here runs on (`testPolicy.ts`).
 * There is no "unless it needs another": a spec that needs a *second* model to
 * prove something proves it in a fixture test instead — see (c) below.
 */
const CLAUDE_E2E_MODEL = E2E_CLAUDE_MODEL;

interface Launched {
  app: ElectronApplication;
  page: Page;
  errors: string[];
}

interface HarnessRow {
  backend: "claude" | "codex" | "api";
  label: string;
  available: boolean;
  reason?: string;
  models: { id: string; label: string }[];
  defaultModel: string;
}

interface AgentRow {
  id: string;
  sessionId: string;
  displayName: string;
  mentionName: string;
  backend: string;
  model: string;
  role: string;
}

/**
 * `engine` picks the engine: `null` drops `CAPYGEN_ENGINE` entirely (live
 * backends), a string sets it (`stub-roundtable` for the offline hop-cap run).
 */
async function launch(
  userDataDir: string,
  projectDir: string,
  engine: string | null,
): Promise<Launched> {
  const errors: string[] = [];
  const app = await electron.launch({
    args: [appDir, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
    env: launchEnv({
      userDataDir,
      projectDir,
      homes,
      ...(engine ? { engine } : {}),
    }),
  });
  const page = await app.firstWindow();
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
  });
  await page.waitForLoadState("domcontentloaded");
  return { app, page, errors };
}

async function invoke<T>(page: Page, channel: string, payload: unknown): Promise<T> {
  return page.evaluate(
    async ([ch, args]) => {
      const bridge = (window as unknown as {
        capygen?: { invoke(channel: string, payload: unknown): Promise<unknown> };
      }).capygen;
      if (!bridge) throw new Error("preload bridge missing");
      return bridge.invoke(ch as string, args);
    },
    [channel, payload] as const,
  ) as Promise<T>;
}

async function harnesses(page: Page): Promise<Record<string, HarnessRow>> {
  const rows = await invoke<HarnessRow[]>(page, "harness.list", {});
  return Object.fromEntries(rows.map((r) => [r.backend, r]));
}

/** See `harnesses.spec.ts`: `realpathSync.native` because `os.tmpdir()` is the
 *  8.3 short form on this machine and Codex's sandbox rejects such a cwd. */
function tempDirs(tag: string): { userDataDir: string; projectDir: string } {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `capygen-${tag}-`));
  const projectDir = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), `capygen-${tag}-proj-`)),
  );
  fs.writeFileSync(path.join(projectDir, "README.md"), "# capygen e2e fixture\n", "utf8");
  return { userDataDir, projectDir };
}

/** Create a session through IPC and open it. Returns the session and its agents. */
async function openSession(
  page: Page,
  projectDir: string,
  body: { mode: "solo" | "round-table"; title: string; agents: unknown[]; settings?: unknown },
): Promise<{ sessionId: string; agents: AgentRow[] }> {
  const projects = await invoke<{ id: string; path: string }[]>(page, "projects.list", {});
  const project = projects.find((p) => p.path === projectDir) ?? projects[0]!;
  const created = await invoke<{ session: { id: string }; agents: AgentRow[] }>(
    page,
    "sessions.create",
    { projectId: project.id, mode: body.mode, title: body.title, agents: body.agents },
  );
  if (body.settings) {
    await invoke(page, "sessions.updateSettings", {
      sessionId: created.session.id,
      patch: body.settings,
    });
  }
  await page.evaluate((id) => {
    window.location.hash = `#/c/${id}`;
  }, created.session.id);
  await expect(page.getByTestId("chat-page")).toBeVisible();
  return { sessionId: created.session.id, agents: created.agents };
}

interface TurnRow {
  id: string;
  role: string;
  agentId: string | null;
  hopIndex: number;
  status: string;
  speakerLabel?: string;
  mentions: string[];
}

interface BlockRow {
  id: string;
  turnId: string;
  kind: string;
  text?: string;
  model?: string;
  backend?: string;
  delegated?: boolean;
  name?: string;
}

async function transcript(
  page: Page,
  sessionId: string,
): Promise<{ turns: TurnRow[]; blocks: BlockRow[] }> {
  return invoke(page, "turns.list", { sessionId });
}

/** What a failing routing assertion should print instead of "expected codex,
 *  received empty string": the turn's own outcome and every block it wrote. */
function dump(turns: TurnRow[], blocks: BlockRow[]): string {
  const lines = turns.map(
    (t) =>
      `  turn ${t.role} hop=${t.hopIndex} status=${t.status}: ` +
      blocks
        .filter((b) => b.turnId === t.id)
        .map((b) =>
          b.kind === "subagent"
            ? `subagent(${b.name}, backend=${b.backend}, model=${b.model}, delegated=${b.delegated})`
            : b.kind === "text"
              ? `text(${(b.text ?? "").slice(0, 120)})`
              : b.kind,
        )
        .join(", "),
  );
  return ["", ...lines].join("\n");
}

function textOf(blocks: BlockRow[], turnId: string): string {
  return blocks
    .filter((b) => b.turnId === turnId && b.kind === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

test.describe("round table, hop cap and sub-agent routing", () => {
  test.slow();

  // -------------------------------------------------------------------------
  // (a) two backends, one transcript, in order
  // -------------------------------------------------------------------------
  test("round table: @claude then @codex, and Codex sees what Claude wrote", async () => {
    test.setTimeout(4 * LIVE_TIMEOUT_MS);
    fs.mkdirSync(outDir, { recursive: true });
    const { userDataDir, projectDir } = tempDirs("rt");

    let launched: Launched | null = null;
    try {
      launched = await launch(userDataDir, projectDir, null);
      const page = launched.page;
      await expect(page.getByTestId("landing")).toBeVisible();

      const rows = await harnesses(page);
      test.skip(!rows.claude?.available, `Claude is unavailable: ${rows.claude?.reason ?? "no row"}`);
      test.skip(!rows.codex?.available, `Codex is unavailable: ${rows.codex?.reason ?? "no row"}`);

      const { sessionId, agents } = await openSession(page, projectDir, {
        mode: "round-table",
        title: "round table",
        agents: [
          {
            name: "Claude",
            mentionName: "claude",
            backend: "claude",
            model: CLAUDE_E2E_MODEL,
            role: "lead",
            config: pinnedConfigFor("claude"),
          },
          {
            name: "Codex",
            mentionName: "codex",
            backend: "codex",
            model: E2E_CODEX_MODEL,
            role: "member",
            config: pinnedConfigFor("codex"),
          },
        ],
      });
      expect(agents.map((a) => a.mentionName)).toEqual(["claude", "codex"]);
      // Before a single token is spent: both agents on the pinned model at the
      // pinned effort. This session was created through `sessions.create`, so
      // the check happens while there is still something to stop.
      await assertSessionPinned(page, sessionId);

      // Both agents are in the pane before anyone has spoken (R13's tree).
      await page.getByTestId("agents-pane-toggle").click();
      await expect(page.getByTestId("agents-tree-row")).toHaveCount(2);

      const composer = page.getByTestId("chat-composer-input");
      await composer.click();
      await composer.fill(
        "@claude write a haiku about capybaras. " +
          "@codex review what @claude wrote in one sentence, " +
          "and quote its first line back to me exactly.",
      );
      await composer.press("Enter");

      // --- two agent turns, in mention order (R11) ------------------------
      // Rows are opened before the round runs, so both exist immediately; what
      // takes a live turn each is their *status*.
      await expect(page.getByTestId("turn")).toHaveCount(3, { timeout: LIVE_TIMEOUT_MS });
      const claudeTurn = page.getByTestId("turn").nth(1);
      const codexTurn = page.getByTestId("turn").nth(2);
      await expect(claudeTurn).toHaveAttribute("data-status", "done", {
        timeout: LIVE_TIMEOUT_MS,
      });
      await expect(codexTurn).toHaveAttribute("data-status", "done", {
        timeout: LIVE_TIMEOUT_MS,
      });

      const { turns, blocks } = await transcript(page, sessionId);
      const claudeAgent = agents.find((a) => a.mentionName === "claude")!;
      const codexAgent = agents.find((a) => a.mentionName === "codex")!;
      // The *round* this message opened is hop 1. Anything at hop 2 is the
      // agents having gone on to @-mention each other, which R11 allows and
      // the hop cap bounds — it is not what this test is about.
      const round = turns.filter((t) => t.role === "agent" && t.hopIndex === 1);
      expect(round).toHaveLength(2);
      // Order is the mention order, not completion order.
      expect(round[0]!.agentId).toBe(claudeAgent.id);
      expect(round[1]!.agentId).toBe(codexAgent.id);
      // The user turn recorded both mentions, in order (R11).
      expect(turns[0]!.role).toBe("user");
      expect(turns[0]!.mentions).toEqual([claudeAgent.id, codexAgent.id]);

      // Speaker labels are what the transcript attributes turns with (R13).
      expect(round[0]!.speakerLabel).toBe("@claude (Claude Code)");
      expect(round[1]!.speakerLabel).toBe("@codex (Codex)");
      await expect(page.getByTestId("speaker-label").first()).toBeVisible();

      // --- the context delta reached Codex (SPEC R23) ---------------------
      // Codex was never sent the transcript; it was sent the turns since its
      // own last one, labelled. Asking it to *quote* Claude's first line is
      // the only airtight proof: a paraphrase could be reconstructed from the
      // user's own prompt ("a haiku about capybaras"), but the exact words of
      // a line Claude invented one turn ago can only have come from the delta.
      const haiku = textOf(blocks, round[0]!.id);
      const review = textOf(blocks, round[1]!.id);
      expect(haiku.length, "Claude wrote nothing").toBeGreaterThan(10);
      expect(review.length, "Codex wrote nothing").toBeGreaterThan(10);
      const norm = (t: string): string =>
        t
          .toLowerCase()
          .replace(/[^a-z0-9 ]+/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      const firstLine = haiku
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 8);
      expect(firstLine, `Claude's haiku had no usable first line: ${haiku}`).toBeTruthy();
      expect(
        norm(review),
        "Codex did not quote Claude's first line, so the context delta did not reach it." +
          `\nhaiku: ${haiku}\nreview: ${review}`,
      ).toContain(norm(firstLine!));

      await page.screenshot({ path: path.join(outDir, "roundtable.png"), fullPage: false });
      // The two may well have gone on talking to each other (R11 lets them);
      // stop the session so the app is not torn down mid-turn, which would
      // show up as a console error rather than as the thing under test.
      await invoke(page, "chat.interrupt", { sessionId });
      expect(launched.errors, launched.errors.join(" | ")).toEqual([]);
    } finally {
      await launched?.app.close().catch(() => undefined);
    }
  });

  // -------------------------------------------------------------------------
  // (b) the hop cap, offline
  // -------------------------------------------------------------------------
  test("hop cap: a ping-pong stops at 3 hops and Continue grants exactly one more", async () => {
    test.setTimeout(120_000);
    fs.mkdirSync(outDir, { recursive: true });
    const { userDataDir, projectDir } = tempDirs("hopcap");

    let launched: Launched | null = null;
    try {
      // The echo double with `peerMentions`: every reply ends "over to @other",
      // so the two agents would talk forever if nothing stopped them.
      launched = await launch(userDataDir, projectDir, "stub-roundtable");
      const page = launched.page;
      await expect(page.getByTestId("landing")).toBeVisible();

      const { sessionId } = await openSession(page, projectDir, {
        mode: "round-table",
        title: "hop cap",
        agents: [
          { name: "Alice", mentionName: "alice", backend: "claude", model: "stub", role: "lead" },
          { name: "Bob", mentionName: "bob", backend: "claude", model: "stub", role: "member" },
        ],
      });

      // The chat header shares the title-bar row with `.titlebar-drag`, a
      // window-wide fixed strip that used to swallow every click in it (the
      // row held nothing interactive before Phase 4). Playwright's
      // actionability check fails on an intercepted click, so this is the
      // regression guard, and it costs nothing: the session is already in
      // round-table mode, so the picker's own `option !== mode` guard makes
      // the click a no-op.
      await page.getByTestId("chat-mode-picker-round-table").click();
      await expect(page.getByTestId("session-settings-button")).toBeEnabled();

      const composer = page.getByTestId("chat-composer-input");
      await composer.click();
      await composer.fill("@alice say hello");
      await composer.press("Enter");

      // --- the chain stops, and says so ------------------------------------
      const bar = page.getByTestId("chain-stopped-bar");
      await expect(bar).toBeVisible({ timeout: 60_000 });
      await expect(bar).toContainText(/continue/i);

      // hopCap defaults to 3, and hop indices are absolute (user = 0), so the
      // agent turns are exactly hops 1, 2 and 3 — the hop-4 plan is refused.
      const first = await transcript(page, sessionId);
      const hops = first.turns.filter((t) => t.role === "agent").map((t) => t.hopIndex);
      expect(hops).toEqual([1, 2, 3]);
      // …and the transcript records why, once for the round.
      const systemTurns = first.turns.filter((t) => t.role === "system");
      expect(systemTurns).toHaveLength(1);
      expect(textOf(first.blocks, systemTurns[0]!.id)).toMatch(/stopped after 3 hops/i);
      await page.screenshot({ path: path.join(outDir, "roundtable-hopcap.png") });

      // --- Continue grants exactly one more hop -----------------------------
      await page.getByTestId("chain-stopped-continue").click();
      // Rows are opened before a round runs, so "there are four" is true a
      // beat before the fourth has actually answered — poll on the settled
      // count, or the status assertion below races the echo's own timer.
      await expect
        .poll(
          async () =>
            (await transcript(page, sessionId)).turns.filter(
              (t) => t.role === "agent" && t.status === "done",
            ).length,
          { timeout: 60_000 },
        )
        .toBe(4);
      const second = await transcript(page, sessionId);
      const after = second.turns.filter((t) => t.role === "agent");
      expect(after.map((t) => t.hopIndex)).toEqual([1, 2, 3, 4]);
      // One press, one hop: the cap applies again to what that hop said, so a
      // second "chain stopped" notice is written and no fifth turn appears.
      await expect(bar).toBeVisible({ timeout: 60_000 });
      await page.waitForTimeout(2_000);
      const third = await transcript(page, sessionId);
      expect(third.turns.filter((t) => t.role === "agent")).toHaveLength(4);

      expect(launched.errors, launched.errors.join(" | ")).toEqual([]);
    } finally {
      await launched?.app.close().catch(() => undefined);
    }
  });

  // -------------------------------------------------------------------------
  // (c) same-backend routing — PARTIAL evidence, deliberately
  //
  // This test used to route the sub-agent to `haiku` and assert the stored
  // block named it, which proved the `PreToolUse` hook's `updatedInput.model`
  // rewrite actually took effect. The e2e model policy allows no second model
  // (`testPolicy.ts`), so the route now targets the *same* pinned model the
  // lead runs on — and a spawn that names the pinned model is exactly what an
  // *ignored* rewrite would also produce. What survives here is that the hook
  // fires, a native same-backend spawn is written, and it is not a delegation.
  //
  // The different-model rewrite itself is proved deterministically in the
  // fixture tests (`apps/desktop/test/sessionRunnerRoundTable.test.ts`), which
  // spend no tokens and can route to any model id they like. Do not restore a
  // model claim here without restoring a second live model to claim it with.
  // -------------------------------------------------------------------------
  test("routed sub-agent: a Claude Task spawn is re-homed by the routing hook (partial)", async () => {
    test.setTimeout(4 * LIVE_TIMEOUT_MS);
    fs.mkdirSync(outDir, { recursive: true });
    const { userDataDir, projectDir } = tempDirs("route");
    // Something for the sub-agent to actually count.
    fs.writeFileSync(path.join(projectDir, "NOTES.md"), "# notes\n", "utf8");
    fs.writeFileSync(path.join(projectDir, "TODO.md"), "# todo\n", "utf8");

    let launched: Launched | null = null;
    try {
      launched = await launch(userDataDir, projectDir, null);
      const page = launched.page;
      await expect(page.getByTestId("landing")).toBeVisible();

      const rows = await harnesses(page);
      test.skip(!rows.claude?.available, `Claude is unavailable: ${rows.claude?.reason ?? "no row"}`);

      const { sessionId } = await openSession(page, projectDir, {
        mode: "solo",
        title: "routed sub-agent",
        agents: [
          {
            name: "Claude",
            mentionName: "claude",
            backend: "claude",
            model: CLAUDE_E2E_MODEL,
            role: "lead",
            // Same backend: enforced by the `PreToolUse` hook on `Task|Agent`,
            // whose only lever is `updatedInput.model` (docs/adr/0004). The
            // routed model is the pinned one — see the PARTIAL note above.
            subagentRouting: { backend: "claude", model: CLAUDE_E2E_MODEL },
            config: {
              claude: {
                permissionMode: "bypassPermissions",
                ...(pinnedConfigFor("claude").claude as Record<string, unknown>),
              },
            },
          },
        ],
      });

      await assertSessionPinned(page, sessionId);

      const composer = page.getByTestId("chat-composer-input");
      await composer.click();
      await composer.fill(
        "Use the Task tool to spawn a subagent that counts the .md files here " +
          "and report the number.",
      );
      await composer.press("Enter");

      // --- the tree shows the spawn, on the routed model (R12/R13) ---------
      await page.getByTestId("agents-pane-toggle").click();
      const subagentRow = page.getByTestId("agents-tree-subagent").first();
      await expect(subagentRow).toBeVisible({ timeout: LIVE_TIMEOUT_MS });

      // The assertion that matters is the stored block, not the label: the
      // pane renders whatever the block says, so reading the block is reading
      // what the hook actually did. Wait for the turn to settle first — a
      // sub-agent's block is upserted several times as it runs.
      await expect(page.getByTestId("turn").nth(1)).toHaveAttribute("data-status", "done", {
        timeout: LIVE_TIMEOUT_MS,
      });
      const { turns, blocks } = await transcript(page, sessionId);
      const sub = blocks.find((b) => b.kind === "subagent");
      expect(sub, `no subagent block was written${dump(turns, blocks)}`).toBeTruthy();
      // PARTIAL: the routed model equals the lead's, so this asserts the block
      // carries the pinned model — it cannot distinguish "the hook rewrote it"
      // from "the hook was ignored and the sub-agent inherited it". Claiming a
      // rewrite here would be claiming evidence this test does not have.
      expect(sub!.model ?? "", `the spawn named an unpinned model${dump(turns, blocks)}`).toBe(
        CLAUDE_E2E_MODEL,
      );
      expect(sub!.backend).toBe("claude");
      // Same backend ⇒ the native spawn, re-labelled — not a delegation.
      expect(sub!.delegated ?? false).toBe(false);
      // The pane renders whatever the block says; assert the pinned model, not
      // a second model this test is no longer allowed to route to.
      await expect(subagentRow).toContainText(CLAUDE_E2E_MODEL);

      await page.screenshot({ path: path.join(outDir, "roundtable-routed-subagent.png") });
      expect(launched.errors, launched.errors.join(" | ")).toEqual([]);
    } finally {
      await launched?.app.close().catch(() => undefined);
    }
  });

  // -------------------------------------------------------------------------
  // (d) cross-backend delegation through delegate_task
  // -------------------------------------------------------------------------
  test("cross-backend delegation: a Claude lead delegates to Codex and gets pong", async () => {
    test.setTimeout(4 * LIVE_TIMEOUT_MS);
    fs.mkdirSync(outDir, { recursive: true });
    const { userDataDir, projectDir } = tempDirs("delegate");

    let launched: Launched | null = null;
    try {
      launched = await launch(userDataDir, projectDir, null);
      const page = launched.page;
      await expect(page.getByTestId("landing")).toBeVisible();

      const rows = await harnesses(page);
      test.skip(!rows.claude?.available, `Claude is unavailable: ${rows.claude?.reason ?? "no row"}`);
      test.skip(!rows.codex?.available, `Codex is unavailable: ${rows.codex?.reason ?? "no row"}`);

      const { sessionId } = await openSession(page, projectDir, {
        mode: "solo",
        title: "delegation",
        agents: [
          {
            name: "Claude",
            mentionName: "claude",
            backend: "claude",
            model: CLAUDE_E2E_MODEL,
            role: "lead",
            // The delegated child's model is named explicitly: leaving it out
            // makes `resolveRoute` send "" and lets the Codex harness pick its
            // own default, which the e2e policy does not allow to be spent on.
            subagentRouting: { backend: "codex", model: E2E_CODEX_MODEL },
            // `createDelegateRunner` builds the child harness with the
            // *parent's* `config` (SessionRunner.harnessExtras), so the child's
            // `codex.reasoningEffort` has to be declared here — it is the only
            // lever a test has over a delegated agent.
            config: {
              claude: {
                permissionMode: "bypassPermissions",
                ...(pinnedConfigFor("claude").claude as Record<string, unknown>),
              },
              ...pinnedConfigFor("codex"),
            },
          },
        ],
      });

      await assertSessionPinned(page, sessionId);

      const composer = page.getByTestId("chat-composer-input");
      await composer.click();
      await composer.fill(
        "Delegate to a sub-agent: reply with the word pong. " +
          "Then reply to me with just what the sub-agent said.",
      );
      await composer.press("Enter");

      // --- a delegated sub-agent block, on codex ---------------------------
      const agentTurn = page.getByTestId("turn").nth(1);
      await expect(agentTurn).toHaveAttribute("data-status", "done", {
        timeout: LIVE_TIMEOUT_MS,
      });
      const { turns, blocks } = await transcript(page, sessionId);
      const sub = blocks.find((b) => b.kind === "subagent");
      expect(sub, `nothing was delegated${dump(turns, blocks)}`).toBeTruthy();
      // Cross-backend ⇒ capygen ran it, not the Claude CLI (docs/adr/0004).
      expect(sub!.delegated, `the spawn was native, not delegated${dump(turns, blocks)}`).toBe(
        true,
      );
      expect(sub!.backend).toBe("codex");

      const lead = turns.filter((t) => t.role === "agent")[0]!;
      expect(textOf(blocks, lead.id), dump(turns, blocks)).toMatch(/pong/i);

      await page.screenshot({ path: path.join(outDir, "roundtable-delegated.png") });
      expect(launched.errors, launched.errors.join(" | ")).toEqual([]);
    } finally {
      await launched?.app.close().catch(() => undefined);
    }
  });

  // -------------------------------------------------------------------------
  // (e) the agent info drawer (R13)
  // -------------------------------------------------------------------------
  test("agent info drawer shows description, model, tools and the other agent", async () => {
    test.setTimeout(4 * LIVE_TIMEOUT_MS);
    fs.mkdirSync(outDir, { recursive: true });
    const { userDataDir, projectDir } = tempDirs("info");

    let launched: Launched | null = null;
    try {
      launched = await launch(userDataDir, projectDir, null);
      const page = launched.page;
      await expect(page.getByTestId("landing")).toBeVisible();

      const rows = await harnesses(page);
      test.skip(!rows.claude?.available, `Claude is unavailable: ${rows.claude?.reason ?? "no row"}`);
      test.skip(!rows.codex?.available, `Codex is unavailable: ${rows.codex?.reason ?? "no row"}`);

      const { sessionId, agents } = await openSession(page, projectDir, {
        mode: "round-table",
        title: "agent info",
        agents: [
          {
            name: "Claude",
            mentionName: "claude",
            backend: "claude",
            model: CLAUDE_E2E_MODEL,
            role: "lead",
            config: pinnedConfigFor("claude"),
            description: "Writes and reviews the prose.",
          },
          {
            name: "Codex",
            mentionName: "codex",
            backend: "codex",
            model: E2E_CODEX_MODEL,
            role: "member",
            config: pinnedConfigFor("codex"),
          },
        ],
      });

      await assertSessionPinned(page, sessionId);

      // One cheap turn first: `tools` and `capabilities` are facts of a
      // *running* harness (Claude reports them in `system/init`, which arrives
      // when the first turn starts), so a drawer opened before that honestly
      // says "Not reported yet".
      const composer = page.getByTestId("chat-composer-input");
      await composer.click();
      await composer.fill("@claude reply with exactly the word ok.");
      await composer.press("Enter");
      await expect(page.getByTestId("turn").nth(1)).toHaveAttribute("data-status", "done", {
        timeout: LIVE_TIMEOUT_MS,
      });

      await page.getByTestId("agents-pane-toggle").click();
      await page
        .getByTestId("agents-tree-row")
        .filter({ hasText: "Claude" })
        .first()
        .getByTestId("agent-tree-select")
        .click();

      const drawer = page.getByTestId("agent-info-drawer");
      await expect(drawer).toBeVisible();
      await expect(drawer.getByTestId("agent-info-error")).toHaveCount(0);
      // description (R13 "usage description"), model, tools, and the roster.
      await expect(drawer.getByTestId("agent-info-description")).toHaveText(
        "Writes and reviews the prose.",
      );
      // …and the generated usage description beside it, which is the half only
      // a live harness can produce (R13: role, capabilities, tools, model).
      await expect(drawer.getByTestId("agent-info-usage-description")).toContainText(
        /Lead agent on Claude Code/,
      );
      await expect(drawer).toContainText(CLAUDE_E2E_MODEL);
      await expect(drawer).toContainText(/Files \(/);
      await expect(drawer.getByTestId("agent-info-usage-input")).not.toHaveText("0");
      const others = drawer.getByTestId("agent-info-other");
      await expect(others).toHaveCount(1);
      await expect(others.first()).toContainText("@codex");

      // The same facts through the channel, so a UI change cannot hide a
      // regression in what `agents.describe` actually answers.
      const claudeAgent = agents.find((a) => a.mentionName === "claude")!;
      const info = await invoke<{
        description: string;
        capabilities: string[];
        tools: string[];
        model: string;
        backend: string;
        usage: { input: number; costUsd: number };
        others: { mentionName: string }[];
      }>(page, "agents.describe", { agentId: claudeAgent.id });
      expect(info.backend).toBe("claude");
      expect(info.tools.length).toBeGreaterThan(0);
      expect(info.capabilities).toContain("Can spawn sub-agents");
      expect(info.usage.input).toBeGreaterThan(0);
      expect(info.others.map((o) => o.mentionName)).toEqual(["codex"]);

      await page.screenshot({ path: path.join(outDir, "roundtable-agent-info.png") });
      expect(launched.errors, launched.errors.join(" | ")).toEqual([]);
    } finally {
      await launched?.app.close().catch(() => undefined);
    }
  });
});
