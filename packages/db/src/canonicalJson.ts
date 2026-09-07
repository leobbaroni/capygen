/**
 * Deterministic content identity for a shared bundle.
 *
 * Two files carrying the same conversation must hash the same however their
 * writer happened to order object keys, or a re-import of identical content
 * would look like a conflicting bundle. So keys are sorted recursively and
 * arrays keep their order — array position is meaning here (entry order,
 * comment reply order), never incidental.
 *
 * What is deliberately *not* done: Unicode normalization. Normalizing would
 * make two different strings — a tool argument, a path, a label — share one
 * identity, which widens what a hash match asserts. The same rule ADR-0007
 * fixes for grant signatures applies for the same reason: string bytes are
 * preserved exactly.
 */
import crypto from "node:crypto";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => {
      const item = (value as Record<string, unknown>)[key];
      // `undefined` is not representable in JSON; a schema-validated bundle has
      // no such member, and skipping keeps the hash equal to the parsed form.
      return item === undefined ? null : `${JSON.stringify(key)}:${canonicalJson(item)}`;
    })
    .filter((part): part is string => part !== null);
  return `{${entries.join(",")}}`;
}

/** SHA-256, lowercase hex, over the canonical serialization of `value`. */
export function canonicalSha256(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
