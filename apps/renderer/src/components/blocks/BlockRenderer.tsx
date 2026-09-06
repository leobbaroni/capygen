/**
 * One renderer per block kind (CONTEXT.md §Block; SPEC R6). The `switch` is
 * exhaustive on purpose — adding a kind to the `Block` union in
 * `packages/shared` makes this a type error rather than a silently dropped
 * block.
 */
import type { Block } from "@capygen/shared";
import { DiffCard } from "./DiffCard";
import { ElicitationCard } from "./ElicitationCard";
import { ErrorCard } from "./ErrorCard";
import { PermissionCard } from "./PermissionCard";
import { QuestionCard } from "./QuestionCard";
import { SubagentCard } from "./SubagentCard";
import { TextBlockView } from "./TextBlockView";
import { ThinkingCard } from "./ThinkingCard";
import { ToolCallCard } from "./ToolCallCard";
import { UsageLine } from "./UsageLine";
import { WidgetCard } from "./WidgetCard";

/** Unreachable if every `Block` kind above has a `case` — a compile error
 * otherwise, restoring the exhaustiveness the file's header comment promises
 * (a bare switch with no `default` does not itself enforce that in TS). */
function assertNever(value: never): never {
  throw new Error(`BlockRenderer: no card for block kind ${JSON.stringify(value)}`);
}

export function BlockRenderer({ block, isUser }: { block: Block; isUser: boolean }) {
  switch (block.kind) {
    case "text":
      return <TextBlockView block={block} isUser={isUser} />;
    case "thinking":
      return <ThinkingCard block={block} />;
    case "tool_call":
      return <ToolCallCard block={block} />;
    case "diff":
      return <DiffCard block={block} />;
    case "permission":
      return <PermissionCard block={block} />;
    case "question":
      return <QuestionCard block={block} />;
    case "subagent":
      return <SubagentCard block={block} />;
    case "error":
      return <ErrorCard block={block} />;
    case "usage":
      return <UsageLine block={block} />;
    case "widget":
      return <WidgetCard block={block} />;
    case "elicitation":
      return <ElicitationCard block={block} />;
    default:
      return assertNever(block);
  }
}
