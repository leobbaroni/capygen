/**
 * The local tool runtime (SPEC R9, R25, R27).
 *
 * Everything that touches the filesystem runs against a real `mkdtemp`
 * directory: these tools exist to be correct about paths, line ranges and
 * unique-string edits on Windows, and a mocked `fs` would assert the mock.
 * Everything that would touch a *process* or the *network* (bash, ripgrep,
 * web_fetch) goes through its injected double, so the suite stays offline and
 * fast — those seams (`ShellRunner`, `RipgrepRunner`, `FetchLike`) exist for
 * exactly this.
 */
import fs from "node:fs/promises";
import os from "node:os";
import { realpathSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_IGNORED_DIRS,
  askUserQuestionTool,
  builtinTools,
  clampText,
  createBashTool,
  createGrepTool,
  createWebFetchTool,
  editFileTool,
  gateDenialMessage,
  gateFor,
  globToRegExp,
  globTool,
  htmlToText,
  listDirTool,
  parseAskInput,
  readFileTool,
  resolvePath,
  shellFor,
  toolMap,
  walkFiles,
  writeFileTool,
  type PermissionClass,
  type ShellResult,
  type ToolContext,
  type ToolDefinition,
} from "../src/tools/index.js";
import type { Question } from "@capygen/shared";

let root = "";

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "capygen-tools-"));
  await fs.mkdir(path.join(root, "src", "deep"), { recursive: true });
  await fs.mkdir(path.join(root, "node_modules", "junk"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src", "a.ts"),
    "line one\nline two\nline three\nline four\n",
    "utf8",
  );
  await fs.writeFile(path.join(root, "src", "deep", "b.ts"), "needle here\nother\n", "utf8");
  await fs.writeFile(path.join(root, "README.md"), "# title\nneedle in markdown\n", "utf8");
  await fs.writeFile(path.join(root, "node_modules", "junk", "c.ts"), "needle\n", "utf8");
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: root,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    maxOutputChars: 64 * 1024,
    ask: async () => ({}),
    ...overrides,
  };
}

