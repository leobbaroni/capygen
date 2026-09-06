/**
 * Reads an `ElicitationBlock.schema` into an ordered field list the form can
 * render controls from (SPEC R32: "form generated from the schema/fields:
 * text, number, boolean, enum").
 *
 * `schema` is deliberately `unknown` on the block (domain.ts's own comment:
 * "either a JSON Schema object (MCP) or Codex's own user-input field list").
 * Only the MCP shape is implemented here — a flat JSON Schema object with
 * `properties`/`required`, per MCP's `elicitation/create` spec — since Codex
 * approvals are not wired yet (COMPAT.md: "Not wired yet (Phase 3)"). A
 * schema that isn't shaped that way reads as zero fields, which the card
 * treats as a bare accept/decline consent prompt rather than an error.
 */

export interface SchemaProperty {
  type?: string;
  enum?: unknown[];
  enumNames?: unknown[];
  default?: unknown;
  title?: string;
  description?: string;
}

export interface SchemaField {
  name: string;
  prop: SchemaProperty;
  required: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse `schema` into an ordered field list; `[]` for anything not shaped
 *  like a JSON Schema object with properties (including `null`/`undefined`,
 *  Codex's own shape, or a schema with no properties at all — a bare consent
 *  prompt, where the card's Accept/Decline buttons are the right control). */
export function schemaFields(schema: unknown): SchemaField[] {
  if (!isRecord(schema)) return [];
  const properties = schema.properties;
  if (!isRecord(properties)) return [];
  const entries = Object.entries(properties);
  if (entries.length === 0) return [];
  const requiredRaw = schema.required;
  const required = new Set(
    Array.isArray(requiredRaw) ? requiredRaw.filter((r): r is string => typeof r === "string") : [],
  );
  return entries
    .filter(([, prop]) => isRecord(prop))
    .map(([name, prop]) => ({ name, prop: prop as SchemaProperty, required: required.has(name) }));
}

/** One value MCP allows in an `ElicitResult.content` map. */
export type ElicitValue = string | number | boolean;
export type ElicitationDraft = Record<string, ElicitValue | undefined>;
export type ElicitationAnswers = Record<string, ElicitValue>;

function isElicitValue(value: unknown): value is ElicitValue {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/** A field's starting value: its `default`, or unset. A boolean with no
 *  default starts `undefined` rather than `false` — they are different
 *  answers, and an untouched checkbox has told the server nothing. */
export function initialValue(field: SchemaField): ElicitValue | undefined {
  if (field.prop.default !== undefined && isElicitValue(field.prop.default)) return field.prop.default;
  if (field.prop.type === "boolean") return undefined;
  return "";
}

export function enumValues(prop: SchemaProperty): string[] {
  if (!Array.isArray(prop.enum)) return [];
  return prop.enum
    .filter((v): v is string | number => typeof v === "string" || typeof v === "number")
    .map(String);
}

/** The spec lets a server pair `enum` with `enumNames` — display text for
 *  values that are really ids. Falls back to the value itself. */
export function enumLabel(prop: SchemaProperty, index: number, value: string): string {
  const names = prop.enumNames;
  if (!Array.isArray(names)) return value;
  const name = names[index];
  return typeof name === "string" && name.length > 0 ? name : value;
}

function isNumericType(prop: SchemaProperty): boolean {
  return prop.type === "number" || prop.type === "integer";
}

/** A numeric field's value as a finite number matching its declared type, or
 *  `null` when it doesn't parse (`Number("1e999")` is `Infinity`, which
 *  `JSON.stringify` writes as `null` — silently sending the server a null
 *  where it declared a number is worse than refusing to submit). */
function numberOrNull(field: SchemaField, value: ElicitValue): number | null {
  if (!isNumericType(field.prop)) return 0;
  const parsed = Number(String(value));
  if (!Number.isFinite(parsed)) return null;
  if (field.prop.type === "integer" && !Number.isInteger(parsed)) return null;
  return parsed;
}

/** Every required field answered, and every numeric field (required or not)
 *  either blank or parseable. A boolean is always "answered" — `false` is a
 *  real answer, not a blank. */
export function isComplete(fields: SchemaField[], answers: ElicitationDraft): boolean {
  return fields.every((field) => {
    const value = answers[field.name];
    if (typeof value === "boolean") return true;
    const blank = value === undefined || String(value).trim().length === 0;
    if (blank) return !field.required;
    return numberOrNull(field, value) !== null;
  });
}

/** Draft → the `ElicitResult.content` map: blank optional fields are dropped
 *  (an untouched text field sending `""` would read as "answered, with
 *  nothing" rather than "not answered"), numbers are coerced. */
export function toContent(fields: SchemaField[], answers: ElicitationDraft): ElicitationAnswers {
  const content: ElicitationAnswers = {};
  for (const field of fields) {
    const value = answers[field.name];
    if (value === undefined) continue;
    if (typeof value === "boolean") {
      content[field.name] = value;
      continue;
    }
    const text = String(value);
    if (text.trim().length === 0) continue;
    if (isNumericType(field.prop)) {
      const parsed = numberOrNull(field, value);
      if (parsed !== null) content[field.name] = parsed;
      continue;
    }
    content[field.name] = text;
  }
  return content;
}
