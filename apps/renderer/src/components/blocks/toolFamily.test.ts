import { describe, expect, it } from "vitest";
import {
  bashCommand,
  bashExitStatus,
  buildEditDiff,
  buildWriteDiff,
  editStrings,
  effectiveFamily,
  familySummary,
  fetchUrl,
  filePath,
  lineRange,
  mcpContentItems,
  mcpServerAndTool,
  searchGlob,
  searchPattern,
  splitResultList,
  subagentBlockId,
  writeContent,
} from "./toolFamily";

describe("effectiveFamily", () => {
  it("classifies Claude Code's own native tool names", () => {
    expect(effectiveFamily({ family: undefined, name: "Bash", serverName: undefined })).toBe("bash");
    expect(effectiveFamily({ family: undefined, name: "Read", serverName: undefined })).toBe("read");
    expect(effectiveFamily({ family: undefined, name: "Write", serverName: undefined })).toBe("write");
    expect(effectiveFamily({ family: undefined, name: "Edit", serverName: undefined })).toBe("edit");
    expect(effectiveFamily({ family: undefined, name: "Glob", serverName: undefined })).toBe("glob");
    expect(effectiveFamily({ family: undefined, name: "Grep", serverName: undefined })).toBe("grep");
    expect(effectiveFamily({ family: undefined, name: "WebFetch", serverName: undefined })).toBe("web");
    expect(effectiveFamily({ family: undefined, name: "WebSearch", serverName: undefined })).toBe("web");
    expect(effectiveFamily({ family: undefined, name: "Task", serverName: undefined })).toBe("task");
  });

  it("classifies capygen's own API tool runtime names", () => {
    expect(effectiveFamily({ family: undefined, name: "read_file", serverName: undefined })).toBe("read");
    expect(effectiveFamily({ family: undefined, name: "edit_file", serverName: undefined })).toBe("edit");
    expect(effectiveFamily({ family: undefined, name: "web_fetch", serverName: undefined })).toBe("web");
  });

  it("prefers an explicit family over name-based classification", () => {
    expect(effectiveFamily({ family: "other", name: "Bash", serverName: undefined })).toBe("other");
  });

  it("reads mcp from a serverName or an mcp__ prefixed name", () => {
    expect(effectiveFamily({ family: undefined, name: "anything", serverName: "higgsfield" })).toBe("mcp");
    expect(effectiveFamily({ family: undefined, name: "mcp__x__y", serverName: undefined })).toBe("mcp");
  });

  it("falls back to other for an unrecognised name", () => {
    expect(effectiveFamily({ family: undefined, name: "custom_tool", serverName: undefined })).toBe("other");
  });
});

describe("field extraction", () => {
  it("reads a bash command", () => {
    expect(bashCommand({ command: "ls -la" })).toBe("ls -la");
    expect(bashCommand({})).toBeUndefined();
  });

  it("reads path or file_path", () => {
    expect(filePath({ path: "a.ts" })).toBe("a.ts");
    expect(filePath({ file_path: "b.ts" })).toBe("b.ts");
    expect(filePath({})).toBeUndefined();
  });

  it("formats an offset/limit line range", () => {
    expect(lineRange({ offset: 10, limit: 5 })).toBe("lines 10-14");
    expect(lineRange({ offset: 10 })).toBe("from line 10");
    expect(lineRange({})).toBeUndefined();
  });

  it("reads old_string/new_string/replace_all", () => {
    expect(editStrings({ old_string: "a", new_string: "b", replace_all: true })).toEqual({
      oldString: "a",
      newString: "b",
      replaceAll: true,
    });
    expect(editStrings({ old_string: "a" })).toBeNull();
  });

  it("reads write content", () => {
    expect(writeContent({ content: "hello" })).toBe("hello");
    expect(writeContent({})).toBeUndefined();
  });

  it("reads pattern and grep's glob filter", () => {
    expect(searchPattern({ pattern: "TODO" })).toBe("TODO");
    expect(searchGlob({ glob: "**/*.ts" })).toBe("**/*.ts");
  });

  it("reads a fetch url", () => {
    expect(fetchUrl({ url: "https://example.com" })).toBe("https://example.com");
  });

  it("lifts a bash tool's own embedded exit/timeout status", () => {
    expect(bashExitStatus("$ ls\n(exit code 0)\nfiles")).toBe("exit code 0");
    expect(bashExitStatus("$ sleep\n(timed out after 1000 ms)\n")).toBe("timed out after 1000 ms");
    expect(bashExitStatus("plain output, no status line")).toBeUndefined();
    expect(bashExitStatus(null)).toBeUndefined();
  });
});