describe("read_file", () => {
  it("numbers lines and reads the whole file by default", async () => {
    const result = await readFileTool.run({ path: "src/a.ts" }, ctx());
    expect(result.content).toContain("     1\tline one");
    expect(result.content).toContain("     4\tline four");
    expect(result.isError).toBeUndefined();
  });

  it("reads a slice with offset and limit, and says so in the header", async () => {
    const result = await readFileTool.run({ path: "src/a.ts", offset: 2, limit: 2 }, ctx());
    expect(result.content).toContain("(lines 2-3 of 5)");
    expect(result.content).toContain("     2\tline two");
    expect(result.content).toContain("     3\tline three");
    expect(result.content).not.toContain("line one");
  });

  it("reports a missing file as a tool error, not a throw", async () => {
    const result = await readFileTool.run({ path: "nope.ts" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No such file");
  });

  it("refuses a directory and points at list_dir", async () => {
    const result = await readFileTool.run({ path: "src" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("list_dir");
  });

  it("resolves a relative path against the project directory, not process.cwd()", () => {
    // Compared against the *canonical* root: `os.tmpdir()` hands back an 8.3
    // alias on Windows, and `resolvePath` now returns the real location it
    // actually checked rather than the spelling it was given.
    const real = realpathSync.native(root);
    expect(resolvePath(root, "src/a.ts")).toBe(path.join(real, "src", "a.ts"));
    expect(resolvePath(root, path.join(root, "src", "a.ts"))).toBe(
      path.join(real, "src", "a.ts"),
    );
  });

  it("refuses a path outside the project directory, absolute or via ..", () => {
    // `read` is an `allow` class in every permission mode, plan included, so
    // the boundary is the only thing between a model and ~/.ssh (R27).
    for (const target of [
      path.join(os.homedir(), ".ssh", "id_rsa"),
      path.join("..", "..", "other-project", ".env"),
    ]) {
      expect(() => resolvePath(root, target)).toThrow(/outside the project directory/);
    }
    expect(resolvePath(root, ".")).toBe(realpathSync.native(root));
  });

  it("reports an out-of-project read as a tool error, not a crash", async () => {
    const outside = path.join(os.homedir(), ".ssh", "id_rsa");
    await expect(readFileTool.run({ path: outside }, ctx())).rejects.toThrow(
      /outside the project directory/,
    );
  });
});

describe("write_file and edit_file", () => {
  it("writes a new file, creating parent directories", async () => {
    const result = await writeFileTool.run(
      { path: "generated/nested/new.txt", content: "hello\n" },
      ctx(),
    );
    expect(result.content).toContain("Wrote");
    expect(await fs.readFile(path.join(root, "generated/nested/new.txt"), "utf8")).toBe("hello\n");
  });

  it("replaces a unique string", async () => {
    const file = path.join(root, "edit-unique.txt");
    await fs.writeFile(file, "alpha\nbeta\ngamma\n", "utf8");
    const result = await editFileTool.run(
      { path: "edit-unique.txt", old_string: "beta", new_string: "BETA" },
      ctx(),
    );
    expect(result.isError).toBeUndefined();
    expect(await fs.readFile(file, "utf8")).toBe("alpha\nBETA\ngamma\n");
  });

  it("refuses an ambiguous edit and says how many matches there were", async () => {
    const file = path.join(root, "edit-ambiguous.txt");
    await fs.writeFile(file, "x\nx\nx\n", "utf8");
    const result = await editFileTool.run(
      { path: "edit-ambiguous.txt", old_string: "x", new_string: "y" },
      ctx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("occurs 3 times");
    // The file must be untouched after a refused edit.
    expect(await fs.readFile(file, "utf8")).toBe("x\nx\nx\n");
  });

  it("replaces every occurrence when replace_all is set", async () => {
    const file = path.join(root, "edit-all.txt");
    await fs.writeFile(file, "x\nx\nx\n", "utf8");
    const result = await editFileTool.run(
      { path: "edit-all.txt", old_string: "x", new_string: "y", replace_all: true },
      ctx(),
    );
    expect(result.content).toContain("Replaced 3 occurrences");
    expect(await fs.readFile(file, "utf8")).toBe("y\ny\ny\n");
  });

  it("tells the model to re-read when the old string is not there", async () => {
    const result = await editFileTool.run(
      { path: "src/a.ts", old_string: "not present", new_string: "z" },
      ctx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("whitespace and indentation must match");
  });
});

describe("list_dir", () => {
  it("lists directories first with a trailing slash", async () => {
    const result = await listDirTool.run({ path: "src" }, ctx());
    const lines = result.content.split("\n").slice(1);
    expect(lines[0]).toBe("deep/");
    expect(lines).toContain("a.ts");
  });
});

describe("glob", () => {
  it("compiles the patterns a coding agent actually types", () => {
    expect(globToRegExp("src/**/*.ts").test("src/deep/b.ts")).toBe(true);
    // `**/` may match zero segments.
    expect(globToRegExp("src/**/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("src/a.ts")).toBe(false);
    expect(globToRegExp("**/*.{json,md}").test("README.md")).toBe(true);
    expect(globToRegExp("src/?.ts").test("src/a.ts")).toBe(true);
  });

  it("matches files and skips node_modules", async () => {
    const result = await globTool.run({ pattern: "**/*.ts" }, ctx());
    expect(result.content).toContain("src/a.ts");
    expect(result.content).toContain("src/deep/b.ts");
    expect(result.content).not.toContain("node_modules");
  });

  it("says so plainly when nothing matches", async () => {
    const result = await globTool.run({ pattern: "**/*.rs" }, ctx());
    expect(result.content).toContain("No files match");
  });

  it("walkFiles honours its limit", async () => {
    const found = await walkFiles({ root, match: () => true, limit: 2 });
    expect(found).toHaveLength(2);
    expect(DEFAULT_IGNORED_DIRS.has("node_modules")).toBe(true);
  });
});

describe("grep", () => {
  it("falls back to the in-process search when ripgrep is absent", async () => {
    const grep = createGrepTool({ ripgrep: null });
    const result = await grep.run({ pattern: "needle" }, ctx());
    expect(result.content).toContain("(in-process)");
    expect(result.content).toContain("src/deep/b.ts:1:needle here");
    expect(result.content).toContain("README.md:2:needle in markdown");
    expect(result.content).not.toContain("node_modules");
  });

  it("uses ripgrep when it answers, and passes the flags it was given", async () => {
    const seen: string[][] = [];
    const grep = createGrepTool({
      ripgrep: {
        run: async (args) => {
          seen.push(args);
          return "./src/deep/b.ts:1:needle here\n";
        },
      },
    });
    const result = await grep.run(
      { pattern: "needle", glob: "**/*.ts", ignore_case: true, limit: 5 },
      ctx(),
    );
    expect(result.content).toContain("(ripgrep)");
    // `./` is stripped so the output matches the fallback's shape.
    expect(result.content).toContain("src/deep/b.ts:1:needle here");
    const args = seen[0] as string[];
    expect(args).toContain("--ignore-case");
    expect(args).toContain("--glob");
    expect(args).toContain("**/*.ts");
    expect(args).toContain("--max-count");
    expect(args).toContain("5");
  });

  it("falls back when ripgrep fails rather than reporting no matches", async () => {
    const grep = createGrepTool({ ripgrep: { run: async () => null } });
    const result = await grep.run({ pattern: "needle" }, ctx());
    expect(result.content).toContain("(in-process)");
    expect(result.content).toContain("needle here");
  });

  it("reports an invalid regular expression as a tool error", async () => {
    const grep = createGrepTool({ ripgrep: null });
    const result = await grep.run({ pattern: "([" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid pattern");
  });
});

describe("bash", () => {
  it("runs PowerShell on Windows and sh elsewhere", () => {
    expect(shellFor("win32", "echo hi")).toEqual({
      file: "powershell",
      args: ["-NoProfile", "-NonInteractive", "-Command", "echo hi"],
    });
    expect(shellFor("linux", "echo hi")).toEqual({ file: "/bin/sh", args: ["-c", "echo hi"] });
  });

  it("says PowerShell in its description on Windows, so the model writes PowerShell", () => {
    const tool = createBashTool({ platform: "win32", shell: { run: async () => empty() } });
    expect(tool.description).toContain("PowerShell");
    expect(tool.permissionClass).toBe("execute");
    expect(tool.family).toBe("bash");
  });

  it("reports the exit code and marks a non-zero exit as an error", async () => {
    const tool = createBashTool({
      shell: { run: async () => ({ output: "boom", code: 3, signal: null, timedOut: false }) },
    });
    const result = await tool.run({ command: "fail" }, ctx());
    expect(result.content).toContain("exit code 3");
    expect(result.content).toContain("boom");
    expect(result.isError).toBe(true);
  });

  it("clamps a huge output to a stub and keeps the whole thing (R25)", async () => {
    const huge = "x".repeat(5_000);
    const tool = createBashTool({
      shell: { run: async () => ({ output: huge, code: 0, signal: null, timedOut: false }) },
    });
    const result = await tool.run({ command: "spam" }, ctx({ maxOutputChars: 100 }));
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBeLessThan(300);
    expect(result.content).toContain("more characters (truncated)");
    expect((result.fullOutput ?? "").length).toBeGreaterThan(5_000);
  });

  it("passes a cleaned environment and the resolved cwd to the shell", async () => {
    let seen: { cwd: string; env: NodeJS.ProcessEnv } | null = null;
    const tool = createBashTool({
      shell: {
        run: async (_command, options) => {
          seen = { cwd: options.cwd, env: options.env };
          return empty();
        },
      },
    });
    await tool.run({ command: "pwd", cwd: "src" }, ctx({ env: { CLAUDECODE: "1", PATH: "/x" } }));
    const captured = seen as unknown as { cwd: string; env: NodeJS.ProcessEnv };
    expect(captured.cwd).toBe(path.join(realpathSync.native(root), "src"));
    expect(captured.env.CLAUDECODE).toBeUndefined();
    expect(captured.env.PYTHONUTF8).toBe("1");
  });

  it("marks a timeout as an error and says how long it waited", async () => {
    const tool = createBashTool({
      shell: { run: async () => ({ output: "", code: null, signal: null, timedOut: true }) },
    });
    const result = await tool.run({ command: "sleep", timeout_ms: 1_500 }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("timed out after 1500 ms");
  });
});

function empty(): ShellResult {
  return { output: "", code: 0, signal: null, timedOut: false };
}

describe("web_fetch", () => {
  it("refuses anything that is not https before making a request", async () => {
    let called = false;
    const tool = createWebFetchTool({
      fetch: (async () => {
        called = true;
        throw new Error("should not be reached");
      }) as never,
    });
    for (const url of ["http://example.com", "file:///c:/secrets.txt", "data:text/plain,hi"]) {
      const result = await tool.run({ url }, ctx());
      expect(result.isError).toBe(true);
      expect(result.content).toContain("only allows https");
    }
    expect(called).toBe(false);
  });

  it("reduces HTML to readable text", () => {
    const text = htmlToText(
      "<html><head><style>p{color:red}</style></head><body><h1>Title</h1>" +
        "<p>First &amp; best</p><script>alert(1)</script><ul><li>one</li><li>two</li></ul></body></html>",
    );
    expect(text).toContain("Title");
    expect(text).toContain("First & best");
    expect(text).toContain("- one");
    expect(text).not.toContain("alert(1)");
    expect(text).not.toContain("color:red");
  });

  it("returns JSON untouched and reports the final URL", async () => {
    const tool = createWebFetchTool({
      fetch: (async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        url: "https://example.com/final",
        headers: { get: () => "application/json" },
        text: async () => '{"a":1}',
      })) as never,
    });
    const result = await tool.run({ url: "https://example.com/start" }, ctx());
    expect(result.content).toContain("https://example.com/final");
    expect(result.content).toContain('{"a":1}');
  });

  it("caps the body at max_bytes", async () => {
    const tool = createWebFetchTool({
      fetch: (async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        url: "https://example.com/big",
        headers: { get: () => "text/plain" },
        text: async () => "y".repeat(50_000),
      })) as never,
    });
    const result = await tool.run({ url: "https://example.com/big", max_bytes: 2_000 }, ctx());
    expect(result.content).toContain("truncated at 2000 bytes");
  });

  it("refuses a redirect that downgrades to http (SSRF: the scheme is re-checked per hop)", async () => {
    const seen: string[] = [];
    const tool = createWebFetchTool({
      fetch: (async (url: string) => {
        seen.push(url);
        return {
          ok: false,
          status: 302,
          statusText: "Found",
          url,
          headers: {
            get: (n: string) =>
              n.toLowerCase() === "location"
                ? "http://169.254.169.254/latest/meta-data/"
                : null,
          },
          text: async () => "",
        };
      }) as never,
    });
    const result = await tool.run({ url: "https://attacker.example/go" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("only allows https");
    // The metadata endpoint was never requested.
    expect(seen).toEqual(["https://attacker.example/go"]);
  });

  it("refuses an https redirect to a loopback/private address", async () => {
    const tool = createWebFetchTool({
      fetch: (async (url: string) => ({
        ok: false,
        status: 307,
        statusText: "Temporary Redirect",
        url,
        headers: {
          get: (n: string) => (n.toLowerCase() === "location" ? "https://127.0.0.1/admin" : null),
        },
        text: async () => "",
      })) as never,
    });
    const result = await tool.run({ url: "https://example.com/go" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("loopback/private address");
  });

  it("refuses a private address on the first hop too", async () => {
    let called = false;
    const tool = createWebFetchTool({
      fetch: (async () => {
        called = true;
        throw new Error("should not be reached");
      }) as never,
    });
    for (const url of [
      "https://localhost/x",
      "https://127.0.0.1/x",
      "https://10.1.2.3/x",
      "https://192.168.0.1/x",
      "https://169.254.169.254/x",
    ]) {
      const result = await tool.run({ url }, ctx());
      expect(result.isError).toBe(true);
      expect(result.content).toContain("loopback/private address");
    }
    expect(called).toBe(false);
  });

  it("follows an https → https redirect and returns the final body", async () => {
    const seen: string[] = [];
    const tool = createWebFetchTool({
      fetch: (async (url: string) => {
        seen.push(url);
        if (url.endsWith("/go")) {
          return {
            ok: false,
            status: 302,
            statusText: "Found",
            url,
            headers: {
              get: (n: string) => (n.toLowerCase() === "location" ? "/final" : null),
            },
            text: async () => "",
          };
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          url,
          headers: { get: (n: string) => (n.toLowerCase() === "location" ? null : "text/plain") },
          text: async () => "arrived",
        };
      }) as never,
    });
    const result = await tool.run({ url: "https://example.com/go" }, ctx());
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("arrived");
    expect(seen).toEqual(["https://example.com/go", "https://example.com/final"]);
  });

  it("surfaces a non-2xx status as an error", async () => {
    const tool = createWebFetchTool({
      fetch: (async () => ({
        ok: false,
        status: 404,
        statusText: "Not Found",
        url: "https://example.com/missing",
        headers: { get: () => "text/html" },
        text: async () => "<p>gone</p>",
      })) as never,
    });
    const result = await tool.run({ url: "https://example.com/missing" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("HTTP 404");
  });
});

describe("ask_user_question", () => {
  it("parses Claude's AskUserQuestion input shape", () => {
    const questions = parseAskInput({
      questions: [
        {
          question: "Which database?",
          header: "Storage",
          multiSelect: false,
          options: [{ label: "SQLite", description: "local" }, { label: "Postgres" }, { bad: 1 }],
        },
        { question: "", options: [] },
      ],
    });
    expect(questions).toHaveLength(1);
    expect(questions[0]?.header).toBe("Storage");
    expect(questions[0]?.options.map((o) => o.label)).toEqual(["SQLite", "Postgres"]);
  });

  it("is never permission-gated, in any mode", () => {
    expect(askUserQuestionTool.permissionClass).toBe("interaction");
    for (const mode of ["default", "acceptEdits", "bypassPermissions", "plan"] as const) {
      expect(gateFor(mode, "interaction")).toBe("allow");
    }
  });

  it("round-trips an answer through ToolContext.ask", async () => {
    let seen: { questions: Question[]; allowOther: boolean } | null = null;
    const result = await askUserQuestionTool.run(
      {
        questions: [{ question: "Which one?", options: [{ label: "A" }, { label: "B" }] }],
        allow_other: false,
      },
      ctx({
        ask: async (questions, allowOther) => {
          seen = { questions, allowOther };
          return { "Which one?": "B" };
        },
      }),
    );
    const captured = seen as unknown as { questions: Question[]; allowOther: boolean };
    expect(captured.allowOther).toBe(false);
    expect(captured.questions[0]?.question).toBe("Which one?");
    expect(result.content).toContain("Which one?");
    expect(result.content).toContain("→ B");
  });

  it("reports an empty question list as a tool error", async () => {
    const result = await askUserQuestionTool.run({ questions: [] }, ctx());
    expect(result.isError).toBe(true);
  });
});

describe("the permission gate (R27)", () => {
  const classes: PermissionClass[] = ["read", "write", "execute", "network", "interaction"];

  it("is the table in registry.ts", () => {
    const table = Object.fromEntries(
      (["default", "acceptEdits", "bypassPermissions", "plan"] as const).map((mode) => [
        mode,
        Object.fromEntries(classes.map((c) => [c, gateFor(mode, c)])),
      ]),
    );
    expect(table).toEqual({
      default: {
        read: "allow",
        write: "ask",
        execute: "ask",
        network: "ask",
        interaction: "allow",
      },
      acceptEdits: {
        read: "allow",
        write: "allow",
        execute: "ask",
        network: "ask",
        interaction: "allow",
      },
      bypassPermissions: {
        read: "allow",
        write: "allow",
        execute: "allow",
        network: "allow",
        interaction: "allow",
      },
      plan: {
        read: "allow",
        write: "deny",
        execute: "deny",
        network: "deny",
        interaction: "allow",
      },
    });
  });

  it("explains a plan-mode denial in words the model can act on", () => {
    const message = gateDenialMessage("plan", writeFileTool);
    expect(message).toContain("plan mode");
    expect(message).toContain("Present the plan");
  });
});

describe("the built-in tool set", () => {
  it("is the nine tools SPEC R9 names, in a stable order (R24)", () => {
    const tools = builtinTools({ bash: { platform: "win32" } });
    expect(tools.map((t) => t.name)).toEqual([
      "read_file",
      "write_file",
      "edit_file",
      "list_dir",
      "glob",
      "grep",
      "bash",
      "web_fetch",
      "ask_user_question",
    ]);
    // Same input, same order — the request prefix must be byte-identical.
    expect(builtinTools({ bash: { platform: "win32" } }).map((t) => t.name)).toEqual(
      tools.map((t) => t.name),
    );
  });

  it("declares one permission class per tool", () => {
    const byClass = Object.fromEntries(
      builtinTools().map((t: ToolDefinition) => [t.name, t.permissionClass]),
    );
    expect(byClass).toEqual({
      read_file: "read",
      write_file: "write",
      edit_file: "write",
      list_dir: "read",
      glob: "read",
      grep: "read",
      bash: "execute",
      web_fetch: "network",
      ask_user_question: "interaction",
    });
  });

  it("can exclude tools by name and indexes them for dispatch", () => {
    const tools = builtinTools({ exclude: ["bash", "web_fetch"] });
    expect(tools.map((t) => t.name)).not.toContain("bash");
    expect(toolMap(tools).get("read_file")?.family).toBe("read");
  });
});

describe("clampText", () => {
  it("passes short text through and stubs long text", () => {
    expect(clampText("short", 100)).toEqual({ content: "short" });
    const clamped = clampText("z".repeat(200), 50);
    expect(clamped.truncated).toBe(true);
    expect(clamped.content).toContain("150 more characters");
    expect(clamped.fullOutput).toHaveLength(200);
  });
});
