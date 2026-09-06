/**
 * Tool-call block, rendered per family (SPEC R6 item 3). Look ported from
 * reference/omnigent/web/src/components/blocks/ToolCard.tsx: a single muted
 * trigger line (status icon + name + args summary + chevron) that expands to
 * detail — the reference deliberately keeps tool calls quiet so the agent's
 * prose reads first. `toolFamily.ts` carries the per-family classification
 * and field extraction so this file stays about layout.
 *
 * Families and what they add over the generic parameters+output panel:
 *   - bash: the command as the summary, a detected exit/timeout status line.
 *   - read: path (+ line range) as the summary.
 *   - write / edit: path as the summary, plus a `DiffView` (a synthetic
 *     before/after diff for edit, a whole-file addition for write).
 *   - glob / grep: pattern as the summary, output rendered as a match list.
 *   - web: the URL as the summary.
 *   - mcp: a "server · tool" badge, output read as an MCP `CallToolResult`
 *     (text / image / anything else as JSON).
 *   - task: a link that scrolls to the spawned sub-agent's block.
 *   - other: the pre-existing generic behaviour, unchanged.
 *
 * Truncated output (R25) has two shapes: `fullOutput` already inline on the
 * block (small enough to keep on the row), or `outputRef` pointing at a
 * `tool_outputs` row fetched on demand via `blocks.getOutput` — "Show full
 * output" triggers that fetch the first time it's clicked.
 */
import {
  ChevronRightIcon,
  CircleSlashIcon,
  GlobeIcon,
  Loader2Icon,
  PlugIcon,
  UsersIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import { useState } from "react";
import type { SubagentBlock, ToolCallBlock, ToolCallFamily } from "@capygen/shared";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ipc } from "@/lib/ipc";
import { useAppStore } from "@/store/appStore";
import { summarizeToolInput, toPrettyJson } from "./blockFormat";
import { DiffView } from "./DiffCard";
import {
  bashExitStatus,
  buildEditDiff,
  buildWriteDiff,
  editStrings,
  effectiveFamily,
  familySummary,
  filePath,
  mcpContentItems,
  mcpServerAndTool,
  splitResultList,
  subagentBlockId,
  writeContent,
  type McpContentItem,
} from "./toolFamily";

