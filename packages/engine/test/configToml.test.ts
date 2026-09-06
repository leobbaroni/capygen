/**
 * The comment-preserving TOML patcher (SPEC R20: "never clobber unknown keys").
 *
 * The fixture is a trimmed copy of the *shape* of this machine's real
 * `~/.codex/config.toml` — literal-string Windows paths, quoted table headers,
 * a nested `[mcp_servers.x.env]`, a multi-line array, and comments in three
 * positions — because that file is what the writer has to survive. Every
 * assertion here is of the same form: change one thing, then prove every other
 * byte is where it was.
 */
import { describe, expect, it } from "vitest";
import {
  findTable,
  formatTomlValue,
  isTomlRaw,
  parseTomlDocument,
  removeRootKey,
  removeTable,
  renderKey,
  setRootKey,
  tomlToObject,
  upsertTable,
} from "../src/config/toml.js";

const FIXTURE = `# capygen must never eat this header comment
model = "gpt-6-astra"
model_reasoning_effort = "medium"
notify = [
    'C:\\Program Files\\thing\\notify.exe',
    "turn-ended",
]

[projects.'c:\\users\\tugaplayz']
trust_level = "trusted"

# a comment that belongs to the node_repl server
[mcp_servers.node_repl]
command = 'C:\\Users\\x\\node_repl.exe'
args = []
startup_timeout_sec = 120

[mcp_servers.node_repl.env]
CODEX_HOME = 'C:\\Users\\x\\.codex'
FLAG = "1"

[mcp_servers.comfy-mcp]
command = "comfy-mcp"

[features]
memories = true # trailing comment
`;

describe("TOML reader", () => {
  it("reads the whole document, nested tables and all", () => {
    const doc = parseTomlDocument(FIXTURE);
    const config = tomlToObject(doc);
    expect(config.model).toBe("gpt-6-astra");
    expect(config.notify).toEqual(["C:\\Program Files\\thing\\notify.exe", "turn-ended"]);
    const servers = config.mcp_servers as Record<string, Record<string, unknown>>;
    expect(Object.keys(servers).sort()).toEqual(["comfy-mcp", "node_repl"]);
    expect(servers.node_repl?.command).toBe("C:\\Users\\x\\node_repl.exe");
    expect(servers.node_repl?.args).toEqual([]);
    expect(servers.node_repl?.startup_timeout_sec).toBe(120);
    // The nested `[mcp_servers.node_repl.env]` table is a member of the server,
    // not a separate server — the shipped Phase 3 reader dropped these.
    expect(servers.node_repl?.env).toEqual({
      CODEX_HOME: "C:\\Users\\x\\.codex",
      FLAG: "1",
    });
    const projects = config.projects as Record<string, unknown>;
    expect(Object.keys(projects)).toEqual(["c:\\users\\tugaplayz"]);
    expect((config.features as Record<string, unknown>).memories).toBe(true);
  });

  it("keeps a value it cannot model as its own source text", () => {
    const doc = parseTomlDocument(`when = 1979-05-27T07:32:00Z\nn = nan\n`);
    const config = tomlToObject(doc);
    expect(isTomlRaw(config.when)).toBe(true);
    expect(isTomlRaw(config.n)).toBe(true);
    // …and writing an unrelated key leaves it byte-identical.
    const next = setRootKey(doc, "model", "gpt-6");
    expect(next).toContain("when = 1979-05-27T07:32:00Z");
  });
});

