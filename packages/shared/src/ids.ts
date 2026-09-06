/**
 * Prefixed, sortable ids. `crypto.randomUUID` is available in Node 22, Electron
 * and every browser we target, so no dependency is needed. The prefix makes a
 * stray id readable in a log line or a SQLite row without a lookup.
 */
const PREFIXES = {
  project: "prj",
  session: "ses",
  agent: "agt",
  turn: "trn",
  block: "blk",
  usage: "usg",
  request: "req",
  toolOutput: "tout",
} as const;

export type IdKind = keyof typeof PREFIXES;

export function newId(kind: IdKind): string {
  return `${PREFIXES[kind]}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function isId(kind: IdKind, value: string): boolean {
  return value.startsWith(`${PREFIXES[kind]}_`);
}
