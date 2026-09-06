/**
 * A TOML reader that remembers **where every table and key came from**, so
 * capygen can edit `~/.codex/config.toml` by replacing text ranges instead of
 * re-serialising the file (SPEC R20, R29).
 *
 * Why not a library. `@iarna/toml` and `smol-toml` (both verified on npm on
 * 2026-09-06: 2.2.5 and 1.8.0) parse TOML into plain JavaScript objects, and a
 * plain object has nowhere to keep a comment, a key order, or the difference
 * between `'C:\Users\x'` and `"C:\\Users\\x"`. Round-tripping the user's real
 * config through either one would silently rewrite the whole file: on this
 * machine that means losing `[projects.'…']` quoting on 80 table headers and
 * every hand-written comment. The requirement is "never clobber unknown keys",
 * so the writer here is a **patcher**: it rewrites exactly the byte range of
 * the table or key it was asked to change and leaves every other byte —
 * comments, ordering, blank lines, quoting style — untouched.
 *
 * What is understood, which is everything real Codex/Claude TOML uses:
 * standard tables (`[a.b."c"]`), array-of-tables headers (`[[a]]`, recorded but
 * never edited), bare/quoted/dotted keys, basic and literal strings including
 * their multi-line forms, integers, floats, booleans, arrays (multi-line
 * included) and inline tables. Anything else — a date-time, an unknown token —
 * is kept as an opaque `TomlRaw` whose original text is preserved verbatim, so
 * an unparseable value is still never destroyed; it simply reads back as its
 * source text rather than as a JS value.
 */

export interface TomlSpan {
  /** Inclusive start offset into the document text. */
  start: number;
  /** Exclusive end offset. */
  end: number;
}

/** A value this reader could not turn into a JS primitive, kept verbatim. */
export interface TomlRaw {
  readonly __tomlRaw: string;
}

export function isTomlRaw(value: unknown): value is TomlRaw {
  return typeof value === "object" && value !== null && "__tomlRaw" in value;
}

export type TomlValue =
  | string
  | number
  | boolean
  | TomlRaw
  | TomlValue[]
  | { [key: string]: TomlValue };

export interface TomlEntry {
  /** Dotted key path relative to the enclosing table. */
  path: string[];
  value: TomlValue;
  /** The whole `key = value` line(s), including the trailing newline. */
  span: TomlSpan;
}

export interface TomlTable {
  /** Dotted table path, already unquoted: `["mcp_servers", "node repl"]`. */
  path: string[];
  kind: "table" | "arrayTable";
  /** The `[header]` line, including its trailing newline. */
  headerSpan: TomlSpan;
  /**
   * The unbroken run of comment lines immediately above the header, if any
   * (empty otherwise). Only `removeTable` uses it: a comment written directly
   * above `[mcp_servers.foo]` describes *that* table, so deleting the table
   * takes it too — but a blank line in between ends the run, and an `upsert`
   * never touches it, so a comment survives every edit that is not a delete.
   */
  leadSpan: TomlSpan;
  /**
   * Header line start → end of this table's last key line (or the header's own
   * end when the table has no keys). Interleaved comments fall inside;
   * comments *after* the last key do not, so removing a table never deletes a
   * comment that was written about whatever comes next.
   */
  blockSpan: TomlSpan;
  entries: TomlEntry[];
}

export interface TomlDocument {
  text: string;
  /** Keys written before the first table header. */
  root: TomlEntry[];
  tables: TomlTable[];
}

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

