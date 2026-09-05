/**
 * Pure formatting helpers shared by the block cards. Split out from the
 * components so they can be unit-tested without React.
 */

/** `JSON.stringify(value, null, 2)`, falling back to `String(value)` for
 *  anything that throws (a circular structure, a BigInt, …). */
export function toPrettyJson(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** One-line summary of a tool call's input for the collapsed trigger row. */
export function summarizeToolInput(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return truncate(input, 80);
  if (typeof input !== "object") return truncate(String(input), 80);
  const obj = input as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return "";
  const parts = keys.slice(0, 3).map((key) => {
    const v = obj[key];
    const rendered = typeof v === "string" ? v : toPrettyJson(v);
    return `${key}: ${truncate(rendered.replace(/\s+/g, " ").trim(), 40)}`;
  });
  return truncate(parts.join(", "), 100);
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** `1_234` → `"1,234"`; used for token counts. */
export function formatCount(n: number): string {
  return n.toLocaleString();
}

export function formatCostUsd(costUsd: number): string {
  return `$${costUsd.toFixed(costUsd < 0.01 && costUsd > 0 ? 4 : 2)}`;
}
