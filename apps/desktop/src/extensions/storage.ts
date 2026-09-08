import { join } from "node:path";
import { ExtensionIdSchema } from "@capygen/shared";
import { atomicJson, boundedRead } from "./files.js";

const VALUE_BYTES = 32 * 1024;
const NAMESPACE_BYTES = 256 * 1024;
const AGGREGATE_BYTES = 8 * 1024 * 1024;
type Data = Record<string, Record<string, unknown>>;
export class ExtensionStorageError extends Error { constructor(readonly code: "quota" | "paced" | "invalid", message: string) { super(message); } }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function validKey(key: string): void { if (!key || key.length > 128 || ["__proto__", "prototype", "constructor"].includes(key) || /[\x00-\x1f]/.test(key)) throw new ExtensionStorageError("invalid", "Invalid storage key"); }
function validate(data: Data): void {
  for (const [namespace, entries] of Object.entries(data)) {
    ExtensionIdSchema.parse(namespace);
    if (!object(entries)) throw new ExtensionStorageError("invalid", "Invalid stored namespace");
    if (Object.keys(entries).length > 128 || Buffer.byteLength(JSON.stringify(entries)) > NAMESPACE_BYTES) throw new ExtensionStorageError("quota", "Extension namespace quota exceeded");
    for (const [key, value] of Object.entries(entries)) {
      validKey(key);
      if (Buffer.byteLength(JSON.stringify(value)) > VALUE_BYTES) throw new ExtensionStorageError("quota", "Extension value exceeds 32 KiB");
    }
  }
  if (Buffer.byteLength(JSON.stringify(data)) > AGGREGATE_BYTES) throw new ExtensionStorageError("quota", "Extension profile storage exceeds 8 MiB");
}
export function createExtensionStorage(profileDirectory: string, now: () => number = Date.now) {
  const file = join(profileDirectory, "capygen-extension-storage.json");
  let data: Data | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const lastWrite = new Map<string, number>();
  async function load(): Promise<Data> {
    if (data) return data;
    try {
      const parsed: unknown = JSON.parse((await boundedRead(file, AGGREGATE_BYTES)).toString("utf8"));
      if (!object(parsed)) throw new Error("Invalid extension storage");
      validate(parsed as Data);
      data = parsed as Data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ExtensionStorageError("invalid", "Extension storage cannot be read");
      data = Object.create(null) as Data;
    }
    return data;
  }
  function serialized<T>(operation: () => Promise<T>): Promise<T> { const result = queue.then(operation); queue = result.catch(() => {}); return result; }
  function check(namespace: string, key: string) { ExtensionIdSchema.parse(namespace); validKey(key); }
  async function change(namespace: string, key: string, value: unknown, remove: boolean, signal?: AbortSignal): Promise<void> {
    check(namespace, key);
    if (signal?.aborted) throw new Error("Write cancelled");
    const at = now();
    if (at - (lastWrite.get(namespace) ?? -Infinity) < 50) throw new ExtensionStorageError("paced", "Extension writes are limited to 20 per second");
    const current = await load();
    let encoded: string | undefined;
    try { encoded = JSON.stringify(value); } catch { throw new ExtensionStorageError("invalid", "Storage values must be JSON"); }
    if (!remove && (encoded === undefined || Buffer.byteLength(encoded) > VALUE_BYTES)) throw new ExtensionStorageError("quota", "Extension value exceeds 32 KiB or is not JSON");
    const next = JSON.parse(JSON.stringify(current)) as Data;
    const entries = { ...(next[namespace] ?? {}) };
    if (remove) delete entries[key]; else entries[key] = JSON.parse(encoded!);
    next[namespace] = entries;
    validate(next);
    await atomicJson(file, next, signal);
    data = next;
    lastWrite.set(namespace, at);
  }
  return {
    get(namespace: string, key: string): Promise<unknown> { return serialized(async () => { check(namespace, key); const value = (await load())[namespace]?.[key]; return value === undefined ? null : JSON.parse(JSON.stringify(value)); }); },
    set(namespace: string, key: string, value: unknown, signal?: AbortSignal): Promise<void> { return serialized(() => change(namespace, key, value, false, signal)); },
    delete(namespace: string, key: string, signal?: AbortSignal): Promise<void> { return serialized(() => change(namespace, key, null, true, signal)); },
  };
}
export type ExtensionStorage = ReturnType<typeof createExtensionStorage>;