export function parseTomlDocument(text: string): TomlDocument {
  const scanner = new Scanner(text);
  const root: TomlEntry[] = [];
  const tables: TomlTable[] = [];
  let current: TomlTable | null = null;

  while (!scanner.done()) {
    scanner.skipTrivia();
    if (scanner.done()) break;

    const lineStart = scanner.index;
    if (scanner.peek() === "[") {
      const header = scanner.readTableHeader();
      if (!header) {
        // An unreadable header stops structured parsing rather than guessing:
        // everything after it stays in `text` and is written back untouched.
        break;
      }
      const table: TomlTable = {
        path: header.path,
        kind: header.kind,
        headerSpan: { start: lineStart, end: scanner.index },
        leadSpan: { start: leadingCommentStart(text, lineStart), end: lineStart },
        blockSpan: { start: lineStart, end: scanner.index },
        entries: [],
      };
      tables.push(table);
      current = table;
      continue;
    }

    const entry = scanner.readKeyValue();
    if (!entry) break;
    entry.span.start = lineStart;
    entry.span.end = scanner.index;
    if (current) {
      current.entries.push(entry);
      current.blockSpan.end = scanner.index;
    } else {
      root.push(entry);
    }
  }

  return { text, root, tables };
}

/** Walk back over `# …` lines that touch the header with no blank line between. */
function leadingCommentStart(text: string, headerStart: number): number {
  let start = headerStart;
  while (start > 0) {
    const previousBreak = text.lastIndexOf("\n", start - 2);
    const lineStart = previousBreak + 1;
    const line = text.slice(lineStart, start).trim();
    if (!line.startsWith("#")) break;
    start = lineStart;
    if (lineStart === 0) break;
  }
  return start;
}

/** The document as a nested plain object (later definitions win, TOML-style). */
export function tomlToObject(doc: TomlDocument): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const entry of doc.root) assign(out, entry.path, entry.value);
  for (const table of doc.tables) {
    if (table.kind === "arrayTable") continue;
    const target = ensureTable(out, table.path);
    for (const entry of table.entries) assign(target, entry.path, entry.value);
  }
  return out;
}

function ensureTable(root: Record<string, unknown>, path: string[]): Record<string, unknown> {
  let node = root;
  for (const segment of path) {
    const next = node[segment];
    if (typeof next === "object" && next !== null && !Array.isArray(next)) {
      node = next as Record<string, unknown>;
    } else {
      const created: Record<string, unknown> = {};
      node[segment] = created;
      node = created;
    }
  }
  return node;
}

function assign(root: Record<string, unknown>, path: string[], value: unknown): void {
  if (path.length === 0) return;
  const leaf = path[path.length - 1] as string;
  const table = ensureTable(root, path.slice(0, -1));
  table[leaf] = value;
}

/** The table with this exact path, or null. */
export function findTable(doc: TomlDocument, path: string[]): TomlTable | null {
  return (
    doc.tables.find(
      (table) =>
        table.kind === "table" &&
        table.path.length === path.length &&
        table.path.every((segment, i) => segment === path[i]),
    ) ?? null
  );
}

/** Every table whose path starts with `prefix` (the table itself included). */
export function findTablesUnder(doc: TomlDocument, prefix: string[]): TomlTable[] {
  return doc.tables.filter(
    (table) =>
      table.path.length >= prefix.length && prefix.every((segment, i) => table.path[i] === segment),
  );
}

// ---------------------------------------------------------------------------
// write — every operation returns new text; nothing is mutated in place
// ---------------------------------------------------------------------------

/**
 * Replace (or append) one standard table and all of its child tables with the
 * given keys. Child tables are removed first, so `env` written as an inline
 * table cannot end up shadowed by a leftover `[mcp_servers.x.env]`.
 */
export function upsertTable(
  doc: TomlDocument,
  path: string[],
  values: Record<string, TomlValue | undefined>,
): string {
  const rendered = renderTable(path, values);
  const existing = findTablesUnder(doc, path)
    .filter((table) => table.kind === "table")
    .sort((a, b) => a.blockSpan.start - b.blockSpan.start);
  if (existing.length === 0) return appendBlock(doc.text, rendered);

  const first = existing[0] as TomlTable;
  // Cut every block belonging to this table, back to front, then splice the
  // replacement in where the first one started.
  let text = doc.text;
  for (let i = existing.length - 1; i >= 0; i -= 1) {
    const table = existing[i] as TomlTable;
    const end = swallowBlankLines(text, table.blockSpan.end);
    text = text.slice(0, table.blockSpan.start) + text.slice(end);
  }
  const head = text.slice(0, first.blockSpan.start);
  const tail = text.slice(first.blockSpan.start);
  return `${head}${rendered}${tail.length > 0 && !tail.startsWith("\n") ? "\n" : ""}${tail}`;
}

