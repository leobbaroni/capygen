/**
 * `/dev/cards` — a fixture transcript rendering every block kind and every
 * per-family `ToolCallCard` variant, for visual QA and the B4 screenshot
 * evidence (`e2e-out/cards.png`). Fixtures are also seeded into the real
 * store's `blocks`/`usageEvents` maps on mount (restored on unmount) so
 * cross-block features exercise for real instead of degrading silently:
 * the `task`-family tool call's sub-agent link needs a `subagent:<id>` block
 * to find, and `UsageLine`'s byModel breakdown needs more than one
 * `usage_events` row for the same turn. Otherwise nothing here talks to a
 * backend — the permission/question/elicitation buttons call the real
 * `ipc()` bridge underneath, but nothing on this page depends on the result.
 *
 * `App.tsx` only mounts this route when `import.meta.env.DEV` — it never
 * ships in a production build.
 */
import { useEffect, type ReactNode } from "react";
import type { Block, UsageEvent } from "@capygen/shared";
import { BlockRenderer } from "@/components/blocks/BlockRenderer";
import { useAppStore } from "@/store/appStore";

const base = { turnId: "turn-fixture", sessionId: "session-fixture", index: 0, createdAt: 0, updatedAt: 0 };

const BIG_OUTPUT = `${"line of output ".repeat(20)}\n${"more output text ".repeat(20)}TAIL-MARKER`;

interface Fixture {
  label: string;
  block: Block;
}

