/**
 * Bounded, immutable snapshots of a tool input (ADR-0007 grant signatures).
 *
 * A grant's identity is "the complete JSON input … no field elision and no
 * Unicode normalization". Taking that at face value from a caller-supplied
 * `unknown` is harder than it looks, and every rule below exists because some
 * shortcut quietly changes what was authorized:
 *
 *   * `JSON.stringify`/`canonicalJson` *drop* what they cannot represent, so
 *     `{ a: undefined }` and `{}` share one identity. Anything not
 *     representable as bounded JSON is refused, never normalized away.
 *   * a plain key walk (`Object.keys` + `out[key] = …`) is not a faithful copy.
 *     `__proto__` arriving from `JSON.parse` is an ordinary own data property,
 *     but assigning it back hits the prototype setter and the field vanishes;
 *     symbol-keyed and non-enumerable own properties are skipped outright; an
 *     array's extra own properties are skipped too. All of that is elision by
 *     another name, so the copy uses own *data descriptors* onto a
 *     null-prototype object and refuses everything it cannot carry exactly.
 *   * reading a property can *run code*. An accessor is rejected from its
 *     descriptor, without ever being invoked.
 *   * the caller keeps a live reference, so the copy is deep-frozen: mutating
 *     the object while the approval card is open cannot change what the
 *     approval authorized.
 *   * limits are charged *during* the walk, keys included. Checking size only
 *     at the end would let 10k × 128KiB members allocate a gigabyte before the
 *     final measurement refused it.
 *
 * The failure path reports a *structural* position (`$.#2[0]`), never the
 * caller's own key text: a refusal message is surfaced in the UI and the
 * property names of a tool input are the caller's data, not ours to echo.
 */
import { canonicalJson } from "@capygen/db";

export interface InputSnapshotLimits {
  /** Nesting depth, counting the root as 1. */
  maxDepth?: number;
  /** Total values visited — the guard against a wide, shallow payload. */
  maxNodes?: number;
  /** Applies to keys as well as string values. */
  maxStringLength?: number;
  /** Cap on the canonical text, in UTF-8 bytes, charged as the walk proceeds. */
  maxCanonicalBytes?: number;
}

export type InputSnapshotFailure =
  | "not-representable"
  | "accessor"
  | "hidden-member"
  | "cycle"
  | "too-deep"
  | "too-many-nodes"
  | "string-too-long"
  | "too-large";

export type InputSnapshotResult =
  | { ok: true; value: unknown; canonical: string }
  | { ok: false; reason: InputSnapshotFailure; path: string };

const DEFAULTS: Required<InputSnapshotLimits> = {
  maxDepth: 32,
  maxNodes: 10_000,
  maxStringLength: 131_072,
  maxCanonicalBytes: 1_048_576,
};

/** Longest structural path reported; a deep failure is still readable. */
const MAX_PATH_LENGTH = 100;

/**
 * A limit is a bound or it is the default.
 *
 * `undefined`, `NaN`, `Infinity`, zero and negatives all fall back: a malformed
 * or hostile options object must not be able to *remove* a bound, which is what
 * a bare `??` and an unchecked `>` comparison would allow (`n > NaN` is false).
 */