/** Delete a standard table and every table nested under it. */
export function removeTable(doc: TomlDocument, path: string[]): string {
  const blocks = findTablesUnder(doc, path)
    .filter((table) => table.kind === "table")
    .sort((a, b) => b.blockSpan.start - a.blockSpan.start);
  let text = doc.text;
  for (const table of blocks) {
    const end = swallowBlankLines(text, table.blockSpan.end);
    text = text.slice(0, table.leadSpan.start) + text.slice(end);
  }
  return text;
}

/**
 * Set a key that lives before the first table header (`model`,
 * `approval_policy`, …). An existing key's line is replaced in place — its
 * position, and every comment around it, survive.
 */
export function setRootKey(doc: TomlDocument, key: string, value: TomlValue): string {
  const existing = doc.root.find((entry) => entry.path.length === 1 && entry.path[0] === key);
  const line = `${renderKey(key)} = ${formatTomlValue(value)}\n`;
  if (existing) {
    return doc.text.slice(0, existing.span.start) + line + doc.text.slice(existing.span.end);
  }
  const firstTable = doc.tables[0];
  if (!firstTable) return appendLine(doc.text, line);
  const at = firstTable.headerSpan.start;
  return `${doc.text.slice(0, at)}${line}${doc.text.slice(at)}`;
}

export function removeRootKey(doc: TomlDocument, key: string): string {
  const existing = doc.root.find((entry) => entry.path.length === 1 && entry.path[0] === key);
  if (!existing) return doc.text;
  return doc.text.slice(0, existing.span.start) + doc.text.slice(existing.span.end);
}

function appendBlock(text: string, block: string): string {
  if (text.length === 0) return block;
  const separator = text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  return `${text}${separator}${block}`;
}

function appendLine(text: string, line: string): string {
  if (text.length === 0 || text.endsWith("\n")) return `${text}${line}`;
  return `${text}\n${line}`;
}

function swallowBlankLines(text: string, from: number): number {
  let index = from;
  while (index < text.length) {
    const lineEnd = text.indexOf("\n", index);
    const stop = lineEnd === -1 ? text.length : lineEnd + 1;
    if (text.slice(index, stop).trim().length > 0) break;
    index = stop;
    if (lineEnd === -1) break;
  }
  return index;
}

export function renderTable(
  path: string[],
  values: Record<string, TomlValue | undefined>,
): string {
  const lines = [`[${path.map(renderKey).join(".")}]`];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    lines.push(`${renderKey(key)} = ${formatTomlValue(value)}`);
  }
  return `${lines.join("\n")}\n`;
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

export function renderKey(key: string): string {
  if (BARE_KEY.test(key)) return key;
  return formatBasicString(key);
}

/**
 * A Windows path is written as a **literal** string (`'C:\Users\x'`) whenever it
 * can be — that is what the user's own `config.toml` does for every
 * `[projects.'…']` header and every `command` — because the basic-string form
 * would double every backslash and make the file unreadable in a diff.
 */