describe("familySummary", () => {
  it("summarises each family from its own fields", () => {
    expect(familySummary("bash", { command: "pnpm test" })).toBe("pnpm test");
    expect(familySummary("read", { path: "a.ts", offset: 1, limit: 10 })).toBe("a.ts (lines 1-10)");
    expect(familySummary("write", { path: "a.ts" })).toBe("a.ts");
    expect(familySummary("edit", { path: "a.ts" })).toBe("a.ts");
    expect(familySummary("glob", { pattern: "**/*.ts" })).toBe("**/*.ts");
    expect(familySummary("grep", { pattern: "TODO", glob: "*.ts" })).toBe("TODO (*.ts)");
    expect(familySummary("web", { url: "https://example.com" })).toBe("https://example.com");
  });

  it("defers to the generic summarizer for mcp/task/other", () => {
    expect(familySummary("mcp", { anything: 1 })).toBeNull();
    expect(familySummary("task", {})).toBeNull();
    expect(familySummary("other", {})).toBeNull();
  });
});

describe("mcpServerAndTool", () => {
  it("prefers an explicit serverName", () => {
    expect(mcpServerAndTool({ name: "generate_image", serverName: "higgsfield" })).toEqual({
      server: "higgsfield",
      tool: "generate_image",
    });
  });

  it("splits Claude's mcp__<server>__<tool> naming", () => {
    expect(mcpServerAndTool({ name: "mcp__higgsfield__generate_image", serverName: undefined })).toEqual({
      server: "higgsfield",
      tool: "generate_image",
    });
  });

  it("falls back when the name isn't namespaced", () => {
    expect(mcpServerAndTool({ name: "weird_tool", serverName: undefined })).toEqual({
      server: "MCP",
      tool: "weird_tool",
    });
  });
});

describe("diff builders", () => {
  it("trims common prefix/suffix around an edit", () => {
    const diff = buildEditDiff("line1\nline2\nline3", "line1\nCHANGED\nline3");
    expect(diff.additions).toBe(1);
    expect(diff.deletions).toBe(1);
    expect(diff.patch).toContain("-line2");
    expect(diff.patch).toContain("+CHANGED");
    expect(diff.patch).not.toContain("-line1");
  });

  it("renders a write as a whole-file addition", () => {
    const diff = buildWriteDiff("a\nb");
    expect(diff.additions).toBe(2);
    expect(diff.deletions).toBe(0);
    expect(diff.patch).toContain("+a");
    expect(diff.patch).toContain("+b");
  });
});

describe("mcpContentItems", () => {
  it("reads an MCP CallToolResult's content array", () => {
    const items = mcpContentItems({ content: [{ type: "text", text: "hi" }] });
    expect(items).toEqual([{ type: "text", text: "hi" }]);
  });

  it("returns null for anything not shaped like that", () => {
    expect(mcpContentItems("plain string")).toBeNull();
    expect(mcpContentItems({ content: [] })).toBeNull();
    expect(mcpContentItems(null)).toBeNull();
  });
});

describe("subagentBlockId", () => {
  it("derives the block id ClaudeHarness uses for a spawned sub-agent", () => {
    expect(subagentBlockId("tool_123")).toBe("subagent:tool_123");
    expect(subagentBlockId(undefined)).toBeNull();
  });
});

describe("splitResultList", () => {
  it("splits a header line from a glob/grep result's matches", () => {
    const result = splitResultList("2 matches for /TODO/ under .\na.ts:1:// TODO\nb.ts:2:// TODO");
    expect(result?.header).toBe("2 matches for /TODO/ under .");
    expect(result?.items).toEqual(["a.ts:1:// TODO", "b.ts:2:// TODO"]);
  });

  it("returns null for text that doesn't look like that shape", () => {
    expect(splitResultList("some error message")).toBeNull();
  });
});