export function ToolCallCard({ block }: { block: ToolCallBlock }) {
  const family = effectiveFamily(block);
  const summary = familySummary(family, block.input) ?? summarizeToolInput(block.input);
  const inputJson = toPrettyJson(block.input);
  const outputText =
    block.output === undefined
      ? null
      : typeof block.output === "string"
        ? block.output
        : toPrettyJson(block.output);
  // R25's inline stub: the harness kept the whole result on the row.
  const inlineFullText =
    block.truncated && block.fullOutput !== undefined
      ? typeof block.fullOutput === "string"
        ? block.fullOutput
        : toPrettyJson(block.fullOutput)
      : null;

  // R25's out-of-row stub: fetched lazily via `blocks.getOutput`, once, the
  // first time "Show full output" is clicked.
  const [fetchedFullText, setFetchedFullText] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const canFetchFull = block.truncated && inlineFullText === null && Boolean(block.outputRef);
  async function fetchFullOutput(): Promise<void> {
    if (!canFetchFull || fetchedFullText !== null || fetching) return;
    setFetching(true);
    try {
      const row = await ipc().invoke("blocks.getOutput", { id: block.outputRef as string });
      const content = row?.content;
      setFetchedFullText(
        content === undefined
          ? "(the full output is no longer available)"
          : typeof content === "string"
            ? content
            : toPrettyJson(content),
      );
    } catch (err) {
      setFetchedFullText(`(could not load the full output: ${describeError(err)})`);
    } finally {
      setFetching(false);
    }
  }
  const fullText = inlineFullText ?? fetchedFullText;

  const mcp = family === "mcp" ? mcpServerAndTool(block) : null;
  const mcpItems = family === "mcp" && block.output !== undefined ? mcpContentItems(block.output) : null;
  const listResult =
    (family === "glob" || family === "grep") && typeof outputText === "string"
      ? splitResultList(outputText)
      : null;
  const editDiff =
    family === "edit"
      ? (() => {
          const strings = editStrings(block.input);
          return strings ? buildEditDiff(strings.oldString, strings.newString) : null;
        })()
      : null;
  const writeDiff =
    family === "write"
      ? (() => {
          const content = writeContent(block.input);
          const path = filePath(block.input);
          return content !== undefined && path ? { path, diff: buildWriteDiff(content) } : null;
        })()
      : null;
  const editPath = family === "edit" ? filePath(block.input) : undefined;
  const exitStatus = family === "bash" ? bashExitStatus(outputText) : undefined;

  return (
    <Collapsible
      defaultOpen={false}
      className="group w-full"
      data-testid="block-tool-call"
      data-status={block.status}
      data-family={family}
    >
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-1.5 py-0.5 text-left text-sm text-muted-foreground transition-colors hover:text-foreground">
        <StatusIcon status={block.status} family={family} />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium text-foreground">{block.name}</span>
          {mcp ? (
            <span className="ml-1.5 text-xs text-muted-foreground">
              {mcp.server} · {mcp.tool}
            </span>
          ) : null}
          {summary ? <span className="text-muted-foreground"> {summary}</span> : null}
        </span>
        <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 ml-2 flex flex-col gap-2 border-l border-border-weak py-1 pl-3">
        {editDiff && editPath ? (
          <DiffView
            testId="tool-call-diff"
            path={editPath}
            patch={editDiff.patch}
            additions={editDiff.additions}
            deletions={editDiff.deletions}
          />
        ) : null}
        {writeDiff ? (
          <DiffView
            testId="tool-call-diff"
            path={writeDiff.path}
            patch={writeDiff.diff.patch}
            additions={writeDiff.diff.additions}
            deletions={writeDiff.diff.deletions}
          />
        ) : null}
        <CodePanel title="Parameters" text={inputJson} />
        {exitStatus ? (
          <p className="text-xs text-muted-foreground">
            Status: <span className="text-foreground">{exitStatus}</span>
          </p>
        ) : null}
        {family === "task" ? <SubagentLink toolUseId={block.toolUseId} /> : null}
        {mcpItems ? (
          <McpResultView items={mcpItems} />
        ) : listResult ? (
          <ResultListView header={listResult.header} items={listResult.items} />
        ) : outputText !== null ? (
          <CodePanel
            title="Output"
            text={outputText}
            truncated={block.truncated}
            fetching={fetching}
            {...(fullText !== null ? { fullText } : {})}
            {...(canFetchFull ? { onRequestFull: fetchFullOutput } : {})}
          />
        ) : block.status === "running" || block.status === "pending" ? (
          <div className="flex items-center gap-2 rounded-md border border-dashed border-border-weak bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
            <Loader2Icon className="size-3.5 shrink-0 animate-spin text-info" />
            Waiting for output…
          </div>
        ) : block.status === "denied" ? (
          <div className="rounded-md border border-dashed border-border-weak bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
            Denied before it ran.
          </div>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function StatusIcon({
  status,
  family,
}: {
  status: ToolCallBlock["status"];
  family: ToolCallFamily;
}) {
  switch (status) {
    case "pending":
    case "running":
      return <Loader2Icon className="size-3.5 shrink-0 animate-spin text-info" />;
    case "error":
      return <XCircleIcon className="size-3.5 shrink-0 text-destructive" />;
    case "denied":
      return <CircleSlashIcon className="size-3.5 shrink-0 text-muted-foreground" />;
    case "success":
    default:
      if (family === "web") return <GlobeIcon className="size-3.5 shrink-0" />;
      if (family === "mcp") return <PlugIcon className="size-3.5 shrink-0" />;
      if (family === "task") return <UsersIcon className="size-3.5 shrink-0" />;
      return <WrenchIcon className="size-3.5 shrink-0" />;
  }
}

/** Scrolls to the sub-agent block a `Task`-family call spawned, when it has
 *  arrived in this session (SPEC R6 item 3: "task … links to the subagent
 *  block"). Renders nothing when the spawn has no block yet or the id can't
 *  be derived (no `toolUseId` — an API-runtime task call, say). */
function SubagentLink({ toolUseId }: { toolUseId: string | undefined }) {
  const targetId = subagentBlockId(toolUseId);
  const target = useAppStore((s) => (targetId ? s.blocks[targetId] : undefined)) as
    | SubagentBlock
    | undefined;
  if (!targetId || !target) return null;
  return (
    <button
      type="button"
      data-testid="tool-call-subagent-link"
      onClick={() =>
        document
          .getElementById(`block-${targetId}`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" })
      }
      className="flex w-fit items-center gap-1.5 rounded-md border border-border-weak bg-muted/30 px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      <UsersIcon className="size-3 shrink-0" />
      View sub-agent “{target.name}”
    </button>
  );
}

function McpResultView({ items }: { items: McpContentItem[] }) {
  return (
    <div className="flex flex-col gap-2" data-testid="tool-call-mcp-result">
      {items.map((item, i) => {
        if (item.type === "text" && typeof item.text === "string") {
          return <CodePanel key={i} title={`Result ${i + 1} · text`} text={item.text} />;
        }
        if (item.type === "image" && typeof item.data === "string") {
          const mime = typeof item.mimeType === "string" ? item.mimeType : "image/png";
          return (
            <img
              key={i}
              src={`data:${mime};base64,${item.data}`}
              alt="MCP tool result"
              className="max-h-64 w-fit rounded-md border border-border-weak"
            />
          );
        }
        return (
          <CodePanel
            key={i}
            title={`Result ${i + 1} · ${typeof item.type === "string" ? item.type : "json"}`}
            text={toPrettyJson(item)}
          />
        );
      })}
    </div>
  );
}

function ResultListView({ header, items }: { header: string | null; items: string[] }) {
  return (
    <div className="flex flex-col gap-1" data-testid="tool-call-result-list">
      {header ? <p className="text-xs text-muted-foreground">{header}</p> : null}
      {items.length > 0 ? (
        <ul className="max-h-80 overflow-auto rounded-md bg-code-bg px-1 py-1 font-mono text-xs">
          {items.map((item, i) => (
            <li key={i} className="truncate rounded px-2 py-0.5 hover:bg-muted/40">
              {item}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function CodePanel({
  title,
  text,
  truncated,
  fullText,
  onRequestFull,
  fetching,
}: {
  title: string;
  text: string;
  truncated?: boolean;
  /** The untruncated value, once known (R25). */
  fullText?: string;
  /** Fetches it (`blocks.getOutput`) when it isn't known yet. */
  onRequestFull?: () => void;
  fetching?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded && fullText !== undefined ? fullText : text;
  const canExpand = Boolean(truncated && (fullText !== undefined || onRequestFull));

  function toggle(): void {
    if (!expanded && fullText === undefined) onRequestFull?.();
    setExpanded((v) => !v);
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {title}
        {truncated ? <span className="normal-case text-warning">truncated</span> : null}
        {canExpand ? (
          <button
            type="button"
            data-testid="tool-output-expand"
            onClick={toggle}
            className="normal-case text-info hover:underline"
          >
            {expanded
              ? "Show less"
              : fetching
                ? "Loading…"
                : fullText !== undefined
                  ? `Show all ${fullText.length} characters`
                  : "Show full output"}
          </button>
        ) : null}
      </div>
      <pre className="max-h-80 overflow-auto rounded-md bg-code-bg px-3 py-2 font-mono text-xs whitespace-pre-wrap break-words text-foreground">
        {shown || "(empty)"}
      </pre>
    </div>
  );
}