export function formatTomlValue(value: TomlValue): string {
  if (isTomlRaw(value)) return value.__tomlRaw;
  if (typeof value === "string") {
    if (value.includes("\\") && !value.includes("'") && !/[\n\r]/.test(value)) {
      return `'${value}'`;
    }
    return formatBasicString(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(value);
  if (Array.isArray(value)) return `[${value.map(formatTomlValue).join(", ")}]`;
  const pairs = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .map(([key, item]) => `${renderKey(key)} = ${formatTomlValue(item as TomlValue)}`);
  return `{ ${pairs.join(", ")} }`;
}

function formatBasicString(value: string): string {
  let out = '"';
  for (const ch of value) {
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else out += ch;
  }
  return `${out}"`;
}

// ---------------------------------------------------------------------------
// scanner
// ---------------------------------------------------------------------------

class Scanner {
  index = 0;

  constructor(private readonly text: string) {}

  done(): boolean {
    return this.index >= this.text.length;
  }

  peek(): string {
    return this.text[this.index] ?? "";
  }

  /** Whitespace, newlines and whole-line comments. */
  skipTrivia(): void {
    for (;;) {
      const ch = this.peek();
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
        this.index += 1;
        continue;
      }
      if (ch === "#") {
        this.skipToLineEnd();
        continue;
      }
      return;
    }
  }

  private skipToLineEnd(): void {
    const next = this.text.indexOf("\n", this.index);
    this.index = next === -1 ? this.text.length : next + 1;
  }

  private skipInlineSpace(): void {
    while (this.peek() === " " || this.peek() === "\t") this.index += 1;
  }

  /** Consume the rest of the line (a trailing comment) and its newline. */
  private finishLine(): void {
    this.skipInlineSpace();
    if (this.peek() === "#") {
      this.skipToLineEnd();
      return;
    }
    if (this.peek() === "\r") this.index += 1;
    if (this.peek() === "\n") this.index += 1;
  }

  readTableHeader(): { path: string[]; kind: TomlTable["kind"] } | null {
    this.index += 1; // '['
    const arrayTable = this.peek() === "[";
    if (arrayTable) this.index += 1;
    const path = this.readKeyPath("]");
    if (!path) return null;
    if (this.peek() !== "]") return null;
    this.index += 1;
    if (arrayTable) {
      if (this.peek() !== "]") return null;
      this.index += 1;
    }
    this.finishLine();
    return { path, kind: arrayTable ? "arrayTable" : "table" };
  }

  readKeyValue(): TomlEntry | null {
    const path = this.readKeyPath("=");
    if (!path) return null;
    if (this.peek() !== "=") return null;
    this.index += 1;
    this.skipInlineSpace();
    const value = this.readValue();
    if (value === undefined) return null;
    this.finishLine();
    return { path, value, span: { start: 0, end: 0 } };
  }

  /** Dotted key up to (not including) `stop`. */
  private readKeyPath(stop: string): string[] | null {
    const path: string[] = [];
    for (;;) {
      this.skipInlineSpace();
      const ch = this.peek();
      if (ch === '"' || ch === "'") {
        const quoted = this.readQuotedString(ch);
        if (quoted === undefined) return null;
        path.push(quoted);
      } else {
        const start = this.index;
        while (/[A-Za-z0-9_-]/.test(this.peek())) this.index += 1;
        if (this.index === start) return null;
        path.push(this.text.slice(start, this.index));
      }
      this.skipInlineSpace();
      if (this.peek() === ".") {
        this.index += 1;
        continue;
      }
      if (this.peek() === stop) return path;
      return null;
    }
  }

  private readQuotedString(quote: string): string | undefined {
    const triple = this.text.startsWith(quote.repeat(3), this.index);
    if (triple) return this.readMultilineString(quote);
    this.index += 1;
    let out = "";
    while (this.index < this.text.length) {
      const ch = this.text[this.index] as string;
      if (ch === "\n") return undefined;
      if (quote === '"' && ch === "\\") {
        const escaped = this.readEscape();
        if (escaped === undefined) return undefined;
        out += escaped;
        continue;
      }
      this.index += 1;
      if (ch === quote) return out;
      out += ch;
    }
    return undefined;
  }

  private readMultilineString(quote: string): string | undefined {
    const fence = quote.repeat(3);
    this.index += 3;
    // A newline immediately after the opening fence is not part of the value.
    if (this.text[this.index] === "\r") this.index += 1;
    if (this.text[this.index] === "\n") this.index += 1;
    let out = "";
    while (this.index < this.text.length) {
      if (this.text.startsWith(fence, this.index)) {
        this.index += 3;
        return out;
      }
      const ch = this.text[this.index] as string;
      if (quote === '"' && ch === "\\") {
        const escaped = this.readEscape();
        if (escaped === undefined) return undefined;
        out += escaped;
        continue;
      }
      this.index += 1;
      out += ch;
    }
    return undefined;
  }

  private readEscape(): string | undefined {
    this.index += 1; // backslash
    const ch = this.text[this.index];
    if (ch === undefined) return undefined;
    this.index += 1;
    switch (ch) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case '"':
        return '"';
      case "\\":
        return "\\";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "u":
      case "U": {
        const width = ch === "u" ? 4 : 8;
        const hex = this.text.slice(this.index, this.index + width);
        this.index += width;
        const code = Number.parseInt(hex, 16);
        return Number.isNaN(code) ? "" : String.fromCodePoint(code);
      }
      case "\n":
      case "\r":
        // Line-ending backslash in a multi-line string: eat the whitespace run.
        while (/[\s]/.test(this.peek())) this.index += 1;
        return "";
      default:
        return ch;
    }
  }

  readValue(): TomlValue | undefined {
    const ch = this.peek();
    if (ch === '"' || ch === "'") return this.readQuotedString(ch);
    if (ch === "[") return this.readArray();
    if (ch === "{") return this.readInlineTable();
    const start = this.index;
    while (this.index < this.text.length && !/[\r\n,\]}#]/.test(this.text[this.index] as string)) {
      this.index += 1;
    }
    const raw = this.text.slice(start, this.index).trim();
    if (raw.length === 0) return undefined;
    return literal(raw);
  }

  private readArray(): TomlValue[] | undefined {
    this.index += 1;
    const out: TomlValue[] = [];
    for (;;) {
      this.skipTrivia();
      if (this.peek() === "]") {
        this.index += 1;
        return out;
      }
      if (this.done()) return undefined;
      const value = this.readValue();
      if (value === undefined) return undefined;
      out.push(value);
      this.skipTrivia();
      if (this.peek() === ",") {
        this.index += 1;
        continue;
      }
      if (this.peek() === "]") {
        this.index += 1;
        return out;
      }
      return undefined;
    }
  }

  private readInlineTable(): Record<string, TomlValue> | undefined {
    this.index += 1;
    const out: Record<string, TomlValue> = {};
    for (;;) {
      this.skipInlineSpace();
      if (this.peek() === "}") {
        this.index += 1;
        return out;
      }
      const path = this.readKeyPath("=");
      if (!path) return undefined;
      this.index += 1; // '='
      this.skipInlineSpace();
      const value = this.readValue();
      if (value === undefined) return undefined;
      assign(out as Record<string, unknown>, path, value);
      this.skipInlineSpace();
      if (this.peek() === ",") {
        this.index += 1;
        continue;
      }
      if (this.peek() === "}") {
        this.index += 1;
        return out;
      }
      return undefined;
    }
  }
}

/** A bare token: boolean, integer, float, or something we keep verbatim. */
function literal(raw: string): TomlValue {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^[+-]?(?:0|[1-9](?:_?\d)*)$/.test(raw)) return Number(raw.replace(/_/g, ""));
  if (/^[+-]?(?:0|[1-9](?:_?\d)*)\.\d(?:_?\d)*(?:[eE][+-]?\d+)?$/.test(raw)) {
    return Number(raw.replace(/_/g, ""));
  }
  if (/^0x[0-9a-fA-F_]+$/.test(raw)) return Number.parseInt(raw.replace(/_/g, ""), 16);
  // Date-times, `inf`, `nan`, or anything this reader does not model: keep the
  // source text so a rewrite of a *neighbouring* key cannot corrupt it.
  return { __tomlRaw: raw };
}
