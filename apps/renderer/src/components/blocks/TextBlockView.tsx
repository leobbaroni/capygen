/**
 * Text block. Rendered as markdown (`react-markdown` + `remark-gfm`, per the
 * task brief) rather than the reference's full ChatMarkdown + shiki stack —
 * capygen has no syntax highlighter yet, so fenced code renders as a plain
 * monospace block; everything else (headings, lists, tables, links, inline
 * code, blockquotes) gets Tailwind classes instead of the `@tailwindcss/
 * typography` plugin, which isn't installed.
 */
import React from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { TextBlock } from "@capygen/shared";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/appStore";

const BUILT_INS = new Set(["/compact", "/context", "/effort", "/model", "/help", "/clear", "/cost"]);
function highlight(value: React.ReactNode, recognized: ReadonlySet<string>): React.ReactNode {
  if (typeof value !== "string") return value;
  const parts = value.split(/((?:^|\s)(?:[@/])[\w:.-]+(?![\w/-]))/g);
  return parts.map((part, index) => { const token = part.trim().toLowerCase(); return recognized.has(token) ? <span key={index}>{part.match(/^\s*/)?.[0]}<span className="rounded bg-primary/10 text-primary">{part.trim()}</span></span> : part; });
}

const components: Components = {
  p: ({ children }) => <p className="mb-2 leading-relaxed last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="mb-2 list-disc pl-5 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2 list-decimal pl-5 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="mb-0.5">{children}</li>,
  h1: ({ children }) => <h1 className="mb-2 text-lg font-semibold">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-2 text-base font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1.5 text-sm font-semibold">{children}</h3>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="mb-2 border-l-2 border-border pl-3 text-muted-foreground last:mb-0">
      {children}
    </blockquote>
  ),
  code: ({ className, children, ...props }) => {
    const isBlock = /language-/.test(className ?? "");
    if (isBlock) {
      return (
        <pre className="mb-2 overflow-x-auto rounded-md bg-code-bg px-3 py-2 font-mono text-xs last:mb-0">
          <code {...props}>{children}</code>
        </pre>
      );
    }
    return (
      <code className="rounded bg-code-bg px-1 py-0.5 font-mono text-[0.9em]" {...props}>
        {children}
      </code>
    );
  },
  table: ({ children }) => (
    <div className="mb-2 overflow-x-auto last:mb-0">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border-weak px-2 py-1 text-left font-medium">{children}</th>
  ),
  td: ({ children }) => <td className="border border-border-weak px-2 py-1">{children}</td>,
};

export function TextBlockView({ block, isUser }: { block: TextBlock; isUser: boolean }) {
  const agents = useAppStore((state) => state.agents);
  const commands = useAppStore((state) => state.commands);
  const recognized = new Set([...BUILT_INS, ...commands.map((command) => command.name.toLowerCase()), ...agents.map((agent) => `@${agent.mentionName.toLowerCase()}`)]);
  const markdownComponents: Components = isUser ? { ...components, p: ({ children }) => <p className="mb-2 leading-relaxed last:mb-0">{React.Children.map(children, (child) => highlight(child, recognized))}</p> } : components;
  return (
    <div
      data-testid="block-text"
      className={cn(
        "text-ui break-words",
        isUser
          ? "rounded-2xl bg-secondary px-3.5 py-2 text-secondary-foreground"
          : "text-foreground",
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {block.text}
      </ReactMarkdown>
    </div>
  );
}