const SECTIONS: { title: string; items: Fixture[] }[] = [
  {
    title: "Text / thinking / diff / subagent / error / usage",
    items: [
      { label: "text", block: { ...base, id: "text", kind: "text", text: "Here is a plain reply with **markdown**." } },
      { label: "thinking", block: { ...base, id: "thinking", kind: "thinking", text: "Weighing a couple of approaches before writing code." } },
      {
        label: "diff",
        block: {
          ...base,
          id: "diff",
          kind: "diff",
          path: "src/index.ts",
          patch: "@@ -1,2 +1,2 @@\n-const x = 1;\n+const x = 2;\n line two",
          additions: 1,
          deletions: 1,
        },
      },
      {
        label: "subagent · running",
        block: {
          ...base,
          id: "subagent",
          kind: "subagent",
          agentId: null,
          name: "reviewer",
          backend: "claude",
          model: "claude-opus-4-5",
          description: "Reviews the diff for correctness issues.",
          status: "running",
        },
      },
      {
        label: "error",
        block: {
          ...base,
          id: "error",
          kind: "error",
          message: "The backend ended the turn without a result.",
          detail: "stderr: connection reset",
        },
      },
      {
        label: "usage (byModel breakdown — see the “2 models” chip)",
        block: {
          ...base,
          id: "usage",
          kind: "usage",
          model: "claude-opus-4-5",
          usage: {
            inputTokens: 1834,
            outputTokens: 412,
            cacheReadTokens: 32000,
            cacheCreationTokens: 0,
            costUsd: 0.0623,
          },
        },
      },
    ],
  },
  {
    title: "Permission (pending / allowed for session / denied)",
    items: [
      {
        label: "pending",
        block: {
          ...base,
          id: "perm-pending",
          kind: "permission",
          title: "Run a shell command",
          description: "capygen wants to run a command in your project directory.",
          request: { requestId: "req-1", toolName: "Bash", input: { command: "pnpm test" }, suggestions: [] },
          decision: null,
        },
      },
      {
        label: "allowed for session",
        block: {
          ...base,
          id: "perm-allowed",
          kind: "permission",
          request: { requestId: "req-2", toolName: "Bash", input: { command: "pnpm test" }, suggestions: [] },
          decision: { behavior: "allow_always", scope: "always", decidedAt: 0 },
        },
      },
      {
        label: "denied with reason",
        block: {
          ...base,
          id: "perm-denied",
          kind: "permission",
          request: { requestId: "req-3", toolName: "Bash", input: { command: "rm -rf /" }, suggestions: [] },
          decision: { behavior: "deny", scope: "once", decidedAt: 0, message: "Too destructive." },
        },
      },
    ],
  },
  {
    title: "Question (AskUserQuestion)",
    items: [
      {
        label: "pending, allowOther",
        block: {
          ...base,
          id: "question-pending",
          kind: "question",
          requestId: "req-q1",
          questions: [
            {
              question: "Which package manager?",
              multiSelect: false,
              options: [{ label: "pnpm", description: "Fast, disk-efficient" }, { label: "npm" }],
            },
          ],
          answers: null,
          allowOther: true,
        },
      },
      {
        label: "answered",
        block: {
          ...base,
          id: "question-answered",
          kind: "question",
          requestId: "req-q2",
          questions: [{ question: "Which package manager?", multiSelect: false, options: [{ label: "pnpm" }] }],
          answers: { "Which package manager?": "pnpm" },
        },
      },
    ],
  },
  {
    title: "Elicitation (form generated from schema)",
    items: [
      {
        label: "pending — text + enum + boolean + number",
        block: {
          ...base,
          id: "elicit-pending",
          kind: "elicitation",
          requestId: "req-e1",
          title: "Configure the release",
          description: "A few details before publishing.",
          schema: {
            properties: {
              branch: { type: "string", title: "Branch", description: "Git branch to release from" },
              channel: { type: "string", title: "Channel", enum: ["stable", "beta"], default: "stable" },
              dryRun: { type: "boolean", title: "Dry run" },
              retries: { type: "integer", title: "Retries", default: 3 },
            },
            required: ["branch"],
          },
          answers: null,
          status: "pending",
        },
      },
      {
        label: "accepted",
        block: {
          ...base,
          id: "elicit-accepted",
          kind: "elicitation",
          requestId: "req-e2",
          title: "Configure the release",
          schema: { properties: { branch: { type: "string" } } },
          answers: { branch: "main" },
          status: "accepted",
        },
      },
    ],
  },
  {
    title: "Tool calls — bash / read / write / edit",
    items: [
      {
        label: "bash",
        block: {
          ...base,
          id: "tool-bash",
          kind: "tool_call",
          name: "Bash",
          input: { command: "pnpm test" },
          output: "$ pnpm test\n(exit code 0)\n177 passed",
          status: "success",
        },
      },
      {
        label: "read, truncated (inline fullOutput)",
        block: {
          ...base,
          id: "tool-read",
          kind: "tool_call",
          name: "Read",
          input: { path: "README.md", offset: 1, limit: 40 },
          output: `${BIG_OUTPUT.slice(0, 80)}\n… truncated`,
          truncated: true,
          fullOutput: BIG_OUTPUT,
          status: "success",
        },
      },
      {
        label: "write",
        block: {
          ...base,
          id: "tool-write",
          kind: "tool_call",
          name: "write_file",
          input: { path: "notes.md", content: "# Notes\nFirst line.\nSecond line." },
          output: "Wrote notes.md (3 lines, 30 characters).",
          status: "success",
        },
      },
      {
        label: "edit",
        block: {
          ...base,
          id: "tool-edit",
          kind: "tool_call",
          name: "Edit",
          input: {
            file_path: "src/app.ts",
            old_string: "const x = 1;\nconst y = 2;",
            new_string: "const x = 10;\nconst y = 2;",
          },
          output: "Replaced 1 occurrence in src/app.ts.",
          status: "success",
        },
      },
    ],
  },
  {
    title: "Tool calls — glob / grep / web / mcp / task / other",
    items: [
      {
        label: "glob",
        block: {
          ...base,
          id: "tool-glob",
          kind: "tool_call",
          name: "Glob",
          input: { pattern: "src/**/*.ts" },
          output: "3 matches for src/**/*.ts under .\nsrc/index.ts\nsrc/app.ts\nsrc/util.ts",
          status: "success",
        },
      },
      {
        label: "grep",
        block: {
          ...base,
          id: "tool-grep",
          kind: "tool_call",
          name: "Grep",
          input: { pattern: "TODO", glob: "**/*.ts" },
          output:
            "2 matches for /TODO/ under . (ripgrep)\nsrc/app.ts:12:// TODO: handle error\nsrc/util.ts:4:// TODO: cache",
          status: "success",
        },
      },
      {
        label: "web",
        block: {
          ...base,
          id: "tool-web",
          kind: "tool_call",
          name: "WebFetch",
          input: { url: "https://example.com/docs" },
          output: "https://example.com/docs (HTTP 200, text/html)\n\nExample docs page…",
          status: "success",
        },
      },
      {
        label: "mcp — text + image result",
        block: {
          ...base,
          id: "tool-mcp",
          kind: "tool_call",
          name: "mcp__higgsfield__generate_image",
          serverName: "higgsfield",
          input: { prompt: "a red bicycle" },
          output: {
            content: [
              { type: "text", text: "Generated 1 image." },
              { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
            ],
          },
          status: "success",
        },
      },
      {
        label: "task — spawned a sub-agent (expand to see the link)",
        block: {
          ...base,
          id: "tool-task",
          kind: "tool_call",
          name: "Task",
          toolUseId: "spawn-1",
          input: { description: "Review the diff", subagent_type: "reviewer" },
          output: "Sub-agent finished.",
          status: "success",
        },
      },
      {
        label: "( ↑ that Task's spawned sub-agent block, so its link resolves)",
        block: {
          ...base,
          id: "subagent:spawn-1",
          kind: "subagent",
          agentId: null,
          name: "reviewer",
          backend: "claude",
          model: "claude-opus-4-5",
          description: "Reviews the diff for correctness issues.",
          status: "done",
        },
      },
      {
        label: "other / pending",
        block: {
          ...base,
          id: "tool-other",
          kind: "tool_call",
          name: "custom_tool",
          input: { note: "an unclassified tool" },
          status: "pending",
        },
      },
    ],
  },
  {
    title: "Widget (MCP Apps host — owned outside B4, placeholder card)",
    items: [
      {
        label: "pending html",
        block: {
          ...base,
          id: "widget-pending",
          kind: "widget",
          toolCallId: "tool-mcp",
          serverName: "higgsfield",
          toolName: "generate_image",
          resourceUri: "ui://higgsfield/generate-image",
          html: null,
          htmlStatus: "pending",
          toolInput: {},
          toolResult: null,
          meta: null,
        },
      },
    ],
  },
];

const FIXTURE_USAGE_EVENTS: UsageEvent[] = [
  {
    id: "usage-fixture-1",
    sessionId: base.sessionId,
    agentId: null,
    turnId: base.turnId,
    backend: "claude",
    model: "claude-opus-4-5",
    inputTokens: 1834,
    outputTokens: 412,
    cacheReadTokens: 32000,
    cacheCreationTokens: 0,
    costUsd: 0.0623,
    ts: 0,
  },
  {
    id: "usage-fixture-2",
    sessionId: base.sessionId,
    agentId: null,
    turnId: base.turnId,
    backend: "claude",
    model: "claude-haiku-4-5",
    inputTokens: 220,
    outputTokens: 40,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0.0009,
    ts: 0,
  },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-b border-border-weak pb-6">
      <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h2>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

export function DevCardsPage() {
  // Seed cross-block fixtures into the real store so the task→subagent link
  // and the usage byModel breakdown have something to find; restored so
  // navigating away doesn't leave fixture rows in a real session's state.
  useEffect(() => {
    const before = useAppStore.getState();
    const fixtureBlocks = Object.fromEntries(
      SECTIONS.flatMap((s) => s.items).map(({ block }) => [block.id, block]),
    );
    useAppStore.setState({
      blocks: { ...before.blocks, ...fixtureBlocks },
      usageEvents: [...before.usageEvents, ...FIXTURE_USAGE_EVENTS],
    });
    return () => {
      useAppStore.setState({ blocks: before.blocks, usageEvents: before.usageEvents });
    };
  }, []);

  return (
    <div
      className="mx-auto flex w-full max-w-[900px] flex-col gap-8 px-8 py-10"
      data-testid="dev-cards-page"
    >
      <header>
        <h1 className="text-2xl font-semibold text-foreground">Card fixtures</h1>
        <p className="text-sm text-muted-foreground">
          Every block kind, and every ToolCallCard family, rendered from static fixtures — not a
          real session. Dev-only route, never part of a production build.
        </p>
      </header>

      {SECTIONS.map((section) => (
        <Section key={section.title} title={section.title}>
          {section.items.map(({ label, block }) => (
            <div key={block.id} className="flex flex-col gap-1">
              <p className="font-mono text-[0.65rem] text-muted-foreground/70">{label}</p>
              <BlockRenderer block={block} isUser={false} />
            </div>
          ))}
        </Section>
      ))}
    </div>
  );
}