describe("TOML patcher", () => {
  it("adds a server without touching a single other byte", () => {
    const doc = parseTomlDocument(FIXTURE);
    const next = upsertTable(doc, ["mcp_servers", "capy"], {
      command: "node",
      args: ["server.js"],
    });
    // everything that was there is still there, verbatim
    expect(next).toContain("# capygen must never eat this header comment");
    expect(next).toContain("# a comment that belongs to the node_repl server");
    expect(next).toContain("memories = true # trailing comment");
    expect(next).toContain("[projects.'c:\\users\\tugaplayz']");
    expect(next).toContain("CODEX_HOME = 'C:\\Users\\x\\.codex'");
    expect(next.startsWith(FIXTURE.trimEnd())).toBe(true);
    // …and the new table parses back
    const servers = tomlToObject(parseTomlDocument(next)).mcp_servers as Record<string, unknown>;
    expect(servers.capy).toEqual({ command: "node", args: ["server.js"] });
    expect(Object.keys(servers).sort()).toEqual(["capy", "comfy-mcp", "node_repl"]);
  });

  it("replaces a server in place, child tables included", () => {
    const doc = parseTomlDocument(FIXTURE);
    const next = upsertTable(doc, ["mcp_servers", "node_repl"], {
      command: "node",
      args: [],
      env: { ONLY: "this" },
    });
    // the old nested env table is gone, not shadowing the inline one
    expect(next).not.toContain("[mcp_servers.node_repl.env]");
    expect(next).not.toContain("startup_timeout_sec");
    const config = tomlToObject(parseTomlDocument(next));
    const servers = config.mcp_servers as Record<string, Record<string, unknown>>;
    expect(servers.node_repl?.env).toEqual({ ONLY: "this" });
    // the *other* server and every unrelated table survived
    expect(servers["comfy-mcp"]).toEqual({ command: "comfy-mcp" });
    expect(config.projects).toEqual({ "c:\\users\\tugaplayz": { trust_level: "trusted" } });
    expect(next).toContain("# capygen must never eat this header comment");
    expect(next).toContain("memories = true # trailing comment");
  });

  it("removes a server and its child tables, and nothing else", () => {
    const doc = parseTomlDocument(FIXTURE);
    const next = removeTable(doc, ["mcp_servers", "node_repl"]);
    expect(next).not.toContain("node_repl");
    const config = tomlToObject(parseTomlDocument(next));
    expect(Object.keys(config.mcp_servers as Record<string, unknown>)).toEqual(["comfy-mcp"]);
    expect(config.model).toBe("gpt-6-astra");
    expect(next).toContain("[features]");
    expect(next).toContain("# capygen must never eat this header comment");
    // The comment written directly above the header goes with the table…
    expect(next).not.toContain("belongs to the node_repl server");
  });

  it("keeps a comment that a blank line separates from the header", () => {
    const doc = parseTomlDocument(
      `# unrelated note\n\n[mcp_servers.gone]\ncommand = "x"\n\n[features]\na = 1\n`,
    );
    const next = removeTable(doc, ["mcp_servers", "gone"]);
    expect(next).toContain("# unrelated note");
    expect(next).not.toContain("gone");
    expect(tomlToObject(parseTomlDocument(next)).features).toEqual({ a: 1 });
  });

  it("edits a root key in place and keeps its position", () => {
    const doc = parseTomlDocument(FIXTURE);
    const next = setRootKey(doc, "model_reasoning_effort", "high");
    expect(next.split("\n")[2]).toBe('model_reasoning_effort = "high"');
    expect(tomlToObject(parseTomlDocument(next)).model).toBe("gpt-6-astra");
    expect(next).toContain("notify = [");
  });

  it("inserts a new root key before the first table, never inside one", () => {
    const doc = parseTomlDocument(FIXTURE);
    const next = setRootKey(doc, "approval_policy", "on-request");
    const config = tomlToObject(parseTomlDocument(next));
    expect(config.approval_policy).toBe("on-request");
    // it must land above `[projects…]`, or it would become a key of that table
    expect(next.indexOf("approval_policy")).toBeLessThan(next.indexOf("[projects."));
  });

  it("removes a root key without disturbing its neighbours", () => {
    const doc = parseTomlDocument(FIXTURE);
    const next = removeRootKey(doc, "model");
    const config = tomlToObject(parseTomlDocument(next));
    expect(config.model).toBeUndefined();
    expect(config.model_reasoning_effort).toBe("medium");
    expect(next).toContain("# capygen must never eat this header comment");
  });

  it("writes a Windows path as a literal string, the way the CLI does", () => {
    expect(formatTomlValue("C:\\Users\\x\\node.exe")).toBe("'C:\\Users\\x\\node.exe'");
    // …unless a literal string cannot hold it
    expect(formatTomlValue("it's C:\\x")).toBe('"it\'s C:\\\\x"');
    expect(formatTomlValue(["a", "b"])).toBe('["a", "b"]');
    expect(formatTomlValue({ A: "1" })).toBe('{ A = "1" }');
    expect(renderKey("plain_key")).toBe("plain_key");
    expect(renderKey("cockpit@cockpit")).toBe('"cockpit@cockpit"');
  });

  it("round-trips a quoted table name such as a plugin id", () => {
    const doc = parseTomlDocument(`[plugins."cockpit@cockpit"]\nenabled = true\n`);
    expect(findTable(doc, ["plugins", "cockpit@cockpit"])).not.toBeNull();
    const next = upsertTable(doc, ["plugins", "cockpit@cockpit"], { enabled: false });
    expect(next).toBe('[plugins."cockpit@cockpit"]\nenabled = false\n');
  });

  it("appends to an empty document", () => {
    const doc = parseTomlDocument("");
    const next = upsertTable(doc, ["mcp_servers", "capy"], { command: "node" });
    expect(next).toBe('[mcp_servers.capy]\ncommand = "node"\n');
  });
});