function normalizeLimits(limits: InputSnapshotLimits): Required<InputSnapshotLimits> {
  const bound = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
  return {
    maxDepth: bound(limits.maxDepth, DEFAULTS.maxDepth),
    maxNodes: bound(limits.maxNodes, DEFAULTS.maxNodes),
    maxStringLength: bound(limits.maxStringLength, DEFAULTS.maxStringLength),
    maxCanonicalBytes: bound(limits.maxCanonicalBytes, DEFAULTS.maxCanonicalBytes),
  };
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * An array's own names are its live indices plus `length` — nothing else.
 *
 * The index test is `String(index) === name`, not a numeric coercion: `"01"`,
 * `"1e0"`, `"+1"`, `"1.0"`, `" 1"` and `"-0"` all coerce to a valid index while
 * being *different* own properties that the positional walk below never visits.
 * Accepting them would discard the member — the elision this module refuses.
 */
function arrayExtras(value: unknown[]): boolean {
  for (const name of Object.getOwnPropertyNames(value)) {
    if (name === "length") continue;
    const index = Number(name);
    if (!Number.isInteger(index) || index < 0 || index >= value.length) return true;
    if (String(index) !== name) return true;
  }
  return false;
}

/**
 * Copy `input` if — and only if — it is bounded JSON held in own data
 * properties.
 *
 * Refused: `undefined` anywhere (a present-but-undefined property or an array
 * hole included), functions, symbols, bigints, `NaN`/`±Infinity`, class
 * instances and exotic objects such as `Date`/`Map` (their JSON form is a lossy
 * projection, not the value), accessors, symbol-keyed or non-enumerable own
 * properties, extra own properties on an array, cycles, and anything past the
 * limits.
 */
export function snapshotToolInput(
  input: unknown,
  limits: InputSnapshotLimits = {},
): InputSnapshotResult {
  const bounds = normalizeLimits(limits);
  let nodes = 0;
  let bytes = 0;
  // A holder rather than a bare `let`: the assignments happen inside `copy`,
  // and control-flow narrowing would otherwise treat the outer read as `null`.
  const state: { failure: { reason: InputSnapshotFailure; path: string } | null } = { failure: null };

  const fail = (reason: InputSnapshotFailure, path: string): undefined => {
    state.failure ??= {
      reason,
      path: path.length > MAX_PATH_LENGTH ? `${path.slice(0, MAX_PATH_LENGTH)}…` : path,
    };
    return undefined;
  };

  /** Charge the canonical text this value will occupy, before building it. */
  const charge = (amount: number, path: string): boolean => {
    bytes += amount;
    if (bytes > bounds.maxCanonicalBytes) {
      fail("too-large", path);
      return false;
    }
    return true;
  };

  // `ancestors` rather than a global seen-set: the same object appearing twice
  // in different branches is a legitimate shared reference, only an ancestor
  // repeating is a cycle.
  const copy = (value: unknown, depth: number, path: string, ancestors: Set<object>): unknown => {
    if (state.failure) return undefined;
    nodes += 1;
    if (nodes > bounds.maxNodes) return fail("too-many-nodes", path);
    if (depth > bounds.maxDepth) return fail("too-deep", path);

    if (value === null) return charge(4, path) ? null : undefined;
    switch (typeof value) {
      case "boolean":
        return charge(value ? 4 : 5, path) ? value : undefined;
      case "number":
        if (!Number.isFinite(value)) return fail("not-representable", path);
        return charge(String(value).length, path) ? value : undefined;
      case "string":
        if (value.length > bounds.maxStringLength) return fail("string-too-long", path);
        return charge(Buffer.byteLength(value, "utf8") + 2, path) ? value : undefined;
      case "object":
        break;
      default:
        // undefined, function, symbol, bigint.
        return fail("not-representable", path);
    }

    const object = value as object;
    if (ancestors.has(object)) return fail("cycle", path);
    if (Object.getOwnPropertySymbols(object).length > 0) return fail("hidden-member", path);
    const nested = new Set(ancestors).add(object);
    if (!charge(2, path)) return undefined;

    if (Array.isArray(object)) {
      if (arrayExtras(object)) return fail("hidden-member", path);
      const out: unknown[] = [];
      for (let index = 0; index < object.length; index += 1) {
        const here = `${path}[${index}]`;
        const descriptor = Object.getOwnPropertyDescriptor(object, index);
        // A hole reads as `undefined` and would serialize as `null`, changing
        // the value; it is refused like any other unrepresentable member.
        if (!descriptor) return fail("not-representable", here);
        if (!("value" in descriptor)) return fail("accessor", here);
        // Held to the same contract as an object member: an index hidden from
        // enumeration is still a member, and dropping it changes the value.
        if (!descriptor.enumerable) return fail("hidden-member", here);
        if (index > 0 && !charge(1, here)) return undefined;
        out.push(copy(descriptor.value, depth + 1, here, nested));
        if (state.failure) return undefined;
      }
      return Object.freeze(out);
    }

    if (!isPlainObject(object)) return fail("not-representable", path);
    // A null-prototype target with explicit data descriptors: `out[key] = …`
    // would route `__proto__` through the prototype setter and drop the field.
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const names = Object.getOwnPropertyNames(object);
    for (let i = 0; i < names.length; i += 1) {
      const key = names[i] as string;
      // Positional, not the key itself: the path reaches a UI refusal message.
      const here = `${path}.#${i}`;
      if (key.length > bounds.maxStringLength) return fail("string-too-long", here);
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor) return fail("not-representable", here);
      if (!("value" in descriptor)) return fail("accessor", here);
      // Skipping it silently is exactly the elision this module exists to stop.
      if (!descriptor.enumerable) return fail("hidden-member", here);
      if (descriptor.value === undefined) return fail("not-representable", here);
      if (!charge(Buffer.byteLength(key, "utf8") + (i > 0 ? 4 : 3), here)) return undefined;
      const member = copy(descriptor.value, depth + 1, here, nested);
      if (state.failure) return undefined;
      Object.defineProperty(out, key, {
        value: member, enumerable: true, writable: false, configurable: false,
      });
    }
    return Object.freeze(out);
  };

  const snapshot = copy(input, 1, "$", new Set());
  if (state.failure) return { ok: false, ...state.failure };

  // The charge above is a lower bound (escapes are not counted), so the exact
  // measurement stays as the backstop.
  const canonical = canonicalJson(snapshot);
  if (Buffer.byteLength(canonical, "utf8") > bounds.maxCanonicalBytes) {
    return { ok: false, reason: "too-large", path: "$" };
  }
  return { ok: true, value: snapshot, canonical };
}
